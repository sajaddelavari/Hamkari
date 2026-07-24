import { chmodSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { hashToken, randomToken } from './security.js';

export const SCHEMA_VERSION = 6;

function quotedIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function tableExists(db, table) {
  return Boolean(
    db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(table),
  );
}

function columnNames(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(
    db.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all().map((row) => row.name),
  );
}

function ensureColumn(db, table, column, definition) {
  if (!columnNames(db, table).has(column)) {
    db.exec(
      `ALTER TABLE ${quotedIdentifier(table)} ADD COLUMN ${quotedIdentifier(column)} ${definition}`,
    );
  }
}

export function withTransaction(db, callback, mode = 'IMMEDIATE') {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original error if SQLite already rolled back the transaction.
    }
    throw error;
  }
}

function migration1(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      slug TEXT,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      leader_name TEXT NOT NULL DEFAULT '',
      leader_description TEXT NOT NULL DEFAULT '',
      timeline TEXT NOT NULL DEFAULT '',
      process_description TEXT NOT NULL DEFAULT '',
      target_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);

  // Upgrade the original projects table in place. Keeping it avoids destructive
  // rebuilds and preserves any columns introduced by local prototypes.
  ensureColumn(db, 'projects', 'slug', 'TEXT');
  ensureColumn(db, 'projects', 'leader_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'leader_description', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'timeline', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'process_description', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'target_date', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    'projects',
    'status',
    "TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published'))",
  );
  ensureColumn(db, 'projects', 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'projects', 'updated_at', "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    UPDATE projects
    SET slug = COALESCE(NULLIF(slug, ''), id),
        updated_at = COALESCE(NULLIF(updated_at, ''), created_at);
    UPDATE projects
    SET active = 0
    WHERE active = 1
      AND id <> (
        SELECT id FROM projects WHERE active = 1
        ORDER BY created_at, id LIMIT 1
      );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_unique ON projects(slug);
    CREATE UNIQUE INDEX IF NOT EXISTS projects_single_active
      ON projects(active) WHERE active = 1;

    CREATE TABLE IF NOT EXISTS needs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      target_value TEXT NOT NULL DEFAULT '',
      expectations TEXT NOT NULL DEFAULT '',
      order_no INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS viewer_interactions (
      need_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      following INTEGER NOT NULL DEFAULT 0 CHECK(following IN (0, 1)),
      interested INTEGER NOT NULL DEFAULT 0 CHECK(interested IN (0, 1)),
      first_viewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(need_id, visitor_id),
      FOREIGN KEY(need_id) REFERENCES needs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      need_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      applicant_name TEXT NOT NULL,
      mobile TEXT NOT NULL DEFAULT '',
      email TEXT,
      contribution TEXT NOT NULL,
      availability TEXT,
      notes TEXT,
      consent INTEGER NOT NULL DEFAULT 0 CHECK(consent IN (0, 1)),
      status TEXT NOT NULL CHECK(status IN ('new','contacted','negotiating','accepted','rejected')),
      decision_message TEXT,
      internal_note TEXT,
      tracking_token_hash TEXT NOT NULL UNIQUE,
      idempotency_key_hash TEXT,
      request_hash TEXT,
      legacy_commitment_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      FOREIGN KEY(need_id) REFERENCES needs(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS proposal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('applicant','admin','system')),
      actor_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN ('created','status_changed','internal_note','decision_message','migrated')),
      from_status TEXT,
      to_status TEXT,
      message TEXT,
      visibility TEXT NOT NULL DEFAULT 'applicant' CHECK(visibility IN ('applicant','admin')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);
}

function migration2(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS needs_project_order
      ON needs(project_id, archived_at, order_no);
    CREATE INDEX IF NOT EXISTS viewer_interactions_need
      ON viewer_interactions(need_id, following, interested);
    CREATE INDEX IF NOT EXISTS proposals_need_status
      ON proposals(need_id, status, created_at);
    CREATE INDEX IF NOT EXISTS proposals_status_updated
      ON proposals(status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS proposals_idempotency_unique
      ON proposals(visitor_id, need_id, idempotency_key_hash)
      WHERE idempotency_key_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS proposals_one_accepted_per_need
      ON proposals(need_id) WHERE status = 'accepted';
    CREATE INDEX IF NOT EXISTS proposal_events_proposal_created
      ON proposal_events(proposal_id, created_at, id);
    CREATE INDEX IF NOT EXISTS admin_sessions_expiry
      ON admin_sessions(expires_at);
  `);
}

function migrateLegacyData(db, now) {
  if (tableExists(db, 'pieces')) {
    const legacyPieces = db.prepare(`
      SELECT id, project_id, title, description, category, target_value, order_no
      FROM pieces
      ORDER BY order_no, id
    `).all();
    const insertNeed = db.prepare(`
      INSERT OR IGNORE INTO needs(
        id, project_id, title, description, category, target_value,
        expectations, order_no, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?, ?,?,?)
    `);
    for (const piece of legacyPieces) {
      insertNeed.run(
        piece.id,
        piece.project_id,
        piece.title,
        piece.description,
        piece.category,
        piece.target_value,
        '',
        piece.order_no,
        now,
        now,
      );
    }
  }

  if (tableExists(db, 'interactions')) {
    const rows = db.prepare(`
      SELECT piece_id, actor_id,
             MAX(CASE WHEN action='follow' THEN 1 ELSE 0 END) AS following,
             MAX(CASE WHEN action='interest' THEN 1 ELSE 0 END) AS interested,
             MIN(CASE WHEN action='view' THEN created_at END) AS first_viewed_at,
             MIN(created_at) AS created_at,
             MAX(created_at) AS updated_at
      FROM interactions
      GROUP BY piece_id, actor_id
    `).all();
    const upsertInteraction = db.prepare(`
      INSERT INTO viewer_interactions(
        need_id, visitor_id, following, interested, first_viewed_at, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(need_id, visitor_id) DO UPDATE SET
        following = MAX(viewer_interactions.following, excluded.following),
        interested = MAX(viewer_interactions.interested, excluded.interested),
        first_viewed_at = COALESCE(viewer_interactions.first_viewed_at, excluded.first_viewed_at),
        updated_at = MAX(viewer_interactions.updated_at, excluded.updated_at)
    `);
    for (const row of rows) {
      if (!db.prepare('SELECT 1 FROM needs WHERE id=?').get(row.piece_id)) continue;
      upsertInteraction.run(
        row.piece_id,
        row.actor_id,
        Number(row.following),
        Number(row.interested),
        row.first_viewed_at,
        row.created_at || now,
        row.updated_at || now,
      );
    }
  }

  if (tableExists(db, 'commitments')) {
    const acceptedNeeds = new Set(
      db.prepare(`SELECT need_id FROM proposals WHERE status='accepted'`).all()
        .map((row) => row.need_id),
    );
    const commitments = db.prepare(`
      SELECT id, piece_id, actor_id, actor_name, note, status, created_at
      FROM commitments
      ORDER BY created_at, id
    `).all();
    const insertProposal = db.prepare(`
      INSERT OR IGNORE INTO proposals(
        id, need_id, visitor_id, applicant_name, mobile, email, contribution,
        availability, notes, consent, status, decision_message, internal_note,
        tracking_token_hash, idempotency_key_hash, request_hash,
        legacy_commitment_id, created_at, updated_at, decided_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertEvent = db.prepare(`
      INSERT INTO proposal_events(
        proposal_id, actor_type, event_type, from_status, to_status,
        message, visibility, created_at
      ) VALUES(?, 'system', 'migrated', NULL, ?, ?, 'applicant', ?)
    `);

    for (const commitment of commitments) {
      if (!db.prepare('SELECT 1 FROM needs WHERE id=?').get(commitment.piece_id)) continue;
      let status = {
        pending: 'new',
        rejected: 'rejected',
        approved: 'accepted',
      }[commitment.status] || 'new';
      let migrationMessage = 'این پیشنهاد از نسخه پیشین هم‌ساخت منتقل شده است.';
      if (status === 'accepted' && acceptedNeeds.has(commitment.piece_id)) {
        // The source table is preserved intact. The canonical model can only have
        // one accepted proposal, so additional legacy approvals stay in negotiation.
        status = 'negotiating';
        migrationMessage =
          'این پیشنهاد با وضعیت تأییدشده منتقل شد، اما به‌دلیل وجود تعهد پذیرفته‌شده دیگر در حال مذاکره ثبت شد.';
      }
      if (status === 'accepted') acceptedNeeds.add(commitment.piece_id);
      const result = insertProposal.run(
        commitment.id,
        commitment.piece_id,
        commitment.actor_id,
        commitment.actor_name,
        '',
        null,
        commitment.note,
        null,
        null,
        0,
        status,
        status === 'rejected' ? 'این پیشنهاد در نسخه پیشین رد شده بود.' : null,
        null,
        hashToken(randomToken(32)),
        null,
        null,
        commitment.id,
        commitment.created_at || now,
        commitment.created_at || now,
        ['accepted', 'rejected'].includes(status) ? commitment.created_at || now : null,
      );
      if (Number(result.changes) > 0) {
        insertEvent.run(
          commitment.id,
          status,
          migrationMessage,
          commitment.created_at || now,
        );
      }
    }
  }
}

function migration3(db) {
  const now = new Date().toISOString();
  migrateLegacyData(db, now);
}

function migration4(db) {
  ensureColumn(db, 'projects', 'target_date', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    'projects',
    'status',
    "TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published'))",
  );
  db.exec(`
    UPDATE projects
    SET status = CASE WHEN active = 1 THEN 'published' ELSE 'draft' END;
  `);
}

function migration5(db) {
  db.exec(`
    DELETE FROM viewer_interactions
    WHERE following = 0 AND interested = 0 AND first_viewed_at IS NULL;
  `);
}

function migration6(db) {
  db.exec(`
    DROP INDEX IF EXISTS proposals_idempotency_unique;
    UPDATE proposals
    SET idempotency_key_hash=NULL, request_hash=NULL
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY need_id, idempotency_key_hash
                 ORDER BY created_at, id
               ) AS duplicate_position
        FROM proposals
        WHERE idempotency_key_hash IS NOT NULL
      )
      WHERE duplicate_position > 1
    );
    CREATE UNIQUE INDEX proposals_idempotency_unique
      ON proposals(need_id, idempotency_key_hash)
      WHERE idempotency_key_hash IS NOT NULL;
  `);
}

const MIGRATIONS = [
  migration1,
  migration2,
  migration3,
  migration4,
  migration5,
  migration6,
];

function applyMigrations(db) {
  let current = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than supported version ${SCHEMA_VERSION}.`,
    );
  }
  while (current < SCHEMA_VERSION) {
    const next = current + 1;
    withTransaction(db, () => {
      MIGRATIONS[current](db);
      db.exec(`PRAGMA user_version = ${next}`);
    }, 'EXCLUSIVE');
    current = next;
  }
}

const DEMO_NEEDS = [
  {
    id: 'land',
    title: 'زمین و زیرساخت اولیه',
    description: 'تأمین زمین دارای دسترسی مناسب، سند روشن و امکان دریافت مجوز.',
    category: 'دارایی',
    target: '۲۰ هکتار',
    expectations: 'سند قابل استعلام، دسترسی جاده‌ای و امکان توسعه زیرساخت.',
  },
  {
    id: 'capital',
    title: 'سرمایه ساخت سازه',
    description: 'تأمین مالی مرحله‌ای برای سازه، پوشش و تأسیسات اصلی.',
    category: 'سرمایه',
    target: '۲۵۰ میلیارد ریال',
    expectations: 'توان تأمین مرحله‌ای و همراهی در تدوین مدل مالی.',
  },
  {
    id: 'water',
    title: 'آب و انرژی',
    description: 'تأمین پایدار آب، برق، گاز یا انرژی جایگزین.',
    category: 'زیرساخت',
    target: 'ظرفیت کامل پروژه',
    expectations: 'راهکار پایدار، قابل مجوز و دارای برآورد هزینه اجرا.',
  },
  {
    id: 'technical',
    title: 'دانش فنی گلخانه',
    description: 'طراحی کشت، انتخاب محصول، کنترل اقلیم و بهره‌برداری.',
    category: 'دانش و تجربه',
    target: 'تیم فنی کامل',
    expectations: 'سابقه طراحی یا بهره‌برداری از گلخانه در مقیاس صنعتی.',
  },
  {
    id: 'execution',
    title: 'مدیریت و اجرای پروژه',
    description: 'برنامه‌ریزی، پیمانکاران، کنترل هزینه و تحویل مرحله‌ای.',
    category: 'اجرا',
    target: 'مدیر پروژه و تیم',
    expectations: 'توان مدیریت برنامه، بودجه، خرید و کنترل پیمانکاران.',
  },
  {
    id: 'equipment',
    title: 'تجهیزات و ماشین‌آلات',
    description: 'تأمین تجهیزات آبیاری، کنترل اقلیم، بسته‌بندی و حمل.',
    category: 'تأمین',
    target: 'فهرست تجهیزات مصوب',
    expectations: 'پیشنهاد فنی شفاف، خدمات پس از فروش و زمان تحویل مشخص.',
  },
  {
    id: 'market',
    title: 'بازار فروش و صادرات',
    description: 'قرارداد فروش، کانال توزیع و امکان صادرات محصول.',
    category: 'بازار',
    target: 'فروش حداقل ۷۰٪ ظرفیت',
    expectations: 'شبکه فروش فعال یا سابقه صادرات محصولات کشاورزی.',
  },
  {
    id: 'legal',
    title: 'مجوزها و امور حقوقی',
    description: 'مجوزهای کشاورزی، محیط‌زیست، قراردادها و ساختار حقوقی تعاون.',
    category: 'حقوقی',
    target: 'مجوز و قرارداد نهایی',
    expectations: 'تجربه پروژه‌های کشاورزی و تنظیم قرارداد مشارکت.',
  },
];

function seedDemo(db) {
  const projectCount = Number(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count);
  if (projectCount > 0) return false;
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO projects(
        id, slug, title, subtitle, location, summary, leader_name,
        leader_description, timeline, process_description, target_date, status, active,
        created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'greenhouse-20ha',
      'greenhouse-20ha',
      'گلخانه مشارکتی ۲۰ هکتاری',
      'ساخت یک مجموعه تولیدی با تقسیم روشن مسئولیت‌ها و آورده‌ها',
      'استان مرکزی، ایران',
      'این طرح یک اتاق همکاری شفاف برای تکمیل اجزای یک گلخانه صنعتی است. هر نیاز زمانی تکمیل می‌شود که پیشنهاد آن پس از مذاکره رسمی پذیرفته شود.',
      'گروه توسعه سبز',
      'راهبر شکل‌دهی مشارکت، هماهنگی بررسی پیشنهادها و پیگیری توافق‌ها.',
      'بررسی پیشنهادها از تابستان ۱۴۰۵؛ آغاز اجرا پس از تکمیل تعهدهای کلیدی.',
      'نیاز مناسب را انتخاب کنید، پیشنهاد دقیق خود را بفرستید و با کد امن، نتیجه بررسی را پیگیری کنید.',
      '2028-03-19',
      'published',
      1,
      now,
      now,
    );

    const insertNeed = db.prepare(`
      INSERT INTO needs(
        id, project_id, title, description, category, target_value,
        expectations, order_no, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `);
    DEMO_NEEDS.forEach((need, index) => {
      insertNeed.run(
        need.id,
        'greenhouse-20ha',
        need.title,
        need.description,
        need.category,
        need.target,
        need.expectations,
        index + 1,
        now,
        now,
      );
    });
  });
  return true;
}

function bootstrapDraftProject(db) {
  const projectCount = Number(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count);
  if (projectCount > 0) return false;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO projects(
      id, slug, title, subtitle, location, summary, leader_name,
      leader_description, timeline, process_description, target_date,
      status, active, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'project-room',
    'project-room',
    'پروژه جدید',
    'اطلاعات این پروژه را از پنل مدیریت تکمیل کنید',
    'موقعیت پروژه',
    'این اتاق مشارکت آماده است تا اطلاعات واقعی پروژه، نیازهای همکاری و فرآیند بررسی پیشنهادها در آن ثبت شود.',
    'راهبر پروژه',
    'معرفی راهبر پروژه را از پنل مدیریت تکمیل کنید.',
    '',
    'فرآیند بررسی، تماس، مذاکره و پذیرش پیشنهادها را اینجا توضیح دهید.',
    '',
    'draft',
    0,
    now,
    now,
  );
  return true;
}

export function openDatabase(config, options = {}) {
  if (config.databasePath !== ':memory:') {
    mkdirSync(config.databaseDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(config.databaseDirectory, 0o700);
  }
  const db = new DatabaseSync(config.databasePath, {
    timeout: config.sqliteBusyTimeoutMs,
  });
  if (config.databasePath !== ':memory:' && process.platform !== 'win32') {
    chmodSync(config.databasePath, 0o600);
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${Number(config.sqliteBusyTimeoutMs)};
  `);
  applyMigrations(db);
  const shouldSeedDemo = options.seed ?? !config.isProduction;
  if (shouldSeedDemo) seedDemo(db);
  else if (options.bootstrap ?? config.isProduction) bootstrapDraftProject(db);
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) {
    db.close();
    throw new Error(`Foreign key check failed after migration (${violations.length} violations).`);
  }
  return db;
}

export const databaseInternals = {
  tableExists,
  columnNames,
  applyMigrations,
  seedDemo,
  bootstrapDraftProject,
};

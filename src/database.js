import { chmodSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { hashToken, randomToken } from './security.js';

export const SCHEMA_VERSION = 11;
const MAX_PRACTICAL_WEIGHT = 1_000_000;

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

function migration7(db) {
  ensureColumn(db, 'projects', 'industry', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'archived_at', 'TEXT');
  db.exec(`
    DROP INDEX IF EXISTS projects_single_active;

    CREATE TABLE project_stakeholders (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('person','organization')),
      role TEXT NOT NULL CHECK(role IN ('owner','board','manager','investor','partner')),
      mobile TEXT, email TEXT, archived_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE share_classes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL,
      authorized_units INTEGER NOT NULL CHECK(authorized_units > 0),
      voting_weight REAL NOT NULL DEFAULT 1 CHECK(voting_weight >= 0),
      created_at TEXT NOT NULL, UNIQUE(project_id,symbol),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE share_ledger (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, share_class_id TEXT NOT NULL,
      stakeholder_id TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('issuance','transfer_in','transfer_out','adjustment')),
      units INTEGER NOT NULL CHECK(units <> 0), related_transfer_id TEXT, note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(share_class_id) REFERENCES share_classes(id),
      FOREIGN KEY(stakeholder_id) REFERENCES project_stakeholders(id)
    );
    CREATE TRIGGER share_ledger_no_update BEFORE UPDATE ON share_ledger
      BEGIN SELECT RAISE(ABORT,'share ledger is immutable'); END;
    CREATE TRIGGER share_ledger_no_delete BEFORE DELETE ON share_ledger
      BEGIN SELECT RAISE(ABORT,'share ledger is immutable'); END;
    CREATE TABLE share_transfers (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, share_class_id TEXT NOT NULL,
      from_stakeholder_id TEXT NOT NULL, to_stakeholder_id TEXT NOT NULL,
      units INTEGER NOT NULL CHECK(units > 0), price_amount INTEGER,
      status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','rejected','cancelled')),
      note TEXT, decision_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_at TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(share_class_id) REFERENCES share_classes(id),
      FOREIGN KEY(from_stakeholder_id) REFERENCES project_stakeholders(id),
      FOREIGN KEY(to_stakeholder_id) REFERENCES project_stakeholders(id)
    );
    CREATE TABLE financial_entries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('revenue','expense','investment','distribution','valuation')),
      amount INTEGER NOT NULL CHECK(amount >= 0), occurred_on TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', stakeholder_id TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(stakeholder_id) REFERENCES project_stakeholders(id)
    );
    CREATE TABLE project_goals (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', weight REAL NOT NULL CHECK(weight > 0),
      status TEXT NOT NULL CHECK(status IN ('planned','active','completed','cancelled')),
      due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE goal_milestones (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, title TEXT NOT NULL,
      weight REAL NOT NULL CHECK(weight > 0), completed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(goal_id) REFERENCES project_goals(id) ON DELETE CASCADE
    );
    CREATE TABLE project_meetings (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', minutes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('scheduled','held','cancelled')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE meeting_attendees (
      meeting_id TEXT NOT NULL, stakeholder_id TEXT NOT NULL,
      attendance TEXT NOT NULL CHECK(attendance IN ('invited','present','absent')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(meeting_id,stakeholder_id),
      FOREIGN KEY(meeting_id) REFERENCES project_meetings(id) ON DELETE CASCADE,
      FOREIGN KEY(stakeholder_id) REFERENCES project_stakeholders(id)
    );
    CREATE TABLE meeting_resolutions (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('draft','open','closed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES project_meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE resolution_votes (
      id TEXT PRIMARY KEY, resolution_id TEXT NOT NULL, stakeholder_id TEXT NOT NULL,
      choice TEXT NOT NULL CHECK(choice IN ('yes','no','abstain')),
      voting_power REAL NOT NULL CHECK(voting_power >= 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(resolution_id,stakeholder_id),
      FOREIGN KEY(resolution_id) REFERENCES meeting_resolutions(id) ON DELETE CASCADE,
      FOREIGN KEY(stakeholder_id) REFERENCES project_stakeholders(id)
    );
    CREATE INDEX stakeholders_project ON project_stakeholders(project_id,archived_at);
    CREATE INDEX ledger_project ON share_ledger(project_id,share_class_id,stakeholder_id);
    CREATE INDEX transfers_project ON share_transfers(project_id,status,created_at);
    CREATE INDEX financial_project ON financial_entries(project_id,occurred_on);
    CREATE INDEX goals_project ON project_goals(project_id,status);
    CREATE INDEX meetings_project ON project_meetings(project_id,scheduled_at);
  `);
}

function migration8(db) {
  // Migration 7 may already be present in long-running development databases.
  // Keep it immutable and add the portfolio/corporate-management expansion here.
  ensureColumn(db, 'projects', 'industry', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'sector', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'kind', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'stage', "TEXT NOT NULL DEFAULT 'idea'");
  ensureColumn(db, 'projects', 'currency', "TEXT NOT NULL DEFAULT 'IRR'");
  ensureColumn(db, 'projects', 'budget_amount', 'INTEGER');
  ensureColumn(db, 'projects', 'valuation_amount', 'INTEGER');
  ensureColumn(db, 'projects', 'start_date', 'TEXT');
  ensureColumn(db, 'projects', 'archived_at', 'TEXT');
  ensureColumn(db, 'project_meetings', 'public_visible', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'meeting_resolutions', 'public_visible', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'meeting_resolutions', 'decision', 'TEXT');
  ensureColumn(db, 'meeting_resolutions', 'decided_at', 'TEXT');
  ensureColumn(db, 'financial_entries', 'reversal_of_entry_id', 'TEXT');
  ensureColumn(db, 'share_transfers', 'offer_id', 'TEXT');

  db.exec(`
    UPDATE projects
    SET active=0
    WHERE active=1
      AND id<>(
        SELECT id
        FROM projects
        WHERE active=1
        ORDER BY created_at, id
        LIMIT 1
      );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_single_active
      ON projects(active) WHERE active=1;

    CREATE TABLE IF NOT EXISTS share_offers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      share_class_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('sell','buy')),
      seller_stakeholder_id TEXT,
      buyer_stakeholder_id TEXT,
      units INTEGER NOT NULL CHECK(units > 0),
      remaining_units INTEGER NOT NULL CHECK(remaining_units >= 0 AND remaining_units <= units),
      unit_price INTEGER NOT NULL CHECK(unit_price >= 0),
      available_until TEXT,
      status TEXT NOT NULL CHECK(status IN ('open','partially_filled','filled','cancelled')),
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(share_class_id) REFERENCES share_classes(id),
      FOREIGN KEY(seller_stakeholder_id) REFERENCES project_stakeholders(id),
      FOREIGN KEY(buyer_stakeholder_id) REFERENCES project_stakeholders(id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'admin',
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS share_offers_project_status
      ON share_offers(project_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_project_created
      ON audit_events(project_id, created_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS financial_reversal_once
      ON financial_entries(reversal_of_entry_id)
      WHERE reversal_of_entry_id IS NOT NULL;

    DROP TRIGGER IF EXISTS share_ledger_no_update;
    DROP TRIGGER IF EXISTS share_ledger_no_delete;
    DELETE FROM share_ledger
    WHERE related_transfer_id IS NOT NULL
      AND id IN (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY related_transfer_id, entry_type
              ORDER BY created_at, id
            ) AS duplicate_position
          FROM share_ledger
          WHERE related_transfer_id IS NOT NULL
        )
        WHERE duplicate_position > 1
      );
    CREATE UNIQUE INDEX IF NOT EXISTS share_ledger_transfer_entry_once
      ON share_ledger(related_transfer_id, entry_type)
      WHERE related_transfer_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS share_ledger_no_update
      BEFORE UPDATE ON share_ledger
      BEGIN SELECT RAISE(ABORT, 'share ledger is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS share_ledger_no_delete
      BEFORE DELETE ON share_ledger
      BEGIN SELECT RAISE(ABORT, 'share ledger is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS financial_entries_no_update
      BEFORE UPDATE ON financial_entries
      BEGIN SELECT RAISE(ABORT, 'financial entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS financial_entries_no_delete
      BEFORE DELETE ON financial_entries
      BEGIN SELECT RAISE(ABORT, 'financial entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
  `);
}

function migration9(db) {
  db.exec(`
    CREATE TABLE operation_receipts (
      scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      idempotency_key_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(scope, project_id, idempotency_key_hash),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX operation_receipts_project_created
      ON operation_receipts(project_id, created_at DESC);
    CREATE TRIGGER operation_receipts_no_update
      BEFORE UPDATE ON operation_receipts
      BEGIN SELECT RAISE(ABORT, 'operation receipts are immutable'); END;
    CREATE TRIGGER operation_receipts_no_delete
      BEFORE DELETE ON operation_receipts
      BEGIN SELECT RAISE(ABORT, 'operation receipts are immutable'); END;
  `);
}

function migration10(db) {
  // Repair invariants for databases that were already marked as schema 8 or 9
  // before these guards were introduced. Dropping the indexes first also
  // replaces any accidentally-created non-unique index with the intended one.
  db.exec(`
    DROP INDEX IF EXISTS projects_single_active;
    UPDATE projects
    SET active=0
    WHERE active=1 AND archived_at IS NOT NULL;
    UPDATE projects
    SET active=0
    WHERE active=1
      AND archived_at IS NULL
      AND id<>(
        SELECT id
        FROM projects
        WHERE active=1 AND archived_at IS NULL
        ORDER BY created_at, id
        LIMIT 1
      );
    CREATE UNIQUE INDEX projects_single_active
      ON projects(active) WHERE active=1;

    DROP TRIGGER IF EXISTS share_ledger_no_update;
    DROP TRIGGER IF EXISTS share_ledger_no_delete;
    DROP INDEX IF EXISTS share_ledger_transfer_entry_once;
    DELETE FROM share_ledger
    WHERE related_transfer_id IS NOT NULL;
    INSERT INTO share_ledger(
      id, project_id, share_class_id, stakeholder_id, entry_type,
      units, related_transfer_id, note, created_at
    )
    SELECT
      lower(hex(randomblob(16))),
      project_id,
      share_class_id,
      from_stakeholder_id,
      'transfer_out',
      -units,
      id,
      COALESCE(decision_note, note),
      COALESCE(decided_at, updated_at, created_at)
    FROM share_transfers
    WHERE status='approved';
    INSERT INTO share_ledger(
      id, project_id, share_class_id, stakeholder_id, entry_type,
      units, related_transfer_id, note, created_at
    )
    SELECT
      lower(hex(randomblob(16))),
      project_id,
      share_class_id,
      to_stakeholder_id,
      'transfer_in',
      units,
      id,
      COALESCE(decision_note, note),
      COALESCE(decided_at, updated_at, created_at)
    FROM share_transfers
    WHERE status='approved';
    CREATE UNIQUE INDEX share_ledger_transfer_entry_once
      ON share_ledger(related_transfer_id, entry_type)
      WHERE related_transfer_id IS NOT NULL;

    DROP TRIGGER IF EXISTS financial_entries_no_update;
    DROP TRIGGER IF EXISTS financial_entries_no_delete;
    DROP INDEX IF EXISTS financial_reversal_once;
    DELETE FROM financial_entries
    WHERE reversal_of_entry_id IS NOT NULL
      AND reversal_of_entry_id NOT IN (
        SELECT id
        FROM financial_entries
        WHERE reversal_of_entry_id IS NULL
      );
    DELETE FROM financial_entries
    WHERE reversal_of_entry_id IS NOT NULL
      AND id IN (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY reversal_of_entry_id
              ORDER BY created_at, id
            ) AS duplicate_position
          FROM financial_entries
          WHERE reversal_of_entry_id IS NOT NULL
        )
        WHERE duplicate_position > 1
      );
    UPDATE financial_entries
    SET
      project_id=(
        SELECT original.project_id
        FROM financial_entries original
        WHERE original.id=financial_entries.reversal_of_entry_id
      ),
      type=(
        SELECT original.type
        FROM financial_entries original
        WHERE original.id=financial_entries.reversal_of_entry_id
      ),
      amount=(
        SELECT original.amount
        FROM financial_entries original
        WHERE original.id=financial_entries.reversal_of_entry_id
      ),
      stakeholder_id=(
        SELECT original.stakeholder_id
        FROM financial_entries original
        WHERE original.id=financial_entries.reversal_of_entry_id
      )
    WHERE reversal_of_entry_id IS NOT NULL;
    CREATE UNIQUE INDEX financial_reversal_once
      ON financial_entries(reversal_of_entry_id)
      WHERE reversal_of_entry_id IS NOT NULL;
    UPDATE share_offers
    SET available_until=substr(available_until, 1, 10)
    WHERE available_until GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
      AND date(substr(available_until, 1, 10))=substr(available_until, 1, 10)
      AND julianday(available_until) IS NOT NULL;
    UPDATE share_offers
    SET status='cancelled', available_until=NULL
    WHERE available_until IS NOT NULL
      AND status IN ('open','partially_filled')
      AND NOT (
        length(available_until)=10
        AND available_until GLOB
          '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(available_until)=available_until
      );
    UPDATE share_offers
    SET available_until=NULL
    WHERE available_until IS NOT NULL
      AND status IN ('filled','cancelled')
      AND NOT (
        length(available_until)=10
        AND available_until GLOB
          '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(available_until)=available_until
      );
    CREATE TRIGGER share_ledger_no_update
      BEFORE UPDATE ON share_ledger
      BEGIN SELECT RAISE(ABORT, 'share ledger is immutable'); END;
    CREATE TRIGGER share_ledger_no_delete
      BEFORE DELETE ON share_ledger
      BEGIN SELECT RAISE(ABORT, 'share ledger is immutable'); END;
    CREATE TRIGGER financial_entries_no_update
      BEFORE UPDATE ON financial_entries
      BEGIN SELECT RAISE(ABORT, 'financial entries are immutable'); END;
    CREATE TRIGGER financial_entries_no_delete
      BEFORE DELETE ON financial_entries
      BEGIN SELECT RAISE(ABORT, 'financial entries are immutable'); END;
    DROP TRIGGER IF EXISTS audit_events_no_update;
    DROP TRIGGER IF EXISTS audit_events_no_delete;
    CREATE TRIGGER audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
    CREATE TRIGGER audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
  `);
}

function assertFinancialAggregatesSafeForMigration(db) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT project_id, type, amount, reversal_of_entry_id
      FROM financial_entries
    `).all();
  } catch (error) {
    throw new Error(
      'Migration 11 blocked: a financial amount cannot be represented safely; correct the legacy database before retrying.',
      { cause: error },
    );
  }
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  const totals = new Map();
  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(
        `Migration 11 blocked: project ${row.project_id} has an unsafe financial amount.`,
      );
    }
    const key = `${row.project_id}\u0000${row.type}`;
    const signedAmount = row.reversal_of_entry_id
      ? -BigInt(amount)
      : BigInt(amount);
    totals.set(key, (totals.get(key) || 0n) + signedAmount);
  }
  const byProject = new Map();
  for (const [key, total] of totals) {
    const separator = key.indexOf('\u0000');
    const projectId = key.slice(0, separator);
    const type = key.slice(separator + 1);
    const projectTotals = byProject.get(projectId) || new Map();
    projectTotals.set(type, total);
    byProject.set(projectId, projectTotals);
  }
  const unsafe = (value) => value > maximum || value < -maximum;
  for (const [projectId, projectTotals] of byProject) {
    const revenue = projectTotals.get('revenue') || 0n;
    const expense = projectTotals.get('expense') || 0n;
    const investment = projectTotals.get('investment') || 0n;
    const distribution = projectTotals.get('distribution') || 0n;
    const derived = [
      ...projectTotals.values(),
      revenue - expense,
      revenue + investment - expense - distribution,
    ];
    if (derived.some(unsafe)) {
      throw new Error(
        `Migration 11 blocked: project ${projectId} has a financial aggregate outside JavaScript's safe integer range.`,
      );
    }
  }
}

function assertCapitalAndWeightAggregatesSafeForMigration(db) {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  const blocked = (message) => {
    throw new Error(`Migration 11 blocked: ${message}`);
  };
  const safeWeight = (value) => (
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_PRACTICAL_WEIGHT
  );
  const addPower = (totals, key, units, weight, label) => {
    if (units < 0n || units > maximum) {
      blocked(`${label} has units outside JavaScript's safe integer range.`);
    }
    const power = Number(units) * weight;
    const next = (totals.get(key) || 0) + power;
    if (
      !Number.isFinite(power) ||
      power < 0 ||
      power > Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(next) ||
      next > Number.MAX_SAFE_INTEGER
    ) {
      blocked(`${label} has voting power outside JavaScript's safe numeric range.`);
    }
    totals.set(key, next);
  };

  try {
    const hasCapitalTables = (
      tableExists(db, 'project_stakeholders') &&
      tableExists(db, 'share_classes') &&
      tableExists(db, 'share_ledger')
    );
    const stakeholderRows = hasCapitalTables
      ? db.prepare(`
        SELECT id, project_id
        FROM project_stakeholders
      `).all()
      : [];
    const stakeholderProjects = new Map(
      stakeholderRows.map((row) => [row.id, row.project_id]),
    );
    const classRows = hasCapitalTables
      ? db.prepare(`
        SELECT id, project_id, authorized_units, voting_weight
        FROM share_classes
      `).all()
      : [];
    const classes = new Map();
    const classUnits = new Map();
    for (const row of classRows) {
      const authorizedUnits = Number(row.authorized_units);
      const votingWeight = Number(row.voting_weight);
      if (!Number.isSafeInteger(authorizedUnits) || authorizedUnits <= 0) {
        blocked(`share class ${row.id} has unsafe authorized units.`);
      }
      if (
        !Number.isFinite(votingWeight) ||
        votingWeight < 0 ||
        votingWeight > MAX_PRACTICAL_WEIGHT
      ) {
        blocked(`share class ${row.id} has an unsafe voting weight.`);
      }
      classes.set(row.id, {
        projectId: row.project_id,
        authorizedUnits,
        votingWeight,
      });
      classUnits.set(row.id, 0n);
    }

    const holdingUnits = new Map();
    const ledgerRows = hasCapitalTables
      ? db.prepare(`
        SELECT project_id, share_class_id, stakeholder_id, units
        FROM share_ledger
      `).all()
      : [];
    for (const row of ledgerRows) {
      const units = Number(row.units);
      const shareClass = classes.get(row.share_class_id);
      if (!Number.isSafeInteger(units) || units === 0) {
        blocked('the share ledger contains an unsafe unit value.');
      }
      if (
        !shareClass ||
        shareClass.projectId !== row.project_id ||
        stakeholderProjects.get(row.stakeholder_id) !== row.project_id
      ) {
        blocked('the share ledger contains a cross-project or missing reference.');
      }
      const delta = BigInt(units);
      classUnits.set(
        row.share_class_id,
        classUnits.get(row.share_class_id) + delta,
      );
      const holdingKey =
        `${row.project_id}\u0000${row.stakeholder_id}\u0000${row.share_class_id}`;
      holdingUnits.set(
        holdingKey,
        (holdingUnits.get(holdingKey) || 0n) + delta,
      );
    }

    const projectUnits = new Map();
    const projectVotingPower = new Map();
    for (const [classId, shareClass] of classes) {
      const issuedUnits = classUnits.get(classId) || 0n;
      if (
        issuedUnits < 0n ||
        issuedUnits > maximum ||
        issuedUnits > BigInt(shareClass.authorizedUnits)
      ) {
        blocked(`share class ${classId} has an unsafe issued-unit aggregate.`);
      }
      const nextProjectUnits =
        (projectUnits.get(shareClass.projectId) || 0n) + issuedUnits;
      if (nextProjectUnits > maximum) {
        blocked(
          `project ${shareClass.projectId} has total issued units outside JavaScript's safe integer range.`,
        );
      }
      projectUnits.set(shareClass.projectId, nextProjectUnits);
      addPower(
        projectVotingPower,
        shareClass.projectId,
        issuedUnits,
        shareClass.votingWeight,
        `project ${shareClass.projectId}`,
      );
    }

    const stakeholderVotingPower = new Map();
    for (const [key, units] of holdingUnits) {
      const lastSeparator = key.lastIndexOf('\u0000');
      const shareClassId = key.slice(lastSeparator + 1);
      const stakeholderKey = key.slice(0, lastSeparator);
      const shareClass = classes.get(shareClassId);
      if (units < 0n || units > maximum) {
        blocked(`stakeholder holding ${stakeholderKey} is outside the safe range.`);
      }
      addPower(
        stakeholderVotingPower,
        stakeholderKey,
        units,
        shareClass.votingWeight,
        `stakeholder holding ${stakeholderKey}`,
      );
    }

    const goalRows = tableExists(db, 'project_goals')
      ? db.prepare(`
        SELECT id, project_id, weight
        FROM project_goals
      `).all()
      : [];
    const goals = new Map();
    const goalWeights = new Map();
    for (const row of goalRows) {
      const weight = Number(row.weight);
      if (!safeWeight(weight)) {
        blocked(`goal ${row.id} has an unsafe weight.`);
      }
      const next = (goalWeights.get(row.project_id) || 0) + weight;
      if (!Number.isFinite(next) || next > MAX_PRACTICAL_WEIGHT) {
        blocked(`project ${row.project_id} has an unsafe goal-weight aggregate.`);
      }
      goalWeights.set(row.project_id, next);
      goals.set(row.id, row.project_id);
    }

    const milestoneRows = tableExists(db, 'goal_milestones')
      ? db.prepare(`
        SELECT id, goal_id, weight
        FROM goal_milestones
      `).all()
      : [];
    const milestoneWeights = new Map();
    for (const row of milestoneRows) {
      const weight = Number(row.weight);
      if (!goals.has(row.goal_id) || !safeWeight(weight)) {
        blocked(`milestone ${row.id} has an unsafe weight or missing goal.`);
      }
      const next = (milestoneWeights.get(row.goal_id) || 0) + weight;
      if (!Number.isFinite(next) || next > MAX_PRACTICAL_WEIGHT) {
        blocked(`goal ${row.goal_id} has an unsafe milestone-weight aggregate.`);
      }
      milestoneWeights.set(row.goal_id, next);
    }

    const resolutionPower = new Map();
    const voteRows = tableExists(db, 'resolution_votes')
      ? db.prepare(`
        SELECT resolution_id, voting_power
        FROM resolution_votes
      `).all()
      : [];
    for (const row of voteRows) {
      const votingPower = Number(row.voting_power);
      const next = (resolutionPower.get(row.resolution_id) || 0) + votingPower;
      if (
        !Number.isFinite(votingPower) ||
        votingPower < 0 ||
        votingPower > Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(next) ||
        next > Number.MAX_SAFE_INTEGER
      ) {
        blocked(
          `resolution ${row.resolution_id} has voting power outside JavaScript's safe numeric range.`,
        );
      }
      resolutionPower.set(row.resolution_id, next);
    }

    const projectColumns = columnNames(db, 'projects');
    const projectRows = (
      projectColumns.has('budget_amount') &&
      projectColumns.has('valuation_amount')
    )
      ? db.prepare(`
        SELECT id, budget_amount, valuation_amount
        FROM projects
      `).all()
      : [];
    for (const row of projectRows) {
      for (const [field, value] of [
        ['budget', row.budget_amount],
        ['valuation', row.valuation_amount],
      ]) {
        if (
          value !== null &&
          (!Number.isSafeInteger(Number(value)) || Number(value) < 0)
        ) {
          blocked(`project ${row.id} has an unsafe ${field} amount.`);
        }
      }
    }

    const offerColumns = columnNames(db, 'share_offers');
    const offerRows = (
      offerColumns.has('units') &&
      offerColumns.has('remaining_units') &&
      offerColumns.has('unit_price')
    )
      ? db.prepare(`
        SELECT id, units, remaining_units, unit_price
        FROM share_offers
      `).all()
      : [];
    for (const row of offerRows) {
      const units = Number(row.units);
      const remainingUnits = Number(row.remaining_units);
      const unitPrice = Number(row.unit_price);
      if (
        !Number.isSafeInteger(units) ||
        units <= 0 ||
        !Number.isSafeInteger(remainingUnits) ||
        remainingUnits < 0 ||
        remainingUnits > units ||
        !Number.isSafeInteger(unitPrice) ||
        unitPrice < 0
      ) {
        blocked(`share offer ${row.id} contains an unsafe numeric value.`);
      }
    }

    const transferColumns = columnNames(db, 'share_transfers');
    const transferRows = (
      transferColumns.has('units') &&
      transferColumns.has('price_amount')
    )
      ? db.prepare(`
        SELECT id, units, price_amount
        FROM share_transfers
      `).all()
      : [];
    for (const row of transferRows) {
      if (
        !Number.isSafeInteger(Number(row.units)) ||
        Number(row.units) <= 0 ||
        (
          row.price_amount !== null &&
          (
            !Number.isSafeInteger(Number(row.price_amount)) ||
            Number(row.price_amount) < 0
          )
        )
      ) {
        blocked(`share transfer ${row.id} contains an unsafe numeric value.`);
      }
    }
  } catch (error) {
    if (String(error?.message || '').startsWith('Migration 11 blocked:')) {
      throw error;
    }
    throw new Error(
      'Migration 11 blocked: a capital, voting, or weighted-progress value cannot be represented safely; correct the legacy database before retrying.',
      { cause: error },
    );
  }
}

function repairReservedProjectSlug(db) {
  const reserved = db.prepare(
    `SELECT id FROM projects WHERE slug='current' ORDER BY created_at, id LIMIT 1`,
  ).get();
  if (!reserved) return;
  let suffix = 1;
  while (suffix < 1_000_000) {
    const candidate = suffix === 1
      ? 'current-project'
      : `current-project-${suffix}`;
    if (!db.prepare('SELECT 1 FROM projects WHERE slug=?').get(candidate)) {
      db.prepare('UPDATE projects SET slug=? WHERE id=?').run(
        candidate,
        reserved.id,
      );
      return;
    }
    suffix += 1;
  }
  throw new Error(
    'Migration 11 blocked: unable to allocate a non-reserved slug for the legacy current project.',
  );
}

function migration11(db) {
  // Schema 10 was used by local MVP installations before the authoritative
  // ledger/reversal repair was added. Re-run the idempotent repair so those
  // databases receive the same invariants as a direct upgrade from schema 8/9.
  migration10(db);
  repairReservedProjectSlug(db);
  assertCapitalAndWeightAggregatesSafeForMigration(db);
  assertFinancialAggregatesSafeForMigration(db);
}

const MIGRATIONS = [
  migration1,
  migration2,
  migration3,
  migration4,
  migration5,
  migration6,
  migration7,
  migration8,
  migration9,
  migration10,
  migration11,
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

function seedPortfolioDemos(db) {
  // Only extend the bundled development fixture. A production bootstrap never
  // contains this id and therefore never receives public demo projects.
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get('greenhouse-20ha')) {
    return false;
  }
  const shouldEnrichGreenhouse = !db.prepare(
    `SELECT 1 FROM projects WHERE id IN ('solar-industrial-park','digital-supply-network') LIMIT 1`,
  ).get();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    if (shouldEnrichGreenhouse) {
      db.prepare(`
        UPDATE projects
        SET industry=CASE WHEN industry='' THEN 'کشاورزی' ELSE industry END,
            sector=CASE WHEN sector='' THEN 'کشاورزی هوشمند' ELSE sector END,
            kind=CASE WHEN kind='' THEN 'توسعه صنعتی' ELSE kind END,
            stage=CASE WHEN stage='idea' THEN 'fundraising' ELSE stage END,
            currency=CASE WHEN currency='' THEN 'IRR' ELSE currency END,
            budget_amount=COALESCE(budget_amount, 250000000000),
            valuation_amount=COALESCE(valuation_amount, 420000000000),
            start_date=COALESCE(start_date, '2026-09-23')
        WHERE id='greenhouse-20ha'
      `).run();
    }

    const insertProject = db.prepare(`
      INSERT OR IGNORE INTO projects(
        id, slug, title, subtitle, location, summary, leader_name,
        leader_description, timeline, process_description, target_date,
        status, active, industry, sector, kind, stage, currency,
        budget_amount, valuation_amount, start_date, archived_at, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    insertProject.run(
      'solar-industrial-park',
      'solar-industrial-park',
      'نیروگاه خورشیدی شهرک صنعتی',
      'تأمین برق پایدار با مدل سرمایه‌گذاری مشارکتی',
      'یزد، ایران',
      'پروژه طراحی، تأمین مالی و بهره‌برداری از یک نیروگاه خورشیدی مقیاس متوسط برای صنایع منطقه.',
      'کنسرسیوم انرژی روشن',
      'راهبر توسعه انرژی پاک و هماهنگ‌کننده سرمایه‌گذاران و پیمانکاران.',
      'طراحی و مجوز در ۱۴۰۵؛ ساخت و اتصال به شبکه در ۱۴۰۶.',
      'سرمایه، زمین و ظرفیت اجرایی پس از ارزیابی رسمی در ساختار پروژه ثبت می‌شود.',
      '2028-03-19',
      'published',
      0,
      'انرژی',
      'انرژی تجدیدپذیر',
      'زیرساخت',
      'construction',
      'IRR',
      780000000000,
      1100000000000,
      '2026-11-01',
      null,
      now,
      now,
    );
    insertProject.run(
      'digital-supply-network',
      'digital-supply-network',
      'شبکه دیجیتال تأمین تولیدکنندگان',
      'اتصال شفاف تولیدکننده، توزیع‌کننده و سرمایه در گردش',
      'سراسری',
      'پلتفرم B2B برای مدیریت سفارش، اعتبار و ظرفیت تولید کسب‌وکارهای کوچک و متوسط.',
      'تیم محصول هم‌ساخت',
      'تیم چندتخصصی محصول، عملیات و توسعه بازار.',
      'نسخه پایلوت در شش ماه و توسعه شبکه در دوازده ماه.',
      'همکاران پس از ارزیابی ظرفیت به پایلوت‌های منطقه‌ای متصل می‌شوند.',
      '2027-09-22',
      'published',
      0,
      'فناوری',
      'تجارت دیجیتال',
      'پلتفرم',
      'pilot',
      'IRR',
      95000000000,
      180000000000,
      '2026-08-01',
      null,
      now,
      now,
    );

    const insertNeed = db.prepare(`
      INSERT OR IGNORE INTO needs(
        id, project_id, title, description, category, target_value,
        expectations, order_no, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `);
    insertNeed.run(
      'solar-epc',
      'solar-industrial-park',
      'پیمانکار EPC',
      'طراحی و اجرای نیروگاه با تضمین عملکرد.',
      'اجرا',
      'ظرفیت ۲۰ مگاوات',
      'سابقه اتصال نیروگاه به شبکه و تیم اجرایی مستقر.',
      1,
      now,
      now,
    );
    insertNeed.run(
      'solar-capital',
      'solar-industrial-park',
      'سرمایه‌گذار پروژه',
      'تأمین بخشی از سرمایه ساخت در قالب سهام پروژه.',
      'سرمایه',
      '۴۰۰ میلیارد ریال',
      'افق سرمایه‌گذاری میان‌مدت و پذیرش سازوکار حاکمیت پروژه.',
      2,
      now,
      now,
    );
    insertNeed.run(
      'digital-pilot',
      'digital-supply-network',
      'شریک پایلوت صنعتی',
      'اجرای پایلوت سفارش و تأمین در یک زنجیره واقعی.',
      'بازار',
      'حداقل ۳۰ تأمین‌کننده',
      'دسترسی به شبکه تولیدکنندگان و تیم عملیات محلی.',
      1,
      now,
      now,
    );
    insertNeed.run(
      'digital-product',
      'digital-supply-network',
      'همکار ارشد محصول',
      'تکمیل تجربه سفارش، اعتبارسنجی و داشبورد شبکه.',
      'تخصص',
      'یک تیم محصول',
      'تجربه محصول B2B و تحلیل فرایندهای زنجیره تأمین.',
      2,
      now,
      now,
    );

    const insertStakeholder = db.prepare(`
      INSERT OR IGNORE INTO project_stakeholders(
        id, project_id, name, kind, role, mobile, email, archived_at, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `);
    insertStakeholder.run(
      'solar-owner',
      'solar-industrial-park',
      'کنسرسیوم انرژی روشن',
      'organization',
      'owner',
      null,
      null,
      null,
      now,
      now,
    );
    insertStakeholder.run(
      'digital-owner',
      'digital-supply-network',
      'تیم محصول هم‌ساخت',
      'organization',
      'owner',
      null,
      null,
      null,
      now,
      now,
    );
    insertStakeholder.run(
      'digital-investor',
      'digital-supply-network',
      'سرمایه‌گذار پایلوت',
      'organization',
      'investor',
      null,
      null,
      null,
      now,
      now,
    );
    const insertClass = db.prepare(`
      INSERT OR IGNORE INTO share_classes(
        id, project_id, name, symbol, authorized_units, voting_weight, created_at
      ) VALUES(?,?,?,?,?,?,?)
    `);
    insertClass.run('solar-common', 'solar-industrial-park', 'سهام عادی', 'SOL', 100000, 1, now);
    insertClass.run('digital-common', 'digital-supply-network', 'سهام عادی', 'DSN', 1000000, 1, now);
    const insertLedger = db.prepare(`
      INSERT OR IGNORE INTO share_ledger(
        id, project_id, share_class_id, stakeholder_id, entry_type,
        units, related_transfer_id, note, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `);
    insertLedger.run(
      'solar-initial-issuance',
      'solar-industrial-park',
      'solar-common',
      'solar-owner',
      'issuance',
      60000,
      null,
      'تخصیص اولیه نمونه توسعه',
      now,
    );
    insertLedger.run(
      'digital-initial-issuance',
      'digital-supply-network',
      'digital-common',
      'digital-owner',
      'issuance',
      750000,
      null,
      'تخصیص اولیه نمونه توسعه',
      now,
    );

    const insertFinancial = db.prepare(`
      INSERT OR IGNORE INTO financial_entries(
        id, project_id, type, amount, occurred_on, description,
        stakeholder_id, created_at, reversal_of_entry_id
      ) VALUES(?,?,?,?,?,?,?,?,NULL)
    `);
    insertFinancial.run(
      'solar-investment-seed',
      'solar-industrial-park',
      'investment',
      180000000000,
      '2026-06-01',
      'سرمایه اولیه توسعه و مجوز',
      'solar-owner',
      now,
    );
    insertFinancial.run(
      'digital-revenue-seed',
      'digital-supply-network',
      'revenue',
      12000000000,
      '2026-06-15',
      'درآمد قرارداد پایلوت',
      null,
      now,
    );
    insertFinancial.run(
      'digital-expense-seed',
      'digital-supply-network',
      'expense',
      7000000000,
      '2026-06-20',
      'هزینه توسعه و عملیات پایلوت',
      null,
      now,
    );

    const insertGoal = db.prepare(`
      INSERT OR IGNORE INTO project_goals(
        id, project_id, title, description, weight, status,
        due_date, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `);
    insertGoal.run(
      'solar-grid-goal',
      'solar-industrial-park',
      'اتصال فاز نخست به شبکه',
      'تکمیل طراحی، خرید و اتصال ده مگاوات نخست.',
      70,
      'active',
      '2027-12-01',
      now,
      now,
    );
    insertGoal.run(
      'digital-pilot-goal',
      'digital-supply-network',
      'اعتبارسنجی پایلوت بازار',
      'رسیدن به سفارش تکرارشونده در شبکه اولیه.',
      100,
      'active',
      '2027-02-01',
      now,
      now,
    );

    const insertMilestone = db.prepare(`
      INSERT OR IGNORE INTO goal_milestones(
        id, goal_id, title, weight, completed_at, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?)
    `);
    insertMilestone.run(
      'solar-permit-milestone',
      'solar-grid-goal',
      'دریافت موافقت اتصال',
      30,
      now,
      now,
      now,
    );
    insertMilestone.run(
      'solar-procurement-milestone',
      'solar-grid-goal',
      'تأمین تجهیزات فاز نخست',
      70,
      null,
      now,
      now,
    );
    insertMilestone.run(
      'digital-discovery-milestone',
      'digital-pilot-goal',
      'اعتبارسنجی مسئله و فرایند سفارش',
      40,
      now,
      now,
      now,
    );
    insertMilestone.run(
      'digital-repeat-order-milestone',
      'digital-pilot-goal',
      'رسیدن به سفارش تکرارشونده',
      60,
      null,
      now,
      now,
    );

    db.prepare(`
      INSERT OR IGNORE INTO share_offers(
        id, project_id, share_class_id, side, seller_stakeholder_id,
        buyer_stakeholder_id, units, remaining_units, unit_price,
        available_until, status, note, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'digital-open-offer',
      'digital-supply-network',
      'digital-common',
      'sell',
      'digital-owner',
      null,
      50000,
      50000,
      250000,
      '2027-12-31',
      'open',
      'پیشنهاد نمونه برای مشارکت سرمایه‌گذار پایلوت',
      now,
      now,
    );
    db.prepare(`
      INSERT OR IGNORE INTO share_transfers(
        id, project_id, share_class_id, from_stakeholder_id,
        to_stakeholder_id, units, price_amount, status, note,
        decision_note, created_at, updated_at, decided_at, offer_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'digital-pending-transfer',
      'digital-supply-network',
      'digital-common',
      'digital-owner',
      'digital-investor',
      10000,
      2500000000,
      'pending',
      'انتقال نمونه در انتظار تصویب',
      null,
      now,
      now,
      null,
      'digital-open-offer',
    );

    db.prepare(`
      INSERT OR IGNORE INTO project_meetings(
        id, project_id, title, scheduled_at, location, minutes, status,
        created_at, updated_at, public_visible
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      'digital-board-meeting',
      'digital-supply-network',
      'جلسه تصویب پایلوت منطقه‌ای',
      '2026-07-15T08:30:00.000Z',
      'آنلاین',
      'چارچوب پایلوت، بودجه و شاخص‌های موفقیت بررسی شد.',
      'held',
      now,
      now,
      1,
    );
    db.prepare(`
      INSERT OR IGNORE INTO meeting_attendees(
        meeting_id, stakeholder_id, attendance, created_at, updated_at
      ) VALUES(?,?,?,?,?)
    `).run('digital-board-meeting', 'digital-owner', 'present', now, now);
    db.prepare(`
      INSERT OR IGNORE INTO meeting_resolutions(
        id, meeting_id, title, description, status, created_at, updated_at,
        public_visible, decision, decided_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      'digital-pilot-resolution',
      'digital-board-meeting',
      'آغاز پایلوت سه‌ماهه',
      'اجرای پایلوت با سقف بودجه مصوب و گزارش ماهانه.',
      'closed',
      now,
      now,
      1,
      'آغاز پایلوت از مرداد ۱۴۰۵ تصویب شد.',
      now,
    );
    db.prepare(`
      INSERT OR IGNORE INTO resolution_votes(
        id, resolution_id, stakeholder_id, choice, voting_power,
        created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      'digital-owner-pilot-vote',
      'digital-pilot-resolution',
      'digital-owner',
      'yes',
      750000,
      now,
      now,
    );
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
  if (shouldSeedDemo) {
    seedDemo(db);
    seedPortfolioDemos(db);
  }
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
  seedPortfolioDemos,
  bootstrapDraftProject,
};

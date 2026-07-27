import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDatabase, SCHEMA_VERSION, withTransaction } from '../../src/database.js';
import { createPasswordHash } from '../../src/security.js';
import { createStore } from '../../src/store.js';
import { restoreDatabase } from '../../scripts/restore.js';

function legacyDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL,
      location TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE pieces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      target_value TEXT NOT NULL,
      order_no INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    CREATE TABLE interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('view','follow','interest','proposal','commit')),
      created_at TEXT NOT NULL,
      UNIQUE(piece_id, actor_id, action),
      FOREIGN KEY(piece_id) REFERENCES pieces(id)
    );
    CREATE TABLE commitments (
      id TEXT PRIMARY KEY,
      piece_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      note TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(piece_id) REFERENCES pieces(id)
    );
  `);
  const now = '2025-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)')
    .run('legacy', 'پروژه قدیمی', 'زیرعنوان', 'تهران', 'خلاصه', now);
  db.prepare('INSERT INTO pieces VALUES(?,?,?,?,?,?,?)')
    .run('piece', 'legacy', 'نیاز', 'شرح نیاز', 'دسته', 'هدف', 1);
  db.prepare('INSERT INTO interactions(piece_id,actor_id,action,created_at) VALUES(?,?,?,?)')
    .run('piece', 'actor', 'follow', now);
  db.prepare('INSERT INTO interactions(piece_id,actor_id,action,created_at) VALUES(?,?,?,?)')
    .run('piece', 'viewer', 'view', now);
  const insertCommitment = db.prepare(
    'INSERT INTO commitments VALUES(?,?,?,?,?,?,?)',
  );
  insertCommitment.run('c1', 'piece', 'a1', 'متقاضی یک', 'آورده یک', 'approved', now);
  insertCommitment.run('c2', 'piece', 'a2', 'متقاضی دو', 'آورده دو', 'approved', now);
  db.close();
}

test('legacy schema migrates without deleting source data and preserves one accepted proposal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-migration-'));
  const path = join(directory, 'legacy.db');
  legacyDatabase(path);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: path,
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  });
  const db = openDatabase(config, { seed: false });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pieces').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM commitments').get().c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM needs').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM proposals').get().c, 2);
    assert.equal(
      db.prepare('SELECT status FROM projects WHERE id=?').get('legacy').status,
      'published',
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS c FROM proposals WHERE status='accepted'`).get().c,
      1,
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS c FROM proposals WHERE status='negotiating'`).get().c,
      1,
    );
    const interaction = db.prepare(
      `SELECT following, interested FROM viewer_interactions WHERE visitor_id='actor'`,
    ).get();
    assert.equal(interaction.following, 1);
    assert.equal(interaction.interested, 0);
    const legacyView = db.prepare(`
      SELECT first_viewed_at FROM viewer_interactions WHERE visitor_id='viewer'
    `).get();
    assert.equal(legacyView.first_viewed_at, '2025-01-01T00:00:00.000Z');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 17 preserves proposal history while enabling API-key attribution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-proposal-event-v18-'));
  const path = join(directory, 'schema-17.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: path,
    SESSION_SECRET: 'proposal-event-migration-secret-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'proposal-event-admin-password',
  });
  let db;
  try {
    db = openDatabase(config, { seed: true });
    const needId = db.prepare(
      'SELECT id FROM needs ORDER BY created_at,id LIMIT 1',
    ).get().id;
    db.prepare(`
      INSERT INTO proposals(
        id,need_id,visitor_id,applicant_name,mobile,email,contribution,
        availability,notes,consent,status,tracking_token_hash,created_at,updated_at
      ) VALUES(?,?,?,?,?,NULL,?,NULL,NULL,1,'new',?,?,?)
    `).run(
      'proposal-event-v18-test',
      needId,
      'proposal-event-v18-visitor',
      'Migration applicant',
      '09123456789',
      'Migration contribution',
      'proposal-event-v18-tracking-hash',
      '2026-07-24T10:00:00.000Z',
      '2026-07-24T10:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO proposal_events(
        proposal_id,actor_type,actor_id,event_type,from_status,to_status,
        message,visibility,created_at
      ) VALUES(?,'admin','legacy-admin','created',NULL,'new',NULL,'admin',?)
    `).run('proposal-event-v18-test', '2026-07-24T10:00:00.000Z');
    const before = db.prepare(
      'SELECT COUNT(*) AS count FROM proposal_events',
    ).get().count;
    assert.ok(before > 0);
    db.close();
    db = null;

    const schema17 = new DatabaseSync(path);
    schema17.exec(`
      PRAGMA foreign_keys=OFF;
      DROP INDEX IF EXISTS proposal_events_proposal_created;
      ALTER TABLE proposal_events RENAME TO proposal_events_v18_source;
      CREATE TABLE proposal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        actor_type TEXT NOT NULL
          CHECK(actor_type IN ('applicant','admin','system')),
        actor_id TEXT,
        event_type TEXT NOT NULL
          CHECK(event_type IN (
            'created','status_changed','internal_note','decision_message','migrated'
          )),
        from_status TEXT,
        to_status TEXT,
        message TEXT,
        visibility TEXT NOT NULL DEFAULT 'applicant'
          CHECK(visibility IN ('applicant','admin')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
      );
      INSERT INTO proposal_events(
        id,proposal_id,actor_type,actor_id,event_type,from_status,to_status,
        message,visibility,created_at
      )
      SELECT
        id,proposal_id,actor_type,actor_id,event_type,from_status,to_status,
        message,visibility,created_at
      FROM proposal_events_v18_source;
      DROP TABLE proposal_events_v18_source;
      CREATE INDEX proposal_events_proposal_created
        ON proposal_events(proposal_id, created_at, id);
      PRAGMA user_version=17;
    `);
    schema17.close();

    db = openDatabase(config, { seed: false, bootstrap: false });
    assert.equal(
      db.prepare('PRAGMA user_version').get().user_version,
      SCHEMA_VERSION,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM proposal_events').get().count,
      before,
    );
    const proposalId = db.prepare(
      'SELECT id FROM proposals ORDER BY created_at,id LIMIT 1',
    ).get().id;
    assert.doesNotThrow(() => db.prepare(`
      INSERT INTO proposal_events(
        proposal_id,actor_type,actor_id,event_type,from_status,to_status,
        message,visibility,created_at
      ) VALUES(?,'api_key',?,'internal_note',NULL,NULL,?,'admin',?)
    `).run(
      proposalId,
      'api-key-migration-test',
      'API-key attribution preserved',
      '2026-07-24T12:00:00.000Z',
    ));
    const stored = db.prepare(`
      SELECT actor_type,actor_id
      FROM proposal_events
      WHERE actor_id='api-key-migration-test'
    `).get();
    assert.equal(stored.actor_type, 'api_key');
    assert.equal(stored.actor_id, 'api-key-migration-test');
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('transaction helper rolls back all writes when a step fails', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  });
  const db = openDatabase(config);
  try {
    const before = db.prepare('SELECT COUNT(*) AS c FROM needs').get().c;
    assert.throws(() =>
      withTransaction(db, () => {
        db.prepare(`
          INSERT INTO needs(
            id,project_id,title,description,category,target_value,
            expectations,order_no,created_at,updated_at
          ) VALUES('temporary','greenhouse-20ha','عنوان','شرح','دسته','هدف','',99,'x','x')
        `).run();
        throw new Error('stop');
      }),
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM needs').get().c, before);
  } finally {
    db.close();
  }
});

test('production bootstraps a private blank project instead of publishing demo data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-production-bootstrap-'));
  const path = join(directory, 'production.db');
  const config = loadConfig({
    NODE_ENV: 'production',
    DATABASE_PATH: path,
    PUBLIC_ORIGIN: 'https://example.test',
    SESSION_SECRET: 'production-session-secret-longer-than-thirty-two-characters',
    AUTH_ENCRYPTION_KEY: 'production-encryption-key-longer-than-thirty-two-characters',
    AUDIT_HMAC_KEY: 'production-audit-hmac-key-longer-than-thirty-two-characters',
    ADMIN_PASSWORD_HASH: createPasswordHash('production-admin-password'),
  });
  const db = openDatabase(config);
  try {
    const project = db.prepare(
      'SELECT slug, status, active FROM projects',
    ).get();
    assert.deepEqual({ ...project }, {
      slug: 'project-room',
      status: 'draft',
      active: 0,
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM needs').get().count, 0);
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM projects WHERE slug='greenhouse-20ha'`).get().count,
      0,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('idempotent replay survives visitor and session-secret rotation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-idempotency-rotation-'));
  const path = join(directory, 'rotation.db');
  const common = {
    NODE_ENV: 'test',
    DATABASE_PATH: path,
    PUBLIC_ORIGIN: 'http://localhost:3000',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  };
  const proposal = {
    applicantName: 'متقاضی پایدار',
    mobile: '09123456789',
    email: null,
    contribution: 'شرح کامل و روشن آورده برای آزمون پایداری بازپخش پیشنهاد.',
    availability: null,
    notes: null,
    consent: true,
  };
  const key = '66666666-6666-4666-8666-666666666666';
  let first;
  const firstDb = openDatabase(loadConfig({
    ...common,
    SESSION_SECRET: 'first-session-secret-longer-than-thirty-two-characters',
  }));
  try {
    first = createStore(firstDb, { publicOrigin: common.PUBLIC_ORIGIN })
      .createProposal('land', 'first-visitor', key, proposal);
    const tokenWithoutProposalEntropy = createHash('sha256')
      .update('hamkari:proposal-tracking:v1')
      .update('\0')
      .update('land')
      .update('\0')
      .update(key)
      .digest('base64url');
    assert.notEqual(
      first.proposal.trackingToken,
      tokenWithoutProposalEntropy,
      'tracking token must include server-generated proposal entropy',
    );
  } finally {
    firstDb.close();
  }

  const secondDb = openDatabase(loadConfig({
    ...common,
    SESSION_SECRET: 'second-session-secret-longer-than-thirty-two-characters',
  }));
  try {
    const store = createStore(secondDb, { publicOrigin: common.PUBLIC_ORIGIN });
    const replay = store.createProposal('land', 'rotated-visitor', key, proposal);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.proposal.id, first.proposal.id);
    assert.equal(replay.proposal.trackingToken, first.proposal.trackingToken);
    assert.equal(
      store.trackProposal(replay.proposal.trackingToken).proposal.statusKey,
      'new',
    );
    assert.equal(
      secondDb.prepare('SELECT COUNT(*) AS count FROM proposals').get().count,
      1,
    );
  } finally {
    secondDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backup script creates a consistent non-overwriting SQLite snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-backup-'));
  const source = join(directory, 'source.db');
  const destination = join(directory, 'backup.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: source,
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  });
  openDatabase(config).close();
  if (process.platform !== 'win32') {
    assert.equal(statSync(source).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
  const root = fileURLToPath(new URL('../..', import.meta.url));
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/backup.js', destination],
      {
        cwd: root,
        env: { ...process.env, DATABASE_PATH: source },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const created = JSON.parse(result.stdout.trim());
    assert.equal(created.sizeBytes, statSync(destination).size);
    assert.match(created.sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      created.sha256,
      createHash('sha256')
        .update(readFileSync(destination))
        .digest('hex'),
    );
    const backup = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(backup.prepare('SELECT COUNT(*) AS c FROM projects').get().c, 3);
    } finally {
      backup.close();
    }
    if (process.platform !== 'win32') {
      assert.equal(statSync(destination).mode & 0o777, 0o600);
    }
    const overwrite = spawnSync(
      process.execPath,
      ['scripts/backup.js', destination],
      {
        cwd: root,
        env: { ...process.env, DATABASE_PATH: source },
        encoding: 'utf8',
      },
    );
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /Refusing to overwrite/);
    const defaultDirectory = join(directory, 'default-backups');
    const defaultResult = spawnSync(
      process.execPath,
      ['scripts/backup.js'],
      {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_PATH: source,
          BACKUP_DIR: defaultDirectory,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    const output = JSON.parse(defaultResult.stdout.trim());
    assert.equal(output.backup.startsWith(defaultDirectory), true);

    const dataDirectory = join(directory, 'configured-data');
    const dataSourceConfig = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDirectory,
      SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
      ADMIN_DEV_PASSWORD: 'test-admin-password',
    });
    openDatabase(dataSourceConfig).close();
    const dataDirectoryBackup = join(directory, 'data-dir-backups');
    const dataDirectoryEnv = {
      ...process.env,
      DATA_DIR: dataDirectory,
      BACKUP_DIR: dataDirectoryBackup,
    };
    delete dataDirectoryEnv.DATABASE_PATH;
    const dataDirectoryResult = spawnSync(
      process.execPath,
      ['scripts/backup.js'],
      { cwd: root, env: dataDirectoryEnv, encoding: 'utf8' },
    );
    assert.equal(dataDirectoryResult.status, 0, dataDirectoryResult.stderr);
    const dataDirectoryOutput = JSON.parse(dataDirectoryResult.stdout.trim());
    assert.equal(dataDirectoryOutput.source, join(dataDirectory, 'hamkari.db'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restore script requires explicit confirmation and preserves a rollback database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-restore-'));
  const source = join(directory, 'verified-backup.db');
  const target = join(directory, 'live.db');
  const environment = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  };
  const sourceDb = openDatabase(loadConfig({
    ...environment,
    DATABASE_PATH: source,
  }));
  const sourceMarker = sourceDb.prepare('UPDATE projects SET title=? WHERE id=?')
    .run('restored-marker', 'greenhouse-20ha');
  assert.equal(sourceMarker.changes, 1, 'backup sentinel project must exist');
  sourceDb.close();
  const targetDb = openDatabase(loadConfig({
    ...environment,
    DATABASE_PATH: target,
  }));
  const targetMarker = targetDb.prepare('UPDATE projects SET title=? WHERE id=?')
    .run('rollback-marker', 'greenhouse-20ha');
  assert.equal(targetMarker.changes, 1, 'live sentinel project must exist');
  targetDb.close();

  const root = fileURLToPath(new URL('../..', import.meta.url));
  try {
    const refused = spawnSync(
      process.execPath,
      ['scripts/restore.js', source],
      {
        cwd: root,
        env: { ...process.env, DATABASE_PATH: target },
        encoding: 'utf8',
      },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Restore refused/);

    const restored = spawnSync(
      process.execPath,
      ['scripts/restore.js', source],
      {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_PATH: target,
          RESTORE_CONFIRM: 'I_UNDERSTAND_REPLACE_DATABASE',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(restored.status, 0, restored.stderr);
    const output = JSON.parse(restored.stdout.trim());
    assert.equal(output.database, target);
    assert.ok(output.rollback);
    assert.equal(output.sourceSchemaVersion, SCHEMA_VERSION);
    assert.equal(output.restoredSchemaVersion, SCHEMA_VERSION);

    const current = new DatabaseSync(target, { readOnly: true });
    const rollback = new DatabaseSync(output.rollback, { readOnly: true });
    try {
      assert.equal(
        current.prepare('SELECT title FROM projects WHERE id=?')
          .get('greenhouse-20ha').title,
        'restored-marker',
      );
      assert.equal(
        rollback.prepare('SELECT title FROM projects WHERE id=?')
          .get('greenhouse-20ha').title,
        'rollback-marker',
      );
      assert.equal(current.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(rollback.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      current.close();
      rollback.close();
    }

    const unrelated = join(directory, 'unrelated-current-version.db');
    const unrelatedDb = new DatabaseSync(unrelated);
    unrelatedDb.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    unrelatedDb.close();
    const unrelatedResult = spawnSync(
      process.execPath,
      ['scripts/restore.js', unrelated],
      {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_PATH: target,
          RESTORE_CONFIRM: 'I_UNDERSTAND_REPLACE_DATABASE',
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(unrelatedResult.status, 0);
    assert.match(unrelatedResult.stderr, /not a recognizable Hamkari database/);

    const future = join(directory, 'future-version.db');
    const futureDb = new DatabaseSync(future);
    futureDb.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
    futureDb.close();
    const futureResult = spawnSync(
      process.execPath,
      ['scripts/restore.js', future],
      {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_PATH: target,
          RESTORE_CONFIRM: 'I_UNDERSTAND_REPLACE_DATABASE',
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(futureResult.status, 0);
    assert.match(futureResult.stderr, /does not match required version/);

    const beforeFailedSwap = new DatabaseSync(target);
    const failedSwapMarker = beforeFailedSwap
      .prepare('UPDATE projects SET title=? WHERE id=?')
      .run('pre-failed-swap-marker', 'greenhouse-20ha');
    assert.equal(failedSwapMarker.changes, 1);
    beforeFailedSwap.close();
    assert.throws(
      () => restoreDatabase({
        sourcePath: source,
        targetPath: target,
        afterSwap: ({ targetPath }) => rmSync(targetPath, { force: true }),
      }),
    );
    const automaticallyRolledBack = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(
        automaticallyRolledBack.prepare('SELECT title FROM projects WHERE id=?')
          .get('greenhouse-20ha').title,
        'pre-failed-swap-marker',
      );
      assert.equal(
        automaticallyRolledBack.prepare('PRAGMA user_version').get().user_version,
        SCHEMA_VERSION,
      );
    } finally {
      automaticallyRolledBack.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

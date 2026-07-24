import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
    const backup = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(backup.prepare('SELECT COUNT(*) AS c FROM projects').get().c, 1);
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

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvFile } from 'node:process';
import { SCHEMA_VERSION } from '../src/database.js';

const CONFIRMATION_PHRASE = 'I_UNDERSTAND_REPLACE_DATABASE';
const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REQUIRED_TABLE_COLUMNS = Object.freeze({
  projects: ['id', 'slug', 'organization_id'],
  needs: ['id', 'project_id', 'archived_at'],
  proposals: ['id', 'need_id', 'status'],
  organizations: ['id', 'slug'],
  users: ['id', 'email'],
  journal_entries: ['id', 'status'],
  enterprise_audit_events: ['id', 'previous_hash', 'event_hash'],
});

function quotedIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function removeDatabaseFiles(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(candidate, { force: true });
  }
}

function moveSidecars(source, destination) {
  for (const suffix of ['-wal', '-shm']) {
    const sourceSidecar = `${source}${suffix}`;
    if (existsSync(sourceSidecar)) {
      renameSync(sourceSidecar, `${destination}${suffix}`);
    }
  }
}

export function verifyHamkariDatabase(path, label = 'Database') {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 10_000 });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') {
      throw new Error(`${label} integrity check failed: ${integrity}`);
    }
    const schemaVersion = database.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `${label} schema version ${schemaVersion} does not match required version ${SCHEMA_VERSION}.`,
      );
    }
    for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
      const exists = database.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type='table' AND name=?
      `).get(table);
      if (!exists) {
        throw new Error(`${label} is not a recognizable Hamkari database (missing ${table}).`);
      }
      const columns = new Set(
        database.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`)
          .all()
          .map((row) => row.name),
      );
      const missing = requiredColumns.filter((column) => !columns.has(column));
      if (missing.length) {
        throw new Error(
          `${label} is not a recognizable Hamkari database ` +
          `(missing ${table}.${missing.join(`, ${table}.`)}).`,
        );
      }
    }
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length) {
      throw new Error(
        `${label} foreign key check failed (${foreignKeyViolations.length} violations).`,
      );
    }
    return Object.freeze({ schemaVersion });
  } finally {
    database.close();
  }
}

export function restoreDatabase({
  sourcePath,
  targetPath,
  afterSwap,
  clock = () => new Date(),
}) {
  if (!existsSync(sourcePath)) {
    throw new Error(`Restore source does not exist: ${sourcePath}`);
  }
  if (sourcePath.toLowerCase() === targetPath.toLowerCase()) {
    throw new Error('Restore source must be different from the live database.');
  }

  const source = verifyHamkariDatabase(sourcePath, 'Restore source');
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dirname(targetPath), 0o700);
  const operationId = randomUUID();
  const stagingPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.restore-${operationId}.tmp`,
  );
  const timestamp = clock().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const rollbackPath = join(
    dirname(targetPath),
    `${basename(targetPath, '.db')}-before-restore-${timestamp}-${operationId}.db`,
  );
  let liveMoved = false;
  let stagedInstalled = false;

  try {
    copyFileSync(sourcePath, stagingPath);
    if (process.platform !== 'win32') chmodSync(stagingPath, 0o600);
    verifyHamkariDatabase(stagingPath, 'Staged restore');

    if (existsSync(targetPath)) {
      const live = new DatabaseSync(targetPath, { timeout: 10_000 });
      try {
        live.exec('PRAGMA busy_timeout=10000');
        live.exec('BEGIN EXCLUSIVE');
        const integrity = live.prepare('PRAGMA integrity_check').get().integrity_check;
        if (integrity !== 'ok') {
          throw new Error(`Live database integrity check failed: ${integrity}`);
        }
        live.exec('COMMIT');
        live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) {
        try {
          live.exec('ROLLBACK');
        } catch {
          // Preserve the original failure.
        }
        throw error;
      } finally {
        live.close();
      }
      renameSync(targetPath, rollbackPath);
      liveMoved = true;
      moveSidecars(targetPath, rollbackPath);
    }

    renameSync(stagingPath, targetPath);
    stagedInstalled = true;
    if (process.platform !== 'win32') chmodSync(targetPath, 0o600);
    afterSwap?.({ sourcePath, targetPath, rollbackPath });
    const restored = verifyHamkariDatabase(targetPath, 'Restored database');
    return Object.freeze({
      status: 'ok',
      restoredFrom: sourcePath,
      database: targetPath,
      rollback: liveMoved ? rollbackPath : null,
      sourceSchemaVersion: source.schemaVersion,
      restoredSchemaVersion: restored.schemaVersion,
      restoredAt: clock().toISOString(),
    });
  } catch (error) {
    rmSync(stagingPath, { force: true });
    if (stagedInstalled) removeDatabaseFiles(targetPath);
    if (liveMoved && existsSync(rollbackPath)) {
      renameSync(rollbackPath, targetPath);
      moveSidecars(rollbackPath, targetPath);
      if (process.platform !== 'win32') chmodSync(targetPath, 0o600);
    }
    throw error;
  }
}

function resolveRuntimePaths(sourceValue) {
  const dataValue = process.env.DATA_DIR || join(ROOT_DIR, 'data');
  const dataDirectory = isAbsolute(dataValue)
    ? resolve(dataValue)
    : resolve(ROOT_DIR, dataValue);
  const targetValue = process.env.DATABASE_PATH || join(dataDirectory, 'hamkari.db');
  return {
    sourcePath: isAbsolute(sourceValue)
      ? resolve(sourceValue)
      : resolve(process.cwd(), sourceValue),
    targetPath: isAbsolute(targetValue)
      ? resolve(targetValue)
      : resolve(ROOT_DIR, targetValue),
  };
}

function runCli() {
  const envFile = join(ROOT_DIR, '.env');
  if (existsSync(envFile)) loadEnvFile(envFile);
  const sourceValue = process.argv[2] || process.env.RESTORE_SOURCE || '';
  if (!sourceValue) {
    console.error(
      'Usage: RESTORE_CONFIRM=I_UNDERSTAND_REPLACE_DATABASE ' +
      'npm run restore -- /absolute/path/to/backup.db',
    );
    process.exitCode = 1;
    return;
  }
  if (process.env.RESTORE_CONFIRM !== CONFIRMATION_PHRASE) {
    console.error(
      `Restore refused. Set RESTORE_CONFIRM=${CONFIRMATION_PHRASE} after stopping the service.`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(restoreDatabase(resolveRuntimePaths(sourceValue))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (executedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  runCli();
}

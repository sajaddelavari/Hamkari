import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvFile } from 'node:process';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const envFile = join(rootDir, '.env');
if (existsSync(envFile)) loadEnvFile(envFile);
const dataDirectoryValue = process.env.DATA_DIR || join(rootDir, 'data');
const dataDirectory = isAbsolute(dataDirectoryValue)
  ? resolve(dataDirectoryValue)
  : resolve(rootDir, dataDirectoryValue);
const sourceValue = process.env.DATABASE_PATH || join(dataDirectory, 'hamkari.db');
const sourcePath = isAbsolute(sourceValue) ? resolve(sourceValue) : resolve(rootDir, sourceValue);
const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
const backupDirectoryValue = process.env.BACKUP_DIR || join(rootDir, 'backups');
const backupDirectory = isAbsolute(backupDirectoryValue)
  ? resolve(backupDirectoryValue)
  : resolve(rootDir, backupDirectoryValue);
const destinationValue =
  process.argv[2] || join(backupDirectory, `hamkari-${timestamp}.db`);
const destinationPath = isAbsolute(destinationValue)
  ? resolve(destinationValue)
  : resolve(process.cwd(), destinationValue);

if (!existsSync(sourcePath)) {
  console.error(`Database does not exist: ${sourcePath}`);
  process.exitCode = 1;
} else if (sourcePath.toLowerCase() === destinationPath.toLowerCase()) {
  console.error('Backup destination must be different from the live database.');
  process.exitCode = 1;
} else if (existsSync(destinationPath)) {
  console.error(`Refusing to overwrite an existing backup: ${destinationPath}`);
  process.exitCode = 1;
} else {
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dirname(destinationPath), 0o700);
  const source = new DatabaseSync(sourcePath, { timeout: 10_000 });
  try {
    source.exec('PRAGMA busy_timeout=10000');
    const escapedDestination = destinationPath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escapedDestination}'`);
  } finally {
    source.close();
  }
  if (process.platform !== 'win32') chmodSync(destinationPath, 0o600);

  const backup = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    const integrity = backup.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') {
      throw new Error(`Backup integrity check failed: ${integrity}`);
    }
  } finally {
    backup.close();
  }
  console.log(JSON.stringify({
    status: 'ok',
    source: sourcePath,
    backup: destinationPath,
    createdAt: new Date().toISOString(),
  }));
}

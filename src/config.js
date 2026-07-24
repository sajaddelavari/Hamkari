import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VALID_ENVIRONMENTS = new Set(['development', 'test', 'production']);

function integer(value, fallback, name, minimum, maximum) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function absolutePath(value, fallback, rootDir) {
  const selected = value?.trim() || fallback;
  if (selected === ':memory:') return selected;
  return isAbsolute(selected) ? resolve(selected) : resolve(rootDir, selected);
}

function publicOrigin(value, port) {
  const selected = value?.trim() || `http://localhost:${port}`;
  let url;
  try {
    url = new URL(selected);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a valid http(s) origin.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('PUBLIC_ORIGIN must be a valid http(s) origin.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_ORIGIN must not include a path, query, or fragment.');
  }
  return url.origin;
}

function trustedProxyCidrs(value, nodeEnv) {
  const selected = String(value || '').trim().toLowerCase();
  if (!selected || ['false', '0', 'no'].includes(selected)) return [];
  if (['true', '1', 'yes'].includes(selected)) {
    if (nodeEnv === 'production') {
      throw new Error(
        'TRUST_PROXY must list trusted proxy IP/CIDR ranges in production; boolean true is unsafe.',
      );
    }
    return ['127.0.0.0/8', '::1/128'];
  }
  const entries = selected.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const [address, prefixText, extra] = entry.split('/');
    const version = isIP(address);
    const maximum = version === 4 ? 32 : version === 6 ? 128 : -1;
    const prefix = prefixText === undefined ? maximum : Number(prefixText);
    if (extra !== undefined || maximum < 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error('TRUST_PROXY must be false or a comma-separated list of IP/CIDR ranges.');
    }
  }
  return entries;
}

/**
 * Loads and validates runtime configuration. Tests may pass a plain object instead
 * of mutating process.env.
 */
export function loadConfig(env = process.env, options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
  if (!VALID_ENVIRONMENTS.has(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }

  const port = integer(env.PORT, 3000, 'PORT', 1, 65_535);
  const host = String(
    env.HOST || (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1'),
  ).trim();
  if (!host || /[\s/]/.test(host)) throw new Error('HOST is invalid.');

  const dataDir = absolutePath(env.DATA_DIR, join(rootDir, 'data'), rootDir);
  const databasePath = absolutePath(
    env.DATABASE_PATH,
    join(dataDir, 'hamkari.db'),
    rootDir,
  );

  const warnings = [];
  let sessionSecret = String(env.SESSION_SECRET || '');
  if (!sessionSecret) {
    if (nodeEnv === 'production') {
      throw new Error('SESSION_SECRET is required in production (minimum 32 characters).');
    }
    // A process-local random fallback is safe from guessing. Admin sessions are
    // intentionally invalidated after a development restart.
    sessionSecret = randomBytes(48).toString('base64url');
    if (nodeEnv !== 'test') {
      warnings.push('SESSION_SECRET is unset; using an ephemeral development secret.');
    }
  }
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }

  const selectedPublicOrigin = publicOrigin(env.PUBLIC_ORIGIN, port);
  if (nodeEnv === 'production' && new URL(selectedPublicOrigin).protocol !== 'https:') {
    throw new Error('PUBLIC_ORIGIN must use https in production.');
  }

  let adminPasswordHash = String(env.ADMIN_PASSWORD_HASH || '').trim();
  let developmentAdminPassword = null;
  if (!adminPasswordHash) {
    if (nodeEnv === 'production') {
      throw new Error('ADMIN_PASSWORD_HASH is required in production.');
    }
    const explicitDevelopmentPassword = String(env.ADMIN_DEV_PASSWORD || '');
    developmentAdminPassword = explicitDevelopmentPassword ||
      randomBytes(18).toString('base64url');
    if (developmentAdminPassword.length < 12) {
      throw new Error('ADMIN_DEV_PASSWORD must contain at least 12 characters.');
    }
    if (nodeEnv !== 'test') {
      warnings.push(
        explicitDevelopmentPassword
          ? 'ADMIN_PASSWORD_HASH is unset; development login uses the explicit ADMIN_DEV_PASSWORD.'
          : `ADMIN_PASSWORD_HASH is unset; ephemeral development admin password: ${developmentAdminPassword}`,
      );
    }
  } else if (
    !/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]{11,}\$[A-Za-z0-9_-]{22,}$/.test(
      adminPasswordHash,
    )
  ) {
    throw new Error(
      'ADMIN_PASSWORD_HASH must use the scrypt$N$r$p$salt$key encoded format.',
    );
  }

  return Object.freeze({
    rootDir,
    publicDir: resolve(rootDir, 'public'),
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    port,
    host,
    dataDir,
    databasePath,
    publicOrigin: selectedPublicOrigin,
    sessionSecret,
    adminPasswordHash,
    developmentAdminPassword,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    payloadLimitBytes: 64 * 1024,
    sqliteBusyTimeoutMs: integer(
      env.SQLITE_BUSY_TIMEOUT_MS,
      5_000,
      'SQLITE_BUSY_TIMEOUT_MS',
      100,
      60_000,
    ),
    trustedProxyCidrs: Object.freeze(trustedProxyCidrs(env.TRUST_PROXY, nodeEnv)),
    warnings,
    databaseDirectory: dirname(databasePath),
  });
}

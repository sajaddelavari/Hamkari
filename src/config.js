import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VALID_ENVIRONMENTS = new Set(['development', 'test', 'production']);
const PRODUCTION_PLACEHOLDER_SECRET =
  /(replace|change[-_ ]?me|placeholder|example|dummy|sample|your[-_ ]?(?:secret|key)|todo|insert[-_ ]?(?:random|secret|key))/i;

function integer(value, fallback, name, minimum, maximum) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function booleanValue(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const selected = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(selected)) return true;
  if (['0', 'false', 'no', 'off'].includes(selected)) return false;
  throw new Error(`${name} must be true or false.`);
}

function secretValue(env, name, fallback, nodeEnv) {
  const provided = Object.hasOwn(env, name) && String(env[name] || '').length > 0;
  if (nodeEnv === 'production' && !provided) {
    throw new Error(`${name} is required in production and must be an independent secret.`);
  }
  const selected = String(provided ? env[name] : fallback);
  if (selected.length < 32) {
    throw new Error(`${name} must contain at least 32 characters.`);
  }
  if (
    nodeEnv === 'production' &&
    (PRODUCTION_PLACEHOLDER_SECRET.test(selected) || /^(.)\1{31,}$/.test(selected))
  ) {
    throw new Error(`${name} must not use a placeholder value in production.`);
  }
  return selected;
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
  if (nodeEnv === 'production' && databasePath === ':memory:') {
    throw new Error('DATABASE_PATH=:memory: is not allowed in production.');
  }
  const uploadDir = absolutePath(
    env.UPLOAD_DIR,
    join(dataDir, 'uploads'),
    rootDir,
  );

  const warnings = [];
  let sessionSecret = String(env.SESSION_SECRET || '');
  if (!sessionSecret && nodeEnv !== 'production') {
    // A process-local random fallback is safe from guessing. Admin sessions are
    // intentionally invalidated after a development restart.
    sessionSecret = randomBytes(48).toString('base64url');
    if (nodeEnv !== 'test') {
      warnings.push('SESSION_SECRET is unset; using an ephemeral development secret.');
    }
  }
  sessionSecret = secretValue(env, 'SESSION_SECRET', sessionSecret, nodeEnv);
  const authEncryptionKey = secretValue(
    env,
    'AUTH_ENCRYPTION_KEY',
    sessionSecret,
    nodeEnv,
  );
  const auditHmacKey = secretValue(
    env,
    'AUDIT_HMAC_KEY',
    authEncryptionKey,
    nodeEnv,
  );
  if (
    nodeEnv === 'production' &&
    new Set([sessionSecret, authEncryptionKey, auditHmacKey]).size !== 3
  ) {
    throw new Error(
      'SESSION_SECRET, AUTH_ENCRYPTION_KEY, and AUDIT_HMAC_KEY must be independent in production.',
    );
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
    } else {
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

  const paymentProviderMode = String(
    env.PAYMENT_PROVIDER_MODE || 'manual',
  ).trim().toLowerCase();
  if (!['manual', 'sandbox'].includes(paymentProviderMode)) {
    throw new Error('PAYMENT_PROVIDER_MODE must be manual or sandbox.');
  }
  if (nodeEnv === 'production' && paymentProviderMode !== 'manual') {
    throw new Error(
      'PAYMENT_PROVIDER_MODE must be manual in production until a verified live adapter is installed.',
    );
  }
  const distributionKycRequired = booleanValue(
    env.DISTRIBUTION_KYC_REQUIRED,
    true,
    'DISTRIBUTION_KYC_REQUIRED',
  );
  if (nodeEnv === 'production' && !distributionKycRequired) {
    throw new Error('DISTRIBUTION_KYC_REQUIRED cannot be disabled in production.');
  }
  const notificationProvider = String(
    env.NOTIFICATION_PROVIDER || 'manual',
  ).trim().toLowerCase();
  if (!['manual', 'sandbox'].includes(notificationProvider)) {
    throw new Error('NOTIFICATION_PROVIDER must be manual or sandbox.');
  }
  if (nodeEnv === 'production' && notificationProvider !== 'manual') {
    throw new Error(
      'NOTIFICATION_PROVIDER must be manual in production until a verified live adapter is installed.',
    );
  }
  const documentProjectQuotaBytes = integer(
    env.DOCUMENT_PROJECT_QUOTA_BYTES,
    256 * 1024 * 1024,
    'DOCUMENT_PROJECT_QUOTA_BYTES',
    1024 * 1024,
    1024 * 1024 * 1024 * 1024,
  );
  const documentOrganizationQuotaBytes = integer(
    env.DOCUMENT_ORGANIZATION_QUOTA_BYTES,
    1024 * 1024 * 1024,
    'DOCUMENT_ORGANIZATION_QUOTA_BYTES',
    1024 * 1024,
    1024 * 1024 * 1024 * 1024,
  );
  if (documentOrganizationQuotaBytes < documentProjectQuotaBytes) {
    throw new Error(
      'DOCUMENT_ORGANIZATION_QUOTA_BYTES must be greater than or equal to DOCUMENT_PROJECT_QUOTA_BYTES.',
    );
  }
  const documentMaxVersions = integer(
    env.DOCUMENT_MAX_VERSIONS,
    100,
    'DOCUMENT_MAX_VERSIONS',
    1,
    10_000,
  );
  const documentUploadsPerHour = integer(
    env.DOCUMENT_UPLOADS_PER_HOUR,
    30,
    'DOCUMENT_UPLOADS_PER_HOUR',
    1,
    100_000,
  );

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
    uploadDir,
    publicOrigin: selectedPublicOrigin,
    sessionSecret,
    authEncryptionKey,
    auditHmacKey,
    adminPasswordHash,
    developmentAdminPassword,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    payloadLimitBytes: 64 * 1024,
    uploadLimitBytes: integer(
      env.UPLOAD_LIMIT_BYTES,
      5 * 1024 * 1024,
      'UPLOAD_LIMIT_BYTES',
      1024,
      25 * 1024 * 1024,
    ),
    notificationProvider,
    paymentProviderMode,
    distributionKycRequired,
    documentProjectQuotaBytes,
    documentOrganizationQuotaBytes,
    documentMaxVersions,
    documentUploadsPerHour,
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

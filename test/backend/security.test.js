import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MemoryRateLimiter } from '../../src/rate-limit.js';
import {
  createPasswordHash,
  createSignedVisitorCookie,
  normalizeIranMobile,
  verifyPassword,
  verifySignedVisitorCookie,
} from '../../src/security.js';
import { loadConfig } from '../../src/config.js';
import { clientIp, matchesDeclaredFileType } from '../../src/http.js';

function minimalZip(entryNames) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const entryName of entryNames) {
    const filename = Buffer.from(entryName, 'utf8');
    const content = Buffer.from('<xml/>', 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const localRecord = Buffer.concat([local, filename, content]);
    localRecords.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([central, filename]));
    localOffset += localRecord.length;
  }
  const localData = Buffer.concat(localRecords);
  const centralData = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entryNames.length, 8);
  eocd.writeUInt16LE(entryNames.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, eocd]);
}

const validProductionSecrets = {
  SESSION_SECRET: 'Pd8z7Cu3vwAR9k25mN4TqxY6fJeB2sKL1GHoX5ai',
  AUTH_ENCRYPTION_KEY: 'ys62QVpFhmA9N8xJc3Kg5Lw4RteZ7BuD1Sd0MXqi',
  AUDIT_HMAC_KEY: 'bP4kZ7Jm2YdT8HxW3nV6Qa9fC1sL5RgU0EeiKoNA',
};
const productionDatabasePath = join(tmpdir(), 'hamkari-config-production.db');

test('Iran mobile normalization accepts local and international Persian-digit forms', () => {
  assert.equal(normalizeIranMobile('۰۹۱۲ ۳۴۵ ۶۷۸۹'), '09123456789');
  assert.equal(normalizeIranMobile('+98 (912) 345-6789'), '09123456789');
  assert.equal(normalizeIranMobile('00989123456789'), '09123456789');
  assert.equal(normalizeIranMobile('1234'), null);
});

test('scrypt password hashes verify without storing the password', () => {
  const encoded = createPasswordHash('a-long-secret-password');
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes('a-long-secret-password'), false);
  assert.equal(verifyPassword('a-long-secret-password', encoded), true);
  assert.equal(verifyPassword('wrong-password', encoded), false);
  assert.equal(verifyPassword('anything', 'invalid'), false);
});

test('visitor cookie signature rejects tampering', () => {
  const secret = 'a-secret-value-with-more-than-thirty-two-characters';
  const created = createSignedVisitorCookie(secret);
  assert.equal(
    verifySignedVisitorCookie(created.cookieValue, secret),
    created.visitorId,
  );
  assert.equal(
    verifySignedVisitorCookie(`${created.cookieValue}x`, secret),
    null,
  );
});

test('memory limiter returns a 429 with retry information after its budget', () => {
  let now = 1_000;
  const limiter = new MemoryRateLimiter({
    now: () => now,
    sweepIntervalMs: 60_000,
  });
  try {
    limiter.consume('login', 'ip', { limit: 2, windowMs: 1_000 });
    limiter.consume('login', 'ip', { limit: 2, windowMs: 1_000 });
    assert.throws(
      () => limiter.consume('login', 'ip', { limit: 2, windowMs: 1_000 }),
      (error) => error.status === 429 && error.retryAfter === 1,
    );
    now = 2_001;
    assert.doesNotThrow(() =>
      limiter.consume('login', 'ip', { limit: 2, windowMs: 1_000 }),
    );
  } finally {
    limiter.close();
  }
});

test('development defaults bind locally with a random password and production requires HTTPS', () => {
  const development = loadConfig({
    NODE_ENV: 'development',
    DATABASE_PATH: ':memory:',
  });
  assert.equal(development.host, '127.0.0.1');
  assert.ok(development.developmentAdminPassword.length >= 12);
  assert.notEqual(development.developmentAdminPassword, 'hamkari-dev-admin');
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      DATABASE_PATH: productionDatabasePath,
      PUBLIC_ORIGIN: 'http://example.com',
      ...validProductionSecrets,
      ADMIN_PASSWORD_HASH: createPasswordHash('production-admin-password'),
    }),
    /https/,
  );
});

test('production requires three independent non-placeholder secrets', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_PATH: productionDatabasePath,
    PUBLIC_ORIGIN: 'https://example.com',
    ADMIN_PASSWORD_HASH: createPasswordHash('production-admin-password'),
  };
  assert.throws(
    () => loadConfig({ ...base, SESSION_SECRET: validProductionSecrets.SESSION_SECRET }),
    /AUTH_ENCRYPTION_KEY is required/,
  );
  assert.throws(
    () => loadConfig({
      ...base,
      ...validProductionSecrets,
      AUTH_ENCRYPTION_KEY: 'replace-with-a-separate-random-value',
    }),
    /placeholder/,
  );
  assert.throws(
    () => loadConfig({
      ...base,
      ...validProductionSecrets,
      AUDIT_HMAC_KEY: validProductionSecrets.AUTH_ENCRYPTION_KEY,
    }),
    /must be independent/,
  );
  const config = loadConfig({ ...base, ...validProductionSecrets });
  assert.equal(config.sessionSecret, validProductionSecrets.SESSION_SECRET);
  assert.equal(config.authEncryptionKey, validProductionSecrets.AUTH_ENCRYPTION_KEY);
  assert.equal(config.auditHmacKey, validProductionSecrets.AUDIT_HMAC_KEY);
});

test('production rejects in-memory storage and unverified notification providers', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_PATH: productionDatabasePath,
    PUBLIC_ORIGIN: 'https://example.com',
    ...validProductionSecrets,
    ADMIN_PASSWORD_HASH: createPasswordHash('production-admin-password'),
  };
  assert.throws(
    () => loadConfig({ ...base, DATABASE_PATH: ':memory:' }),
    /not allowed in production/,
  );
  assert.throws(
    () => loadConfig({ ...base, NOTIFICATION_PROVIDER: 'smtp' }),
    /must be manual or sandbox/,
  );
  assert.throws(
    () => loadConfig({ ...base, NOTIFICATION_PROVIDER: 'sandbox' }),
    /must be manual in production/,
  );
  assert.equal(
    loadConfig({ ...base, NOTIFICATION_PROVIDER: 'manual' }).notificationProvider,
    'manual',
  );
  assert.equal(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
      NOTIFICATION_PROVIDER: 'sandbox',
    }).notificationProvider,
    'sandbox',
  );
});

test('document safety limits have production defaults and validate configured bounds', () => {
  const defaults = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
  });
  assert.equal(defaults.documentProjectQuotaBytes, 268_435_456);
  assert.equal(defaults.documentOrganizationQuotaBytes, 1_073_741_824);
  assert.equal(defaults.documentMaxVersions, 100);
  assert.equal(defaults.documentUploadsPerHour, 30);

  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
      DOCUMENT_PROJECT_QUOTA_BYTES: '2097152',
      DOCUMENT_ORGANIZATION_QUOTA_BYTES: '1048576',
    }),
    /DOCUMENT_ORGANIZATION_QUOTA_BYTES/,
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
      DOCUMENT_MAX_VERSIONS: '0',
    }),
    /DOCUMENT_MAX_VERSIONS/,
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
      DOCUMENT_UPLOADS_PER_HOUR: 'not-a-number',
    }),
    /DOCUMENT_UPLOADS_PER_HOUR/,
  );
});

test('forwarded IP is used only when the direct peer matches an explicit trusted range', () => {
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.10, 203.0.113.20' },
  };
  assert.equal(clientIp(request, { trustedProxyCidrs: [] }), '127.0.0.1');
  assert.equal(
    clientIp(request, { trustedProxyCidrs: ['127.0.0.0/8'] }),
    '203.0.113.20',
  );
  assert.equal(
    clientIp(
      {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': '198.51.100.10, 10.0.0.5' },
      },
      { trustedProxyCidrs: ['127.0.0.0/8', '10.0.0.0/8'] },
    ),
    '198.51.100.10',
  );
});

test('Office uploads require the expected OOXML package structure', () => {
  const docx =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const xlsx =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const genericZip = minimalZip(['payload.bin']);
  assert.equal(matchesDeclaredFileType(genericZip, docx), false);
  assert.equal(matchesDeclaredFileType(genericZip, xlsx), false);
  assert.equal(
    matchesDeclaredFileType(
      minimalZip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']),
      docx,
    ),
    true,
  );
  assert.equal(
    matchesDeclaredFileType(
      minimalZip(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml']),
      xlsx,
    ),
    true,
  );
});

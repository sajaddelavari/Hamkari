import assert from 'node:assert/strict';
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
import { clientIp } from '../../src/http.js';

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
      DATABASE_PATH: ':memory:',
      PUBLIC_ORIGIN: 'http://example.com',
      SESSION_SECRET: 'production-secret-that-is-longer-than-thirty-two-characters',
      ADMIN_PASSWORD_HASH: createPasswordHash('production-admin-password'),
    }),
    /https/,
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

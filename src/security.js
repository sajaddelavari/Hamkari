import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const SCRYPT_KEY_LENGTH = 32;

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('base64url');
}

export function deriveToken(secret, namespace, value) {
  return createHmac('sha256', secret)
    .update(namespace)
    .update('\0')
    .update(String(value))
    .digest('base64url');
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function createPasswordHash(password, options = {}) {
  const value = String(password);
  if (value.length < 12) throw new Error('Password must contain at least 12 characters.');
  const cost = options.cost || SCRYPT_COST;
  const blockSize = options.blockSize || SCRYPT_BLOCK_SIZE;
  const parallelism = options.parallelism || SCRYPT_PARALLELISM;
  const salt = options.salt
    ? Buffer.from(options.salt, 'base64url')
    : randomBytes(16);
  const key = scryptSync(value, salt, SCRYPT_KEY_LENGTH, {
    N: cost,
    r: blockSize,
    p: parallelism,
    maxmem: Math.max(64 * 1024 * 1024, 128 * cost * blockSize + 1024),
  });
  return [
    'scrypt',
    cost,
    blockSize,
    parallelism,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password, encodedHash) {
  try {
    const [algorithm, costText, blockText, parallelText, saltText, keyText, extra] =
      String(encodedHash).split('$');
    if (algorithm !== 'scrypt' || extra !== undefined) return false;
    const cost = Number(costText);
    const blockSize = Number(blockText);
    const parallelism = Number(parallelText);
    if (
      !Number.isInteger(cost) ||
      !Number.isInteger(blockSize) ||
      !Number.isInteger(parallelism) ||
      cost < 2 ||
      blockSize < 1 ||
      parallelism < 1
    ) {
      return false;
    }
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(keyText, 'base64url');
    if (salt.length < 8 || expected.length < 16) return false;
    const actual = scryptSync(String(password), salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: Math.max(64 * 1024 * 1024, 128 * cost * blockSize + 1024),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const pieces = [`${name}=${encodeURIComponent(value)}`];
  pieces.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) {
    pieces.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly) pieces.push('HttpOnly');
  if (options.secure) pieces.push('Secure');
  if (options.sameSite) pieces.push(`SameSite=${options.sameSite}`);
  return pieces.join('; ');
}

export function createSignedVisitorCookie(secret) {
  const visitorId = randomToken(18);
  const signature = deriveToken(secret, 'visitor-cookie', visitorId);
  return { visitorId, cookieValue: `${visitorId}.${signature}` };
}

export function verifySignedVisitorCookie(value, secret) {
  const selected = String(value || '');
  const index = selected.lastIndexOf('.');
  if (index < 1) return null;
  const visitorId = selected.slice(0, index);
  const signature = selected.slice(index + 1);
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(visitorId)) return null;
  const expected = deriveToken(secret, 'visitor-cookie', visitorId);
  return safeEqual(signature, expected) ? visitorId : null;
}

const DIGIT_MAP = new Map([
  ['۰', '0'], ['۱', '1'], ['۲', '2'], ['۳', '3'], ['۴', '4'],
  ['۵', '5'], ['۶', '6'], ['۷', '7'], ['۸', '8'], ['۹', '9'],
  ['٠', '0'], ['١', '1'], ['٢', '2'], ['٣', '3'], ['٤', '4'],
  ['٥', '5'], ['٦', '6'], ['٧', '7'], ['٨', '8'], ['٩', '9'],
]);

export function normalizeIranMobile(input) {
  let value = String(input || '')
    .trim()
    .replace(/[۰-۹٠-٩]/g, (digit) => DIGIT_MAP.get(digit))
    .replace(/[\s\-().]/g, '');
  if (value.startsWith('0098')) value = `0${value.slice(4)}`;
  else if (value.startsWith('+98')) value = `0${value.slice(3)}`;
  else if (value.startsWith('98')) value = `0${value.slice(2)}`;
  else if (/^9\d{9}$/.test(value)) value = `0${value}`;
  return /^09\d{9}$/.test(value) ? value : null;
}


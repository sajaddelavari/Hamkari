import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;

function encryptionKey(value) {
  if (!value || String(value).length < 16) {
    throw new Error('TOTP encryption key must contain at least 16 characters.');
  }
  return createHash('sha256').update(String(value)).digest();
}

function normalizeDigits(value) {
  return String(value || '')
    .trim()
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

export function encodeBase32(input) {
  const bytes = Buffer.from(input);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input) {
  const normalized = String(input || '')
    .toUpperCase()
    .replace(/[\s=-]/g, '');
  if (!normalized || [...normalized].some((char) => !BASE32_ALPHABET.includes(char))) {
    throw new Error('Invalid base32 secret.');
  }
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of normalized) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(bytes = 20) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new Error('TOTP secret length is invalid.');
  }
  return encodeBase32(randomBytes(bytes));
}

export function hotp(secret, counter, { digits = DEFAULT_DIGITS } = {}) {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error('HOTP counter is invalid.');
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error('HOTP digit count is invalid.');
  }
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest.at(-1) & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function totpCounter(at = Date.now(), period = DEFAULT_PERIOD) {
  const timestamp = at instanceof Date ? at.getTime() : Number(at);
  if (!Number.isFinite(timestamp)) throw new Error('TOTP timestamp is invalid.');
  return Math.floor(timestamp / 1000 / period);
}

export function generateTotpCode(
  secret,
  { at = Date.now(), period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS } = {},
) {
  return hotp(secret, totpCounter(at, period), { digits });
}

export function verifyTotpCode(
  secret,
  code,
  {
    at = Date.now(),
    period = DEFAULT_PERIOD,
    digits = DEFAULT_DIGITS,
    window = 1,
    afterCounter = -1,
  } = {},
) {
  const normalized = normalizeDigits(code);
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return null;
  const current = totpCounter(at, period);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter < 0 || counter <= afterCounter) continue;
    const expected = hotp(secret, counter, { digits });
    const actualBuffer = Buffer.from(normalized);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return counter;
    }
  }
  return null;
}

export function totpUri({
  secret,
  account,
  issuer = 'هم‌ساخت',
  period = DEFAULT_PERIOD,
  digits = DEFAULT_DIGITS,
}) {
  const label = `${issuer}:${account}`;
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${parameters}`;
}

export function sealTotpState(state, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

export function unsealTotpState(sealed, key) {
  const [version, ivText, ciphertextText, tagText, extra] =
    String(sealed || '').split('.');
  if (version !== 'v1' || extra !== undefined) {
    throw new Error('Invalid sealed TOTP state.');
  }
  const iv = Buffer.from(ivText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
    throw new Error('Invalid sealed TOTP state.');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
  const state = JSON.parse(plaintext);
  if (
    !state ||
    typeof state !== 'object' ||
    typeof state.secret !== 'string' ||
    !Number.isInteger(state.lastCounter)
  ) {
    throw new Error('Invalid sealed TOTP state.');
  }
  return state;
}

export function normalizeBackupCode(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, '');
  return /^[A-Z2-9]{16,40}$/.test(normalized) ? normalized : null;
}

export function generateBackupCodes(count = 10) {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error('Backup-code count is invalid.');
  }
  return Array.from({ length: count }, () => {
    const raw = encodeBase32(randomBytes(12));
    return raw.match(/.{1,4}/g).join('-');
  });
}

export const totpInternals = Object.freeze({
  DEFAULT_PERIOD,
  DEFAULT_DIGITS,
  normalizeDigits,
});

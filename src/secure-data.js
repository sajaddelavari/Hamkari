import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyBytes(key) {
  return createHash('sha256').update(String(key)).digest();
}

export function sealData(value, key, context = 'hamkari') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(String(context)));
  const plaintext = Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  );
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function unsealData(value, key, context = 'hamkari') {
  const [version, ivText, tagText, encryptedText, extra] = String(value || '').split('.');
  if (
    version !== 'v1' ||
    extra !== undefined ||
    !ivText ||
    !tagText ||
    !encryptedText
  ) {
    throw new Error('Sealed value is invalid.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyBytes(key),
    Buffer.from(ivText, 'base64url'),
  );
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

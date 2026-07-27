import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  brotliCompress as brotliCompressCallback,
  constants as zlibConstants,
  gzip as gzipCallback,
} from 'node:zlib';
import { isIP } from 'node:net';
import { AppError, badRequest, forbidden } from './errors.js';

const brotliCompress = promisify(brotliCompressCallback);
const gzip = promisify(gzipCallback);
const staticCache = new Map();
const publicRootCache = new Map();

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
]);

const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.svg']);
const PRIVATE_STATIC_SHELLS = new Set([
  'admin.html',
  'workspace.html',
  'accept-invitation.html',
  'reset-password.html',
]);

function acceptedEncoding(header) {
  const weights = new Map();
  for (const item of String(header || '').toLowerCase().split(',')) {
    const [namePart, ...parameters] = item.trim().split(';');
    if (!namePart) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/);
      if (match) quality = Number(match[1]);
    }
    weights.set(namePart, quality);
  }
  const quality = (name) => weights.has(name)
    ? weights.get(name)
    : (weights.get('*') ?? 0);
  if (quality('br') > 0) return 'br';
  if (quality('gzip') > 0) return 'gzip';
  return 'identity';
}

async function cachedStaticRepresentation(filePath, info, extension, encoding) {
  const version = `${info.size}:${info.mtimeMs}`;
  let entry = staticCache.get(filePath);
  if (!entry || entry.version !== version) {
    const raw = await readFile(filePath);
    entry = {
      version,
      raw,
      etag: `W/"${createHash('sha256').update(raw).digest('base64url').slice(0, 22)}"`,
      gzip: null,
      br: null,
    };
    staticCache.set(filePath, entry);
  }
  if (
    encoding === 'identity' ||
    entry.raw.length < 1024 ||
    !COMPRESSIBLE_EXTENSIONS.has(extension)
  ) {
    return { body: entry.raw, encoding: 'identity', etag: entry.etag };
  }
  if (!entry[encoding]) {
    entry[encoding] = encoding === 'br'
      ? await brotliCompress(entry.raw, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        },
      })
      : await gzip(entry.raw, { level: 6 });
  }
  return { body: entry[encoding], encoding, etag: entry.etag };
}

function etagMatches(header, etag) {
  return String(header || '')
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag);
}

export function setSecurityHeaders(response, config, requestId) {
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
    ].join('; '),
  );
  if (config.isProduction) {
    response.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
}

export function appendSetCookie(response, cookie) {
  const existing = response.getHeader('Set-Cookie');
  if (!existing) response.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(existing)) response.setHeader('Set-Cookie', [...existing, cookie]);
  else response.setHeader('Set-Cookie', [existing, cookie]);
}

export function sendJson(response, status, body, extraHeaders = {}) {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extraHeaders)) {
    response.setHeader(name, value);
  }
  response.end(JSON.stringify(body));
}

export function sendError(response, error, requestId, exposeStack = false) {
  const selected = error instanceof AppError
    ? error
    : new AppError(500, 'INTERNAL_ERROR', 'خطای داخلی سرور رخ داد.');
  const body = {
    error: {
      code: selected.code,
      message: selected.message,
      ...(selected.fields ? { fields: selected.fields } : {}),
    },
    requestId,
  };
  if (exposeStack && !(error instanceof AppError)) body.error.debug = error.message;
  sendJson(
    response,
    selected.status,
    body,
    selected.retryAfter ? { 'Retry-After': selected.retryAfter } : {},
  );
}

export async function readJson(request, limitBytes) {
  const length = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(length) && length > limitBytes) {
    request.resume();
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'حجم درخواست بیشتر از ۶۴ کیلوبایت است.');
  }
  const encoding = String(request.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') {
    request.resume();
    throw new AppError(415, 'UNSUPPORTED_ENCODING', 'فشرده‌سازی بدنه درخواست پشتیبانی نمی‌شود.');
  }
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    request.resume();
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'بدنه درخواست باید JSON باشد.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      request.resume();
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'حجم درخواست بیشتر از ۶۴ کیلوبایت است.');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('INVALID_JSON', 'بدنه JSON معتبر نیست.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('INVALID_JSON', 'بدنه JSON باید یک شیء باشد.');
  }
  return value;
}

export async function readBinary(request, limitBytes, options = {}) {
  const length = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(length) && length > limitBytes) {
    request.resume();
    throw new AppError(
      413,
      'PAYLOAD_TOO_LARGE',
      `حجم فایل نباید بیشتر از ${Math.ceil(limitBytes / 1024 / 1024)} مگابایت باشد.`,
    );
  }
  const encoding = String(request.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') {
    request.resume();
    throw new AppError(
      415,
      'UNSUPPORTED_ENCODING',
      'فشرده‌سازی بدنهٔ فایل پشتیبانی نمی‌شود.',
    );
  }
  const mimeType = String(request.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!mimeType) {
    request.resume();
    throw new AppError(415, 'CONTENT_TYPE_REQUIRED', 'نوع فایل مشخص نشده است.');
  }
  if (options.allowedTypes && !options.allowedTypes.has(mimeType)) {
    request.resume();
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'نوع این فایل مجاز نیست.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      request.resume();
      throw new AppError(
        413,
        'PAYLOAD_TOO_LARGE',
        `حجم فایل نباید بیشتر از ${Math.ceil(limitBytes / 1024 / 1024)} مگابایت باشد.`,
      );
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw badRequest('EMPTY_FILE', 'فایل خالی قابل بارگذاری نیست.');
  }
  const buffer = Buffer.concat(chunks);
  if (!matchesDeclaredFileType(buffer, mimeType)) {
    throw new AppError(
      415,
      'FILE_SIGNATURE_MISMATCH',
      'محتوای فایل با نوع اعلام‌شده هم‌خوانی ندارد.',
    );
  }
  return Object.freeze({
    buffer,
    mimeType,
    size,
    filename: decodeHeaderComponent(
      request.headers['x-file-name'],
      'X-File-Name',
      240,
    ),
  });
}

function zipEntryNames(buffer) {
  if (buffer.length < 22) return null;
  const minimum = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) return null;
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0 ||
    totalEntries > 10_000 ||
    eocd + 22 + commentLength !== buffer.length ||
    centralOffset + centralSize > eocd
  ) return null;
  const names = new Set();
  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) return null;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + filenameLength + extraLength + entryCommentLength;
    if (
      (flags & 0x0001) !== 0 ||
      ![0, 8].includes(method) ||
      next > centralOffset + centralSize ||
      localOffset + 30 > centralOffset ||
      buffer.readUInt32LE(localOffset) !== 0x04034b50
    ) return null;
    const filename = buffer
      .subarray(offset + 46, offset + 46 + filenameLength)
      .toString('utf8')
      .replaceAll('\\', '/');
    const localFilenameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localFilename = buffer
      .subarray(localOffset + 30, localOffset + 30 + localFilenameLength)
      .toString('utf8')
      .replaceAll('\\', '/');
    const dataEnd =
      localOffset + 30 + localFilenameLength + localExtraLength + compressedSize;
    totalUncompressedBytes += uncompressedSize;
    if (
      !filename ||
      filename !== localFilename ||
      filename.startsWith('/') ||
      filename.split('/').includes('..') ||
      filename.includes('\0') ||
      names.has(filename) ||
      dataEnd > centralOffset ||
      totalUncompressedBytes > 256 * 1024 * 1024
    ) return null;
    names.add(filename);
    offset = next;
  }
  return offset === centralOffset + centralSize ? names : null;
}

export function matchesDeclaredFileType(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  }
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    const entries = zipEntryNames(buffer);
    if (
      !entries ||
      !entries.has('[Content_Types].xml') ||
      !entries.has('_rels/.rels')
    ) return false;
    return mimeType.endsWith('wordprocessingml.document')
      ? entries.has('word/document.xml')
      : entries.has('xl/workbook.xml');
  }
  if (mimeType === 'application/json') {
    try {
      JSON.parse(buffer.toString('utf8'));
      return true;
    } catch {
      return false;
    }
  }
  if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    return !buffer.includes(0);
  }
  return true;
}

export function decodeHeaderComponent(value, name, maximum = 1000) {
  const raw = String(value || '');
  // A UTF-8 code point can expand to as many as 12 characters after
  // percent-encoding (four bytes, each rendered as "%XX").
  if (raw.length > maximum * 12 + 20) {
    throw badRequest('INVALID_HEADER_VALUE', `${name} بیش از حد طولانی است.`);
  }
  let decoded = raw;
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw badRequest(
        'INVALID_HEADER_ENCODING',
        `${name} باید با UTF-8 و percent-encoding معتبر ارسال شود.`,
      );
    }
  }
  if (
    decoded.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    throw badRequest('INVALID_HEADER_VALUE', `${name} معتبر نیست.`);
  }
  return decoded;
}

function safeDownloadFilename(value) {
  const selected = String(value || 'download')
    .replace(/[\r\n"]/g, '')
    .replace(/[\\/:*?<>|]/g, '-')
    .trim()
    .slice(0, 180);
  return selected || 'download';
}

export function sendBuffer(response, status, buffer, options = {}) {
  if (response.writableEnded) return;
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  response.statusCode = status;
  response.setHeader('Content-Type', options.contentType || 'application/octet-stream');
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Cache-Control', options.cacheControl || 'private, no-store');
  if (options.filename) {
    const filename = safeDownloadFilename(options.filename);
    response.setHeader(
      'Content-Disposition',
      `${options.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  }
  for (const [name, value] of Object.entries(options.headers || {})) {
    response.setHeader(name, value);
  }
  response.end(body);
}

export function assertSameOrigin(request, config, { required = config.isProduction } = {}) {
  const origin = request.headers.origin;
  if (!origin) {
    if (required) {
      throw forbidden('ORIGIN_REQUIRED', 'مبدأ درخواست مشخص نیست.');
    }
    return;
  }
  let normalized;
  try {
    normalized = new URL(origin).origin;
  } catch {
    throw forbidden('INVALID_ORIGIN', 'مبدأ درخواست معتبر نیست.');
  }
  if (normalized !== config.publicOrigin) {
    throw forbidden('INVALID_ORIGIN', 'این مبدأ اجازه ارسال درخواست ندارد.');
  }
}

/**
 * Browser sessions require an exact Origin check in addition to CSRF. Scoped
 * API keys are intended for server-to-server clients, which normally do not
 * send an Origin header; their bearer credential is still validated by the
 * route authorization layer immediately afterwards.
 */
export function assertMutationOrigin(request, config) {
  const authorization = String(request.headers.authorization || '');
  if (/^Bearer hmk_[A-Za-z0-9_-]{32,200}$/.test(authorization)) return;
  assertSameOrigin(request, config);
}

function ipBytes(value) {
  let address = String(value || '').split('%')[0].toLowerCase();
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) {
    address = address.slice(7);
  }
  const version = isIP(address);
  if (version === 4) return Buffer.from(address.split('.').map(Number));
  if (version !== 6) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    const parts = side.split(':');
    const last = parts.at(-1);
    if (last && isIP(last) === 4) {
      const bytes = last.split('.').map(Number);
      parts.splice(
        parts.length - 1,
        1,
        ((bytes[0] << 8) | bytes[1]).toString(16),
        ((bytes[2] << 8) | bytes[3]).toString(16),
      );
    }
    return parts.map((part) => Number.parseInt(part || '0', 16));
  };
  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] || '');
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array(Math.max(0, fill)).fill(0), ...right];
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return null;
  }
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

function ipInCidr(address, cidr) {
  const [network, prefixText] = cidr.split('/');
  const addressBytes = ipBytes(address);
  const networkBytes = ipBytes(network);
  if (!addressBytes || !networkBytes || addressBytes.length !== networkBytes.length) return false;
  const maximum = addressBytes.length * 8;
  const prefix = prefixText === undefined ? maximum : Number(prefixText);
  const fullBytes = Math.floor(prefix / 8);
  const remaining = prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (addressBytes[index] !== networkBytes[index]) return false;
  }
  if (remaining) {
    const mask = (0xff << (8 - remaining)) & 0xff;
    if ((addressBytes[fullBytes] & mask) !== (networkBytes[fullBytes] & mask)) return false;
  }
  return true;
}

export function clientIp(request, config = {}) {
  const direct = request.socket?.remoteAddress || 'unknown';
  const isTrusted = (address) =>
    (config.trustedProxyCidrs || []).some((cidr) => ipInCidr(address, cidr));
  if (!isTrusted(direct)) return direct;
  const forwarded = String(request.headers['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  let selected = direct;
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const candidate = forwarded[index];
    if (!ipBytes(candidate)) break;
    selected = candidate;
    if (!isTrusted(candidate)) break;
  }
  return selected;
}

export function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw badRequest('INVALID_PATH', 'نشانی درخواست معتبر نیست.');
  }
}

function routeDocument(pathname, publicDir) {
  if (pathname === '/') return 'index.html';
  if (pathname === '/projects') return 'index.html';
  if (pathname === '/admin') {
    return existsSync(resolve(publicDir, 'admin.html')) ? 'admin.html' : 'index.html';
  }
  if (pathname === '/workspace') {
    return existsSync(resolve(publicDir, 'workspace.html'))
      ? 'workspace.html'
      : 'admin.html';
  }
  if (pathname === '/accept-invitation') {
    return existsSync(resolve(publicDir, 'accept-invitation.html'))
      ? 'accept-invitation.html'
      : 'workspace.html';
  }
  if (pathname === '/reset-password') {
    return existsSync(resolve(publicDir, 'reset-password.html'))
      ? 'reset-password.html'
      : 'workspace.html';
  }
  if (pathname === '/marketplace') {
    return existsSync(resolve(publicDir, 'marketplace.html'))
      ? 'marketplace.html'
      : 'index.html';
  }
  if (pathname === '/my-proposals') {
    return existsSync(resolve(publicDir, 'my-proposals.html'))
      ? 'my-proposals.html'
      : 'index.html';
  }
  if (/^\/projects\/[^/]+\/needs\/[^/]+$/.test(pathname)) {
    return existsSync(resolve(publicDir, 'need.html')) ? 'need.html' : 'index.html';
  }
  if (/^\/projects\/[^/]+$/.test(pathname)) {
    return existsSync(resolve(publicDir, 'project.html')) ? 'project.html' : 'index.html';
  }
  return null;
}

export async function serveStatic(request, response, url, config) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const routeFile = routeDocument(url.pathname, config.publicDir);
  const rawRelative = routeFile || decodeSegment(url.pathname).replace(/^[/\\]+/, '');
  if (!rawRelative || rawRelative.includes('\0')) return false;
  const filePath = resolve(config.publicDir, rawRelative);
  const relativePath = relative(config.publicDir, filePath);
  if (relativePath.startsWith('..') || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    return false;
  }
  let realPublicDir;
  let realFilePath;
  try {
    let publicRootPromise = publicRootCache.get(config.publicDir);
    if (!publicRootPromise) {
      publicRootPromise = realpath(config.publicDir);
      publicRootCache.set(config.publicDir, publicRootPromise);
    }
    [realPublicDir, realFilePath] = await Promise.all([
      publicRootPromise,
      realpath(filePath),
    ]);
  } catch {
    return false;
  }
  const realRelativePath = relative(realPublicDir, realFilePath);
  if (
    realRelativePath.startsWith('..') ||
    realRelativePath.startsWith('/') ||
    realRelativePath.startsWith('\\')
  ) {
    return false;
  }
  const info = await stat(realFilePath);
  if (!info.isFile()) return false;
  const extension = extname(realFilePath).toLowerCase();
  const isHtml = extension === '.html';
  const privateShell = PRIVATE_STATIC_SHELLS.has(rawRelative);
  const compressible = COMPRESSIBLE_EXTENSIONS.has(extension);
  const requestedEncoding = compressible
    ? acceptedEncoding(request.headers['accept-encoding'])
    : 'identity';
  const representation = await cachedStaticRepresentation(
    realFilePath,
    info,
    extension,
    requestedEncoding,
  );
  response.statusCode = 200;
  response.setHeader('Content-Type', MIME_TYPES.get(extension) || 'application/octet-stream');
  response.setHeader(
    'Cache-Control',
    privateShell
      ? 'no-store'
      : isHtml || rawRelative === 'sw.js'
      ? 'no-cache'
      : ['.woff2', '.woff', '.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extension)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
  );
  response.setHeader('ETag', representation.etag);
  response.setHeader('Last-Modified', info.mtime.toUTCString());
  if (compressible) response.setHeader('Vary', 'Accept-Encoding');
  if (representation.encoding !== 'identity') {
    response.setHeader('Content-Encoding', representation.encoding);
  }
  if (etagMatches(request.headers['if-none-match'], representation.etag)) {
    response.statusCode = 304;
    response.removeHeader('Content-Length');
    response.end();
    return true;
  }
  response.setHeader('Content-Length', representation.body.length);
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  response.end(representation.body);
  return true;
}

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
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
    isHtml
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

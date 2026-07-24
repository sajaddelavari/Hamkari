import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { routeAdminApi } from './admin-routes.js';
import { openDatabase, SCHEMA_VERSION } from './database.js';
import {
  appendSetCookie,
  clientIp,
  readJson,
  sendError,
  sendJson,
  serveStatic,
  setSecurityHeaders,
} from './http.js';
import { routePublicApi } from './public-routes.js';
import { MemoryRateLimiter } from './rate-limit.js';
import {
  createPasswordHash,
  createSignedVisitorCookie,
  parseCookies,
  serializeCookie,
  verifySignedVisitorCookie,
} from './security.js';
import { createStore } from './store.js';
import { SseBroker } from './sse.js';

const VISITOR_COOKIE = 'hamkari_visitor';

function requestId(request) {
  const supplied = String(request.headers['x-request-id'] || '');
  return /^[A-Za-z0-9_-]{8,100}$/.test(supplied) ? supplied : randomUUID();
}

function jsonLog(logger, value, level = 'log') {
  if (!logger) return;
  const method = typeof logger[level] === 'function' ? level : 'log';
  logger[method](JSON.stringify(value));
}

function redactLogPath(url) {
  return url.pathname.replace(
    /^\/api\/v1\/proposals\/track\/[^/]+$/,
    '/api/v1/proposals/track/[redacted]',
  );
}

/**
 * Creates the complete HTTP application without listening on a port. This is the
 * public composition seam used by server.js and backend integration tests.
 */
export function createApplication(options) {
  const {
    config,
    clock = () => new Date(),
    logger = console,
  } = options;
  const seed = options.seed ?? !config.isProduction;
  const db = options.db || openDatabase(config, {
    seed,
    bootstrap: !seed && config.isProduction,
  });
  const ownsDatabase = !options.db;
  const store = options.store || createStore(db, {
    clock,
    publicOrigin: config.publicOrigin,
  });
  const broker = options.broker || new SseBroker({ now: clock });
  const rateLimiter = options.rateLimiter || new MemoryRateLimiter({
    now: () => clock().getTime(),
  });
  const adminPasswordHash = config.adminPasswordHash ||
    createPasswordHash(config.developmentAdminPassword);
  let closed = false;

  async function handler(request, response) {
    const startedAt = process.hrtime.bigint();
    const id = requestId(request);
    let caughtError = null;
    let logPath = '/';
    setSecurityHeaders(response, config, id);

    try {
      const url = new URL(request.url || '/', config.publicOrigin);
      logPath = redactLogPath(url);
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.setHeader('Allow', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
        response.end();
        return;
      }

      if (
        request.method === 'GET' &&
        (url.pathname === '/healthz' || url.pathname === '/api/v1/healthz')
      ) {
        if (!store.healthcheck()) {
          throw new AppError(503, 'DATABASE_UNAVAILABLE', 'دیتابیس آماده پاسخ‌گویی نیست.');
        }
        sendJson(response, 200, {
          status: 'ok',
          database: 'ok',
          schemaVersion: SCHEMA_VERSION,
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: clock().toISOString(),
        });
        return;
      }

      let visitorId;
      const context = {
        request,
        response,
        url,
        config,
        store,
        broker,
        rateLimiter,
        adminPasswordHash,
        now: clock,
        readJson: () => readJson(request, config.payloadLimitBytes),
        visitor() {
          if (visitorId) return visitorId;
          const existing = parseCookies(request.headers.cookie)[VISITOR_COOKIE];
          visitorId = verifySignedVisitorCookie(existing, config.sessionSecret);
          if (!visitorId) {
            const created = createSignedVisitorCookie(config.sessionSecret);
            visitorId = created.visitorId;
            appendSetCookie(
              response,
              serializeCookie(VISITOR_COOKIE, created.cookieValue, {
                path: '/',
                httpOnly: true,
                secure: config.isProduction,
                sameSite: 'Lax',
                maxAge: 365 * 24 * 60 * 60,
              }),
            );
          }
          return visitorId;
        },
      };

      if (url.pathname.startsWith('/api/v1/admin/')) {
        if (await routeAdminApi(context)) return;
        throw new AppError(404, 'ROUTE_NOT_FOUND', 'مسیر API موردنظر وجود ندارد.');
      }
      if (url.pathname.startsWith('/api/')) {
        if (await routePublicApi(context)) return;
        throw new AppError(404, 'ROUTE_NOT_FOUND', 'مسیر API موردنظر وجود ندارد.');
      }
      if (await serveStatic(request, response, url, config)) return;
      response.statusCode = 404;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end('صفحه موردنظر پیدا نشد.');
    } catch (error) {
      caughtError = error;
      if (response.headersSent && !response.writableEnded) {
        response.destroy(error);
      } else {
        sendError(response, error, id, config.nodeEnv === 'development');
      }
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const entry = {
        timestamp: clock().toISOString(),
        level: caughtError ? 'error' : 'info',
        requestId: id,
        method: request.method,
        path: logPath,
        status: response.statusCode,
        durationMs: Math.round(elapsedMs * 100) / 100,
        ip: clientIp(request, config),
      };
      if (caughtError && !(caughtError instanceof AppError)) {
        entry.error = config.isProduction
          ? { name: caughtError.name }
          : { name: caughtError.name, message: caughtError.message, stack: caughtError.stack };
      } else if (caughtError) {
        entry.error = { code: caughtError.code };
      }
      jsonLog(logger, entry, caughtError ? 'error' : 'log');
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    broker.close();
    rateLimiter.close();
    if (ownsDatabase) db.close();
  }

  return Object.freeze({
    handler,
    close,
    db,
    store,
    broker,
    rateLimiter,
    config,
  });
}

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';
import { routeAdminApi } from './admin-routes.js';
import { routeBootstrapApi } from './bootstrap-routes.js';
import { openDatabase, SCHEMA_VERSION } from './database.js';
import { routeDecisionActionApi } from './decision-action-routes.js';
import { createDecisionActionStore } from './decision-action-store.js';
import { createDocumentStore } from './document-store.js';
import { routeDocumentApi } from './document-routes.js';
import { createEnterpriseAudit } from './enterprise-audit.js';
import { routeEnterpriseFinanceApi } from './enterprise-finance-routes.js';
import { createEnterpriseFinanceStore } from './enterprise-finance-store.js';
import { createEnterpriseHubStore } from './enterprise-hub-store.js';
import { routeEnterpriseHubApi } from './enterprise-hub-routes.js';
import { createIdentityStore } from './identity-store.js';
import { routeIdentityApi } from './identity-routes.js';
import { createNotificationWorker } from './notification-worker.js';
import { createOperationsStore } from './operations-store.js';
import { routeOperationsApi } from './operations-routes.js';
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
import { createPlatformStore } from './platform-store.js';
import { createReadinessStore } from './readiness-store.js';
import { routeReadinessApi } from './readiness-routes.js';
import {
  createPasswordHash,
  createSignedVisitorCookie,
  deriveToken,
  parseCookies,
  serializeCookie,
  verifySignedVisitorCookie,
} from './security.js';
import { createStore } from './store.js';
import { SseBroker } from './sse.js';
import { authorizeWorkspace, routeWorkspaceApi } from './workspace-routes.js';

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
  const auditContext = new AsyncLocalStorage();
  const auditService = options.auditService || createEnterpriseAudit(db, {
    clock,
    hmacKey: config.auditHmacKey,
  });
  const appendEnterpriseAudit = (event) => {
    const requestAudit = auditContext.getStore() || {};
    const eventActor = event?.actor || null;
    return auditService.append({
      ...requestAudit,
      ...event,
      actorType:
        event.actorType ||
        eventActor?.actorType ||
        (eventActor?.apiKey ? 'api_key' : undefined) ||
        requestAudit.actorType,
      actorId:
        event.actorId ||
        event.actorUserId ||
        eventActor?.apiKey?.id ||
        eventActor?.userId ||
        requestAudit.actorId ||
        null,
    });
  };
  const store = options.store || createStore(db, {
    clock,
    publicOrigin: config.publicOrigin,
    audit: appendEnterpriseAudit,
  });
  const identityStore = options.identityStore || createIdentityStore(db, {
    clock,
    sessionSecret: config.sessionSecret,
    encryptionSecret: config.authEncryptionKey,
    sessionTtlMs: config.sessionTtlMs,
    audit: appendEnterpriseAudit,
  });
  const operationsStore = options.operationsStore || createOperationsStore(db, {
    clock,
    audit: appendEnterpriseAudit,
  });
  const enterpriseFinanceStore =
    options.enterpriseFinanceStore ||
    createEnterpriseFinanceStore(db, {
      clock,
      audit: appendEnterpriseAudit,
      paymentProviderMode: config.paymentProviderMode,
      distributionKycRequired: config.distributionKycRequired,
    });
  const readinessStore = options.readinessStore || createReadinessStore(db, {
    clock,
    audit: appendEnterpriseAudit,
  });
  const platformStore = options.platformStore || createPlatformStore(db, {
    clock,
    audit: appendEnterpriseAudit,
    operationsStore,
    financeStore: enterpriseFinanceStore,
    readinessStore,
  });
  const documentStore = options.documentStore || createDocumentStore(db, {
    clock,
    audit: appendEnterpriseAudit,
    projectQuotaBytes: config.documentProjectQuotaBytes,
    organizationQuotaBytes: config.documentOrganizationQuotaBytes,
    maximumVersionsPerDocument: config.documentMaxVersions,
  });
  const decisionActionStore =
    options.decisionActionStore ||
    createDecisionActionStore(db, {
      clock,
      audit: appendEnterpriseAudit,
    });
  const hubStore = options.hubStore || createEnterpriseHubStore(db, {
    clock,
    audit: appendEnterpriseAudit,
    encryptionKey: config.authEncryptionKey,
  });
  const notificationWorker = options.notificationWorker || createNotificationWorker(db, {
    clock,
    encryptionKey: config.authEncryptionKey,
    adapters: options.notificationAdapters || {},
  });
  if (!config.isTest && options.startWorkers !== false) {
    notificationWorker.start();
  }
  const broker = options.broker || new SseBroker({ now: clock });
  const rateLimiter = options.rateLimiter || new MemoryRateLimiter({
    now: () => clock().getTime(),
  });
  const adminPasswordHash = config.adminPasswordHash ||
    (config.developmentAdminPassword
      ? createPasswordHash(config.developmentAdminPassword)
      : null);
  let closed = false;

  async function handleRequest(request, response, id) {
    const startedAt = process.hrtime.bigint();
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
        db,
        store,
        platformStore,
        identityStore,
        operationsStore,
        enterpriseFinanceStore,
        documentStore,
        decisionActionStore,
        readinessStore,
        hubStore,
        auditService,
        notificationWorker,
        broker,
        rateLimiter,
        adminPasswordHash,
        now: clock,
        requestId: id,
        setAuditActor(auth) {
          const state = auditContext.getStore();
          if (!state || !auth) return;
          state.organizationId = auth.organizationId || state.organizationId;
          state.actorType = auth.apiKey
            ? 'api_key'
            : auth.legacy ? 'legacy_admin' : 'user';
          state.actorId = auth.apiKey?.id || auth.actorId || auth.userId || null;
          state.actorUserId = auth.userId || null;
        },
        readJson: () => readJson(request, config.payloadLimitBytes),
        identityNotifications: {
          invitation(result) {
            const invitation = result.invitation;
            hubStore.enqueueNotification({
              organizationId: invitation.organizationId,
              channel: 'email',
              destination: invitation.email,
              templateKey: 'organization-invitation',
              provider: config.notificationProvider,
              payload: {
                organizationName: invitation.organizationName,
                roleKey: invitation.roleKey,
                expiresAt: invitation.expiresAt,
                url: `${config.publicOrigin}/accept-invitation#token=${result.token}`,
              },
            });
          },
          passwordReset(result) {
            const organization = identityStore
              .organizationsForUser(result.user.id).organizations[0];
            if (!organization) return;
            hubStore.enqueueNotification({
              organizationId: organization.id,
              userId: result.user.id,
              channel: 'email',
              destination: result.user.email,
              templateKey: 'password-reset',
              provider: config.notificationProvider,
              payload: {
                fullName: result.user.fullName,
                expiresAt: result.expiresAt,
                url: `${config.publicOrigin}/reset-password#token=${result.token}`,
              },
            });
          },
        },
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

      if (url.pathname.startsWith('/api/v2/')) {
        if (await routeBootstrapApi(context)) return;
        if (await routeIdentityApi(context)) return;
        if (await routeReadinessApi(context, authorizeWorkspace)) return;
        if (await routeOperationsApi(context, authorizeWorkspace)) return;
        if (await routeEnterpriseFinanceApi(context, authorizeWorkspace)) return;
        if (await routeDecisionActionApi(context, authorizeWorkspace)) return;
        if (await routeDocumentApi(context, authorizeWorkspace)) return;
        if (await routeEnterpriseHubApi(context, authorizeWorkspace)) return;
        if (await routeWorkspaceApi(context)) return;
        throw new AppError(404, 'ROUTE_NOT_FOUND', 'مسیر API موردنظر وجود ندارد.');
      }
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
        ipHash: deriveToken(
          config.auditHmacKey,
          'request-log-ip',
          clientIp(request, config),
        ),
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

  async function handler(request, response) {
    const id = requestId(request);
    const ip = clientIp(request, config);
    return auditContext.run(
      {
        requestId: id,
        ipHash: deriveToken(config.auditHmacKey, 'audit-ip', ip),
      },
      () => handleRequest(request, response, id),
    );
  }

  function close() {
    if (closed) return;
    closed = true;
    broker.close();
    rateLimiter.close();
    notificationWorker.stop();
    if (ownsDatabase) db.close();
  }

  return Object.freeze({
    handler,
    close,
    db,
    store,
    platformStore,
    identityStore,
    operationsStore,
    enterpriseFinanceStore,
    readinessStore,
    documentStore,
    hubStore,
    auditService,
    notificationWorker,
    broker,
    rateLimiter,
    config,
  });
}

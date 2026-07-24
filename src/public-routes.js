import { AppError, badRequest } from './errors.js';
import { assertSameOrigin, clientIp, decodeSegment, sendJson } from './http.js';
import {
  validateIdempotencyKey,
  validateProposal,
  validateViewerState,
} from './validation.js';

function publishProjectUpdate(context, slug, reason) {
  // A default SSE "message" event is understood by both the public room and
  // the admin dashboard. The reason field keeps the event extensible.
  context.broker.publish(slug, null, {
    slug,
    reason,
    updatedAt: context.now().toISOString(),
  });
}

export async function routePublicApi(context) {
  const { request, response, url, store } = context;
  if (request.method === 'GET' && url.pathname === '/api/v1/projects') {
    sendJson(response, 200, context.platformStore.portfolio(true, {
      limit: url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/projects/current') {
    const visitorId = context.visitor();
    const payload = store.publicProject(store.publicCurrentProjectSlug(), visitorId);
    Object.assign(
      payload.project,
      context.platformStore.getProject(payload.project.id, {
        publicOnly: true,
      }).project,
    );
    Object.assign(
      payload.project,
      context.platformStore.publicSummary(payload.project.id),
    );
    sendJson(response, 200, payload);
    return true;
  }
  const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (request.method === 'GET' && projectMatch) {
    const visitorId = context.visitor();
    const slug = decodeSegment(projectMatch[1]);
    const payload = store.publicProject(slug, visitorId);
    Object.assign(
      payload.project,
      context.platformStore.getProject(payload.project.id, {
        publicOnly: true,
      }).project,
    );
    Object.assign(
      payload.project,
      context.platformStore.publicSummary(payload.project.id),
    );
    sendJson(response, 200, payload);
    return true;
  }

  const needMatch = url.pathname.match(/^\/api\/v1\/needs\/([^/]+)$/);
  if (request.method === 'GET' && needMatch) {
    const visitorId = context.visitor();
    const id = decodeSegment(needMatch[1]);
    sendJson(response, 200, { need: store.publicNeedById(id, visitorId) });
    return true;
  }

  const viewerStateMatch = url.pathname.match(
    /^\/api\/v1\/needs\/([^/]+)\/viewer-state$/,
  );
  if (request.method === 'PUT' && viewerStateMatch) {
    assertSameOrigin(request, context.config);
    const visitorId = context.visitor();
    const ip = clientIp(request, context.config);
    context.rateLimiter.consume('viewer-state-ip', ip, {
      limit: 300,
      windowMs: 15 * 60 * 1000,
    });
    context.rateLimiter.consume('viewer-state-visitor', visitorId, {
      limit: 120,
      windowMs: 60_000,
    });
    const id = decodeSegment(viewerStateMatch[1]);
    const state = validateViewerState(await context.readJson());
    const result = store.setViewerState(id, visitorId, state);
    const slug = store.projectSlugForNeed(id);
    publishProjectUpdate(context, slug, 'viewer-state');
    sendJson(response, 200, result);
    return true;
  }

  const proposalMatch = url.pathname.match(
    /^\/api\/v1\/needs\/([^/]+)\/proposals$/,
  );
  if (request.method === 'POST' && proposalMatch) {
    assertSameOrigin(request, context.config);
    const visitorId = context.visitor();
    const ip = clientIp(request, context.config);
    context.rateLimiter.consume('proposal-ip', ip, {
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    context.rateLimiter.consume('proposal-visitor', visitorId, {
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    const id = decodeSegment(proposalMatch[1]);
    const idempotencyKey = validateIdempotencyKey(
      request.headers['idempotency-key'],
    );
    const input = validateProposal(await context.readJson());
    const result = store.createProposal(id, visitorId, idempotencyKey, input);
    const slug = store.projectSlugForNeed(id);
    publishProjectUpdate(context, slug, 'proposal-created');
    sendJson(response, result.idempotentReplay ? 200 : 201, result);
    return true;
  }

  const secureTrackingRequest =
    request.method === 'GET' && url.pathname === '/api/v1/proposals/track';
  if (secureTrackingRequest) {
    context.rateLimiter.consume('proposal-track', clientIp(request, context.config), {
      limit: 120,
      windowMs: 60_000,
    });
    const authorization = String(request.headers.authorization || '');
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    const trackingToken = String(bearerMatch?.[1] || '');
    if (!/^[A-Za-z0-9_-]{24,200}$/.test(trackingToken)) {
      throw badRequest('INVALID_TRACKING_TOKEN', 'کد پیگیری معتبر نیست.');
    }
    sendJson(
      response,
      200,
      store.trackProposal(trackingToken),
      { 'Cache-Control': 'private, no-store' },
    );
    return true;
  }

  const eventMatch = url.pathname.match(
    /^\/api\/v1\/projects\/([^/]+)\/events$/,
  );
  if (request.method === 'GET' && eventMatch) {
    const slug = decodeSegment(eventMatch[1]);
    const visitorId = context.visitor();
    context.rateLimiter.consume('sse-connect', clientIp(request, context.config), {
      limit: 30,
      windowMs: 60_000,
    });
    // Resolve the room before headers are committed, so a missing room remains a
    // regular JSON 404 instead of a broken event stream.
    store.publicProject(slug, visitorId);
    if (!context.broker.canSubscribe(slug)) {
      throw new AppError(
        503,
        'SSE_CAPACITY_REACHED',
        'ظرفیت اتصال زنده تکمیل است؛ به‌روزرسانی دوره‌ای ادامه خواهد داشت.',
      );
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();
    context.broker.subscribe(slug, request, response);
    return true;
  }

  return false;
}

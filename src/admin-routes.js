import { AppError, badRequest, unauthorized } from './errors.js';
import {
  appendSetCookie,
  assertSameOrigin,
  clientIp,
  decodeSegment,
  sendJson,
} from './http.js';
import {
  deriveToken,
  hashToken,
  parseCookies,
  randomToken,
  safeEqual,
  serializeCookie,
  verifyPassword,
} from './security.js';
import {
  validateAdminLogin,
  validateNeed,
  validateNeedOrder,
  validateProject,
  validateProposalPatch,
} from './validation.js';
import { routePlatformAdminApi } from './platform-routes.js';

const ADMIN_COOKIE = 'hamkari_admin';

function adminCookie(rawToken, config) {
  return serializeCookie(ADMIN_COOKIE, rawToken, {
    path: '/',
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'Strict',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

function expiredAdminCookie(config) {
  return serializeCookie(ADMIN_COOKIE, '', {
    path: '/',
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'Strict',
    maxAge: 0,
  });
}

function readSession(context, { required = true, csrf = false } = {}) {
  const rawToken = parseCookies(context.request.headers.cookie)[ADMIN_COOKIE];
  const session = rawToken
    ? context.store.adminSession(hashToken(rawToken))
    : null;
  if (!session) {
    if (required) throw unauthorized();
    return null;
  }
  const csrfToken = deriveToken(
    context.config.sessionSecret,
    'admin-csrf',
    rawToken,
  );
  if (!safeEqual(hashToken(csrfToken), session.csrf_token_hash)) {
    // Rotating SESSION_SECRET intentionally invalidates existing sessions.
    context.store.deleteAdminSession(hashToken(rawToken));
    appendSetCookie(context.response, expiredAdminCookie(context.config));
    if (required) throw unauthorized();
    return null;
  }
  if (csrf) {
    const supplied = String(context.request.headers['x-csrf-token'] || '');
    if (
      !supplied ||
      !safeEqual(supplied, csrfToken) ||
      !safeEqual(hashToken(supplied), session.csrf_token_hash)
    ) {
      throw new AppError(
        403,
        'INVALID_CSRF_TOKEN',
        'نشست معتبر است اما توکن امنیتی درخواست صحیح نیست.',
      );
    }
  }
  return { rawToken, session, csrfToken };
}

function publish(context, slug, reason) {
  context.broker.publish(slug, null, {
    slug,
    reason,
    updatedAt: context.now().toISOString(),
  });
}

export async function routeAdminApi(context) {
  const { request, response, url, store, config } = context;
  if (!url.pathname.startsWith('/api/v1/admin/')) return false;

  if (url.pathname === '/api/v1/admin/session' && request.method === 'POST') {
    assertSameOrigin(request, config);
    context.rateLimiter.consume('admin-login', clientIp(request, config), {
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    const { password } = validateAdminLogin(await context.readJson());
    if (!verifyPassword(password, context.adminPasswordHash)) {
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        'رمز عبور صحیح نیست.',
      );
    }
    const rawToken = randomToken(32);
    const csrfToken = deriveToken(config.sessionSecret, 'admin-csrf', rawToken);
    const expiresAt = new Date(context.now().getTime() + config.sessionTtlMs).toISOString();
    store.createAdminSession(hashToken(rawToken), hashToken(csrfToken), expiresAt);
    appendSetCookie(response, adminCookie(rawToken, config));
    sendJson(response, 200, {
      authenticated: true,
      csrfToken,
      projectSlug: store.activeProjectSlug(),
    });
    return true;
  }

  if (url.pathname === '/api/v1/admin/session' && request.method === 'GET') {
    const auth = readSession(context, { required: false });
    if (!auth) {
      sendJson(response, 200, { authenticated: false });
      return true;
    }
    sendJson(response, 200, {
      authenticated: true,
      csrfToken: auth.csrfToken,
      projectSlug: store.activeProjectSlug(),
    });
    return true;
  }

  if (url.pathname === '/api/v1/admin/session' && request.method === 'DELETE') {
    assertSameOrigin(request, config);
    const auth = readSession(context, { csrf: true });
    store.deleteAdminSession(hashToken(auth.rawToken));
    appendSetCookie(response, expiredAdminCookie(config));
    sendJson(response, 200, { authenticated: false });
    return true;
  }

  if (await routePlatformAdminApi(context, readSession)) return true;

  if (url.pathname === '/api/v1/admin/project' && request.method === 'GET') {
    readSession(context);
    sendJson(response, 200, store.adminProject());
    return true;
  }

  if (url.pathname === '/api/v1/admin/project' && request.method === 'PUT') {
    assertSameOrigin(request, config);
    readSession(context, { csrf: true });
    const previousSlug = store.activeProjectSlug();
    const result = store.updateProject(validateProject(await context.readJson()));
    if (previousSlug !== result.project.slug) {
      publish(context, previousSlug, 'project-slug-changed');
    }
    publish(context, result.project.slug, 'project-updated');
    sendJson(response, 200, result);
    return true;
  }

  if (url.pathname === '/api/v1/admin/needs' && request.method === 'POST') {
    assertSameOrigin(request, config);
    readSession(context, { csrf: true });
    const result = store.createNeed(validateNeed(await context.readJson()));
    publish(context, store.activeProjectSlug(), 'need-created');
    sendJson(response, 201, result);
    return true;
  }

  if (url.pathname === '/api/v1/admin/needs/order' && request.method === 'PUT') {
    assertSameOrigin(request, config);
    readSession(context, { csrf: true });
    const ids = validateNeedOrder(await context.readJson());
    const result = store.reorderNeeds(ids);
    publish(context, store.activeProjectSlug(), 'needs-reordered');
    sendJson(response, 200, result);
    return true;
  }

  const needMatch = url.pathname.match(/^\/api\/v1\/admin\/needs\/([^/]+)$/);
  if (needMatch && request.method === 'PATCH') {
    assertSameOrigin(request, config);
    readSession(context, { csrf: true });
    const id = decodeSegment(needMatch[1]);
    const result = store.updateNeed(
      id,
      validateNeed(await context.readJson(), { partial: true }),
    );
    publish(context, store.activeProjectSlug(), 'need-updated');
    sendJson(response, 200, result);
    return true;
  }
  if (needMatch && request.method === 'DELETE') {
    assertSameOrigin(request, config);
    readSession(context, { csrf: true });
    const id = decodeSegment(needMatch[1]);
    const result = store.archiveNeed(id);
    publish(context, store.activeProjectSlug(), 'need-archived');
    sendJson(response, 200, result);
    return true;
  }

  if (url.pathname === '/api/v1/admin/proposals' && request.method === 'GET') {
    readSession(context);
    const status = url.searchParams.get('status') || '';
    if (status && !store.proposalStatuses.includes(status)) {
      throw badRequest('INVALID_STATUS', 'فیلتر وضعیت معتبر نیست.');
    }
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length > 100) {
      throw badRequest('INVALID_QUERY', 'عبارت جستجو بیش از حد طولانی است.');
    }
    const needId = (url.searchParams.get('needId') || '').trim();
    const limitText = url.searchParams.get('limit') || '200';
    const offsetText = url.searchParams.get('offset') || '0';
    const limit = Number(limitText);
    const offset = Number(offsetText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw badRequest('INVALID_PAGINATION', 'limit باید عددی بین ۱ تا ۲۰۰ باشد.');
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw badRequest('INVALID_PAGINATION', 'offset معتبر نیست.');
    }
    sendJson(response, 200, store.proposalList({
      status: status || null,
      query: query || null,
      needId: needId || null,
      limit,
      offset,
    }));
    return true;
  }

  const proposalMatch = url.pathname.match(
    /^\/api\/v1\/admin\/proposals\/([^/]+)$/,
  );
  if (proposalMatch && request.method === 'GET') {
    readSession(context);
    sendJson(
      response,
      200,
      store.proposalDetail(decodeSegment(proposalMatch[1])),
    );
    return true;
  }
  if (proposalMatch && request.method === 'PATCH') {
    assertSameOrigin(request, config);
    const auth = readSession(context, { csrf: true });
    const id = decodeSegment(proposalMatch[1]);
    const patch = validateProposalPatch(await context.readJson());
    const result = store.updateProposal(id, patch, auth.session.id);
    publish(context, result.proposal.need.projectSlug, 'proposal-updated');
    sendJson(response, 200, result);
    return true;
  }

  return false;
}

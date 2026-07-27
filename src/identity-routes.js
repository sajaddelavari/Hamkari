import {
  AppError,
  badRequest,
  forbidden,
  notFound,
  unauthorized,
} from './errors.js';
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
  safeEqual,
  serializeCookie,
} from './security.js';
import { hasPermission, PERMISSIONS } from './rbac.js';

export const IDENTITY_COOKIE = 'hamkari_identity';

function identityStore(context) {
  const store = context.identityStore || context.identity?.store;
  if (!store) throw new Error('Identity store is not configured.');
  return store;
}

function cookieOptions(config, maxAge) {
  return {
    path: '/',
    httpOnly: true,
    secure: Boolean(config.isProduction),
    sameSite: 'Strict',
    maxAge,
  };
}

function sessionCookie(rawToken, config) {
  return serializeCookie(
    IDENTITY_COOKIE,
    rawToken,
    cookieOptions(config, Math.floor((config.sessionTtlMs || 43_200_000) / 1_000)),
  );
}

function expiredSessionCookie(config) {
  return serializeCookie(
    IDENTITY_COOKIE,
    '',
    cookieOptions(config, 0),
  );
}

function readBody(context) {
  if (typeof context.readJson !== 'function') {
    throw new Error('Identity routes require context.readJson().');
  }
  return context.readJson();
}

function requireMutationOrigin(context) {
  assertSameOrigin(context.request, context.config);
}

function limiter(context, bucket, key, options) {
  context.rateLimiter?.consume(bucket, key, options);
}

function requestFingerprint(context) {
  const ip = clientIp(context.request, context.config);
  const secret = context.config.sessionSecret;
  return {
    ip,
    ipHash: deriveToken(secret, 'identity-ip', ip),
    userAgent: String(context.request.headers['user-agent'] || '').slice(0, 500),
  };
}

function authenticationPayload(context, auth) {
  return {
    authenticated: true,
    csrfToken: auth.csrfToken,
    user: auth.user,
    ...identityStore(context).organizationsForUser(auth.user.id),
    session: auth.session,
  };
}

function requireCurrentPassword(context, auth, password) {
  identityStore(context).authenticatePassword(auth.user.email, password);
}

function issueSession(context, userId, { mfaVerified = false } = {}) {
  const fingerprint = requestFingerprint(context);
  const auth = identityStore(context).createSession(userId, {
    ipHash: fingerprint.ipHash,
    userAgent: fingerprint.userAgent,
    mfaVerified,
  });
  appendSetCookie(
    context.response,
    sessionCookie(auth.rawToken, context.config),
  );
  return auth;
}

export function readIdentitySession(
  context,
  { required = true, csrf = false } = {},
) {
  if (context.identityAuth) {
    const cached = context.identityAuth;
    if (csrf) {
      const supplied = String(context.request.headers['x-csrf-token'] || '');
      if (!supplied || !safeEqual(supplied, cached.csrfToken)) {
        throw new AppError(
          403,
          'INVALID_CSRF_TOKEN',
          'توکن امنیتی درخواست صحیح نیست.',
        );
      }
    }
    return cached;
  }
  const rawToken = parseCookies(context.request.headers.cookie)[IDENTITY_COOKIE];
  const auth = rawToken
    ? identityStore(context).sessionByToken(rawToken)
    : null;
  if (!auth) {
    if (rawToken) {
      appendSetCookie(
        context.response,
        expiredSessionCookie(context.config),
      );
    }
    if (required) throw unauthorized('برای ادامه وارد حساب کاربری شوید.');
    return null;
  }
  if (csrf) {
    const supplied = String(context.request.headers['x-csrf-token'] || '');
    if (
      !supplied ||
      !safeEqual(supplied, auth.csrfToken) ||
      !safeEqual(hashToken(supplied), hashToken(auth.csrfToken))
    ) {
      throw new AppError(
        403,
        'INVALID_CSRF_TOKEN',
        'توکن امنیتی درخواست صحیح نیست.',
      );
    }
  }
  context.identityAuth = auth;
  return auth;
}

export function authorizeOrganization(
  context,
  organizationId,
  permission = PERMISSIONS.ORGANIZATION_READ,
  { csrf = false } = {},
) {
  const auth = readIdentitySession(context, { csrf });
  const authorization = identityStore(context).organizationAuthorization(
    auth.user.id,
    organizationId,
  );
  if (!authorization) {
    throw notFound('ORGANIZATION_NOT_FOUND', 'سازمان موردنظر پیدا نشد.');
  }
  if (permission && !hasPermission(authorization, permission)) {
    throw forbidden(
      'INSUFFICIENT_PERMISSION',
      'اجازهٔ انجام این عملیات را ندارید.',
    );
  }
  return { ...auth, authorization };
}

export function authorizeProject(
  context,
  projectId,
  permission = PERMISSIONS.PROJECT_READ,
  { csrf = false } = {},
) {
  const auth = readIdentitySession(context, { csrf });
  const authorization = identityStore(context).projectAuthorization(
    auth.user.id,
    projectId,
  );
  if (!authorization) {
    // Conceal project existence across organization boundaries.
    throw notFound('PROJECT_NOT_FOUND', 'پروژهٔ موردنظر پیدا نشد.');
  }
  if (permission && !hasPermission(authorization, permission)) {
    throw forbidden(
      'INSUFFICIENT_PERMISSION',
      'اجازهٔ انجام این عملیات را ندارید.',
    );
  }
  return { ...auth, authorization };
}

function requireOwnerPermission(context, organizationId, authorization) {
  if (!hasPermission(authorization, PERMISSIONS.OWNERSHIP_MANAGE)) {
    throw forbidden(
      'OWNER_PERMISSION_REQUIRED',
      'این عملیات فقط توسط مالک سازمان قابل انجام است.',
    );
  }
}

function pathSegments(pathname, prefix) {
  if (pathname === prefix) return [];
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname
    .slice(prefix.length + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
}

async function routeAuth(context) {
  const { request, response, url, config } = context;
  const store = identityStore(context);
  if (!url.pathname.startsWith('/api/v2/auth/')) return false;

  if (url.pathname === '/api/v2/auth/session' && request.method === 'GET') {
    const auth = readIdentitySession(context, { required: false });
    sendJson(
      response,
      200,
      auth
        ? authenticationPayload(context, auth)
        : { authenticated: false },
    );
    return true;
  }

  if (url.pathname === '/api/v2/auth/session' && request.method === 'POST') {
    requireMutationOrigin(context);
    const fingerprint = requestFingerprint(context);
    limiter(context, 'identity-login-ip', fingerprint.ip, {
      limit: 10,
      windowMs: 15 * 60 * 1_000,
    });
    const body = await readBody(context);
    const emailKey = deriveToken(
      config.sessionSecret,
      'identity-login-email',
      String(body.email || '').trim().toLowerCase(),
    );
    limiter(context, 'identity-login-email', emailKey, {
      limit: 8,
      windowMs: 15 * 60 * 1_000,
    });
    const login = store.authenticatePassword(body.email, body.password);
    let mfaVerified = false;
    if (login.mfaRequired) {
      if (body.totpCode === undefined && body.backupCode === undefined) {
        sendJson(response, 202, {
          authenticated: false,
          mfaRequired: true,
          user: {
            email: login.user.email,
            fullName: login.user.fullName,
          },
        });
        return true;
      }
      limiter(context, 'identity-mfa-user', login.user.id, {
        limit: 8,
        windowMs: 10 * 60 * 1_000,
      });
      store.verifySecondFactor(login.user.id, {
        totpCode: body.totpCode,
        backupCode: body.backupCode,
      });
      mfaVerified = true;
    }
    const auth = issueSession(context, login.user.id, { mfaVerified });
    sendJson(response, 200, authenticationPayload(context, auth));
    return true;
  }

  if (url.pathname === '/api/v2/auth/session' && request.method === 'DELETE') {
    requireMutationOrigin(context);
    const auth = readIdentitySession(context, { csrf: true });
    store.revokeSession(auth.rawToken);
    appendSetCookie(response, expiredSessionCookie(config));
    sendJson(response, 200, { authenticated: false });
    return true;
  }

  if (
    url.pathname === '/api/v2/auth/invitations/inspect' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const fingerprint = requestFingerprint(context);
    limiter(context, 'identity-invitation-inspect', fingerprint.ip, {
      limit: 60,
      windowMs: 60 * 60 * 1_000,
    });
    const body = await readBody(context);
    sendJson(response, 200, store.inspectInvitation(body.token));
    return true;
  }

  if (
    url.pathname === '/api/v2/auth/invitations/accept' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const fingerprint = requestFingerprint(context);
    limiter(context, 'identity-invitation-accept', fingerprint.ip, {
      limit: 20,
      windowMs: 60 * 60 * 1_000,
    });
    const body = await readBody(context);
    const result = store.acceptInvitation(body.token, {
      fullName: body.fullName,
      password: body.password,
    });
    if (result.user.mfaEnabled) {
      sendJson(response, 200, {
        ...result,
        authenticated: false,
        loginRequired: true,
      });
      return true;
    }
    const auth = issueSession(context, result.user.id);
    sendJson(response, 200, {
      ...result,
      ...authenticationPayload(context, auth),
    });
    return true;
  }

  if (
    url.pathname === '/api/v2/auth/password-reset/request' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const fingerprint = requestFingerprint(context);
    limiter(context, 'identity-reset-ip', fingerprint.ip, {
      limit: 8,
      windowMs: 60 * 60 * 1_000,
    });
    const body = await readBody(context);
    const emailKey = deriveToken(
      config.sessionSecret,
      'identity-reset-email',
      String(body.email || '').trim().toLowerCase(),
    );
    limiter(context, 'identity-reset-email', emailKey, {
      limit: 4,
      windowMs: 60 * 60 * 1_000,
    });
    let reset = null;
    try {
      reset = store.requestPasswordReset(body.email);
    } catch (error) {
      // Invalid and unknown email addresses receive the same public response.
      if (error?.code !== 'VALIDATION_FAILED') throw error;
    }
    if (reset?.created && context.identityNotifications?.passwordReset) {
      await context.identityNotifications.passwordReset(reset);
    }
    sendJson(response, 202, {
      accepted: true,
      message: 'اگر حسابی با این ایمیل وجود داشته باشد، راهنمای بازنشانی ارسال می‌شود.',
    });
    return true;
  }

  if (
    url.pathname === '/api/v2/auth/password-reset/complete' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const fingerprint = requestFingerprint(context);
    limiter(context, 'identity-reset-complete', fingerprint.ip, {
      limit: 20,
      windowMs: 60 * 60 * 1_000,
    });
    const body = await readBody(context);
    sendJson(
      response,
      200,
      store.completePasswordReset(body.token, body.newPassword),
    );
    return true;
  }

  return false;
}

async function routeMe(context) {
  const { request, response, url } = context;
  const store = identityStore(context);
  if (!url.pathname.startsWith('/api/v2/admin/me')) return false;

  if (url.pathname === '/api/v2/admin/me' && request.method === 'GET') {
    const auth = readIdentitySession(context);
    sendJson(response, 200, {
      user: auth.user,
      ...store.organizationsForUser(auth.user.id),
      session: auth.session,
    });
    return true;
  }

  if (url.pathname === '/api/v2/admin/me' && request.method === 'PATCH') {
    requireMutationOrigin(context);
    const auth = readIdentitySession(context, { csrf: true });
    sendJson(response, 200, store.updateProfile(auth.user.id, await readBody(context)));
    return true;
  }

  if (
    url.pathname === '/api/v2/admin/me/password' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const auth = readIdentitySession(context, { csrf: true });
    const body = await readBody(context);
    sendJson(response, 200, store.changePassword(auth.user.id, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      keepSessionId: auth.session.id,
    }));
    return true;
  }

  if (
    url.pathname === '/api/v2/admin/me/mfa/totp/setup' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const auth = readIdentitySession(context, { csrf: true });
    const body = await readBody(context);
    requireCurrentPassword(context, auth, body.currentPassword);
    sendJson(
      response,
      200,
      store.beginTotpEnrollment(auth.user.id, {
        issuer: body.issuer,
      }),
    );
    return true;
  }

  if (
    url.pathname === '/api/v2/admin/me/mfa/totp/confirm' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const auth = readIdentitySession(context, { csrf: true });
    const body = await readBody(context);
    sendJson(
      response,
      200,
      store.confirmTotpEnrollment(auth.user.id, body.code, {
        sessionId: auth.session.id,
      }),
    );
    return true;
  }

  if (
    url.pathname === '/api/v2/admin/me/mfa/backup-codes/regenerate' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const auth = readIdentitySession(context, { csrf: true });
    const body = await readBody(context);
    requireCurrentPassword(context, auth, body.currentPassword);
    sendJson(
      response,
      200,
      store.regenerateBackupCodes(auth.user.id, {
        totpCode: body.totpCode,
        backupCode: body.backupCode,
      }),
    );
    return true;
  }

  if (
    url.pathname === '/api/v2/admin/me/mfa/disable' &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const auth = readIdentitySession(context, { csrf: true });
    const body = await readBody(context);
    requireCurrentPassword(context, auth, body.currentPassword);
    const result = store.disableMfa(auth.user.id, {
      totpCode: body.totpCode,
      backupCode: body.backupCode,
    });
    appendSetCookie(
      response,
      expiredSessionCookie(context.config),
    );
    sendJson(response, 200, result);
    return true;
  }

  return false;
}

async function routeOrganizations(context) {
  const { request, response, url } = context;
  const store = identityStore(context);
  const prefix = '/api/v2/admin/organizations';
  const parts = pathSegments(url.pathname, prefix);
  if (parts === null) return false;

  if (parts.length === 0 && request.method === 'GET') {
    const auth = readIdentitySession(context);
    sendJson(response, 200, store.organizationsForUser(auth.user.id));
    return true;
  }

  if (parts.length === 0 && request.method === 'POST') {
    requireMutationOrigin(context);
    const auth = readIdentitySession(context, { csrf: true });
    sendJson(
      response,
      201,
      store.createOrganization(auth.user.id, await readBody(context)),
    );
    return true;
  }

  const [organizationId, resource, resourceId, nested, nestedId] = parts;
  if (!organizationId) return false;

  if (parts.length === 1 && request.method === 'GET') {
    const auth = authorizeOrganization(
      context,
      organizationId,
      PERMISSIONS.ORGANIZATION_READ,
    );
    sendJson(response, 200, {
      organization: auth.authorization.organization,
      membership: auth.authorization.membership,
      permissions: auth.authorization.serializedPermissions,
    });
    return true;
  }

  if (parts.length === 1 && request.method === 'PATCH') {
    requireMutationOrigin(context);
    const auth = authorizeOrganization(
      context,
      organizationId,
      PERMISSIONS.ORGANIZATION_MANAGE,
      { csrf: true },
    );
    sendJson(
      response,
      200,
      store.updateOrganization(
        organizationId,
        await readBody(context),
        auth.user.id,
      ),
    );
    return true;
  }

  if (parts.length === 1 && request.method === 'DELETE') {
    requireMutationOrigin(context);
    const auth = authorizeOrganization(
      context,
      organizationId,
      PERMISSIONS.OWNERSHIP_MANAGE,
      { csrf: true },
    );
    sendJson(
      response,
      200,
      store.archiveOrganization(organizationId, auth.user.id),
    );
    return true;
  }

  if (resource === 'members' && parts.length === 2 && request.method === 'GET') {
    authorizeOrganization(context, organizationId, PERMISSIONS.MEMBERS_READ);
    sendJson(response, 200, store.listOrganizationMembers(organizationId));
    return true;
  }

  if (resource === 'members' && parts.length === 2 && request.method === 'POST') {
    requireMutationOrigin(context);
    const auth = authorizeOrganization(
      context,
      organizationId,
      PERMISSIONS.MEMBERS_MANAGE,
      { csrf: true },
    );
    const body = await readBody(context);
    if (body.roleKey === 'owner') {
      requireOwnerPermission(context, organizationId, auth.authorization);
    }
    sendJson(
      response,
      201,
      store.createOrganizationMembership(
        organizationId,
        body,
        auth.user.id,
      ),
    );
    return true;
  }

  if (
    resource === 'members' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'PATCH'
  ) {
    requireMutationOrigin(context);
    const auth = authorizeOrganization(
      context,
      organizationId,
      PERMISSIONS.MEMBERS_MANAGE,
      { csrf: true },
    );
    const body = await readBody(context);
    const current = store.listOrganizationMembers(organizationId).members
      .find((member) => member.id === resourceId);
    if (!current) throw notFound('MEMBERSHIP_NOT_FOUND', 'عضویت موردنظر پیدا نشد.');
    if (current.roleKey === 'owner' || body.roleKey === 'owner') {
      requireOwnerPermission(context, organizationId, auth.authorization);
    }
    sendJson(
      response,
      200,
      store.updateOrganizationMembership(
        organizationId,
        resourceId,
        body,
        auth.user.id,
      ),
    );
    return true;
  }

  if (
    resource === 'members' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'DELETE'
  ) {
    requireMutationOrigin(context);
    const auth = authorizeOrganization(
      context,
      organizationId,
      PERMISSIONS.MEMBERS_MANAGE,
      { csrf: true },
    );
    const current = store.listOrganizationMembers(organizationId).members
      .find((member) => member.id === resourceId);
    if (!current) throw notFound('MEMBERSHIP_NOT_FOUND', 'عضویت موردنظر پیدا نشد.');
    if (current.roleKey === 'owner') {
      requireOwnerPermission(context, organizationId, auth.authorization);
    }
    sendJson(
      response,
      200,
      store.deleteOrganizationMembership(
        organizationId,
        resourceId,
        auth.user.id,
      ),
    );
    return true;
  }

  if (
    resource === 'invitations' &&
    parts.length === 2 &&
    request.method === 'GET'
  ) {
    authorizeOrganization(context, organizationId, PERMISSIONS.MEMBERS_READ);
    sendJson(
      response,
      200,
      store.listInvitations(organizationId, {
        includeClosed: url.searchParams.get('includeClosed') === 'true',
      }),
    );
    return true;
  }

  if (
    resource === 'invitations' &&
    parts.length === 2 &&
    request.method === 'POST'
  ) {
    requireMutationOrigin(context);
    const auth = authorizeOrganization(
      context,
      organizationId,
      PERMISSIONS.MEMBERS_MANAGE,
      { csrf: true },
    );
    const body = await readBody(context);
    if (body.roleKey === 'owner') {
      requireOwnerPermission(context, organizationId, auth.authorization);
    }
    const result = store.createInvitation({
      organizationId,
      email: body.email,
      roleKey: body.roleKey,
      projectId: body.projectId,
      invitedByUserId: auth.user.id,
    });
    if (context.identityNotifications?.invitation) {
      await context.identityNotifications.invitation(result);
    }
    sendJson(response, 201, result);
    return true;
  }

  if (
    resource === 'invitations' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'DELETE'
  ) {
    requireMutationOrigin(context);
    const auth = authorizeOrganization(
      context,
      organizationId,
      PERMISSIONS.MEMBERS_MANAGE,
      { csrf: true },
    );
    const invitation = store.listInvitations(organizationId, {
      includeClosed: true,
    }).invitations.find((item) => item.id === resourceId);
    if (invitation?.roleKey === 'owner') {
      requireOwnerPermission(context, organizationId, auth.authorization);
    }
    sendJson(
      response,
      200,
      store.revokeInvitation(organizationId, resourceId, auth.user.id),
    );
    return true;
  }

  if (
    resource === 'projects' &&
    resourceId &&
    nested === 'members' &&
    parts.length === 4 &&
    request.method === 'GET'
  ) {
    authorizeProject(
      context,
      resourceId,
      PERMISSIONS.PROJECT_MEMBERS_MANAGE,
    );
    sendJson(
      response,
      200,
      store.listProjectMemberships(organizationId, resourceId),
    );
    return true;
  }

  if (
    resource === 'projects' &&
    resourceId &&
    nested === 'members' &&
    nestedId &&
    parts.length === 5 &&
    request.method === 'PUT'
  ) {
    requireMutationOrigin(context);
    const auth = authorizeProject(
      context,
      resourceId,
      PERMISSIONS.PROJECT_MEMBERS_MANAGE,
      { csrf: true },
    );
    const body = await readBody(context);
    sendJson(
      response,
      200,
      store.upsertProjectMembership(
        organizationId,
        resourceId,
        nestedId,
        body.roleKey,
        auth.user.id,
      ),
    );
    return true;
  }

  if (
    resource === 'projects' &&
    resourceId &&
    nested === 'members' &&
    nestedId &&
    parts.length === 5 &&
    request.method === 'DELETE'
  ) {
    requireMutationOrigin(context);
    const auth = authorizeProject(
      context,
      resourceId,
      PERMISSIONS.PROJECT_MEMBERS_MANAGE,
      { csrf: true },
    );
    sendJson(
      response,
      200,
      store.deleteProjectMembership(
        organizationId,
        resourceId,
        nestedId,
        auth.user.id,
      ),
    );
    return true;
  }

  return false;
}

export async function routeIdentityApi(context) {
  const pathname = context.url.pathname;
  if (!pathname.startsWith('/api/v2/')) return false;
  if (await routeAuth(context)) return true;
  if (await routeMe(context)) return true;
  if (await routeOrganizations(context)) return true;
  return false;
}

export const identityRouteInternals = Object.freeze({
  sessionCookie,
  expiredSessionCookie,
  authenticationPayload,
});

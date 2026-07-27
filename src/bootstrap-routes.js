import { AppError, badRequest, conflict } from './errors.js';
import { assertSameOrigin, clientIp, sendJson } from './http.js';
import { readLegacyAdminSession } from './admin-routes.js';
import { createPasswordHash } from './security.js';

const DEFAULT_ORGANIZATION_ID = 'default-organization';

function requiredText(value, field, minimum, maximum) {
  const selected = String(value || '').trim();
  if (selected.length < minimum || selected.length > maximum) {
    throw badRequest('VALIDATION_ERROR', 'اطلاعات راه‌اندازی معتبر نیست.', {
      [field]: `طول این فیلد باید بین ${minimum} تا ${maximum} نویسه باشد.`,
    });
  }
  return selected;
}

function emailValue(value) {
  const selected = String(value || '').trim().toLowerCase();
  if (
    selected.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(selected)
  ) {
    throw badRequest('VALIDATION_ERROR', 'ایمیل مالک معتبر نیست.', {
      email: 'یک ایمیل معتبر وارد کنید.',
    });
  }
  return selected;
}

export async function routeBootstrapApi(context) {
  const { request, response, url, identityStore } = context;
  if (url.pathname !== '/api/v2/auth/bootstrap') return false;

  if (request.method === 'GET') {
    const legacy = readLegacyAdminSession(context, { required: false });
    const owner = context.db.prepare(`
      SELECT u.id,u.email,u.full_name
      FROM organization_memberships m
      JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=? AND m.role_key='owner' AND m.status='active'
      ORDER BY m.created_at,m.id LIMIT 1
    `).get(DEFAULT_ORGANIZATION_ID);
    sendJson(response, 200, {
      bootstrapRequired: !owner,
      legacyAuthenticated: Boolean(legacy),
      ownerConfigured: Boolean(owner),
    });
    return true;
  }

  if (request.method === 'POST') {
    assertSameOrigin(request, context.config);
    const existing = context.db.prepare(`
      SELECT 1
      FROM organization_memberships
      WHERE organization_id=? AND role_key='owner' AND status='active'
      LIMIT 1
    `).get(DEFAULT_ORGANIZATION_ID);
    if (existing) {
      throw conflict(
        'BOOTSTRAP_ALREADY_COMPLETED',
        'راه‌اندازی اولیه قبلاً انجام شده است؛ با حساب شخصی وارد شوید.',
      );
    }
    readLegacyAdminSession(context, { csrf: true });
    context.rateLimiter.consume(
      'identity-bootstrap',
      clientIp(request, context.config),
      { limit: 5, windowMs: 60 * 60 * 1000 },
    );
    const input = await context.readJson();
    const email = emailValue(input.email);
    const fullName = requiredText(input.fullName, 'fullName', 2, 160);
    const organizationName = requiredText(
      input.organizationName,
      'organizationName',
      2,
      200,
    );
    const password = String(input.password || '');
    if (password.length < 12 || password.length > 256) {
      throw badRequest('VALIDATION_ERROR', 'رمز شخصی معتبر نیست.', {
        password: 'رمز باید حداقل ۱۲ نویسه باشد.',
      });
    }
    let result;
    try {
      result = identityStore.bootstrapOwner({
        organizationId: DEFAULT_ORGANIZATION_ID,
        email,
        fullName,
        organizationName,
        passwordHash: createPasswordHash(password),
        passwordProbe: password,
      });
      context.db.prepare('DELETE FROM admin_sessions').run();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'BOOTSTRAP_FAILED',
        'ساخت حساب مالک کامل نشد؛ هیچ رمز خامی ذخیره نشده است.',
      );
    }
    sendJson(response, 201, {
      created: true,
      user: result.user,
      organization: identityStore.organizationById(DEFAULT_ORGANIZATION_ID),
    });
    return true;
  }
  return false;
}

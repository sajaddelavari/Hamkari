import { randomUUID } from 'node:crypto';
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  unauthorized,
} from './errors.js';
import { withTransaction } from './database.js';
import {
  createPasswordHash,
  deriveToken,
  hashToken,
  randomToken,
  safeEqual,
  verifyPassword,
} from './security.js';
import {
  generateBackupCodes,
  generateTotpSecret,
  normalizeBackupCode,
  sealTotpState,
  totpUri,
  unsealTotpState,
  verifyTotpCode,
} from './totp.js';
import {
  isOrganizationRole,
  isProjectRole,
  organizationRoleGrantsAllProjects,
  permissionsForRoles,
  serializePermissions,
} from './rbac.js';

const DEFAULT_ORGANIZATION_ID = 'default-organization';
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RESET_TTL_MS = 60 * 60 * 1000;
const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const DUMMY_PASSWORD_HASH = createPasswordHash(
  'identity-dummy-password-never-used',
  { salt: Buffer.from('identity-dummy-s').toString('base64url') },
);

function nowDate(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Identity clock is invalid.');
  return date;
}

function emailValue(value) {
  const email = String(value || '').trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  ) {
    throw badRequest(
      'VALIDATION_FAILED',
      'اطلاعات واردشده معتبر نیست.',
      { email: 'نشانی ایمیل معتبر وارد کنید.' },
    );
  }
  return email;
}

function passwordValue(value, field = 'password') {
  if (
    typeof value !== 'string' ||
    value.length < 12 ||
    value.length > 256
  ) {
    throw badRequest(
      'VALIDATION_FAILED',
      'اطلاعات واردشده معتبر نیست.',
      { [field]: 'رمز عبور باید بین ۱۲ تا ۲۵۶ نویسه باشد.' },
    );
  }
  return value;
}

function textValue(
  value,
  field,
  { minimum = 0, maximum = 200, required = false } = {},
) {
  const selected = typeof value === 'string' ? value.trim() : '';
  const min = required ? Math.max(1, minimum) : minimum;
  if (selected.length < min || selected.length > maximum) {
    throw badRequest(
      'VALIDATION_FAILED',
      'اطلاعات واردشده معتبر نیست.',
      { [field]: `طول این فیلد باید بین ${min} تا ${maximum} نویسه باشد.` },
    );
  }
  return selected;
}

function idValue(value, field = 'id') {
  const selected = String(value || '').trim();
  if (!selected || selected.length > 200 || /[\u0000-\u001f]/.test(selected)) {
    throw badRequest(
      'VALIDATION_FAILED',
      'شناسهٔ ارسال‌شده معتبر نیست.',
      { [field]: 'شناسه معتبر نیست.' },
    );
  }
  return selected;
}

function slugValue(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (
    slug.length < 2 ||
    slug.length > 80 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  ) {
    throw badRequest(
      'VALIDATION_FAILED',
      'اطلاعات سازمان معتبر نیست.',
      { slug: 'شناسهٔ کوتاه باید شامل حروف انگلیسی کوچک، عدد و خط تیره باشد.' },
    );
  }
  return slug;
}

function organizationRoleValue(value) {
  if (!isOrganizationRole(value)) {
    throw badRequest(
      'VALIDATION_FAILED',
      'نقش سازمانی معتبر نیست.',
      { roleKey: 'نقش سازمانی انتخاب‌شده معتبر نیست.' },
    );
  }
  return value;
}

function projectRoleValue(value) {
  if (!isProjectRole(value)) {
    throw badRequest(
      'VALIDATION_FAILED',
      'نقش پروژه معتبر نیست.',
      { roleKey: 'نقش پروژه انتخاب‌شده معتبر نیست.' },
    );
  }
  return value;
}

function membershipStatusValue(value) {
  if (!['invited', 'active', 'suspended'].includes(value)) {
    throw badRequest(
      'VALIDATION_FAILED',
      'وضعیت عضویت معتبر نیست.',
      { status: 'وضعیت عضویت معتبر نیست.' },
    );
  }
  return value;
}

function userView(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    mobile: row.mobile,
    avatarUrl: row.avatar_url,
    locale: row.locale,
    status: row.status,
    emailVerifiedAt: row.email_verified_at,
    passwordChangedAt: row.password_changed_at,
    mfaEnabled: Boolean(row.mfa_enabled),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function organizationView(row) {
  if (!row) return null;
  let settings = {};
  try {
    settings = JSON.parse(row.settings_json || '{}');
  } catch {
    settings = {};
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    legalName: row.legal_name,
    nationalId: row.national_id,
    website: row.website,
    description: row.description,
    logoUrl: row.logo_url,
    timezone: row.timezone,
    defaultCurrency: row.default_currency,
    status: row.status,
    settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function membershipView(row) {
  const user = row.user_id && row.user_email
    ? {
        id: row.user_id,
        email: row.user_email,
        full_name: row.user_full_name,
        mobile: row.user_mobile,
        avatar_url: row.user_avatar_url,
        locale: row.user_locale,
        status: row.user_status,
        email_verified_at: row.user_email_verified_at,
        password_changed_at: row.user_password_changed_at,
        mfa_enabled: row.user_mfa_enabled,
        last_login_at: row.user_last_login_at,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at,
      }
    : null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    roleKey: row.role_key,
    status: row.status,
    joinedAt: row.joined_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(user ? { user: userView(user) } : {}),
  };
}

function projectMembershipView(row) {
  const user = row.user_id && row.user_email
    ? {
        id: row.user_id,
        email: row.user_email,
        full_name: row.user_full_name,
        mobile: row.user_mobile,
        avatar_url: row.user_avatar_url,
        locale: row.user_locale,
        status: row.user_status,
        email_verified_at: row.user_email_verified_at,
        password_changed_at: row.user_password_changed_at,
        mfa_enabled: row.user_mfa_enabled,
        last_login_at: row.user_last_login_at,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at,
      }
    : null;
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    roleKey: row.role_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(user ? { user: userView(user) } : {}),
  };
}

function invitationView(row, { includeEmail = true } = {}) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    ...(includeEmail ? { email: row.email } : {}),
    roleKey: row.project_id
      ? (row.project_role_key || row.role_key)
      : row.role_key,
    projectId: row.project_id,
    projectTitle: row.project_title || null,
    invitedByUserId: row.invited_by_user_id,
    inviterName: row.inviter_name || null,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function sessionView(row) {
  return {
    id: row.id,
    userId: row.user_id,
    ipHash: row.ip_hash,
    userAgent: row.user_agent,
    mfaVerifiedAt: row.mfa_verified_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function tokenValue(value, code, message) {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw badRequest(code, message);
  }
  return token;
}

function sqliteConflict(error, code, message) {
  if (
    error?.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' ||
    String(error?.message || '').includes('UNIQUE constraint failed')
  ) {
    throw conflict(code, message);
  }
  throw error;
}

export function createIdentityStore(db, options = {}) {
  const clock = options.clock || (() => new Date());
  const sessionSecret = String(options.sessionSecret || '');
  const encryptionSecret = String(options.encryptionSecret || sessionSecret);
  const sessionTtlMs = options.sessionTtlMs || DEFAULT_SESSION_TTL_MS;
  const invitationTtlMs = options.invitationTtlMs || DEFAULT_INVITATION_TTL_MS;
  const resetTtlMs = options.resetTtlMs || DEFAULT_RESET_TTL_MS;
  const enrollmentTtlMs = options.enrollmentTtlMs || DEFAULT_ENROLLMENT_TTL_MS;
  const auditHook = typeof options.audit === 'function' ? options.audit : null;

  if (sessionSecret.length < 32) {
    throw new Error('Identity session secret must contain at least 32 characters.');
  }
  if (encryptionSecret.length < 16) {
    throw new Error('Identity encryption secret must contain at least 16 characters.');
  }

  function emitAudit(action, details = {}) {
    if (!auditHook) return;
    auditHook({
      action,
      actorType: 'user',
      actorId: details.actorUserId || null,
      organizationId: details.organizationId || null,
      projectId: details.projectId || null,
      resourceType: details.resourceType || 'identity',
      resourceId: details.resourceId || '',
      before: details.before ?? null,
      after: details.after ?? null,
      metadata: details.metadata || {},
      createdAt: nowDate(clock).toISOString(),
    });
  }

  function requireUser(userId, { active = false } = {}) {
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(idValue(userId, 'userId'));
    if (!row || (active && row.status !== 'active')) {
      throw notFound('USER_NOT_FOUND', 'کاربر موردنظر پیدا نشد.');
    }
    return row;
  }

  function requireOrganization(organizationId, { active = false } = {}) {
    const row = db.prepare('SELECT * FROM organizations WHERE id=?')
      .get(idValue(organizationId, 'organizationId'));
    if (
      !row ||
      (active && (row.status !== 'active' || row.archived_at))
    ) {
      throw notFound('ORGANIZATION_NOT_FOUND', 'سازمان موردنظر پیدا نشد.');
    }
    return row;
  }

  function requireProjectInOrganization(projectId, organizationId) {
    const row = db.prepare(`
      SELECT id, organization_id, title, slug, archived_at
      FROM projects
      WHERE id=? AND organization_id=?
    `).get(
      idValue(projectId, 'projectId'),
      idValue(organizationId, 'organizationId'),
    );
    if (!row) throw notFound('PROJECT_NOT_FOUND', 'پروژهٔ موردنظر پیدا نشد.');
    return row;
  }

  function bootstrapOwner(input = {}) {
    const organizationId = input.organizationId || DEFAULT_ORGANIZATION_ID;
    const email = emailValue(input.email);
    const organizationName = input.organizationName === undefined
      ? null
      : textValue(input.organizationName, 'organizationName', {
        minimum: 2,
        maximum: 200,
        required: true,
      });
    const fullName = textValue(
      input.fullName || 'مدیر سامانه',
      'fullName',
      { minimum: 2, maximum: 160, required: true },
    );
    const passwordHash = String(input.passwordHash || '').trim();
    if (
      !/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]{11,}\$[A-Za-z0-9_-]{22,}$/.test(
        passwordHash,
      )
    ) {
      throw badRequest(
        'INVALID_PASSWORD_HASH',
        'هش رمز مدیر اولیه معتبر نیست.',
      );
    }
    requireOrganization(organizationId);
    return withTransaction(db, () => {
      const existingOwner = db.prepare(`
        SELECT u.*
        FROM organization_memberships om
        JOIN users u ON u.id=om.user_id
        WHERE om.organization_id=? AND om.role_key='owner' AND om.status='active'
        ORDER BY om.created_at, om.id
        LIMIT 1
      `).get(organizationId);
      if (existingOwner) {
        return { user: userView(existingOwner), created: false };
      }
      const now = nowDate(clock).toISOString();
      let user = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email);
      if (!user) {
        const userId = randomUUID();
        db.prepare(`
          INSERT INTO users(
            id, email, password_hash, full_name, status, email_verified_at,
            password_changed_at, created_at, updated_at
          ) VALUES(?,?,?,?, 'active', ?,?,?,?)
        `).run(
          userId,
          email,
          passwordHash,
          fullName,
          now,
          now,
          now,
          now,
        );
        user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      } else if (user.status !== 'active') {
        db.prepare(`
          UPDATE users
          SET status='active', password_hash=?, password_changed_at=?,
              email_verified_at=COALESCE(email_verified_at,?), updated_at=?
          WHERE id=?
        `).run(passwordHash, now, now, now, user.id);
        user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      }
      db.prepare(`
        INSERT INTO organization_memberships(
          id, organization_id, user_id, role_key, status,
          joined_at, created_at, updated_at
        ) VALUES(?,?,?, 'owner', 'active', ?,?,?)
        ON CONFLICT(organization_id,user_id) DO UPDATE SET
          role_key='owner', status='active',
          joined_at=COALESCE(organization_memberships.joined_at, excluded.joined_at),
          updated_at=excluded.updated_at
      `).run(randomUUID(), organizationId, user.id, now, now, now);
      if (organizationName) {
        db.prepare(`
          UPDATE organizations SET name=?,updated_at=? WHERE id=?
        `).run(organizationName, now, organizationId);
      }
      emitAudit('identity.owner_bootstrapped', {
        actorUserId: user.id,
        organizationId,
        resourceType: 'user',
        resourceId: user.id,
        metadata: organizationName ? { organizationNameChanged: true } : {},
      });
      return { user: userView(user), created: true };
    });
  }

  function authenticatePassword(emailInput, passwordInput) {
    const email = emailValue(emailInput);
    const password = typeof passwordInput === 'string' ? passwordInput : '';
    const row = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email);
    const valid = verifyPassword(password, row?.password_hash || DUMMY_PASSWORD_HASH);
    if (!valid || !row || row.status !== 'active') {
      throw unauthorized('ایمیل یا رمز عبور صحیح نیست.');
    }
    return {
      user: userView(row),
      mfaRequired: Boolean(row.mfa_enabled),
    };
  }

  function createSession(userId, input = {}) {
    const user = requireUser(userId, { active: true });
    if (user.mfa_enabled && !input.mfaVerified) {
      throw new AppError(
        403,
        'MFA_REQUIRED',
        'برای ورود، کد احراز هویت دومرحله‌ای لازم است.',
      );
    }
    const now = nowDate(clock);
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + sessionTtlMs).toISOString();
    const rawToken = randomToken(32);
    const csrfToken = deriveToken(sessionSecret, 'identity-csrf', rawToken);
    const id = randomUUID();
    const ipHash = String(input.ipHash || '').slice(0, 200);
    const userAgent = String(input.userAgent || '').slice(0, 500);
    db.prepare(`
      INSERT INTO user_sessions(
        id, user_id, token_hash, csrf_token_hash, ip_hash, user_agent,
        mfa_verified_at, created_at, last_seen_at, expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      user.id,
      hashToken(rawToken),
      hashToken(csrfToken),
      ipHash,
      userAgent,
      input.mfaVerified ? nowIso : null,
      nowIso,
      nowIso,
      expiresAt,
    );
    db.prepare('UPDATE users SET last_login_at=?, updated_at=? WHERE id=?')
      .run(nowIso, nowIso, user.id);
    emitAudit('identity.session_created', {
      actorUserId: user.id,
      resourceType: 'user_session',
      resourceId: id,
    });
    return {
      rawToken,
      csrfToken,
      session: {
        id,
        userId: user.id,
        ipHash,
        userAgent,
        mfaVerifiedAt: input.mfaVerified ? nowIso : null,
        createdAt: nowIso,
        lastSeenAt: nowIso,
        expiresAt,
        revokedAt: null,
      },
      user: userView({ ...user, last_login_at: nowIso, updated_at: nowIso }),
    };
  }

  function sessionByToken(rawTokenInput, { touch = true } = {}) {
    const rawToken = String(rawTokenInput || '');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(rawToken)) return null;
    const now = nowDate(clock).toISOString();
    db.prepare(`
      DELETE FROM user_sessions
      WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?)
    `).run(now, now);
    const row = db.prepare(`
      SELECT
        s.*,
        u.email, u.password_hash, u.full_name, u.mobile, u.avatar_url,
        u.locale, u.status AS user_status, u.email_verified_at,
        u.password_changed_at, u.mfa_enabled, u.totp_secret_sealed,
        u.last_login_at, u.created_at AS user_created_at,
        u.updated_at AS user_updated_at
      FROM user_sessions s
      JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL
        AND u.status='active'
    `).get(hashToken(rawToken), now);
    if (!row) return null;
    const csrfToken = deriveToken(sessionSecret, 'identity-csrf', rawToken);
    if (!safeEqual(hashToken(csrfToken), row.csrf_token_hash)) {
      db.prepare('UPDATE user_sessions SET revoked_at=? WHERE id=?').run(now, row.id);
      return null;
    }
    if (touch) {
      db.prepare('UPDATE user_sessions SET last_seen_at=? WHERE id=?').run(now, row.id);
      row.last_seen_at = now;
    }
    const user = {
      id: row.user_id,
      email: row.email,
      full_name: row.full_name,
      mobile: row.mobile,
      avatar_url: row.avatar_url,
      locale: row.locale,
      status: row.user_status,
      email_verified_at: row.email_verified_at,
      password_changed_at: row.password_changed_at,
      mfa_enabled: row.mfa_enabled,
      last_login_at: row.last_login_at,
      created_at: row.user_created_at,
      updated_at: row.user_updated_at,
    };
    return {
      rawToken,
      csrfToken,
      session: sessionView(row),
      user: userView(user),
    };
  }

  function revokeSession(rawTokenInput) {
    const rawToken = String(rawTokenInput || '');
    if (!rawToken) return false;
    const now = nowDate(clock).toISOString();
    const result = db.prepare(`
      UPDATE user_sessions SET revoked_at=?
      WHERE token_hash=? AND revoked_at IS NULL
    `).run(now, hashToken(rawToken));
    return Number(result.changes) > 0;
  }

  function revokeAllSessions(userId, { exceptSessionId = null } = {}) {
    requireUser(userId);
    const now = nowDate(clock).toISOString();
    const result = exceptSessionId
      ? db.prepare(`
          UPDATE user_sessions SET revoked_at=?
          WHERE user_id=? AND id<>? AND revoked_at IS NULL
        `).run(now, userId, exceptSessionId)
      : db.prepare(`
          UPDATE user_sessions SET revoked_at=?
          WHERE user_id=? AND revoked_at IS NULL
        `).run(now, userId);
    return Number(result.changes);
  }

  function updateProfile(userId, input = {}) {
    const current = requireUser(userId, { active: true });
    const fullName = input.fullName === undefined
      ? current.full_name
      : textValue(input.fullName, 'fullName', {
          minimum: 2,
          maximum: 160,
          required: true,
        });
    const mobile = input.mobile === undefined
      ? current.mobile
      : textValue(input.mobile, 'mobile', { maximum: 30 });
    const avatarUrl = input.avatarUrl === undefined
      ? current.avatar_url
      : textValue(input.avatarUrl, 'avatarUrl', { maximum: 1_000 });
    const locale = input.locale === undefined
      ? current.locale
      : textValue(input.locale, 'locale', {
          minimum: 2,
          maximum: 20,
          required: true,
        });
    const now = nowDate(clock).toISOString();
    db.prepare(`
      UPDATE users
      SET full_name=?, mobile=?, avatar_url=?, locale=?, updated_at=?
      WHERE id=?
    `).run(fullName, mobile, avatarUrl, locale, now, current.id);
    const updated = requireUser(current.id);
    emitAudit('identity.profile_updated', {
      actorUserId: current.id,
      resourceType: 'user',
      resourceId: current.id,
      before: userView(current),
      after: userView(updated),
    });
    return { user: userView(updated) };
  }

  function changePassword(userId, input = {}) {
    const current = requireUser(userId, { active: true });
    const currentPassword = passwordValue(input.currentPassword, 'currentPassword');
    const nextPassword = passwordValue(input.newPassword, 'newPassword');
    if (!verifyPassword(currentPassword, current.password_hash)) {
      throw new AppError(
        403,
        'CURRENT_PASSWORD_INVALID',
        'رمز عبور فعلی صحیح نیست.',
      );
    }
    if (verifyPassword(nextPassword, current.password_hash)) {
      throw badRequest(
        'PASSWORD_UNCHANGED',
        'رمز عبور جدید باید با رمز فعلی متفاوت باشد.',
      );
    }
    const now = nowDate(clock).toISOString();
    return withTransaction(db, () => {
      db.prepare(`
        UPDATE users
        SET password_hash=?, password_changed_at=?, updated_at=?
        WHERE id=?
      `).run(createPasswordHash(nextPassword), now, now, current.id);
      revokeAllSessions(current.id, { exceptSessionId: input.keepSessionId || null });
      db.prepare(`
        UPDATE password_reset_tokens SET used_at=?
        WHERE user_id=? AND used_at IS NULL
      `).run(now, current.id);
      emitAudit('identity.password_changed', {
        actorUserId: current.id,
        resourceType: 'user',
        resourceId: current.id,
      });
      return { changed: true };
    });
  }

  function beginTotpEnrollment(userId, input = {}) {
    const user = requireUser(userId, { active: true });
    if (user.mfa_enabled) {
      throw conflict(
        'MFA_ALREADY_ENABLED',
        'احراز هویت دومرحله‌ای قبلاً فعال شده است.',
      );
    }
    const now = nowDate(clock);
    const secret = generateTotpSecret();
    const pendingExpiresAt = new Date(now.getTime() + enrollmentTtlMs).toISOString();
    const sealed = sealTotpState({
      secret,
      lastCounter: -1,
      pendingExpiresAt,
    }, encryptionSecret);
    db.prepare(`
      UPDATE users SET totp_secret_sealed=?, updated_at=? WHERE id=?
    `).run(sealed, now.toISOString(), user.id);
    emitAudit('identity.mfa_enrollment_started', {
      actorUserId: user.id,
      resourceType: 'user',
      resourceId: user.id,
    });
    return {
      secret,
      otpauthUri: totpUri({
        secret,
        account: user.email,
        issuer: input.issuer || 'هم‌ساخت',
      }),
      expiresAt: pendingExpiresAt,
    };
  }

  function replaceBackupCodes(userId, now) {
    const codes = generateBackupCodes(10);
    db.prepare('DELETE FROM mfa_backup_codes WHERE user_id=?').run(userId);
    const insert = db.prepare(`
      INSERT INTO mfa_backup_codes(id,user_id,code_hash,created_at)
      VALUES(?,?,?,?)
    `);
    for (const code of codes) {
      const normalized = normalizeBackupCode(code);
      insert.run(randomUUID(), userId, hashToken(normalized), now);
    }
    return codes;
  }

  function confirmTotpEnrollment(userId, code, { sessionId = null } = {}) {
    return withTransaction(db, () => {
      const user = requireUser(userId, { active: true });
      if (user.mfa_enabled) {
        throw conflict(
          'MFA_ALREADY_ENABLED',
          'احراز هویت دومرحله‌ای قبلاً فعال شده است.',
        );
      }
      if (!user.totp_secret_sealed) {
        throw conflict(
          'MFA_ENROLLMENT_MISSING',
          'ابتدا راه‌اندازی احراز هویت دومرحله‌ای را آغاز کنید.',
        );
      }
      let state;
      try {
        state = unsealTotpState(user.totp_secret_sealed, encryptionSecret);
      } catch {
        throw conflict(
          'MFA_ENROLLMENT_INVALID',
          'اطلاعات راه‌اندازی احراز هویت دومرحله‌ای معتبر نیست.',
        );
      }
      const now = nowDate(clock);
      if (
        !state.pendingExpiresAt ||
        state.pendingExpiresAt <= now.toISOString()
      ) {
        throw new AppError(
          410,
          'MFA_ENROLLMENT_EXPIRED',
          'مهلت راه‌اندازی تمام شده است؛ دوباره شروع کنید.',
        );
      }
      const counter = verifyTotpCode(state.secret, code, {
        at: now,
        afterCounter: -1,
      });
      if (counter === null) {
        throw new AppError(
          401,
          'INVALID_MFA_CODE',
          'کد احراز هویت صحیح نیست.',
        );
      }
      const sealed = sealTotpState({
        secret: state.secret,
        lastCounter: counter,
      }, encryptionSecret);
      const nowIso = now.toISOString();
      db.prepare(`
        UPDATE users
        SET mfa_enabled=1, totp_secret_sealed=?, updated_at=?
        WHERE id=?
      `).run(sealed, nowIso, user.id);
      const backupCodes = replaceBackupCodes(user.id, nowIso);
      if (sessionId) {
        db.prepare(`
          UPDATE user_sessions
          SET mfa_verified_at=?
          WHERE id=? AND user_id=? AND revoked_at IS NULL
        `).run(nowIso, sessionId, user.id);
        revokeAllSessions(user.id, { exceptSessionId: sessionId });
      } else {
        revokeAllSessions(user.id);
      }
      emitAudit('identity.mfa_enabled', {
        actorUserId: user.id,
        resourceType: 'user',
        resourceId: user.id,
      });
      return { enabled: true, backupCodes };
    });
  }

  function verifySecondFactor(userId, input = {}) {
    return withTransaction(db, () => {
      const user = requireUser(userId, { active: true });
      if (!user.mfa_enabled || !user.totp_secret_sealed) {
        throw conflict('MFA_NOT_ENABLED', 'احراز هویت دومرحله‌ای فعال نیست.');
      }
      const now = nowDate(clock);
      const nowIso = now.toISOString();
      if (input.totpCode !== undefined) {
        let state;
        try {
          state = unsealTotpState(user.totp_secret_sealed, encryptionSecret);
        } catch {
          throw new AppError(
            500,
            'MFA_STATE_INVALID',
            'اطلاعات امنیتی حساب قابل خواندن نیست.',
          );
        }
        const counter = verifyTotpCode(state.secret, input.totpCode, {
          at: now,
          afterCounter: state.lastCounter,
        });
        if (counter === null) {
          throw new AppError(
            401,
            'INVALID_MFA_CODE',
            'کد احراز هویت صحیح نیست یا قبلاً استفاده شده است.',
          );
        }
        db.prepare(`
          UPDATE users SET totp_secret_sealed=?, updated_at=? WHERE id=?
        `).run(
          sealTotpState({
            secret: state.secret,
            lastCounter: counter,
          }, encryptionSecret),
          nowIso,
          user.id,
        );
        return { verified: true, method: 'totp', verifiedAt: nowIso };
      }
      const backupCode = normalizeBackupCode(input.backupCode);
      if (backupCode) {
        const result = db.prepare(`
          UPDATE mfa_backup_codes
          SET used_at=?
          WHERE user_id=? AND code_hash=? AND used_at IS NULL
        `).run(nowIso, user.id, hashToken(backupCode));
        if (Number(result.changes) === 1) {
          emitAudit('identity.mfa_backup_code_used', {
            actorUserId: user.id,
            resourceType: 'user',
            resourceId: user.id,
          });
          return { verified: true, method: 'backup_code', verifiedAt: nowIso };
        }
      }
      throw new AppError(
        401,
        'INVALID_MFA_CODE',
        'کد احراز هویت صحیح نیست یا قبلاً استفاده شده است.',
      );
    });
  }

  function regenerateBackupCodes(userId, verification) {
    verifySecondFactor(userId, verification);
    const now = nowDate(clock).toISOString();
    return withTransaction(db, () => {
      const backupCodes = replaceBackupCodes(userId, now);
      emitAudit('identity.mfa_backup_codes_regenerated', {
        actorUserId: userId,
        resourceType: 'user',
        resourceId: userId,
      });
      return { backupCodes };
    });
  }

  function disableMfa(userId, verification) {
    verifySecondFactor(userId, verification);
    const now = nowDate(clock).toISOString();
    return withTransaction(db, () => {
      db.prepare(`
        UPDATE users
        SET mfa_enabled=0, totp_secret_sealed=NULL, updated_at=?
        WHERE id=?
      `).run(now, userId);
      db.prepare('DELETE FROM mfa_backup_codes WHERE user_id=?').run(userId);
      revokeAllSessions(userId);
      emitAudit('identity.mfa_disabled', {
        actorUserId: userId,
        resourceType: 'user',
        resourceId: userId,
      });
      return { enabled: false };
    });
  }

  function createInvitation(input = {}) {
    const organizationId = idValue(input.organizationId, 'organizationId');
    const organization = requireOrganization(organizationId, { active: true });
    const email = emailValue(input.email);
    const projectId = input.projectId
      ? idValue(input.projectId, 'projectId')
      : null;
    const roleKey = projectId
      ? projectRoleValue(input.roleKey)
      : organizationRoleValue(input.roleKey);
    const organizationRoleKey = projectId ? 'viewer' : roleKey;
    const projectRoleKey = projectId ? roleKey : null;
    if (projectId) {
      requireProjectInOrganization(projectId, organizationId);
    }
    if (input.invitedByUserId) requireUser(input.invitedByUserId, { active: true });
    const now = nowDate(clock);
    const nowIso = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + (input.ttlMs || invitationTtlMs),
    ).toISOString();
    const rawToken = randomToken(32);
    const id = randomUUID();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE organization_invitations
        SET revoked_at=?
        WHERE organization_id=? AND email=? COLLATE NOCASE
          AND accepted_at IS NULL AND revoked_at IS NULL
      `).run(nowIso, organizationId, email);
      db.prepare(`
        INSERT INTO organization_invitations(
          id, organization_id, email, role_key, project_id, project_role_key, token_hash,
          invited_by_user_id, expires_at, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        organizationId,
        email,
        organizationRoleKey,
        projectId,
        projectRoleKey,
        hashToken(rawToken),
        input.invitedByUserId || null,
        expiresAt,
        nowIso,
      );
      emitAudit('identity.invitation_created', {
        actorUserId: input.invitedByUserId,
        organizationId,
        projectId,
        resourceType: 'organization_invitation',
        resourceId: id,
        metadata: { email, roleKey },
      });
    });
    return {
      invitation: {
        id,
        organizationId,
        organizationName: organization.name,
        organizationSlug: organization.slug,
        email,
        roleKey,
        projectId,
        invitedByUserId: input.invitedByUserId || null,
        expiresAt,
        acceptedAt: null,
        revokedAt: null,
        createdAt: nowIso,
      },
      token: rawToken,
    };
  }

  const invitationSelect = `
    SELECT
      i.*,
      o.name AS organization_name,
      o.slug AS organization_slug,
      o.status AS organization_status,
      o.archived_at AS organization_archived_at,
      p.title AS project_title,
      inviter.full_name AS inviter_name
    FROM organization_invitations i
    JOIN organizations o ON o.id=i.organization_id
    LEFT JOIN projects p ON p.id=i.project_id
    LEFT JOIN users inviter ON inviter.id=i.invited_by_user_id
  `;

  function inspectInvitation(rawTokenInput) {
    const rawToken = tokenValue(
      rawTokenInput,
      'INVALID_INVITATION_TOKEN',
      'لینک دعوت معتبر نیست.',
    );
    const row = db.prepare(`
      ${invitationSelect}
      WHERE i.token_hash=?
    `).get(hashToken(rawToken));
    if (!row || row.revoked_at || row.accepted_at) {
      throw notFound('INVITATION_NOT_FOUND', 'دعوت فعال پیدا نشد.');
    }
    if (row.expires_at <= nowDate(clock).toISOString()) {
      throw new AppError(410, 'INVITATION_EXPIRED', 'مهلت استفاده از دعوت تمام شده است.');
    }
    if (
      ['archived', 'suspended'].includes(row.organization_status) ||
      row.organization_archived_at
    ) {
      throw notFound('INVITATION_NOT_FOUND', 'دعوت فعال پیدا نشد.');
    }
    return { invitation: invitationView(row) };
  }

  function listInvitations(organizationId, { includeClosed = false } = {}) {
    requireOrganization(organizationId);
    return {
      invitations: db.prepare(`
        ${invitationSelect}
        WHERE i.organization_id=?
          ${includeClosed ? '' : 'AND i.accepted_at IS NULL AND i.revoked_at IS NULL'}
        ORDER BY i.created_at DESC, i.id
      `).all(organizationId).map((row) => invitationView(row)),
    };
  }

  function revokeInvitation(organizationId, invitationId, actorUserId = null) {
    requireOrganization(organizationId);
    const now = nowDate(clock).toISOString();
    const result = db.prepare(`
      UPDATE organization_invitations
      SET revoked_at=?
      WHERE id=? AND organization_id=?
        AND accepted_at IS NULL AND revoked_at IS NULL
    `).run(now, invitationId, organizationId);
    if (Number(result.changes) !== 1) {
      throw notFound('INVITATION_NOT_FOUND', 'دعوت فعال پیدا نشد.');
    }
    emitAudit('identity.invitation_revoked', {
      actorUserId,
      organizationId,
      resourceType: 'organization_invitation',
      resourceId: invitationId,
    });
    return { revoked: true, id: invitationId };
  }

  function acceptInvitation(rawTokenInput, input = {}) {
    const rawToken = tokenValue(
      rawTokenInput,
      'INVALID_INVITATION_TOKEN',
      'لینک دعوت معتبر نیست.',
    );
    return withTransaction(db, () => {
      const row = db.prepare(`
        ${invitationSelect}
        WHERE i.token_hash=?
      `).get(hashToken(rawToken));
      const now = nowDate(clock);
      const nowIso = now.toISOString();
      if (!row || row.revoked_at || row.accepted_at) {
        throw notFound('INVITATION_NOT_FOUND', 'دعوت فعال پیدا نشد.');
      }
      if (row.expires_at <= nowIso) {
        throw new AppError(410, 'INVITATION_EXPIRED', 'مهلت استفاده از دعوت تمام شده است.');
      }
      const organization = requireOrganization(row.organization_id, { active: true });
      if (row.project_id) {
        requireProjectInOrganization(row.project_id, row.organization_id);
      }
      let user = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE')
        .get(row.email);
      const password = passwordValue(input.password);
      if (user && user.status === 'active') {
        if (!verifyPassword(password, user.password_hash)) {
          throw unauthorized('برای پیوستن، با رمز حساب موجود وارد شوید.');
        }
      } else if (user && ['suspended', 'disabled'].includes(user.status)) {
        throw new AppError(
          403,
          'USER_DISABLED',
          'این حساب کاربری غیرفعال است.',
        );
      } else if (user) {
        const fullName = input.fullName === undefined
          ? user.full_name
          : textValue(input.fullName, 'fullName', {
              minimum: 2,
              maximum: 160,
              required: true,
            });
        db.prepare(`
          UPDATE users
          SET password_hash=?, full_name=?, status='active',
              email_verified_at=COALESCE(email_verified_at,?),
              password_changed_at=?, updated_at=?
          WHERE id=?
        `).run(
          createPasswordHash(password),
          fullName,
          nowIso,
          nowIso,
          nowIso,
          user.id,
        );
        user = requireUser(user.id);
      } else {
        const fullName = textValue(input.fullName, 'fullName', {
          minimum: 2,
          maximum: 160,
          required: true,
        });
        const userId = randomUUID();
        db.prepare(`
          INSERT INTO users(
            id, email, password_hash, full_name, status, email_verified_at,
            password_changed_at, created_at, updated_at
          ) VALUES(?,?,?,?, 'active', ?,?,?,?)
        `).run(
          userId,
          row.email,
          createPasswordHash(password),
          fullName,
          nowIso,
          nowIso,
          nowIso,
          nowIso,
        );
        user = requireUser(userId);
      }

      const organizationRole = row.project_id ? 'viewer' : row.role_key;
      const existingMembership = db.prepare(`
        SELECT * FROM organization_memberships
        WHERE organization_id=? AND user_id=?
      `).get(row.organization_id, user.id);
      if (!existingMembership) {
        db.prepare(`
          INSERT INTO organization_memberships(
            id, organization_id, user_id, role_key, status,
            joined_at, created_at, updated_at
          ) VALUES(?,?,?,?,'active',?,?,?)
        `).run(
          randomUUID(),
          row.organization_id,
          user.id,
          organizationRole,
          nowIso,
          nowIso,
          nowIso,
        );
      } else {
        db.prepare(`
          UPDATE organization_memberships
          SET role_key=CASE WHEN status='active' THEN role_key ELSE ? END,
              status='active', joined_at=COALESCE(joined_at,?), updated_at=?
          WHERE id=?
        `).run(organizationRole, nowIso, nowIso, existingMembership.id);
      }
      if (row.project_id) {
        db.prepare(`
          INSERT INTO project_memberships(
            id, project_id, user_id, role_key, created_at, updated_at
          ) VALUES(?,?,?,?,?,?)
          ON CONFLICT(project_id,user_id) DO UPDATE SET
            role_key=excluded.role_key, updated_at=excluded.updated_at
        `).run(
          randomUUID(),
          row.project_id,
          user.id,
          projectRoleValue(row.project_role_key || row.role_key),
          nowIso,
          nowIso,
        );
      }
      const accepted = db.prepare(`
        UPDATE organization_invitations
        SET accepted_at=?
        WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL
      `).run(nowIso, row.id);
      if (Number(accepted.changes) !== 1) {
        throw conflict('INVITATION_ALREADY_USED', 'این دعوت قبلاً استفاده شده است.');
      }
      db.prepare(`
        UPDATE organization_invitations
        SET revoked_at=?
        WHERE organization_id=? AND email=? COLLATE NOCASE AND id<>?
          AND accepted_at IS NULL AND revoked_at IS NULL
      `).run(nowIso, row.organization_id, row.email, row.id);
      emitAudit('identity.invitation_accepted', {
        actorUserId: user.id,
        organizationId: row.organization_id,
        projectId: row.project_id,
        resourceType: 'organization_invitation',
        resourceId: row.id,
      });
      return {
        user: userView(user),
        organization: organizationView(organization),
        invitation: {
          ...invitationView(row),
          acceptedAt: nowIso,
        },
      };
    });
  }

  function requestPasswordReset(emailInput) {
    const email = emailValue(emailInput);
    const user = db.prepare(`
      SELECT * FROM users WHERE email=? COLLATE NOCASE AND status='active'
    `).get(email);
    if (!user) return { created: false };
    const now = nowDate(clock);
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + resetTtlMs).toISOString();
    const rawToken = randomToken(32);
    withTransaction(db, () => {
      db.prepare(`
        UPDATE password_reset_tokens
        SET used_at=?
        WHERE user_id=? AND used_at IS NULL
      `).run(nowIso, user.id);
      db.prepare(`
        INSERT INTO password_reset_tokens(
          id,user_id,token_hash,expires_at,created_at
        ) VALUES(?,?,?,?,?)
      `).run(randomUUID(), user.id, hashToken(rawToken), expiresAt, nowIso);
      emitAudit('identity.password_reset_requested', {
        actorUserId: user.id,
        resourceType: 'user',
        resourceId: user.id,
      });
    });
    return {
      created: true,
      token: rawToken,
      expiresAt,
      user: userView(user),
    };
  }

  function completePasswordReset(rawTokenInput, newPasswordInput) {
    const rawToken = tokenValue(
      rawTokenInput,
      'INVALID_RESET_TOKEN',
      'لینک بازنشانی رمز معتبر نیست.',
    );
    const newPassword = passwordValue(newPasswordInput, 'newPassword');
    return withTransaction(db, () => {
      const now = nowDate(clock).toISOString();
      const row = db.prepare(`
        SELECT t.*, u.password_hash, u.status AS user_status
        FROM password_reset_tokens t
        JOIN users u ON u.id=t.user_id
        WHERE t.token_hash=?
      `).get(hashToken(rawToken));
      if (!row || row.used_at || row.user_status !== 'active') {
        throw notFound('RESET_TOKEN_NOT_FOUND', 'لینک بازنشانی فعال پیدا نشد.');
      }
      if (row.expires_at <= now) {
        throw new AppError(
          410,
          'RESET_TOKEN_EXPIRED',
          'مهلت بازنشانی رمز عبور تمام شده است.',
        );
      }
      if (verifyPassword(newPassword, row.password_hash)) {
        throw badRequest(
          'PASSWORD_UNCHANGED',
          'رمز عبور جدید باید با رمز قبلی متفاوت باشد.',
        );
      }
      const consumed = db.prepare(`
        UPDATE password_reset_tokens SET used_at=?
        WHERE id=? AND used_at IS NULL
      `).run(now, row.id);
      if (Number(consumed.changes) !== 1) {
        throw conflict('RESET_TOKEN_ALREADY_USED', 'این لینک قبلاً استفاده شده است.');
      }
      db.prepare(`
        UPDATE users
        SET password_hash=?, password_changed_at=?, updated_at=?
        WHERE id=?
      `).run(createPasswordHash(newPassword), now, now, row.user_id);
      db.prepare(`
        UPDATE password_reset_tokens
        SET used_at=?
        WHERE user_id=? AND used_at IS NULL
      `).run(now, row.user_id);
      revokeAllSessions(row.user_id);
      emitAudit('identity.password_reset_completed', {
        actorUserId: row.user_id,
        resourceType: 'user',
        resourceId: row.user_id,
      });
      return { changed: true };
    });
  }

  function createOrganization(actorUserId, input = {}) {
    const actor = requireUser(actorUserId, { active: true });
    const id = randomUUID();
    const slug = slugValue(input.slug);
    const name = textValue(input.name, 'name', {
      minimum: 2,
      maximum: 200,
      required: true,
    });
    const now = nowDate(clock).toISOString();
    try {
      withTransaction(db, () => {
        db.prepare(`
          INSERT INTO organizations(
            id,slug,name,legal_name,national_id,website,description,logo_url,
            timezone,default_currency,settings_json,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          id,
          slug,
          name,
          textValue(input.legalName, 'legalName', { maximum: 240 }),
          textValue(input.nationalId, 'nationalId', { maximum: 80 }),
          textValue(input.website, 'website', { maximum: 1_000 }),
          textValue(input.description, 'description', { maximum: 5_000 }),
          textValue(input.logoUrl, 'logoUrl', { maximum: 1_000 }),
          textValue(input.timezone || 'Asia/Tehran', 'timezone', {
            minimum: 1,
            maximum: 80,
            required: true,
          }),
          textValue(input.defaultCurrency || 'IRR', 'defaultCurrency', {
            minimum: 3,
            maximum: 12,
            required: true,
          }).toUpperCase(),
          JSON.stringify(input.settings || {}),
          now,
          now,
        );
        db.prepare(`
          INSERT INTO organization_memberships(
            id,organization_id,user_id,role_key,status,joined_at,created_at,updated_at
          ) VALUES(?,?,?,'owner','active',?,?,?)
        `).run(randomUUID(), id, actor.id, now, now, now);
        emitAudit('identity.organization_created', {
          actorUserId: actor.id,
          organizationId: id,
          resourceType: 'organization',
          resourceId: id,
        });
      });
    } catch (error) {
      sqliteConflict(error, 'ORGANIZATION_SLUG_TAKEN', 'این شناسهٔ سازمان قبلاً استفاده شده است.');
    }
    return { organization: organizationView(requireOrganization(id)) };
  }

  function organizationsForUser(userId) {
    requireUser(userId, { active: true });
    const rows = db.prepare(`
      SELECT o.*, om.role_key, om.status AS membership_status,
             om.id AS membership_id, om.joined_at
      FROM organization_memberships om
      JOIN organizations o ON o.id=om.organization_id
      WHERE om.user_id=? AND om.status='active'
        AND o.status<>'archived' AND o.archived_at IS NULL
      ORDER BY o.name, o.id
    `).all(userId);
    return {
      organizations: rows.map((row) => ({
        ...organizationView(row),
        membership: {
          id: row.membership_id,
          roleKey: row.role_key,
          status: row.membership_status,
          joinedAt: row.joined_at,
        },
        permissions: serializePermissions(permissionsForRoles(row.role_key)),
      })),
    };
  }

  function updateOrganization(organizationId, input = {}, actorUserId = null) {
    const current = requireOrganization(organizationId);
    const now = nowDate(clock).toISOString();
    const slug = input.slug === undefined ? current.slug : slugValue(input.slug);
    const settings = input.settings === undefined
      ? current.settings_json
      : JSON.stringify(input.settings || {});
    try {
      db.prepare(`
        UPDATE organizations
        SET slug=?, name=?, legal_name=?, national_id=?, website=?,
            description=?, logo_url=?, timezone=?, default_currency=?,
            settings_json=?, updated_at=?
        WHERE id=?
      `).run(
        slug,
        input.name === undefined
          ? current.name
          : textValue(input.name, 'name', {
              minimum: 2,
              maximum: 200,
              required: true,
            }),
        input.legalName === undefined
          ? current.legal_name
          : textValue(input.legalName, 'legalName', { maximum: 240 }),
        input.nationalId === undefined
          ? current.national_id
          : textValue(input.nationalId, 'nationalId', { maximum: 80 }),
        input.website === undefined
          ? current.website
          : textValue(input.website, 'website', { maximum: 1_000 }),
        input.description === undefined
          ? current.description
          : textValue(input.description, 'description', { maximum: 5_000 }),
        input.logoUrl === undefined
          ? current.logo_url
          : textValue(input.logoUrl, 'logoUrl', { maximum: 1_000 }),
        input.timezone === undefined
          ? current.timezone
          : textValue(input.timezone, 'timezone', {
              minimum: 1,
              maximum: 80,
              required: true,
            }),
        input.defaultCurrency === undefined
          ? current.default_currency
          : textValue(input.defaultCurrency, 'defaultCurrency', {
              minimum: 3,
              maximum: 12,
              required: true,
            }).toUpperCase(),
        settings,
        now,
        current.id,
      );
    } catch (error) {
      sqliteConflict(error, 'ORGANIZATION_SLUG_TAKEN', 'این شناسهٔ سازمان قبلاً استفاده شده است.');
    }
    const updated = requireOrganization(current.id);
    emitAudit('identity.organization_updated', {
      actorUserId,
      organizationId: current.id,
      resourceType: 'organization',
      resourceId: current.id,
      before: organizationView(current),
      after: organizationView(updated),
    });
    return { organization: organizationView(updated) };
  }

  function archiveOrganization(organizationId, actorUserId = null) {
    const current = requireOrganization(organizationId);
    const now = nowDate(clock).toISOString();
    db.prepare(`
      UPDATE organizations
      SET status='archived', archived_at=COALESCE(archived_at,?), updated_at=?
      WHERE id=?
    `).run(now, now, current.id);
    emitAudit('identity.organization_archived', {
      actorUserId,
      organizationId: current.id,
      resourceType: 'organization',
      resourceId: current.id,
    });
    return { id: current.id, archived: true, archivedAt: now };
  }

  function organizationAuthorization(userId, organizationId) {
    const row = db.prepare(`
      SELECT
        o.*,
        om.id AS membership_id,
        om.role_key,
        om.status AS membership_status
      FROM organizations o
      JOIN organization_memberships om
        ON om.organization_id=o.id AND om.user_id=?
      WHERE o.id=? AND om.status='active'
        AND o.status='active' AND o.archived_at IS NULL
    `).get(userId, organizationId);
    if (!row) return null;
    const permissions = permissionsForRoles(row.role_key);
    return {
      organization: organizationView(row),
      membership: {
        id: row.membership_id,
        organizationId: row.id,
        userId,
        roleKey: row.role_key,
        status: row.membership_status,
      },
      organizationRole: row.role_key,
      projectRole: null,
      permissions,
      serializedPermissions: serializePermissions(permissions),
    };
  }

  function projectAuthorization(userId, projectId) {
    const row = db.prepare(`
      SELECT
        p.id AS project_id,
        p.organization_id,
        p.title AS project_title,
        p.slug AS project_slug,
        p.archived_at AS project_archived_at,
        o.name AS organization_name,
        o.slug AS organization_slug,
        o.status AS organization_status,
        o.archived_at AS organization_archived_at,
        om.id AS organization_membership_id,
        om.role_key AS organization_role,
        om.status AS organization_membership_status,
        pm.id AS project_membership_id,
        pm.role_key AS project_role
      FROM projects p
      JOIN organizations o ON o.id=p.organization_id
      JOIN organization_memberships om
        ON om.organization_id=p.organization_id AND om.user_id=?
      LEFT JOIN project_memberships pm
        ON pm.project_id=p.id AND pm.user_id=?
      WHERE p.id=? AND om.status='active'
        AND o.status='active' AND o.archived_at IS NULL
    `).get(userId, userId, projectId);
    if (!row) return null;
    const hasAllProjects = organizationRoleGrantsAllProjects(row.organization_role);
    if (!hasAllProjects && !row.project_membership_id) return null;
    const permissions = permissionsForRoles(
      row.organization_role,
      row.project_role,
    );
    return {
      project: {
        id: row.project_id,
        organizationId: row.organization_id,
        title: row.project_title,
        slug: row.project_slug,
        archivedAt: row.project_archived_at,
      },
      organization: {
        id: row.organization_id,
        name: row.organization_name,
        slug: row.organization_slug,
      },
      organizationRole: row.organization_role,
      projectRole: row.project_role || null,
      permissions,
      serializedPermissions: serializePermissions(permissions),
    };
  }

  function accessibleProjectIds(userId, organizationId = null) {
    requireUser(userId, { active: true });
    const parameters = [userId, userId];
    let organizationClause = '';
    if (organizationId) {
      organizationClause = 'AND p.organization_id=?';
      parameters.push(organizationId);
    }
    const rows = db.prepare(`
      SELECT DISTINCT p.id
      FROM projects p
      JOIN organizations o ON o.id=p.organization_id
      JOIN organization_memberships om
        ON om.organization_id=p.organization_id AND om.user_id=?
      LEFT JOIN project_memberships pm
        ON pm.project_id=p.id AND pm.user_id=?
      WHERE om.status='active' AND o.status='active'
        AND o.archived_at IS NULL
        AND (
          om.role_key IN ('owner','admin','project_manager','finance','board','auditor')
          OR pm.id IS NOT NULL
        )
        ${organizationClause}
      ORDER BY p.id
    `).all(...parameters);
    return rows.map((row) => row.id);
  }

  function listOrganizationMembers(organizationId) {
    requireOrganization(organizationId);
    return {
      members: db.prepare(`
        SELECT
          om.*,
          u.email AS user_email,
          u.full_name AS user_full_name,
          u.mobile AS user_mobile,
          u.avatar_url AS user_avatar_url,
          u.locale AS user_locale,
          u.status AS user_status,
          u.email_verified_at AS user_email_verified_at,
          u.password_changed_at AS user_password_changed_at,
          u.mfa_enabled AS user_mfa_enabled,
          u.last_login_at AS user_last_login_at,
          u.created_at AS user_created_at,
          u.updated_at AS user_updated_at
        FROM organization_memberships om
        JOIN users u ON u.id=om.user_id
        WHERE om.organization_id=?
        ORDER BY
          CASE om.role_key WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
          u.full_name,u.id
      `).all(organizationId).map(membershipView),
    };
  }

  function assertNotLastOwner(organizationId, membership, next = {}) {
    const removesOwner =
      membership.role_key === 'owner' &&
      membership.status === 'active' &&
      (
        (next.roleKey !== undefined && next.roleKey !== 'owner') ||
        (next.status !== undefined && next.status !== 'active') ||
        next.deleted
      );
    if (!removesOwner) return;
    const count = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM organization_memberships
      WHERE organization_id=? AND role_key='owner' AND status='active'
    `).get(organizationId).count);
    if (count <= 1) {
      throw conflict(
        'LAST_OWNER_REQUIRED',
        'آخرین مالک فعال سازمان قابل حذف، تعلیق یا تغییر نقش نیست.',
      );
    }
  }

  function createOrganizationMembership(organizationId, input = {}, actorUserId = null) {
    requireOrganization(organizationId, { active: true });
    const user = input.userId
      ? requireUser(input.userId, { active: true })
      : db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE')
          .get(emailValue(input.email));
    if (!user || user.status !== 'active') {
      throw notFound('USER_NOT_FOUND', 'کاربر موردنظر پیدا نشد.');
    }
    const roleKey = organizationRoleValue(input.roleKey);
    const status = membershipStatusValue(input.status || 'active');
    const now = nowDate(clock).toISOString();
    try {
      db.prepare(`
        INSERT INTO organization_memberships(
          id,organization_id,user_id,role_key,status,joined_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `).run(
        randomUUID(),
        organizationId,
        user.id,
        roleKey,
        status,
        status === 'active' ? now : null,
        now,
        now,
      );
    } catch (error) {
      sqliteConflict(error, 'MEMBERSHIP_EXISTS', 'این کاربر از قبل عضو سازمان است.');
    }
    const membership = db.prepare(`
      SELECT * FROM organization_memberships
      WHERE organization_id=? AND user_id=?
    `).get(organizationId, user.id);
    emitAudit('identity.organization_member_created', {
      actorUserId,
      organizationId,
      resourceType: 'organization_membership',
      resourceId: membership.id,
      after: membershipView(membership),
    });
    return { membership: membershipView(membership), user: userView(user) };
  }

  function updateOrganizationMembership(
    organizationId,
    membershipId,
    input = {},
    actorUserId = null,
  ) {
    requireOrganization(organizationId);
    const current = db.prepare(`
      SELECT * FROM organization_memberships
      WHERE id=? AND organization_id=?
    `).get(membershipId, organizationId);
    if (!current) throw notFound('MEMBERSHIP_NOT_FOUND', 'عضویت موردنظر پیدا نشد.');
    const roleKey = input.roleKey === undefined
      ? current.role_key
      : organizationRoleValue(input.roleKey);
    const status = input.status === undefined
      ? current.status
      : membershipStatusValue(input.status);
    if (status === 'active') requireUser(current.user_id, { active: true });
    assertNotLastOwner(organizationId, current, { roleKey, status });
    const now = nowDate(clock).toISOString();
    db.prepare(`
      UPDATE organization_memberships
      SET role_key=?,status=?,joined_at=CASE
        WHEN ?='active' THEN COALESCE(joined_at,?)
        ELSE joined_at END,
        updated_at=?
      WHERE id=?
    `).run(roleKey, status, status, now, now, current.id);
    const updated = db.prepare('SELECT * FROM organization_memberships WHERE id=?')
      .get(current.id);
    emitAudit('identity.organization_member_updated', {
      actorUserId,
      organizationId,
      resourceType: 'organization_membership',
      resourceId: current.id,
      before: membershipView(current),
      after: membershipView(updated),
    });
    return { membership: membershipView(updated) };
  }

  function deleteOrganizationMembership(
    organizationId,
    membershipId,
    actorUserId = null,
  ) {
    requireOrganization(organizationId);
    return withTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM organization_memberships
        WHERE id=? AND organization_id=?
      `).get(membershipId, organizationId);
      if (!current) throw notFound('MEMBERSHIP_NOT_FOUND', 'عضویت موردنظر پیدا نشد.');
      assertNotLastOwner(organizationId, current, { deleted: true });
      const projectIds = db.prepare(`
        SELECT id FROM projects WHERE organization_id=?
      `).all(organizationId).map((row) => row.id);
      if (projectIds.length) {
        const placeholders = projectIds.map(() => '?').join(',');
        db.prepare(`
          DELETE FROM project_memberships
          WHERE user_id=? AND project_id IN (${placeholders})
        `).run(current.user_id, ...projectIds);
      }
      db.prepare('DELETE FROM organization_memberships WHERE id=?').run(current.id);
      emitAudit('identity.organization_member_deleted', {
        actorUserId,
        organizationId,
        resourceType: 'organization_membership',
        resourceId: current.id,
        before: membershipView(current),
      });
      return { deleted: true, id: current.id };
    });
  }

  function listProjectMemberships(organizationId, projectId) {
    requireProjectInOrganization(projectId, organizationId);
    return {
      members: db.prepare(`
        SELECT
          pm.*,
          u.email AS user_email,
          u.full_name AS user_full_name,
          u.mobile AS user_mobile,
          u.avatar_url AS user_avatar_url,
          u.locale AS user_locale,
          u.status AS user_status,
          u.email_verified_at AS user_email_verified_at,
          u.password_changed_at AS user_password_changed_at,
          u.mfa_enabled AS user_mfa_enabled,
          u.last_login_at AS user_last_login_at,
          u.created_at AS user_created_at,
          u.updated_at AS user_updated_at
        FROM project_memberships pm
        JOIN users u ON u.id=pm.user_id
        WHERE pm.project_id=?
        ORDER BY u.full_name,u.id
      `).all(projectId).map(projectMembershipView),
    };
  }

  function upsertProjectMembership(
    organizationId,
    projectId,
    userId,
    roleKeyInput,
    actorUserId = null,
  ) {
    requireProjectInOrganization(projectId, organizationId);
    const user = requireUser(userId, { active: true });
    const roleKey = projectRoleValue(roleKeyInput);
    const organizationMembership = db.prepare(`
      SELECT * FROM organization_memberships
      WHERE organization_id=? AND user_id=? AND status='active'
    `).get(organizationId, user.id);
    if (!organizationMembership) {
      throw conflict(
        'ORGANIZATION_MEMBERSHIP_REQUIRED',
        'کاربر ابتدا باید عضو فعال سازمان باشد.',
      );
    }
    const now = nowDate(clock).toISOString();
    db.prepare(`
      INSERT INTO project_memberships(
        id,project_id,user_id,role_key,created_at,updated_at
      ) VALUES(?,?,?,?,?,?)
      ON CONFLICT(project_id,user_id) DO UPDATE SET
        role_key=excluded.role_key,updated_at=excluded.updated_at
    `).run(randomUUID(), projectId, user.id, roleKey, now, now);
    const membership = db.prepare(`
      SELECT * FROM project_memberships WHERE project_id=? AND user_id=?
    `).get(projectId, user.id);
    emitAudit('identity.project_member_upserted', {
      actorUserId,
      organizationId,
      projectId,
      resourceType: 'project_membership',
      resourceId: membership.id,
      after: projectMembershipView(membership),
    });
    return { membership: projectMembershipView(membership) };
  }

  function deleteProjectMembership(
    organizationId,
    projectId,
    userId,
    actorUserId = null,
  ) {
    requireProjectInOrganization(projectId, organizationId);
    const current = db.prepare(`
      SELECT * FROM project_memberships WHERE project_id=? AND user_id=?
    `).get(projectId, userId);
    if (!current) {
      throw notFound('PROJECT_MEMBERSHIP_NOT_FOUND', 'عضویت پروژه پیدا نشد.');
    }
    db.prepare('DELETE FROM project_memberships WHERE id=?').run(current.id);
    emitAudit('identity.project_member_deleted', {
      actorUserId,
      organizationId,
      projectId,
      resourceType: 'project_membership',
      resourceId: current.id,
      before: projectMembershipView(current),
    });
    return { deleted: true, id: current.id };
  }

  return Object.freeze({
    bootstrapOwner,
    authenticatePassword,
    createSession,
    sessionByToken,
    revokeSession,
    revokeAllSessions,
    updateProfile,
    changePassword,
    beginTotpEnrollment,
    confirmTotpEnrollment,
    verifySecondFactor,
    regenerateBackupCodes,
    disableMfa,
    createInvitation,
    inspectInvitation,
    listInvitations,
    revokeInvitation,
    acceptInvitation,
    requestPasswordReset,
    completePasswordReset,
    createOrganization,
    organizationsForUser,
    updateOrganization,
    archiveOrganization,
    organizationAuthorization,
    projectAuthorization,
    accessibleProjectIds,
    listOrganizationMembers,
    createOrganizationMembership,
    updateOrganizationMembership,
    deleteOrganizationMembership,
    listProjectMemberships,
    upsertProjectMembership,
    deleteProjectMembership,
    userById: (id) => userView(requireUser(id)),
    organizationById: (id) => organizationView(requireOrganization(id)),
  });
}

export const identityStoreInternals = Object.freeze({
  DEFAULT_ORGANIZATION_ID,
  emailValue,
  passwordValue,
  invitationView,
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/database.js';
import { sendError, sendJson, readJson } from '../../src/http.js';
import { createIdentityStore } from '../../src/identity-store.js';
import { routeIdentityApi } from '../../src/identity-routes.js';
import { MemoryRateLimiter } from '../../src/rate-limit.js';
import {
  hasPermission,
  PERMISSIONS,
} from '../../src/rbac.js';
import {
  createPasswordHash,
  hashToken,
} from '../../src/security.js';
import {
  generateTotpCode,
  hotp,
  sealTotpState,
  unsealTotpState,
  verifyTotpCode,
} from '../../src/totp.js';
import { TestClient } from './helpers.js';

const SESSION_SECRET = 'identity-test-session-secret-with-more-than-thirty-two-characters';
const OWNER_PASSWORD = 'owner-password-strong';
const SECOND_PASSWORD = 'second-password-strong';
const FIXED_TIME = Date.parse('2026-04-05T10:00:00.000Z');

function identityFixture() {
  let currentTime = FIXED_TIME;
  const clock = () => new Date(currentTime);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET,
    ADMIN_DEV_PASSWORD: 'legacy-test-password',
  });
  const db = openDatabase(config, { seed: true });
  const audits = [];
  const store = createIdentityStore(db, {
    clock,
    sessionSecret: SESSION_SECRET,
    encryptionSecret: `${SESSION_SECRET}:totp`,
    audit: (event) => audits.push(event),
  });
  const bootstrap = store.bootstrapOwner({
    email: 'owner@example.com',
    fullName: 'مالک نخست',
    passwordHash: createPasswordHash(OWNER_PASSWORD, {
      salt: Buffer.from('owner-test-salt-1').toString('base64url'),
    }),
  });
  return {
    db,
    store,
    config,
    audits,
    owner: bootstrap.user,
    clock,
    advance(milliseconds) {
      currentTime += milliseconds;
    },
    close() {
      db.close();
    },
  };
}

async function startIdentityServer(fixture) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const config = Object.freeze({
    ...fixture.config,
    publicOrigin: origin,
  });
  const rateLimiter = new MemoryRateLimiter({
    now: () => fixture.clock().getTime(),
  });
  const deliveries = {
    invitations: [],
    resets: [],
  };
  server.on('request', async (request, response) => {
    const url = new URL(request.url || '/', origin);
    const context = {
      request,
      response,
      url,
      config,
      identityStore: fixture.store,
      rateLimiter,
      now: fixture.clock,
      readJson: () => readJson(request, config.payloadLimitBytes),
      identityNotifications: {
        invitation: async (value) => deliveries.invitations.push(value),
        passwordReset: async (value) => deliveries.resets.push(value),
      },
    };
    try {
      if (await routeIdentityApi(context)) return;
      sendJson(response, 404, {
        error: { code: 'ROUTE_NOT_FOUND', message: 'مسیر پیدا نشد.' },
      });
    } catch (error) {
      sendError(response, error, 'identity-test-request', false);
    }
  });
  return {
    origin,
    deliveries,
    client: () => new TestClient(origin),
    async close() {
      rateLimiter.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('RFC HOTP/TOTP primitives, replay floor and sealed state are deterministic', () => {
  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(hotp(rfcSecret, 0), '755224');
  assert.equal(hotp(rfcSecret, 1), '287082');
  assert.equal(
    generateTotpCode(rfcSecret, { at: 59_000, digits: 8 }),
    '94287082',
  );
  const counter = verifyTotpCode(rfcSecret, '94287082', {
    at: 59_000,
    digits: 8,
    window: 0,
  });
  assert.equal(counter, 1);
  assert.equal(
    verifyTotpCode(rfcSecret, '94287082', {
      at: 59_000,
      digits: 8,
      window: 0,
      afterCounter: counter,
    }),
    null,
  );

  const state = { secret: rfcSecret, lastCounter: 42 };
  const sealed = sealTotpState(state, SESSION_SECRET);
  assert.equal(sealed.includes(rfcSecret), false);
  assert.deepEqual(unsealTotpState(sealed, SESSION_SECRET), state);
  assert.throws(
    () => unsealTotpState(sealed, `${SESSION_SECRET}-wrong`),
  );
});

test('bootstrap, hashed sessions and one-use password reset preserve account security', (t) => {
  const fixture = identityFixture();
  t.after(fixture.close);

  const repeated = fixture.store.bootstrapOwner({
    email: 'another@example.com',
    fullName: 'مالک دیگر',
    passwordHash: createPasswordHash(SECOND_PASSWORD),
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.user.id, fixture.owner.id);
  assert.throws(
    () => fixture.store.authenticatePassword('owner@example.com', 'wrong-password'),
    (error) => error.status === 401 && error.code === 'UNAUTHENTICATED',
  );

  const auth = fixture.store.authenticatePassword(
    'OWNER@EXAMPLE.COM',
    OWNER_PASSWORD,
  );
  assert.equal(auth.user.id, fixture.owner.id);
  const issued = fixture.store.createSession(auth.user.id, {
    ipHash: 'hashed-ip',
    userAgent: 'identity-test',
  });
  assert.equal(
    fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM user_sessions WHERE token_hash=?',
    ).get(issued.rawToken).count,
    0,
  );
  assert.equal(
    fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM user_sessions WHERE token_hash=?',
    ).get(hashToken(issued.rawToken)).count,
    1,
  );
  assert.equal(
    fixture.store.sessionByToken(issued.rawToken).csrfToken,
    issued.csrfToken,
  );

  const reset = fixture.store.requestPasswordReset('owner@example.com');
  assert.equal(reset.created, true);
  assert.equal(
    fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM password_reset_tokens WHERE token_hash=?',
    ).get(reset.token).count,
    0,
  );
  assert.deepEqual(
    fixture.store.completePasswordReset(reset.token, SECOND_PASSWORD),
    { changed: true },
  );
  assert.equal(fixture.store.sessionByToken(issued.rawToken), null);
  assert.throws(
    () => fixture.store.completePasswordReset(reset.token, OWNER_PASSWORD),
    (error) => error.status === 404,
  );
  assert.throws(
    () => fixture.store.authenticatePassword('owner@example.com', OWNER_PASSWORD),
    (error) => error.status === 401,
  );
  assert.equal(
    fixture.store.authenticatePassword('owner@example.com', SECOND_PASSWORD).user.id,
    fixture.owner.id,
  );
  assert.ok(
    fixture.audits.some((event) => event.action === 'identity.password_reset_completed'),
  );
});

test('TOTP enrollment encrypts the secret and rejects TOTP and backup-code replay', (t) => {
  const fixture = identityFixture();
  t.after(fixture.close);
  const session = fixture.store.createSession(fixture.owner.id);
  const enrollment = fixture.store.beginTotpEnrollment(fixture.owner.id);
  const databaseState = fixture.db.prepare(`
    SELECT totp_secret_sealed FROM users WHERE id=?
  `).get(fixture.owner.id).totp_secret_sealed;
  assert.equal(databaseState.includes(enrollment.secret), false);

  const firstCode = generateTotpCode(enrollment.secret, { at: fixture.clock() });
  const confirmed = fixture.store.confirmTotpEnrollment(
    fixture.owner.id,
    firstCode,
    { sessionId: session.session.id },
  );
  assert.equal(confirmed.enabled, true);
  assert.equal(confirmed.backupCodes.length, 10);
  assert.equal(fixture.store.sessionByToken(session.rawToken).session.mfaVerifiedAt != null, true);
  assert.throws(
    () => fixture.store.verifySecondFactor(fixture.owner.id, { totpCode: firstCode }),
    (error) => error.code === 'INVALID_MFA_CODE',
  );

  fixture.advance(30_000);
  const secondCode = generateTotpCode(enrollment.secret, { at: fixture.clock() });
  assert.equal(
    fixture.store.verifySecondFactor(
      fixture.owner.id,
      { totpCode: secondCode },
    ).method,
    'totp',
  );
  assert.throws(
    () => fixture.store.verifySecondFactor(
      fixture.owner.id,
      { totpCode: secondCode },
    ),
    (error) => error.code === 'INVALID_MFA_CODE',
  );

  assert.equal(
    fixture.store.verifySecondFactor(
      fixture.owner.id,
      { backupCode: confirmed.backupCodes[0] },
    ).method,
    'backup_code',
  );
  assert.throws(
    () => fixture.store.verifySecondFactor(
      fixture.owner.id,
      { backupCode: confirmed.backupCodes[0] },
    ),
    (error) => error.code === 'INVALID_MFA_CODE',
  );
  assert.throws(
    () => fixture.store.createSession(fixture.owner.id),
    (error) => error.code === 'MFA_REQUIRED',
  );
});

test('invitations, scope resolution and last-owner invariant enforce tenant RBAC', (t) => {
  const fixture = identityFixture();
  t.after(fixture.close);
  const projects = fixture.db.prepare(`
    SELECT id FROM projects ORDER BY id LIMIT 2
  `).all();
  assert.equal(projects.length, 2);

  const ownerMembership = fixture.store.listOrganizationMembers(
    'default-organization',
  ).members.find((member) => member.userId === fixture.owner.id);
  assert.throws(
    () => fixture.store.updateOrganizationMembership(
      'default-organization',
      ownerMembership.id,
      { roleKey: 'admin' },
      fixture.owner.id,
    ),
    (error) => error.code === 'LAST_OWNER_REQUIRED',
  );

  const invitation = fixture.store.createInvitation({
    organizationId: 'default-organization',
    projectId: projects[0].id,
    email: 'viewer@example.com',
    roleKey: 'viewer',
    invitedByUserId: fixture.owner.id,
  });
  assert.equal(fixture.store.inspectInvitation(invitation.token).invitation.projectId, projects[0].id);
  const accepted = fixture.store.acceptInvitation(invitation.token, {
    fullName: 'مشاهده‌گر پروژه',
    password: SECOND_PASSWORD,
  });
  assert.throws(
    () => fixture.store.acceptInvitation(invitation.token, {
      fullName: 'تکراری',
      password: SECOND_PASSWORD,
    }),
    (error) => error.status === 404,
  );

  const orgAuth = fixture.store.organizationAuthorization(
    accepted.user.id,
    'default-organization',
  );
  assert.equal(hasPermission(orgAuth, PERMISSIONS.ORGANIZATION_READ), true);
  assert.equal(hasPermission(orgAuth, PERMISSIONS.MEMBERS_READ), false);
  const assigned = fixture.store.projectAuthorization(
    accepted.user.id,
    projects[0].id,
  );
  assert.equal(hasPermission(assigned, PERMISSIONS.PROJECT_READ), true);
  assert.equal(hasPermission(assigned, PERMISSIONS.FINANCE_READ), false);
  assert.equal(
    fixture.store.projectAuthorization(accepted.user.id, projects[1].id),
    null,
  );
  const contributorInvitation = fixture.store.createInvitation({
    organizationId: 'default-organization',
    projectId: projects[0].id,
    email: 'contributor@example.com',
    roleKey: 'contributor',
    invitedByUserId: fixture.owner.id,
  });
  const contributor = fixture.store.acceptInvitation(
    contributorInvitation.token,
    {
      fullName: 'همکار پروژه',
      password: SECOND_PASSWORD,
    },
  );
  const contributorAuth = fixture.store.projectAuthorization(
    contributor.user.id,
    projects[0].id,
  );
  assert.equal(contributorAuth.projectRole, 'contributor');
  assert.equal(
    hasPermission(contributorAuth, PERMISSIONS.PROJECT_WORK_WRITE),
    true,
  );

  const secondOrganization = fixture.store.createOrganization(
    fixture.owner.id,
    { slug: 'second-org', name: 'سازمان دوم' },
  ).organization;
  assert.throws(
    () => fixture.store.upsertProjectMembership(
      secondOrganization.id,
      projects[0].id,
      accepted.user.id,
      'viewer',
      fixture.owner.id,
    ),
    (error) => error.code === 'PROJECT_NOT_FOUND',
  );

  const revoked = fixture.store.createInvitation({
    organizationId: 'default-organization',
    email: 'revoked@example.com',
    roleKey: 'auditor',
    invitedByUserId: fixture.owner.id,
  });
  fixture.store.revokeInvitation(
    'default-organization',
    revoked.invitation.id,
    fixture.owner.id,
  );
  assert.throws(
    () => fixture.store.inspectInvitation(revoked.token),
    (error) => error.status === 404,
  );
});

test('v2 routes issue secure sessions, enforce CSRF/permissions and keep reset enumeration-safe', async (t) => {
  const fixture = identityFixture();
  t.after(fixture.close);
  const server = await startIdentityServer(fixture);
  t.after(server.close);
  const owner = server.client();

  let result = await owner.request('/api/v2/auth/session', {
    method: 'POST',
    body: { email: 'owner@example.com', password: 'not-the-password' },
  });
  assert.equal(result.response.status, 401);

  result = await owner.request('/api/v2/auth/session', {
    method: 'POST',
    body: { email: 'owner@example.com', password: OWNER_PASSWORD },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
  assert.ok(owner.cookie('hamkari_identity'));
  const csrf = result.data.csrfToken;

  result = await owner.request('/api/v2/admin/organizations/default-organization', {
    method: 'PATCH',
    body: { name: 'بدون توکن' },
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INVALID_CSRF_TOKEN');

  result = await owner.request('/api/v2/admin/organizations/default-organization', {
    method: 'PATCH',
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'سازمان آزمون هویت' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.organization.name, 'سازمان آزمون هویت');

  const projectId = fixture.db.prepare(
    'SELECT id FROM projects ORDER BY id LIMIT 1',
  ).get().id;
  result = await owner.request(
    '/api/v2/admin/organizations/default-organization/invitations',
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        email: 'route-viewer@example.com',
        roleKey: 'viewer',
        projectId,
      },
    },
  );
  assert.equal(result.response.status, 201);
  assert.equal(server.deliveries.invitations.length, 1);
  const invitationToken = result.data.token;

  const viewer = server.client();
  result = await viewer.request('/api/v2/auth/invitations/inspect', {
    method: 'POST',
    body: { token: invitationToken },
  });
  assert.equal(result.response.status, 200);
  result = await viewer.request('/api/v2/auth/invitations/accept', {
    method: 'POST',
    body: {
      token: invitationToken,
      fullName: 'کاربر مسیر',
      password: SECOND_PASSWORD,
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
  result = await viewer.request(
    '/api/v2/admin/organizations/default-organization/members',
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INSUFFICIENT_PERMISSION');

  const unknownReset = await server.client().request(
    '/api/v2/auth/password-reset/request',
    {
      method: 'POST',
      body: { email: 'unknown@example.com' },
    },
  );
  const knownReset = await server.client().request(
    '/api/v2/auth/password-reset/request',
    {
      method: 'POST',
      body: { email: 'owner@example.com' },
    },
  );
  assert.equal(unknownReset.response.status, 202);
  assert.equal(knownReset.response.status, 202);
  assert.deepEqual(unknownReset.data, knownReset.data);
  assert.equal(server.deliveries.resets.length, 1);

  result = await server.client().request(
    '/api/v2/auth/password-reset/complete',
    {
      method: 'POST',
      body: {
        token: server.deliveries.resets[0].token,
        newPassword: SECOND_PASSWORD,
      },
    },
  );
  assert.equal(result.response.status, 200);
  result = await owner.request('/api/v2/admin/me');
  assert.equal(result.response.status, 401);
});

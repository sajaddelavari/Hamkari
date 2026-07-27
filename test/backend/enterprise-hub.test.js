import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/database.js';
import { createDocumentStore } from '../../src/document-store.js';
import { createEnterpriseAudit } from '../../src/enterprise-audit.js';
import {
  API_KEY_PERMISSIONS,
  createEnterpriseHubStore,
} from '../../src/enterprise-hub-store.js';
import { createNotificationWorker } from '../../src/notification-worker.js';
import { createOperationsStore } from '../../src/operations-store.js';
import { createPlatformStore } from '../../src/platform-store.js';
import { unsealData } from '../../src/secure-data.js';
import { hashToken } from '../../src/security.js';
import {
  startTestApplication,
  TEST_PASSWORD,
} from './helpers.js';

const NOW = '2026-07-24T10:00:00.000Z';
const OWNER_PASSWORD = 'owner-password-for-enterprise-tests';
const ORGANIZATION_ID = 'default-organization';
const USER_ID = 'enterprise-hub-test-user';

function createStoreFixture(t) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'enterprise-hub-test-secret-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'enterprise-hub-legacy-password',
  });
  const db = openDatabase(config, { seed: true });
  t.after(() => db.close());
  const clock = () => new Date(NOW);
  const auditService = createEnterpriseAudit(db, {
    clock,
    hmacKey: config.auditHmacKey,
  });
  const audit = (event) => auditService.append(event);
  const hubStore = createEnterpriseHubStore(db, {
    clock,
    audit,
    encryptionKey: config.authEncryptionKey,
  });
  const documentStore = createDocumentStore(db, { clock, audit });
  const platformStore = createPlatformStore(db, { clock });
  const operationsStore = createOperationsStore(db, { clock, audit });
  db.prepare(`
    INSERT INTO users(
      id,email,password_hash,full_name,status,password_changed_at,
      created_at,updated_at
    ) VALUES(?,?,?,'Enterprise Test User','active',?,?,?)
  `).run(
    USER_ID,
    'enterprise-hub@example.com',
    'not-used-by-store-tests',
    NOW,
    NOW,
    NOW,
  );
  return {
    config,
    db,
    clock,
    auditService,
    hubStore,
    documentStore,
    platformStore,
    operationsStore,
    actor: {
      userId: USER_ID,
      permissions: ['*'],
    },
  };
}

async function bootstrapOwner(fixture) {
  const client = fixture.client();
  let result = await client.request('/api/v2/auth/bootstrap');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.bootstrapRequired, true);
  assert.equal(result.data.legacyAuthenticated, false);

  result = await client.request('/api/v2/auth/bootstrap', {
    method: 'POST',
    body: {
      email: 'owner@example.com',
      fullName: 'Enterprise Owner',
      organizationName: 'Enterprise Test Organization',
      password: OWNER_PASSWORD,
    },
  });
  assert.equal(result.response.status, 401);

  const legacyLogin = await client.request('/api/v1/admin/session', {
    method: 'POST',
    body: { password: TEST_PASSWORD },
  });
  assert.equal(legacyLogin.response.status, 200);

  result = await client.request('/api/v2/auth/bootstrap', {
    method: 'POST',
    headers: { 'X-CSRF-Token': legacyLogin.data.csrfToken },
    body: {
      email: 'owner@example.com',
      fullName: 'Enterprise Owner',
      organizationName: 'Enterprise Test Organization',
      password: OWNER_PASSWORD,
    },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.created, true);
  assert.equal(result.data.organization.name, 'Enterprise Test Organization');
  const owner = result.data.user;

  result = await client.request('/api/v2/auth/bootstrap', {
    method: 'POST',
    headers: { 'X-CSRF-Token': legacyLogin.data.csrfToken },
    body: {
      email: 'other-owner@example.com',
      fullName: 'Other Owner',
      organizationName: 'Must Not Replace Organization',
      password: OWNER_PASSWORD,
    },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'BOOTSTRAP_ALREADY_COMPLETED');

  result = await client.request('/api/v2/auth/session', {
    method: 'POST',
    body: {
      email: 'owner@example.com',
      password: OWNER_PASSWORD,
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
  return {
    client,
    owner,
    csrf: result.data.csrfToken,
  };
}

test('enterprise audit redacts secrets, chains events and detects counterfeit rows', (t) => {
  const { db, auditService } = createStoreFixture(t);
  const first = auditService.append({
    organizationId: ORGANIZATION_ID,
    actorType: 'user',
    actorId: USER_ID,
    action: 'security.profile_changed',
    resourceType: 'user',
    resourceId: USER_ID,
    after: {
      displayName: 'Visible name',
      email: 'private@example.com',
      nested: { accessToken: 'raw-token', harmless: 'visible' },
    },
    metadata: { password: 'never-store-this', reason: 'test' },
  });
  const second = auditService.append({
    organizationId: ORGANIZATION_ID,
    action: 'security.session_revoked',
    resourceType: 'session',
    resourceId: 'session-1',
  });

  const listed = auditService.list({ organizationId: ORGANIZATION_ID });
  const firstEvent = listed.events.find((event) => event.id === first.id);
  assert.equal(firstEvent.after.displayName, 'Visible name');
  assert.equal(firstEvent.after.email, '[REDACTED]');
  assert.equal(firstEvent.after.nested.accessToken, '[REDACTED]');
  assert.equal(firstEvent.after.nested.harmless, 'visible');
  assert.equal(firstEvent.metadata.password, '[REDACTED]');
  assert.deepEqual(auditService.verify(), {
    valid: true,
    checked: 2,
    headHash: second.hash,
    verifiedAt: NOW,
  });

  assert.throws(
    () => db.prepare(`
      UPDATE enterprise_audit_events SET action='tampered' WHERE id=?
    `).run(first.id),
    /enterprise audit is immutable/,
  );

  db.prepare(`
    INSERT INTO enterprise_audit_events(
      id,organization_id,actor_type,request_id,ip_hash,action,resource_type,
      resource_id,metadata_json,previous_hash,event_hash,created_at
    ) VALUES(
      'counterfeit-event',?,'system','','','security.counterfeit','audit',
      'counterfeit','{}',?,'not-a-valid-hash',?
    )
  `).run(ORGANIZATION_ID, second.hash, NOW);
  assert.deepEqual(auditService.verify(), {
    valid: false,
    checked: 2,
    failedEventId: 'counterfeit-event',
    reason: 'EVENT_HASH_MISMATCH',
  });
});

test('bootstrap, workspace, document versions and API-key scope work through v2 HTTP routes', async (t) => {
  const fixture = await startTestApplication({
    applicationOptions: {
      clock: () => new Date(NOW),
      startWorkers: false,
    },
  });
  t.after(fixture.close);
  const { client, owner, csrf } = await bootstrapOwner(fixture);

  let legacyResult = await client.request('/api/v1/admin/session');
  assert.equal(legacyResult.response.status, 200);
  assert.equal(legacyResult.data.authenticated, false);
  assert.equal(legacyResult.data.disabled, true);
  legacyResult = await client.request('/api/v1/admin/session', {
    method: 'POST',
    body: { password: TEST_PASSWORD },
  });
  assert.equal(legacyResult.response.status, 403);
  assert.equal(legacyResult.data.error.code, 'LEGACY_ADMIN_DISABLED');

  const passwordRow = fixture.application.db.prepare(`
    SELECT password_hash FROM users WHERE id=?
  `).get(owner.id);
  assert.notEqual(passwordRow.password_hash, OWNER_PASSWORD);
  assert.match(passwordRow.password_hash, /^scrypt\$/);

  let result = await client.request('/api/v2/admin/workspace');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
  assert.equal(result.data.user.id, owner.id);
  assert.ok(result.data.projects.length >= 3);

  const projectInput = {
    organizationId: ORGANIZATION_ID,
    slug: 'enterprise-v2-route-project',
    title: 'Enterprise V2 Route Project',
    status: 'published',
    visibility: 'public',
    lifecycle: 'executing',
    stage: 'execution',
    currency: 'IRR',
  };
  result = await client.request('/api/v2/admin/projects', {
    method: 'POST',
    body: projectInput,
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INVALID_CSRF_TOKEN');

  result = await client.request('/api/v2/admin/projects', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: projectInput,
  });
  assert.equal(result.response.status, 201);
  const projectId = result.data.project.id;
  assert.equal(result.data.project.organizationId, ORGANIZATION_ID);
  assert.equal(result.data.project.ownerUserId, owner.id);

  result = await client.request(
    `/api/v2/admin/projects/${projectId}/stakeholders`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Enterprise Capital Holder',
        kind: 'person',
        role: 'investor',
      },
    },
  );
  assert.equal(result.response.status, 201);
  const stakeholderId = result.data.stakeholder.id;
  result = await client.request(
    `/api/v2/admin/projects/${projectId}/share-classes`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Enterprise Common',
        symbol: 'ENT',
        authorizedUnits: 1_000,
        votingWeight: 1,
      },
    },
  );
  assert.equal(result.response.status, 201);
  const shareClassId = result.data.shareClass.id;
  result = await client.request(
    `/api/v2/admin/projects/${projectId}/share-classes/${shareClassId}/issuances`,
    {
      method: 'POST',
      headers: {
        'X-CSRF-Token': csrf,
        'Idempotency-Key': 'enterprise-direct-issuance-must-be-blocked',
      },
      body: { stakeholderId, units: 10 },
    },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'CORPORATE_ACTION_REQUIRED');

  const contributorPassword = 'contributor-enterprise-password';
  const contributorInvitation = fixture.application.identityStore.createInvitation({
    organizationId: ORGANIZATION_ID,
    projectId,
    email: 'workspace-contributor@example.com',
    roleKey: 'contributor',
    invitedByUserId: owner.id,
  });
  fixture.application.identityStore.acceptInvitation(
    contributorInvitation.token,
    {
      fullName: 'Workspace Contributor',
      password: contributorPassword,
    },
  );
  const contributorClient = fixture.client();
  result = await contributorClient.request('/api/v2/auth/session', {
    method: 'POST',
    body: {
      email: 'workspace-contributor@example.com',
      password: contributorPassword,
    },
  });
  assert.equal(result.response.status, 200);
  result = await contributorClient.request(
    `/api/v2/admin/workspace?projectId=${encodeURIComponent(projectId)}`,
  );
  assert.equal(result.response.status, 200);
  assert.equal(
    result.data.selectedProjectAuthorization.projectRole,
    'contributor',
  );
  assert.equal(
    result.data.selectedProjectAuthorization.permissions.includes(
      'project_work.write',
    ),
    true,
  );

  const outsider = fixture.client();
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents`,
  );
  assert.equal(result.response.status, 401);

  result = await client.request(
    `/api/v2/admin/projects/${projectId}/documents`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        title: 'Board agreement',
        folder: 'governance/board',
        category: 'contract',
        visibility: 'private',
      },
    },
  );
  assert.equal(result.response.status, 201);
  const documentId = result.data.document.id;

  result = await client.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}/versions`,
    {
      method: 'POST',
      headers: {
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/pdf',
        'X-File-Name': 'forged.pdf',
      },
      body: Buffer.from('this is not a pdf', 'utf8'),
    },
  );
  assert.equal(result.response.status, 415);
  assert.equal(result.data.error.code, 'FILE_SIGNATURE_MISMATCH');

  const content = Buffer.from('%PDF-1.4 deterministic-enterprise-test', 'utf8');
  result = await client.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}/versions`,
    {
      method: 'POST',
      headers: {
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/pdf',
        'X-File-Name': 'board-agreement.pdf',
        'X-Change-Note': 'Initial approved draft',
      },
      body: content,
    },
  );
  assert.equal(result.response.status, 201);
  assert.equal(result.data.version.versionNo, 1);
  assert.equal(result.data.version.sizeBytes, content.length);
  assert.equal(result.data.version.sha256.length, 64);
  const versionId = result.data.version.id;
  result = await client.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}/versions`,
    {
      method: 'POST',
      headers: {
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent('توافق‌نامه-هیئت‌مدیره.pdf'),
        'X-Change-Note': encodeURIComponent('نسخهٔ فارسی تصویب‌شده'),
      },
      body: Buffer.from('%PDF-1.4 unicode-metadata-test', 'utf8'),
    },
  );
  assert.equal(result.response.status, 201);
  assert.equal(result.data.version.versionNo, 2);
  assert.equal(result.data.version.filename, 'توافق‌نامه-هیئت‌مدیره.pdf');
  assert.equal(result.data.version.changeNote, 'نسخهٔ فارسی تصویب‌شده');

  result = await client.request(
    `/api/v2/admin/projects/${projectId}/documents`,
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.data.documents[0].currentVersionNo, 2);
  assert.equal(Object.hasOwn(result.data.documents[0].versions[0], 'content'), false);

  result = await client.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}/versions/${versionId}`,
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('content-type'), 'application/pdf');
  assert.match(
    result.response.headers.get('content-disposition'),
    /board-agreement\.pdf/,
  );
  assert.equal(result.data, content.toString('utf8'));

  result = await client.request(
    `/api/v2/admin/projects/${projectId}/comments`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        resourceType: 'task',
        resourceId: 'api-key-ownership-boundary',
        body: 'Team API-key boundary note',
        visibility: 'team',
      },
    },
  );
  assert.equal(result.response.status, 201);
  result = await client.request(
    `/api/v2/admin/projects/${projectId}/comments`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        resourceType: 'task',
        resourceId: 'api-key-ownership-boundary',
        body: 'Private owner API-key boundary note',
        visibility: 'private',
      },
    },
  );
  assert.equal(result.response.status, 201);
  const privateOwnerCommentId = result.data.comment.id;
  result = await client.request(
    `/api/v2/admin/projects/${projectId}/comments`
      + '?resourceType=task&resourceId=api-key-ownership-boundary',
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(
    result.data.comments.map((comment) => comment.body).sort(),
    ['Private owner API-key boundary note', 'Team API-key boundary note'],
  );

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Document reader',
        permissions: ['project.read'],
      },
    },
  );
  assert.equal(result.response.status, 201);
  assert.equal(result.data.tokenShownOnce, true);
  const rawApiKey = result.data.token;
  const apiKeyId = result.data.apiKey.id;
  assert.match(rawApiKey, /^hmk_/);
  const storedKey = fixture.application.db.prepare(`
    SELECT token_hash FROM api_keys WHERE id=?
  `).get(apiKeyId);
  assert.equal(storedKey.token_hash, hashToken(rawApiKey));
  assert.notEqual(storedKey.token_hash, rawApiKey);

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
  );
  assert.equal(result.response.status, 200);
  assert.equal(Object.hasOwn(result.data.apiKeys[0], 'token'), false);

  const keyHeaders = { Authorization: `Bearer ${rawApiKey}` };
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents`,
    { headers: keyHeaders },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.documents, []);
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}/versions/${versionId}`,
    { headers: keyHeaders },
  );
  assert.equal(result.response.status, 404);
  assert.equal(result.data.error.code, 'DOCUMENT_NOT_FOUND');
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/comments`
      + '?resourceType=task&resourceId=api-key-ownership-boundary',
    { headers: keyHeaders },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(
    result.data.comments.map((comment) => comment.body),
    ['Team API-key boundary note'],
  );
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/needs`,
    { headers: keyHeaders },
  );
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.data.needs));

  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents`,
    {
      method: 'POST',
      headers: keyHeaders,
      body: {
        title: 'Forbidden write',
        category: 'other',
      },
    },
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INSUFFICIENT_API_KEY_PERMISSION');

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Server document writer',
        permissions: ['project_work.write'],
      },
    },
  );
  assert.equal(result.response.status, 201);
  const writerApiKey = result.data.token;
  const writerApiKeyId = result.data.apiKey.id;
  const writerKeyHeaders = { Authorization: `Bearer ${writerApiKey}` };
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}`,
    {
      method: 'PATCH',
      origin: false,
      headers: writerKeyHeaders,
      body: { title: 'API-key ownership bypass attempt' },
    },
  );
  assert.equal(result.response.status, 404);
  assert.equal(result.data.error.code, 'DOCUMENT_NOT_FOUND');
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}/versions`,
    {
      method: 'POST',
      origin: false,
      headers: {
        ...writerKeyHeaders,
        'Content-Type': 'application/pdf',
        'X-File-Name': 'api-key-ownership-bypass.pdf',
      },
      body: Buffer.from('%PDF-1.4 api-key ownership bypass attempt', 'utf8'),
    },
  );
  assert.equal(result.response.status, 404);
  assert.equal(result.data.error.code, 'DOCUMENT_NOT_FOUND');
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/comments/${privateOwnerCommentId}`,
    {
      method: 'DELETE',
      origin: false,
      headers: writerKeyHeaders,
    },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'COMMENT_OWNERSHIP_REQUIRED');
  result = await client.request(
    `/api/v2/admin/projects/${projectId}/comments/${privateOwnerCommentId}`,
    {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrf },
    },
  );
  assert.equal(result.response.status, 200);
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents`,
    {
      method: 'POST',
      origin: false,
      headers: { Authorization: `Bearer ${writerApiKey}` },
      body: {
        title: 'Server-to-server document',
        category: 'evidence',
        visibility: 'project',
      },
    },
  );
  assert.equal(result.response.status, 201);
  assert.equal(result.data.document.title, 'Server-to-server document');
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/tasks`,
    {
      method: 'POST',
      origin: false,
      headers: { Authorization: `Bearer ${writerApiKey}` },
      body: {
        title: 'API-key attributed task',
        progressMethod: 'manual',
      },
    },
  );
  assert.equal(result.response.status, 201);
  const attributedTaskId = result.data.task.id;
  const attributedAudit = fixture.application.db.prepare(`
    SELECT organization_id,actor_type,actor_id
    FROM enterprise_audit_events
    WHERE project_id=? AND resource_type='project_task'
      AND resource_id=? AND action='created'
    LIMIT 1
  `).get(projectId, attributedTaskId);
  assert.deepEqual({ ...attributedAudit }, {
    organization_id: ORGANIZATION_ID,
    actor_type: 'api_key',
    actor_id: writerApiKeyId,
  });

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Contract document automation',
        permissions: [
          'project.read',
          'project_work.write',
          'contracts.read',
          'contracts.manage',
        ],
      },
    },
  );
  assert.equal(result.response.status, 201);
  const contractKeyHeaders = {
    Authorization: `Bearer ${result.data.token}`,
  };
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents`,
    { headers: contractKeyHeaders },
  );
  assert.equal(result.response.status, 200);
  assert.equal(
    result.data.documents.some((document) => document.id === documentId),
    true,
  );
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}/versions/${versionId}`,
    { headers: contractKeyHeaders },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.data, content.toString('utf8'));
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}`,
    {
      method: 'PATCH',
      origin: false,
      headers: contractKeyHeaders,
      body: { title: 'Board agreement — API maintained' },
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.data.document.title, 'Board agreement — API maintained');
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents/${documentId}/versions`,
    {
      method: 'POST',
      origin: false,
      headers: {
        ...contractKeyHeaders,
        'Content-Type': 'application/pdf',
        'X-File-Name': 'board-agreement-api-maintained.pdf',
      },
      body: Buffer.from('%PDF-1.4 scoped contract automation', 'utf8'),
    },
  );
  assert.equal(result.response.status, 201);
  assert.equal(result.data.version.versionNo, 3);

  const secondOrganization = fixture.application.identityStore
    .createOrganization(owner.id, {
      slug: 'isolated-enterprise-org',
      name: 'Isolated Enterprise Organization',
    }).organization;
  const foreignProject = fixture.application.platformStore.createProject({
    organizationId: secondOrganization.id,
    slug: 'isolated-enterprise-project',
    title: 'Isolated Enterprise Project',
    status: 'published',
    visibility: 'private',
  }).project;
  result = await outsider.request(
    `/api/v2/admin/projects/${foreignProject.id}/documents`,
    { headers: keyHeaders },
  );
  assert.equal(result.response.status, 404);
  assert.equal(result.data.error.code, 'PROJECT_NOT_FOUND');

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Organization automation key',
        permissions: ['organization.manage'],
      },
    },
  );
  assert.equal(result.response.status, 201);
  const organizationApiKey = result.data.token;
  const organizationKeyHeaders = {
    Authorization: `Bearer ${organizationApiKey}`,
  };
  result = await outsider.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    { headers: organizationKeyHeaders },
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INTERACTIVE_SESSION_REQUIRED');
  result = await outsider.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    {
      method: 'POST',
      origin: false,
      headers: organizationKeyHeaders,
      body: {
        name: 'Credential chaining must fail',
        permissions: ['organization.manage'],
      },
    },
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INTERACTIVE_SESSION_REQUIRED');

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys/${apiKeyId}`,
    {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrf },
    },
  );
  assert.equal(result.response.status, 200);
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents`,
    { headers: keyHeaders },
  );
  assert.equal(result.response.status, 401);

  fixture.application.db.prepare(`
    UPDATE users SET status='suspended' WHERE id=?
  `).run(owner.id);
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents`,
    { headers: { Authorization: `Bearer ${writerApiKey}` } },
  );
  assert.equal(result.response.status, 401);
});

test('private documents and comments are filtered by actor and board scope', (t) => {
  const {
    db,
    documentStore,
    hubStore,
    platformStore,
    actor,
  } = createStoreFixture(t);
  const project = platformStore.createProject({
    organizationId: ORGANIZATION_ID,
    slug: 'visibility-policy-project',
    title: 'Visibility Policy Project',
    status: 'published',
    visibility: 'private',
  }).project;
  const privateDocument = documentStore.create(
    project.id,
    ORGANIZATION_ID,
    {
      title: 'Private contract',
      category: 'contract',
      visibility: 'private',
    },
    actor,
  ).document;
  documentStore.create(
    project.id,
    ORGANIZATION_ID,
    {
      title: 'Project evidence',
      category: 'evidence',
      visibility: 'project',
    },
    actor,
  );
  const privateContent = Buffer.from(
    '%PDF-1.4 private contract store boundary',
    'utf8',
  );
  const privateVersion = documentStore.addVersion(
    project.id,
    privateDocument.id,
    {
      filename: 'private-contract.pdf',
      mimeType: 'application/pdf',
      buffer: privateContent,
    },
    actor,
  ).version;
  assert.equal(
    Buffer.from(documentStore.versionContent(
      project.id,
      privateDocument.id,
      privateVersion.id,
      actor,
    ).content).toString('utf8'),
    privateContent.toString('utf8'),
  );
  assert.equal(
    documentStore.patch(
      project.id,
      privateDocument.id,
      { folder: 'legal/contracts' },
      actor,
    ).document.folder,
    'legal/contracts',
  );

  const projectReader = {
    userId: 'project-reader',
    permissions: ['project.read'],
  };
  const financeReader = {
    userId: 'finance-reader',
    permissions: ['project.read', 'finance.read'],
  };
  const contractReader = {
    userId: 'contract-reader',
    permissions: ['project.read', 'contracts.read'],
  };
  assert.deepEqual(
    documentStore.list(project.id, {}, projectReader).documents.map(
      (document) => document.title,
    ),
    ['Project evidence'],
  );
  assert.deepEqual(
    documentStore.list(project.id, {}, financeReader).documents.map(
      (document) => document.title,
    ),
    ['Project evidence'],
  );
  assert.deepEqual(
    documentStore.list(project.id, {}, contractReader).documents.map(
      (document) => document.title,
    ).sort(),
    ['Private contract', 'Project evidence'],
  );
  assert.throws(
    () => documentStore.patch(
      project.id,
      privateDocument.id,
      { title: 'Unauthorized change' },
      contractReader,
    ),
    (error) => error?.code === 'DOCUMENT_NOT_FOUND',
  );
  const creatorReadKey = {
    userId: USER_ID,
    actorType: 'api_key',
    apiKey: { id: 'creator-read-key' },
    permissions: ['project.read'],
  };
  assert.deepEqual(
    documentStore.list(project.id, {}, creatorReadKey).documents.map(
      (document) => document.title,
    ),
    ['Project evidence'],
  );
  assert.throws(
    () => documentStore.versionContent(
      project.id,
      privateDocument.id,
      privateVersion.id,
      creatorReadKey,
    ),
    (error) => error?.code === 'DOCUMENT_NOT_FOUND',
  );
  const creatorWriteKey = {
    userId: USER_ID,
    actorType: 'api_key',
    apiKey: { id: 'creator-write-key' },
    permissions: ['project_work.write'],
  };
  assert.throws(
    () => documentStore.patch(
      project.id,
      privateDocument.id,
      { title: 'Creator key must not inherit ownership' },
      creatorWriteKey,
    ),
    (error) => error?.code === 'DOCUMENT_NOT_FOUND',
  );
  assert.throws(
    () => documentStore.addVersion(
      project.id,
      privateDocument.id,
      {
        filename: 'creator-key-bypass.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 creator key bypass', 'utf8'),
      },
      creatorWriteKey,
    ),
    (error) => error?.code === 'DOCUMENT_NOT_FOUND',
  );
  const scopedContractReadKey = {
    ...creatorReadKey,
    apiKey: { id: 'scoped-contract-read-key' },
    permissions: ['project.read', 'contracts.read'],
  };
  assert.deepEqual(
    documentStore.list(project.id, {}, scopedContractReadKey).documents.map(
      (document) => document.title,
    ).sort(),
    ['Private contract', 'Project evidence'],
  );
  assert.equal(
    Buffer.from(documentStore.versionContent(
      project.id,
      privateDocument.id,
      privateVersion.id,
      scopedContractReadKey,
    ).content).toString('utf8'),
    privateContent.toString('utf8'),
  );
  const scopedContractManageKey = {
    ...creatorWriteKey,
    apiKey: { id: 'scoped-contract-manage-key' },
    permissions: ['project_work.write', 'contracts.manage'],
  };
  assert.equal(
    documentStore.patch(
      project.id,
      privateDocument.id,
      { title: 'Scoped contract automation' },
      scopedContractManageKey,
    ).document.title,
    'Scoped contract automation',
  );
  assert.equal(
    documentStore.addVersion(
      project.id,
      privateDocument.id,
      {
        filename: 'scoped-contract-automation.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 scoped contract automation', 'utf8'),
      },
      scopedContractManageKey,
    ).version.versionNo,
    2,
  );

  hubStore.addComment(project.id, ORGANIZATION_ID, {
    resourceType: 'task',
    resourceId: 'visibility-task',
    body: 'Team comment',
    visibility: 'team',
  }, actor);
  const privateComment = hubStore.addComment(project.id, ORGANIZATION_ID, {
    resourceType: 'task',
    resourceId: 'visibility-task',
    body: 'Private owner note',
    visibility: 'private',
  }, actor).comment;
  const boardActor = {
    userId: 'board-user',
    organizationRole: 'board',
    permissions: ['project.read', 'governance.manage'],
  };
  db.prepare(`
    INSERT INTO users(
      id,email,password_hash,full_name,status,password_changed_at,
      created_at,updated_at
    ) VALUES(?,?,?,'Board User','active',?,?,?)
  `).run(
    boardActor.userId,
    'board-user@example.com',
    'not-used-by-store-tests',
    NOW,
    NOW,
    NOW,
  );
  hubStore.addComment(project.id, ORGANIZATION_ID, {
    resourceType: 'task',
    resourceId: 'visibility-task',
    body: 'Board-only comment',
    visibility: 'board',
  }, boardActor);

  assert.deepEqual(
    hubStore.comments(
      project.id,
      'task',
      'visibility-task',
      projectReader,
    ).comments.map((comment) => comment.body),
    ['Team comment'],
  );
  assert.deepEqual(
    hubStore.comments(
      project.id,
      'task',
      'visibility-task',
      boardActor,
    ).comments.map((comment) => comment.body).sort(),
    ['Board-only comment', 'Team comment'],
  );
  assert.deepEqual(
    hubStore.comments(
      project.id,
      'task',
      'visibility-task',
      actor,
    ).comments.map((comment) => comment.body).sort(),
    ['Board-only comment', 'Private owner note', 'Team comment'],
  );
  assert.deepEqual(
    hubStore.comments(
      project.id,
      'task',
      'visibility-task',
      creatorReadKey,
    ).comments.map((comment) => comment.body),
    ['Team comment'],
  );
  assert.throws(
    () => hubStore.deleteComment(
      project.id,
      privateComment.id,
      creatorWriteKey,
    ),
    (error) => error?.code === 'COMMENT_OWNERSHIP_REQUIRED',
  );
  assert.deepEqual(
    hubStore.deleteComment(project.id, privateComment.id, actor),
    { deleted: true, id: privateComment.id },
  );
  assert.throws(
    () => hubStore.addComment(project.id, ORGANIZATION_ID, {
      resourceType: 'task',
      resourceId: 'visibility-task',
      body: 'Forbidden board comment',
      visibility: 'board',
    }, projectReader),
    (error) => error?.code === 'BOARD_VISIBILITY_FORBIDDEN',
  );
});

test('document versions enforce per-document, project and organization quotas atomically', (t) => {
  const {
    db,
    clock,
    auditService,
    platformStore,
    actor,
  } = createStoreFixture(t);
  const documentStore = createDocumentStore(db, {
    clock,
    audit: (event) => auditService.append(event),
    projectQuotaBytes: 8,
    organizationQuotaBytes: 10,
    maximumVersionsPerDocument: 1,
  });
  const firstProject = platformStore.createProject({
    organizationId: ORGANIZATION_ID,
    slug: 'document-quota-one',
    title: 'Document quota one',
    status: 'draft',
    visibility: 'private',
  }).project;
  const firstDocument = documentStore.create(
    firstProject.id,
    ORGANIZATION_ID,
    { title: 'Quota document', visibility: 'private' },
    actor,
  ).document;
  documentStore.addVersion(firstProject.id, firstDocument.id, {
    filename: 'one.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('123456'),
  }, actor);
  assert.throws(
    () => documentStore.addVersion(firstProject.id, firstDocument.id, {
      filename: 'two.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('1'),
    }, actor),
    (error) => error?.code === 'DOCUMENT_VERSION_LIMIT_EXCEEDED',
  );

  const secondDocument = documentStore.create(
    firstProject.id,
    ORGANIZATION_ID,
    { title: 'Second quota document', visibility: 'private' },
    actor,
  ).document;
  assert.throws(
    () => documentStore.addVersion(firstProject.id, secondDocument.id, {
      filename: 'project-over.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('123'),
    }, actor),
    (error) => error?.code === 'PROJECT_DOCUMENT_QUOTA_EXCEEDED',
  );

  const secondProject = platformStore.createProject({
    organizationId: ORGANIZATION_ID,
    slug: 'document-quota-two',
    title: 'Document quota two',
    status: 'draft',
    visibility: 'private',
  }).project;
  const organizationDocument = documentStore.create(
    secondProject.id,
    ORGANIZATION_ID,
    { title: 'Organization quota document', visibility: 'private' },
    actor,
  ).document;
  assert.throws(
    () => documentStore.addVersion(secondProject.id, organizationDocument.id, {
      filename: 'organization-over.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('12345'),
    }, actor),
    (error) => error?.code === 'ORGANIZATION_DOCUMENT_QUOTA_EXCEEDED',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM document_versions').get().count,
    1,
  );
});

test('marketplace hides non-public opportunities and applies public facets and filters consistently', (t) => {
  const {
    hubStore,
    platformStore,
    actor,
  } = createStoreFixture(t);
  const publicProject = platformStore.createProject({
    organizationId: ORGANIZATION_ID,
    slug: 'market-public-project',
    title: 'Public Market Project',
    status: 'published',
    visibility: 'public',
    industry: 'Energy',
    currency: 'IRR',
  }).project;
  const privateProject = platformStore.createProject({
    organizationId: ORGANIZATION_ID,
    slug: 'market-private-project',
    title: 'Private Market Project',
    status: 'published',
    visibility: 'private',
    industry: 'Confidential',
    currency: 'IRR',
  }).project;

  const visible = hubStore.upsertListing(
    publicProject.id,
    ORGANIZATION_ID,
    {
      type: 'investment',
      title: 'Visible clean-energy investment',
      summary: 'A public opportunity suitable for marketplace discovery.',
      minimumAmount: 1_000,
      maximumAmount: 10_000,
      currency: 'IRR',
      tags: ['energy', 'public'],
      status: 'published',
    },
    actor,
  ).listing;
  const otherCurrency = hubStore.upsertListing(
    publicProject.id,
    ORGANIZATION_ID,
    {
      type: 'expert',
      title: 'Public USD expert opportunity',
      summary: 'A second visible opportunity used to verify filters.',
      currency: 'USD',
      status: 'published',
    },
    actor,
  ).listing;
  const expired = hubStore.upsertListing(
    publicProject.id,
    ORGANIZATION_ID,
    {
      type: 'investment',
      title: 'Expired investment',
      summary: 'This opportunity must disappear after its closing date.',
      currency: 'IRR',
      closesAt: '2026-07-23T23:59:59.000Z',
      status: 'published',
    },
    actor,
  ).listing;
  const privateListing = hubStore.upsertListing(
    privateProject.id,
    ORGANIZATION_ID,
    {
      type: 'investment',
      title: 'Confidential investment',
      summary: 'A published record whose project visibility is private.',
      currency: 'IRR',
      status: 'published',
    },
    actor,
  ).listing;
  hubStore.upsertListing(
    publicProject.id,
    ORGANIZATION_ID,
    {
      type: 'investment',
      title: 'Draft opportunity',
      summary: 'Draft listings are never public.',
      currency: 'IRR',
      status: 'draft',
    },
    actor,
  );

  const allPublic = hubStore.publicListings({ limit: 20 });
  assert.deepEqual(
    new Set(allPublic.listings.map((listing) => listing.id)),
    new Set([visible.id, otherCurrency.id]),
  );
  assert.equal(
    allPublic.listings.some((listing) => listing.id === expired.id),
    false,
  );
  const filtered = hubStore.publicListings({
    type: 'investment',
    currency: 'irr',
    q: 'clean-energy',
  });
  assert.deepEqual(filtered.listings.map((listing) => listing.id), [visible.id]);
  assert.equal(
    JSON.stringify(filtered).includes('Confidential investment'),
    false,
  );
  assert.equal(
    Object.hasOwn(filtered.listings[0].organization, 'nationalId'),
    false,
  );
  assert.equal(
    Object.hasOwn(filtered.listings[0], 'contactEmail'),
    false,
  );
  assert.throws(
    () => hubStore.publicListing(privateListing.id),
    (error) => error.code === 'LISTING_NOT_FOUND',
  );

  const facets = hubStore.marketplaceFacets();
  assert.deepEqual(
    Object.fromEntries(facets.types.map((item) => [item.value, item.count])),
    { expert: 1, investment: 1 },
  );
  assert.deepEqual(
    Object.fromEntries(
      facets.currencies.map((item) => [item.value, item.count]),
    ),
    { IRR: 1, USD: 1 },
  );
  assert.deepEqual(
    facets.industries,
    [{ value: 'Energy', count: 2 }],
  );
});

test('CSV reports neutralize formulas and HTML reports escape user-controlled cells', (t) => {
  const {
    hubStore,
    platformStore,
    operationsStore,
    actor,
  } = createStoreFixture(t);
  const project = platformStore.createProject({
    organizationId: ORGANIZATION_ID,
    slug: 'safe-report-project',
    title: 'Safe Report Project',
    status: 'published',
    visibility: 'public',
  }).project;
  operationsStore.createTask(project.id, {
    title: '=HYPERLINK("https://invalid.example","click")',
    description: 'Formula-injection regression row.',
  }, { actorUserId: USER_ID });
  operationsStore.createTask(project.id, {
    title: '<img src=x onerror=alert(1)>',
    description: 'HTML-escaping regression row.',
  }, { actorUserId: USER_ID });

  const csv = hubStore.generateReport(
    project.id,
    ORGANIZATION_ID,
    'tasks',
    'csv',
    actor,
  );
  const csvText = csv.content.toString('utf8');
  assert.ok(csvText.startsWith('\uFEFF'));
  assert.match(
    csvText,
    /"'=HYPERLINK\(""https:\/\/invalid\.example"",""click""\)"/,
  );
  assert.doesNotMatch(csvText, /,"=HYPERLINK/);

  const html = hubStore.generateReport(
    project.id,
    ORGANIZATION_ID,
    'tasks',
    'html',
    actor,
  ).content.toString('utf8');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('notification outbox keeps payloads sealed and distinguishes manual from sandbox delivery', async (t) => {
  const {
    config,
    db,
    clock,
    hubStore,
    actor,
  } = createStoreFixture(t);
  const manualId = hubStore.enqueueNotification({
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    channel: 'email',
    destination: 'recipient@example.com',
    templateKey: 'password-reset',
    provider: 'manual',
    payload: {
      resetToken: 'raw-reset-token-must-stay-encrypted',
      displayName: 'Recipient',
    },
  });
  const storedManual = db.prepare(`
    SELECT * FROM notification_outbox WHERE id=?
  `).get(manualId);
  assert.equal(
    storedManual.payload_json.includes('raw-reset-token-must-stay-encrypted'),
    false,
  );
  assert.equal(JSON.parse(storedManual.payload_json).sealed.length > 40, true);
  assert.equal(
    Object.hasOwn(
      hubStore.notificationOutbox(ORGANIZATION_ID).outbox[0],
      'payload',
    ),
    false,
  );
  const revealedManual = hubStore.notificationOutbox(ORGANIZATION_ID, {
    revealManualPayload: true,
  }).outbox.find((item) => item.id === manualId);
  assert.equal(Object.hasOwn(revealedManual, 'payload'), false);

  const worker = createNotificationWorker(db, {
    clock,
    encryptionKey: config.authEncryptionKey,
  });
  let result = await worker.runOnce();
  assert.deepEqual(result, {
    processed: false,
    reason: 'EMPTY',
  });
  let row = db.prepare(`
    SELECT status,attempts,next_attempt_at,sent_at FROM notification_outbox
    WHERE id=?
  `).get(manualId);
  assert.equal(row.status, 'pending');
  assert.equal(Number(row.attempts), 0);
  assert.equal(row.next_attempt_at, NOW);
  assert.equal(row.sent_at, null);

  db.prepare(`
    UPDATE notification_outbox
    SET status='processing',updated_at='2026-07-24T09:50:00.000Z'
    WHERE id=?
  `).run(manualId);
  result = await worker.runOnce();
  assert.deepEqual(result, {
    processed: false,
    reason: 'EMPTY',
  });
  row = db.prepare(`
    SELECT status,attempts,next_attempt_at,last_error
    FROM notification_outbox WHERE id=?
  `).get(manualId);
  assert.equal(row.status, 'pending');
  assert.equal(Number(row.attempts), 0);
  assert.equal(row.next_attempt_at, NOW);
  assert.match(row.last_error, /تحویل دستی اپراتور/);

  const manuallyDelivered = hubStore.updateNotificationOutbox(
    ORGANIZATION_ID,
    manualId,
    { action: 'mark_sent' },
    actor,
  );
  assert.equal(manuallyDelivered.id, manualId);
  assert.equal(manuallyDelivered.status, 'sent');
  assert.equal(manuallyDelivered.sentAt, NOW);
  assert.equal(Object.hasOwn(manuallyDelivered, 'payload'), false);
  assert.throws(
    () => hubStore.updateNotificationOutbox(
      ORGANIZATION_ID,
      manualId,
      { action: 'cancel' },
      actor,
    ),
    (error) => error?.code === 'OUTBOX_ITEM_FINAL',
  );

  const sandboxId = hubStore.enqueueNotification({
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    channel: 'sms',
    destination: '09120000000',
    templateKey: 'decision',
    provider: 'sandbox',
    payload: { decision: 'approved', secret: 'sandbox-secret' },
  });
  result = await worker.runOnce();
  assert.deepEqual(result, {
    processed: true,
    id: sandboxId,
    delivered: true,
    sandbox: true,
  });
  row = db.prepare(`
    SELECT status,attempts,next_attempt_at,sent_at,payload_json
    FROM notification_outbox WHERE id=?
  `).get(sandboxId);
  assert.equal(row.status, 'sent');
  assert.equal(Number(row.attempts), 1);
  assert.equal(row.next_attempt_at, null);
  assert.equal(row.sent_at, NOW);
  assert.equal(row.payload_json.includes('sandbox-secret'), false);
  const recoveredId = hubStore.enqueueNotification({
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    channel: 'email',
    destination: 'recovery@example.com',
    templateKey: 'lease-recovery',
    provider: 'sandbox',
    payload: { recovery: true },
  });
  db.prepare(`
    UPDATE notification_outbox
    SET status='processing',attempts=1,updated_at='2026-07-24T09:50:00.000Z'
    WHERE id=?
  `).run(recoveredId);
  result = await worker.runOnce();
  assert.deepEqual(result, {
    processed: true,
    id: recoveredId,
    delivered: true,
    sandbox: true,
  });
  row = db.prepare(`
    SELECT status,attempts FROM notification_outbox WHERE id=?
  `).get(recoveredId);
  assert.equal(row.status, 'sent');
  assert.equal(Number(row.attempts), 2);
  assert.deepEqual(await worker.runOnce(), {
    processed: false,
    reason: 'EMPTY',
  });

  const notificationId = hubStore.notify({
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    type: 'project.updated',
    title: 'Project updated',
    body: 'A deterministic in-app notification.',
  });
  assert.equal(hubStore.notifications(USER_ID).unreadCount, 1);
  assert.equal(
    hubStore.markNotifications(USER_ID, { ids: [notificationId] }).unreadCount,
    0,
  );

  const integration = hubStore.upsertIntegration(
    ORGANIZATION_ID,
    {
      providerKey: 'sandbox-kyc',
      displayName: 'Sandbox KYC',
      mode: 'sandbox',
      status: 'configured',
      config: { apiKey: 'private-provider-key' },
    },
    actor,
  ).connection;
  assert.equal(integration.configured, true);
  assert.equal(Object.hasOwn(integration, 'config'), false);
  const sealedConfig = db.prepare(`
    SELECT config_sealed FROM integration_connections WHERE id=?
  `).get(integration.id).config_sealed;
  assert.equal(sealedConfig.includes('private-provider-key'), false);
  assert.throws(
    () => hubStore.upsertIntegration(
      ORGANIZATION_ID,
      {
        providerKey: 'unverified-live-provider',
        displayName: 'Unverified Live Provider',
        mode: 'live',
        status: 'healthy',
      },
      actor,
    ),
    (error) => error.code === 'PROVIDER_NOT_VERIFIED',
  );
});

test('organization outbox never discloses reset or invitation credentials', async (t) => {
  const fixture = await startTestApplication({
    applicationOptions: {
      clock: () => new Date(NOW),
      startWorkers: false,
    },
  });
  t.after(fixture.close);
  const { client, csrf } = await bootstrapOwner(fixture);
  const outsider = fixture.client();

  let result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Outbox operator',
        permissions: ['organization.manage'],
      },
    },
  );
  assert.equal(result.response.status, 201);
  const apiKeyHeaders = {
    Authorization: `Bearer ${result.data.token}`,
  };

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/invitations`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        email: 'one-time-link@example.com',
        roleKey: 'viewer',
      },
    },
  );
  assert.equal(result.response.status, 201);
  assert.match(result.data.token, /^[A-Za-z0-9_-]{20,}$/);
  const invitationToken = result.data.token;

  result = await outsider.request('/api/v2/auth/password-reset/request', {
    method: 'POST',
    body: { email: 'owner@example.com' },
  });
  assert.equal(result.response.status, 202);

  const resetRow = fixture.application.db.prepare(`
    SELECT * FROM notification_outbox
    WHERE organization_id=? AND template_key='password-reset'
    ORDER BY created_at DESC,id DESC LIMIT 1
  `).get(ORGANIZATION_ID);
  assert.ok(resetRow);
  const resetEnvelope = JSON.parse(resetRow.payload_json);
  const resetPayload = JSON.parse(unsealData(
    resetEnvelope.sealed,
    fixture.config.authEncryptionKey,
    `notification-outbox:${resetRow.id}`,
  ));
  assert.match(resetPayload.url, /reset-password#token=/);

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/notification-outbox?limit=100&revealManualPayload=true`,
  );
  assert.equal(result.response.status, 200);
  assert.equal(
    result.data.outbox.every((item) => !Object.hasOwn(item, 'payload')),
    true,
  );
  assert.equal(JSON.stringify(result.data).includes(resetPayload.url), false);
  assert.equal(JSON.stringify(result.data).includes(invitationToken), false);

  result = await outsider.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/notification-outbox?limit=100&revealManualPayload=true`,
    { headers: apiKeyHeaders },
  );
  assert.equal(result.response.status, 200);
  assert.equal(
    result.data.outbox.every((item) => !Object.hasOwn(item, 'payload')),
    true,
  );
  assert.equal(JSON.stringify(result.data).includes(resetPayload.url), false);
  assert.equal(JSON.stringify(result.data).includes(invitationToken), false);

  result = await outsider.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/notification-outbox/${resetRow.id}`,
    {
      method: 'PATCH',
      origin: false,
      headers: apiKeyHeaders,
      body: { action: 'mark_sent' },
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'sent');
  assert.equal(Object.hasOwn(result.data, 'payload'), false);
  assert.equal(JSON.stringify(result.data).includes(resetPayload.url), false);
});

test('API-key permissions follow current organization and project membership', async (t) => {
  const fixture = await startTestApplication({
    applicationOptions: {
      clock: () => new Date(NOW),
      startWorkers: false,
    },
  });
  t.after(fixture.close);
  const { client, owner, csrf } = await bootstrapOwner(fixture);
  const outsider = fixture.client();
  const projectId = fixture.application.db.prepare(`
    SELECT id FROM projects WHERE archived_at IS NULL ORDER BY id LIMIT 1
  `).get().id;

  let result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Membership-bound automation',
        permissions: [
          'organization.manage',
          'project.read',
          'project_work.write',
          'capital.manage',
        ],
      },
    },
  );
  assert.equal(result.response.status, 201);
  const apiKeyHeaders = {
    Authorization: `Bearer ${result.data.token}`,
  };

  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/share-transfers`,
    {
      method: 'POST',
      origin: false,
      headers: {
        ...apiKeyHeaders,
        'Idempotency-Key': 'api-key-is-not-an-interactive-capital-actor',
      },
      body: {
        shareClassId: 'unresolved-share-class',
        fromStakeholderId: 'unresolved-seller',
        toStakeholderId: 'unresolved-buyer',
        units: 1,
        status: 'draft',
      },
    },
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'CAPITAL_INTERACTIVE_USER_REQUIRED');

  const secondOwnerInvitation =
    fixture.application.identityStore.createInvitation({
      organizationId: ORGANIZATION_ID,
      email: 'second-owner@example.com',
      roleKey: 'owner',
      invitedByUserId: owner.id,
    });
  const secondOwner = fixture.application.identityStore.acceptInvitation(
    secondOwnerInvitation.token,
    {
      fullName: 'Second Owner',
      password: 'second-owner-password-for-api-key-test',
    },
  ).user;
  fixture.application.identityStore.upsertProjectMembership(
    ORGANIZATION_ID,
    projectId,
    owner.id,
    'project_manager',
    secondOwner.id,
  );
  const ownerMembership = fixture.application.identityStore
    .listOrganizationMembers(ORGANIZATION_ID).members
    .find((membership) => membership.userId === owner.id);
  fixture.application.identityStore.updateOrganizationMembership(
    ORGANIZATION_ID,
    ownerMembership.id,
    { roleKey: 'viewer' },
    secondOwner.id,
  );

  result = await outsider.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/notification-outbox`,
    { headers: apiKeyHeaders },
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INSUFFICIENT_API_KEY_PERMISSION');

  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/tasks`,
    {
      method: 'POST',
      origin: false,
      headers: apiKeyHeaders,
      body: {
        title: 'Allowed by current project role',
        progressMethod: 'manual',
      },
    },
  );
  assert.equal(result.response.status, 201);

  fixture.application.identityStore.upsertProjectMembership(
    ORGANIZATION_ID,
    projectId,
    owner.id,
    'viewer',
    secondOwner.id,
  );
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/tasks`,
    {
      method: 'POST',
      origin: false,
      headers: apiKeyHeaders,
      body: {
        title: 'Must be blocked after project demotion',
        progressMethod: 'manual',
      },
    },
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INSUFFICIENT_API_KEY_PERMISSION');

  fixture.application.identityStore.deleteProjectMembership(
    ORGANIZATION_ID,
    projectId,
    owner.id,
    secondOwner.id,
  );
  result = await outsider.request(
    `/api/v2/admin/projects/${projectId}/documents`,
    { headers: apiKeyHeaders },
  );
  assert.equal(result.response.status, 404);
  assert.equal(result.data.error.code, 'PROJECT_NOT_FOUND');
});

test('notification cancellation wins races with provider success and failure', async (t) => {
  const { config, db, clock, hubStore, actor } = createStoreFixture(t);
  const pending = new Map();
  function deferred(key) {
    let release;
    let started;
    const releasePromise = new Promise((resolve, reject) => {
      release = { resolve, reject };
    });
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    pending.set(key, { release, started, releasePromise, startedPromise });
    return pending.get(key);
  }
  const success = deferred('success');
  const failure = deferred('failure');
  const worker = createNotificationWorker(db, {
    clock,
    encryptionKey: config.authEncryptionKey,
    adapters: {
      'race-success': {
        async send() {
          success.started();
          return success.releasePromise;
        },
      },
      'race-failure': {
        async send() {
          failure.started();
          await failure.releasePromise;
          throw new Error('simulated provider failure');
        },
      },
    },
  });

  const successId = hubStore.enqueueNotification({
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    channel: 'email',
    destination: 'success-race@example.com',
    templateKey: 'race-success',
    provider: 'race-success',
    payload: { credential: 'must-remain-sealed' },
  });
  const successRun = worker.runOnce();
  await success.startedPromise;
  assert.equal(
    hubStore.updateNotificationOutbox(
      ORGANIZATION_ID,
      successId,
      { action: 'cancel' },
      actor,
    ).status,
    'cancelled',
  );
  success.release.resolve({ accepted: true });
  await successRun;
  assert.equal(
    db.prepare('SELECT status FROM notification_outbox WHERE id=?')
      .get(successId).status,
    'cancelled',
  );

  const failureId = hubStore.enqueueNotification({
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    channel: 'email',
    destination: 'failure-race@example.com',
    templateKey: 'race-failure',
    provider: 'race-failure',
    payload: { credential: 'must-remain-sealed' },
  });
  const failureRun = worker.runOnce();
  await failure.startedPromise;
  assert.equal(
    hubStore.updateNotificationOutbox(
      ORGANIZATION_ID,
      failureId,
      { action: 'cancel' },
      actor,
    ).status,
    'cancelled',
  );
  failure.release.resolve();
  await failureRun;
  assert.equal(
    db.prepare('SELECT status FROM notification_outbox WHERE id=?')
      .get(failureId).status,
    'cancelled',
  );
});

test('API-key proposal mutations retain the key actor in domain and enterprise audit', async (t) => {
  const fixture = await startTestApplication({
    applicationOptions: {
      clock: () => new Date(NOW),
      startWorkers: false,
    },
  });
  t.after(fixture.close);
  const { client, csrf } = await bootstrapOwner(fixture);
  const publicClient = fixture.client();
  const apiClient = fixture.client();

  let result = await publicClient.request('/api/v1/needs/land/proposals', {
    method: 'POST',
    headers: {
      'Idempotency-Key': 'api-key-proposal-actor-regression',
    },
    body: {
      applicantName: 'API Key Proposal Applicant',
      mobile: '09123456789',
      email: 'api-key-proposal@example.com',
      contribution:
        'A complete and testable contribution offered for this collaboration need.',
      availability: 'Immediately',
      notes: 'Actor attribution regression.',
      consent: true,
      website: '',
    },
  });
  assert.equal(result.response.status, 201);
  const proposalId = result.data.proposal.id;

  result = await client.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`,
    {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        name: 'Proposal workflow automation',
        permissions: ['proposals.manage'],
      },
    },
  );
  assert.equal(result.response.status, 201);
  const apiKeyId = result.data.apiKey.id;

  result = await apiClient.request(
    `/api/v2/admin/projects/greenhouse-20ha/proposals/${proposalId}`,
    {
      method: 'PATCH',
      origin: false,
      headers: {
        Authorization: `Bearer ${result.data.token}`,
      },
      body: { status: 'contacted' },
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.data.proposal.status, 'contacted');

  const proposalEvent = fixture.application.db.prepare(`
    SELECT actor_type,actor_id,event_type
    FROM proposal_events
    WHERE proposal_id=?
    ORDER BY id DESC LIMIT 1
  `).get(proposalId);
  assert.deepEqual({ ...proposalEvent }, {
    actor_type: 'api_key',
    actor_id: apiKeyId,
    event_type: 'status_changed',
  });
  const auditEvent = fixture.application.db.prepare(`
    SELECT actor_type,actor_id,action
    FROM enterprise_audit_events
    WHERE resource_type='proposal' AND resource_id=?
      AND action='proposal.updated'
    ORDER BY created_at DESC,id DESC LIMIT 1
  `).get(proposalId);
  assert.deepEqual({ ...auditEvent }, {
    actor_type: 'api_key',
    actor_id: apiKeyId,
    action: 'proposal.updated',
  });
});

test('API-key issuance uses a strict allowlist, canonical expiry and interactive-only me routes', async (t) => {
  const fixture = await startTestApplication({
    applicationOptions: {
      clock: () => new Date(NOW),
      startWorkers: false,
    },
  });
  t.after(fixture.close);
  const { client, csrf } = await bootstrapOwner(fixture);
  const apiClient = fixture.client();
  const keyEndpoint =
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/api-keys`;

  let result = await client.request(keyEndpoint, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: {
      name: 'Personal scope must be rejected',
      permissions: ['session.read'],
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'API_KEY_PERMISSION_NOT_ALLOWED');

  result = await client.request(keyEndpoint, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: {
      name: 'Invalid permission must be rejected',
      permissions: ['ownership.manage'],
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'API_KEY_PERMISSION_NOT_ALLOWED');

  result = await client.request(keyEndpoint, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: {
      name: 'Expanded bounded automation',
      permissions: ['*'],
      expiresAt: 'Sat, 25 Jul 2026 12:30:00 GMT',
    },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.apiKey.expiresAt, '2026-07-25T12:30:00.000Z');
  assert.deepEqual(result.data.apiKey.permissions, [...API_KEY_PERMISSIONS].sort());
  assert.equal(result.data.apiKey.permissions.includes('*'), false);
  assert.equal(result.data.apiKey.permissions.includes('session.read'), false);
  const apiKeyId = result.data.apiKey.id;
  const rawApiKey = result.data.token;
  const storedKey = fixture.application.db.prepare(`
    SELECT permissions_json,expires_at FROM api_keys WHERE id=?
  `).get(apiKeyId);
  assert.equal(JSON.parse(storedKey.permissions_json).includes('*'), false);
  assert.equal(storedKey.expires_at, '2026-07-25T12:30:00.000Z');

  const keyHeaders = { Authorization: `Bearer ${rawApiKey}` };
  result = await apiClient.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/overview`,
    { headers: keyHeaders },
  );
  assert.equal(result.response.status, 200);

  const personalRequests = [
    ['/api/v2/admin/me/notifications', { headers: keyHeaders }],
    ['/api/v2/admin/me/notifications', {
      method: 'PATCH',
      origin: false,
      headers: keyHeaders,
      body: { all: true },
    }],
    ['/api/v2/admin/me/notification-preferences', {
      method: 'PUT',
      origin: false,
      headers: keyHeaders,
      body: { preferences: [] },
    }],
    ['/api/v2/admin/me/saved-listings', { headers: keyHeaders }],
    ['/api/v2/admin/me/saved-listings/listing-id', {
      method: 'PUT',
      origin: false,
      headers: keyHeaders,
      body: { saved: true },
    }],
  ];
  for (const [path, options] of personalRequests) {
    result = await apiClient.request(path, options);
    assert.equal(result.response.status, 403);
    assert.equal(result.data.error.code, 'INTERACTIVE_SESSION_REQUIRED');
  }

  result = await client.request(keyEndpoint, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: {
      name: 'Past non-ISO expiry',
      permissions: ['organization.read'],
      expiresAt: 'Wed, 01 Jul 2026 00:00:00 GMT',
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'VALIDATION_ERROR');

  result = await client.request(keyEndpoint, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: {
      name: 'Invalid expiry',
      permissions: ['organization.read'],
      expiresAt: 'not-a-real-date',
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'VALIDATION_ERROR');

  fixture.application.db.prepare(`
    UPDATE api_keys SET expires_at='Wed, 01 Jul 2026 00:00:00 GMT'
    WHERE id=?
  `).run(apiKeyId);
  result = await apiClient.request(
    `/api/v2/admin/organizations/${ORGANIZATION_ID}/overview`,
    { headers: keyHeaders },
  );
  assert.equal(result.response.status, 401);
});

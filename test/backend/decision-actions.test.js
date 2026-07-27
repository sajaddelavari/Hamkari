import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/database.js';
import { createDecisionActionStore } from '../../src/decision-action-store.js';
import { routeDecisionActionApi } from '../../src/decision-action-routes.js';
import { createEnterpriseAudit } from '../../src/enterprise-audit.js';

const NOW = '2026-07-24T10:00:00.000Z';
const USER_ID = 'decision-action-user';
const OTHER_USER_ID = 'decision-action-outsider';

function insertProject(db, organizationId, id) {
  db.prepare(`
    INSERT INTO projects(
      id,slug,title,status,active,created_at,updated_at,
      organization_id,code,visibility,lifecycle,currency
    ) VALUES(?,?,?,'draft',0,?,?,?,?,?,'planning','IRR')
  `).run(
    id,
    id,
    `Project ${id}`,
    NOW,
    NOW,
    organizationId,
    id.toUpperCase(),
    'private',
  );
}

function insertUser(db, id, email, fullName) {
  db.prepare(`
    INSERT INTO users(
      id,email,password_hash,full_name,password_changed_at,
      created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)
  `).run(id, email, 'unused-test-hash', fullName, NOW, NOW, NOW);
}

function fixture(t) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://hamkari.test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'decision-action-test-secret-longer-than-thirty-two',
    AUDIT_HMAC_KEY: 'decision-action-audit-key-longer-than-thirty-two',
    ADMIN_DEV_PASSWORD: 'decision-action-admin-password',
  });
  const db = openDatabase(config, { seed: false, bootstrap: false });
  t.after(() => db.close());
  const organizationId = db.prepare(`
    SELECT id FROM organizations ORDER BY created_at,id LIMIT 1
  `).get().id;
  insertProject(db, organizationId, 'decision-project-a');
  insertProject(db, organizationId, 'decision-project-b');
  db.prepare(`
    INSERT INTO organizations(id,slug,name,created_at,updated_at)
    VALUES('decision-other-org','decision-other-org','Other organization',?,?)
  `).run(NOW, NOW);
  insertProject(db, 'decision-other-org', 'decision-project-foreign');
  insertUser(db, USER_ID, 'decision@example.com', 'Decision Owner');
  insertUser(db, OTHER_USER_ID, 'outsider@example.com', 'Outside User');
  db.prepare(`
    INSERT INTO organization_memberships(
      id,organization_id,user_id,role_key,status,joined_at,created_at,updated_at
    ) VALUES('decision-membership',?,?,'board','active',?,?,?)
  `).run(organizationId, USER_ID, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO project_meetings(
      id,project_id,title,scheduled_at,location,minutes,status,
      created_at,updated_at
    ) VALUES
      ('meeting-a','decision-project-a','Board meeting',?,'','',
       'held',?,?),
      ('meeting-b','decision-project-b','Foreign project meeting',?,'','',
       'held',?,?)
  `).run(NOW, NOW, NOW, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO meeting_resolutions(
      id,meeting_id,title,description,status,created_at,updated_at
    ) VALUES
      ('resolution-a','meeting-a','Launch approved','','closed',?,?),
      ('resolution-b','meeting-b','Other approval','','closed',?,?)
  `).run(NOW, NOW, NOW, NOW);
  const audit = createEnterpriseAudit(db, {
    clock: () => new Date(NOW),
    hmacKey: 'decision-action-audit-key-longer-than-thirty-two',
  });
  const store = createDecisionActionStore(db, {
    clock: () => new Date(NOW),
    audit: audit.append,
  });
  return {
    db,
    config,
    audit,
    store,
    organizationId,
    projectId: 'decision-project-a',
    otherProjectId: 'decision-project-b',
    foreignProjectId: 'decision-project-foreign',
  };
}

function actor(extra = {}) {
  return {
    userId: USER_ID,
    organizationId: 'default-organization',
    permissions: ['*'],
    legacy: false,
    ...extra,
  };
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('decision action lifecycle links resolution, records HMAC history and reopens', (t) => {
  const f = fixture(t);
  const created = f.store.create(f.projectId, {
    resolutionId: 'resolution-a',
    title: 'Prepare the operating plan',
    description: 'Convert the resolution into assigned delivery work.',
    assigneeUserId: USER_ID,
    dueDate: '2026-08-10',
    priority: 'high',
  }, actor()).action;
  assert.equal(created.meetingId, 'meeting-a');
  assert.equal(created.resolutionId, 'resolution-a');
  assert.equal(created.status, 'open');
  assert.equal(created.assignee.fullName, 'Decision Owner');

  let action = f.store.transition(
    f.projectId,
    created.id,
    { toStatus: 'in_progress', note: 'Work started.' },
    actor(),
  ).action;
  assert.equal(action.status, 'in_progress');
  action = f.store.transition(
    f.projectId,
    created.id,
    { toStatus: 'blocked', note: 'Awaiting regulator response.' },
    actor(),
  ).action;
  assert.equal(action.status, 'blocked');
  assert.equal(action.blockedAt, NOW);
  action = f.store.transition(
    f.projectId,
    created.id,
    { toStatus: 'completed', note: 'Approved and delivered.' },
    actor(),
  ).action;
  assert.equal(action.status, 'completed');
  assert.equal(action.completedAt, NOW);
  assert.equal(
    f.db.prepare('SELECT status FROM decision_actions WHERE id=?')
      .get(created.id).status,
    'done',
  );
  action = f.store.transition(
    f.projectId,
    created.id,
    { toStatus: 'open', note: 'Board requested a revision.' },
    actor(),
  ).action;
  assert.equal(action.status, 'open');
  assert.equal(action.completedAt, null);
  action = f.store.transition(
    f.projectId,
    created.id,
    { toStatus: 'cancelled', note: 'Board paused the initiative.' },
    actor(),
  ).action;
  assert.equal(action.status, 'cancelled');
  assert.equal(action.cancelledAt, NOW);
  action = f.store.transition(
    f.projectId,
    created.id,
    { toStatus: 'open', note: 'Board restored the initiative.' },
    actor(),
  ).action;
  assert.equal(action.status, 'open');
  assert.equal(action.cancelledAt, null);

  const history = f.store.history(f.projectId, created.id);
  assert.equal(history.total, 7);
  assert.equal(history.history[0].eventType, 'reopened');
  assert.ok(history.history.every((entry) => entry.audit?.hmacLinked));
  assert.deepEqual(f.audit.verify().valid, true);
  const enterpriseEvents = f.audit.list({ projectId: f.projectId }).events;
  assert.equal(enterpriseEvents.length, 7);
  assert.equal(enterpriseEvents[0].resourceType, 'decision_action');
  assert.equal(enterpriseEvents[0].actorType, 'user');
});

test('patching and filters validate assignment, dates and immutable status', (t) => {
  const f = fixture(t);
  const first = f.store.create(f.projectId, {
    title: 'Critical overdue item',
    assigneeUserId: USER_ID,
    dueDate: '2026-07-20',
    priority: 'critical',
  }, actor()).action;
  const second = f.store.create(f.projectId, {
    title: 'Later item',
    dueDate: '2026-08-20',
    priority: 'low',
  }, actor()).action;
  const patched = f.store.patch(f.projectId, second.id, {
    title: 'Later clarified item',
    description: 'Precise scope',
    assigneeUserId: USER_ID,
    dueDate: null,
    priority: 'medium',
  }, actor());
  assert.equal(patched.changed, true);
  assert.equal(patched.action.dueDate, null);
  assert.equal(patched.action.priority, 'medium');

  let result = f.store.list(f.projectId, {
    priority: 'critical',
    overdue: true,
  });
  assert.equal(result.total, 1);
  assert.equal(result.actions[0].id, first.id);
  assert.equal(result.summary.open, 2);
  result = f.store.list(f.projectId, {
    assigneeUserId: 'unassigned',
    q: 'clarified',
  });
  assert.equal(result.total, 0);

  expectCode(
    () => f.store.patch(f.projectId, first.id, { status: 'completed' }, actor()),
    'VALIDATION_FAILED',
  );
  expectCode(
    () => f.store.patch(
      f.projectId,
      first.id,
      { assigneeUserId: OTHER_USER_ID },
      actor(),
    ),
    'INVALID_ASSIGNEE',
  );
  expectCode(
    () => f.store.patch(f.projectId, first.id, { dueDate: '2026-02-31' }, actor()),
    'VALIDATION_FAILED',
  );
});

test('invalid transitions and cross-project governance references are rejected', (t) => {
  const f = fixture(t);
  expectCode(
    () => f.store.create(f.projectId, {
      title: 'Cross-project meeting',
      meetingId: 'meeting-b',
    }, actor()),
    'INVALID_MEETING',
  );
  expectCode(
    () => f.store.create(f.projectId, {
      title: 'Cross-project resolution',
      resolutionId: 'resolution-b',
    }, actor()),
    'INVALID_RESOLUTION',
  );
  const action = f.store.create(f.projectId, {
    title: 'Governance task',
    meetingId: 'meeting-a',
  }, actor()).action;
  expectCode(
    () => f.store.transition(
      f.projectId,
      action.id,
      { toStatus: 'completed' },
      actor(),
    ),
    'INVALID_DECISION_ACTION_TRANSITION',
  );
  expectCode(
    () => f.store.get(f.otherProjectId, action.id),
    'DECISION_ACTION_NOT_FOUND',
  );
  expectCode(
    () => f.store.get(f.foreignProjectId, action.id),
    'DECISION_ACTION_NOT_FOUND',
  );
});

test('audit failure atomically rolls back a decision action transition', (t) => {
  const f = fixture(t);
  const action = f.store.create(f.projectId, {
    title: 'Audit-protected action',
  }, actor()).action;
  const failingStore = createDecisionActionStore(f.db, {
    clock: () => new Date(NOW),
    audit() {
      throw new Error('audit unavailable');
    },
  });
  assert.throws(
    () => failingStore.transition(
      f.projectId,
      action.id,
      { toStatus: 'in_progress' },
      actor(),
    ),
    /audit unavailable/,
  );
  assert.equal(failingStore.get(f.projectId, action.id).action.status, 'open');
  assert.equal(failingStore.history(f.projectId, action.id).total, 1);
});

function responseRecorder() {
  return {
    statusCode: 0,
    headers: new Map(),
    writableEnded: false,
    body: '',
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    end(body = '') {
      this.body = body;
      this.writableEnded = true;
    },
  };
}

test('decision action routes use governance permissions, origin and shared actor', async (t) => {
  const f = fixture(t);
  const authorizationCalls = [];
  const authorize = async (_context, scope) => {
    authorizationCalls.push(scope);
    return actor({ organizationId: f.organizationId });
  };
  let response = responseRecorder();
  let context = {
    request: {
      method: 'POST',
      headers: { origin: 'https://hamkari.test' },
    },
    response,
    url: new URL(
      `/api/v2/admin/projects/${f.projectId}/decision-actions`,
      f.config.publicOrigin,
    ),
    config: f.config,
    decisionActionStore: f.store,
    readJson: async () => ({
      title: 'Route-created action',
      priority: 'high',
    }),
  };
  assert.equal(await routeDecisionActionApi(context, authorize), true);
  assert.equal(response.statusCode, 201);
  const action = JSON.parse(response.body).action;
  assert.deepEqual(authorizationCalls[0], {
    projectId: f.projectId,
    permission: 'governance.manage',
    mutation: true,
  });

  response = responseRecorder();
  context = {
    ...context,
    request: { method: 'GET', headers: {} },
    response,
    url: new URL(
      `/api/v2/admin/projects/${f.projectId}/decision-actions` +
      `/${action.id}/history`,
      f.config.publicOrigin,
    ),
  };
  assert.equal(await routeDecisionActionApi(context, authorize), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(authorizationCalls[1], {
    projectId: f.projectId,
    permission: 'governance.read',
    mutation: false,
  });

  const invalidOriginContext = {
    ...context,
    request: {
      method: 'PATCH',
      headers: { origin: 'https://evil.example' },
    },
    response: responseRecorder(),
    url: new URL(
      `/api/v2/admin/projects/${f.projectId}/decision-actions/${action.id}`,
      f.config.publicOrigin,
    ),
    readJson: async () => ({ title: 'Should not change' }),
  };
  await assert.rejects(
    routeDecisionActionApi(invalidOriginContext, authorize),
    (error) => error.code === 'INVALID_ORIGIN',
  );
});

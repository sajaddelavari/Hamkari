import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDatabase, SCHEMA_VERSION } from '../../src/database.js';
import { createPlatformStore } from '../../src/platform-store.js';
import { createReadinessStore } from '../../src/readiness-store.js';
import { startTestApplication, TEST_PASSWORD } from './helpers.js';

const NOW = '2026-07-27T10:00:00.000Z';
const USER_ID = 'readiness-owner';
const PROJECT_ID = 'readiness-project';

function fixture(t) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'readiness-test-secret-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'readiness-test-password',
  });
  const db = openDatabase(config, { seed: false, bootstrap: false });
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const organizationId = db.prepare(`
    SELECT id FROM organizations ORDER BY created_at,id LIMIT 1
  `).get().id;
  db.prepare(`
    INSERT INTO users(
      id,email,password_hash,full_name,password_changed_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)
  `).run(
    USER_ID,'readiness@example.test','unused','Readiness Owner',NOW,NOW,NOW,
  );
  db.prepare(`
    INSERT INTO projects(
      id,slug,title,status,active,created_at,updated_at,organization_id,code,
      visibility,lifecycle,stage,currency,kind,industry
    ) VALUES(?,?,?,'draft',0,?,?,?,?,?,'planning','execution','IRR',?,?)
  `).run(
    PROJECT_ID,PROJECT_ID,'Operational Readiness Project',NOW,NOW,
    organizationId,'READY-01','private','factory','manufacturing',
  );
  for (const index of [1, 2]) {
    db.prepare(`
      INSERT INTO needs(
        id,project_id,title,description,created_at,updated_at
      ) VALUES(?,?,?,?,?,?)
    `).run(`need-${index}`,PROJECT_ID,`Need ${index}`,'Required participation',NOW,NOW);
  }
  const audits = [];
  const store = createReadinessStore(db, {
    clock: () => new Date(NOW),
    audit: (event) => audits.push(event),
  });
  return { db, store, audits, organizationId, actor: { userId: USER_ID } };
}

function acceptNeed(db, index) {
  db.prepare(`
    INSERT INTO proposals(
      id,need_id,visitor_id,applicant_name,mobile,contribution,consent,status,
      tracking_token_hash,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,1,'accepted',?,?,?)
  `).run(
    `proposal-${index}`,`need-${index}`,`visitor-${index}`,`Partner ${index}`,
    '989121234567','Committed delivery capacity',`track-${index}`,NOW,NOW,
  );
}

test('readiness engine snapshots templates and gates operating on participation and rules', (t) => {
  const { db, store, organizationId, actor, audits } = fixture(t);
  const created = store.createTemplate(organizationId, {
    name: 'Factory commissioning',
    projectKind: 'factory',
    industry: 'manufacturing',
  }, actor).template;
  const step = store.createTemplateStep(organizationId, created.id, {
    title: 'Commissioning inspection',
    actionType: 'form',
    required: true,
    formSchema: [{
      key: 'inspectionApproved',
      label: 'Inspection approved',
      type: 'checkbox',
      required: true,
    }],
    gateRules: [{
      type: 'manual_checkbox',
      fieldKey: 'inspectionApproved',
      label: 'Inspection confirmation',
    }],
  }, actor).step;

  const initialized = store.initialize(PROJECT_ID, {}, actor);
  assert.equal(initialized.run.templateId, created.id);
  assert.equal(initialized.steps.length, 1);
  assert.notEqual(initialized.steps[0].id, step.id);
  assert.equal(initialized.eligibleToOperate, false);
  assert.equal(initialized.participation.percent, 0);

  store.submitStep(PROJECT_ID, initialized.steps[0].id, {
    values: { inspectionApproved: true },
    note: 'Inspection evidence reviewed.',
  }, actor);
  assert.equal(store.details(PROJECT_ID).steps[0].status, 'completed');
  assert.throws(
    () => store.activate(PROJECT_ID, actor),
    (error) => error.code === 'PROJECT_NOT_READY_TO_OPERATE',
  );

  acceptNeed(db, 1);
  assert.equal(store.details(PROJECT_ID).participation.percent, 50);
  acceptNeed(db, 2);
  const ready = store.details(PROJECT_ID);
  assert.equal(ready.participation.percent, 100);
  assert.equal(ready.eligibleToOperate, true);

  const operating = store.activate(PROJECT_ID, actor);
  assert.equal(operating.run.status, 'operating');
  assert.equal(operating.project.lifecycle, 'operating');
  assert.equal(
    db.prepare('SELECT stage FROM projects WHERE id=?').get(PROJECT_ID).stage,
    'operating',
  );
  const platform = createPlatformStore(db, { clock: () => new Date(NOW), audit: () => {} });
  assert.throws(
    () => platform.archiveProject(PROJECT_ID),
    (error) => error.code === 'READINESS_TRANSITION_REQUIRED',
  );

  db.prepare(`UPDATE proposals SET status='rejected' WHERE id='proposal-2'`).run();
  assert.equal(store.projectSummary(PROJECT_ID).status, 'attention_required');
  const suspended = store.suspend(PROJECT_ID, { note: 'Participation commitment was withdrawn.' }, actor);
  assert.equal(suspended.run.status, 'suspended');
  assert.equal(suspended.project.lifecycle, 'paused');
  const reopened = store.reopenStep(PROJECT_ID, initialized.steps[0].id, {
    note: 'Inspection must be repeated before resuming operations.',
  }, actor);
  assert.equal(reopened.steps[0].status, 'in_progress');
  assert.ok(suspended.events.some((event) => event.eventType === 'activated'));
  assert.ok(audits.some((event) => event.action === 'project_readiness.activated'));
});

test('template changes do not alter an initialized run and direct operating updates are rejected', (t) => {
  const { db, store, organizationId, actor } = fixture(t);
  const template = store.createTemplate(organizationId, { name: 'Generic readiness' }, actor).template;
  store.createTemplateStep(organizationId, template.id, {
    title: 'Initial checklist',
    actionType: 'manual',
    required: true,
  }, actor);
  const initialized = store.initialize(PROJECT_ID, { templateId: template.id }, actor);
  store.createTemplateStep(organizationId, template.id, {
    title: 'Future template step',
    actionType: 'manual',
    required: true,
  }, actor);
  assert.equal(store.details(PROJECT_ID).steps.length, 1);
  assert.equal(initialized.run.templateVersion + 1, store.getTemplate(organizationId, template.id).template.version);

  const platform = createPlatformStore(db, { clock: () => new Date(NOW), audit: () => {} });
  assert.throws(
    () => platform.updateProject(PROJECT_ID, { lifecycle: 'operating' }),
    (error) => error.code === 'READINESS_REQUIRED',
  );
});

test('document, task, resolution and form rules use live project sources before approval', (t) => {
  const { db, store, organizationId, actor } = fixture(t);
  acceptNeed(db, 1);
  acceptNeed(db, 2);
  db.prepare(`
    INSERT INTO project_tasks(id,project_id,title,created_at,updated_at)
    VALUES('commissioning-task',?,'Commissioning task',?,?)
  `).run(PROJECT_ID, NOW, NOW);
  db.prepare(`
    INSERT INTO documents(
      id,organization_id,project_id,title,category,status,created_at,updated_at
    ) VALUES('operating-license',?,?,?,'legal','draft',?,?)
  `).run(organizationId, PROJECT_ID, 'Operating license', NOW, NOW);
  db.prepare(`
    INSERT INTO project_meetings(
      id,project_id,title,scheduled_at,status,created_at,updated_at
    ) VALUES('launch-meeting',?,'Launch meeting',?,'held',?,?)
  `).run(PROJECT_ID, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO meeting_resolutions(
      id,meeting_id,title,status,created_at,updated_at,result_json
    ) VALUES('launch-resolution','launch-meeting','Approve launch','open',?,?,?)
  `).run(NOW, NOW, '{}');

  const template = store.createTemplate(organizationId, {
    name: 'Evidence-driven commissioning',
  }, actor).template;
  const taskTemplateStep = store.createTemplateStep(organizationId, template.id, {
    title: 'Finish commissioning work',
    actionType: 'task',
    position: 1,
    gateRules: [{ type: 'task_status', taskId: 'commissioning-task' }],
  }, actor).step;
  const documentTemplateStep = store.createTemplateStep(organizationId, template.id, {
    title: 'Attach operating license',
    actionType: 'document',
    position: 2,
    gateRules: [{ type: 'document_exists', category: 'legal' }],
  }, actor).step;
  const resolutionTemplateStep = store.createTemplateStep(organizationId, template.id, {
    title: 'Approve operating launch',
    actionType: 'resolution',
    position: 3,
    gateRules: [{
      type: 'resolution_approved',
      resolutionId: 'launch-resolution',
    }],
  }, actor).step;
  const approvalTemplateStep = store.createTemplateStep(organizationId, template.id, {
    title: 'Verify readiness score',
    actionType: 'form',
    position: 4,
    approvalRequired: true,
    formSchema: [{
      key: 'readinessScore',
      label: 'Readiness score',
      type: 'number',
      required: true,
      min: 0,
      max: 100,
    }],
    gateRules: [{
      type: 'form_field',
      fieldKey: 'readinessScore',
      operator: 'gte',
      value: 80,
    }],
  }, actor).step;
  const initialized = store.initialize(PROJECT_ID, { templateId: template.id }, actor);
  const runStep = (templateStep) => initialized.steps.find(
    (step) => step.templateStepId === templateStep.id,
  );

  assert.throws(
    () => store.submitStep(PROJECT_ID, runStep(taskTemplateStep).id, { values: {} }, actor),
    (error) => error.code === 'READINESS_RULES_FAILED',
  );
  db.prepare(`
    UPDATE project_tasks SET status='done',progress_percent=100,completed_at=?
    WHERE id='commissioning-task'
  `).run(NOW);
  store.submitStep(PROJECT_ID, runStep(taskTemplateStep).id, { values: {} }, actor);

  db.prepare(`
    INSERT INTO document_versions(
      id,document_id,version_no,filename,mime_type,size_bytes,sha256,content,created_at
    ) VALUES('license-v1','operating-license',1,'license.pdf','application/pdf',4,?, ?, ?)
  `).run('a'.repeat(64), Buffer.from('%PDF'), NOW);
  db.prepare(`
    UPDATE documents SET status='active',current_version_no=1 WHERE id='operating-license'
  `).run();
  store.submitStep(PROJECT_ID, runStep(documentTemplateStep).id, {
    values: {},
    evidenceDocumentId: 'operating-license',
  }, actor);

  assert.throws(
    () => store.submitStep(PROJECT_ID, runStep(resolutionTemplateStep).id, { values: {} }, actor),
    (error) => error.code === 'READINESS_RULES_FAILED',
  );
  db.prepare(`
    UPDATE meeting_resolutions
    SET status='closed',result_json=?,decided_at=?
    WHERE id='launch-resolution'
  `).run(JSON.stringify({ outcome: 'approved', quorum: { quorumMet: true } }), NOW);
  store.submitStep(PROJECT_ID, runStep(resolutionTemplateStep).id, { values: {} }, actor);

  const submitted = store.submitStep(PROJECT_ID, runStep(approvalTemplateStep).id, {
    values: { readinessScore: 91 },
  }, actor);
  assert.equal(
    submitted.steps.find((step) => step.templateStepId === approvalTemplateStep.id).status,
    'submitted',
  );
  assert.equal(submitted.eligibleToOperate, false);
  const approved = store.approveStep(
    PROJECT_ID,
    runStep(approvalTemplateStep).id,
    { note: 'Readiness score independently approved.' },
    actor,
  );
  assert.equal(approved.eligibleToOperate, true);
  assert.equal(approved.run.effectiveStatus, 'ready');
});

test('readiness v2 routes enforce session CSRF and expose project-scoped state', async (t) => {
  const application = await startTestApplication({
    applicationOptions: { startWorkers: false },
  });
  t.after(application.close);
  const client = application.client();
  let result = await client.request('/api/v1/admin/session', {
    method: 'POST',
    body: { password: TEST_PASSWORD },
  });
  assert.equal(result.response.status, 200);
  result = await client.request('/api/v2/auth/bootstrap', {
    method: 'POST',
    headers: { 'X-CSRF-Token': result.data.csrfToken },
    body: {
      email: 'readiness-route-owner@example.test',
      fullName: 'Readiness Route Owner',
      organizationName: 'Readiness Route Organization',
      password: 'readiness-route-owner-password',
    },
  });
  assert.equal(result.response.status, 201);
  const organizationId = result.data.organization.id;
  result = await client.request('/api/v2/auth/session', {
    method: 'POST',
    body: {
      email: 'readiness-route-owner@example.test',
      password: 'readiness-route-owner-password',
    },
  });
  assert.equal(result.response.status, 200);
  const headers = { 'X-CSRF-Token': result.data.csrfToken };
  const readinessEvents = [];
  const publish = application.application.broker.publish.bind(
    application.application.broker,
  );
  application.application.broker.publish = (slug, event, data) => {
    if (String(data?.reason || '').startsWith('readiness-')) {
      readinessEvents.push({ slug, event, data });
    }
    return publish(slug, event, data);
  };

  result = await client.request('/api/v2/admin/projects', {
    method: 'POST',
    headers,
    body: {
      organizationId,
      slug: 'readiness-route-project',
      title: 'Readiness Route Project',
      status: 'draft',
      visibility: 'private',
      lifecycle: 'executing',
      stage: 'execution',
      kind: 'service',
      industry: 'operations',
      currency: 'IRR',
    },
  });
  assert.equal(result.response.status, 201);
  const projectId = result.data.project.id;

  const templatePath = `/api/v2/admin/organizations/${organizationId}/readiness-templates`;
  result = await client.request(templatePath, {
    method: 'POST',
    body: { name: 'Route template' },
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INVALID_CSRF_TOKEN');

  result = await client.request(templatePath, {
    method: 'POST',
    headers,
    body: { name: 'Route template', projectKind: 'service' },
  });
  assert.equal(result.response.status, 201);
  const templateId = result.data.template.id;
  result = await client.request(`${templatePath}/${templateId}/steps`, {
    method: 'POST',
    headers,
    body: {
      title: 'Final manual check',
      actionType: 'manual',
      required: true,
    },
  });
  assert.equal(result.response.status, 201);

  result = await client.request(`/api/v2/admin/projects/${projectId}/readiness/initialize`, {
    method: 'POST',
    headers,
    body: { templateId, participationRequired: true },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.run.templateName, 'Route template');
  assert.equal(result.data.eligibleToOperate, false);
  assert.equal(readinessEvents.length, 1);
  assert.equal(readinessEvents[0].slug, 'readiness-route-project');
  assert.equal(readinessEvents[0].data.reason, 'readiness-initialized');
  assert.equal(readinessEvents[0].data.readiness.status, 'in_progress');

  result = await client.request(`/api/v2/admin/projects/${projectId}/readiness`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.steps.length, 1);
  assert.equal(result.data.participation.totalNeeds, 0);

  result = await client.request(`/api/v2/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { lifecycle: 'operating' },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'READINESS_REQUIRED');
});

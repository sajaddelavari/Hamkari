import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/database.js';
import { createOperationsStore } from '../../src/operations-store.js';
import { routeOperationsApi } from '../../src/operations-routes.js';

const NOW = '2026-07-24T08:00:00.000Z';
const USER_ID = 'operations-test-user';

function operationsFixture(t, { audit } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'operations-test-secret-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'operations-test-password',
  });
  const db = openDatabase(config, { seed: false, bootstrap: false });
  t.after(() => db.close());
  const organizationId = db.prepare(`
    SELECT id FROM organizations ORDER BY created_at, id LIMIT 1
  `).get().id;
  createIsolatedProject(db, organizationId, 'operations-project-a');
  createIsolatedProject(db, organizationId, 'operations-project-b');
  db.prepare(`
    INSERT INTO users(
      id, email, password_hash, full_name, password_changed_at,
      created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?)
  `).run(
    USER_ID,
    'operations@example.com',
    'not-used-in-store-tests',
    'Operations Test User',
    NOW,
    NOW,
    NOW,
  );
  const projects = db.prepare(`
    SELECT id, organization_id
    FROM projects
    WHERE archived_at IS NULL
    ORDER BY created_at, id
  `).all();
  assert.ok(projects.length >= 2);
  const audits = [];
  const store = createOperationsStore(db, {
    clock: () => new Date(NOW),
    audit: audit || ((event) => audits.push(event)),
  });
  return {
    db,
    config,
    store,
    audits,
    projectId: projects[0].id,
    otherProjectId: projects[1].id,
    organizationId: projects[0].organization_id,
  };
}

function actor(extra = {}) {
  return { actorUserId: USER_ID, ...extra };
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function createIsolatedProject(db, organizationId, id) {
  db.prepare(`
    INSERT INTO projects(
      id, slug, title, status, active, created_at, updated_at,
      organization_id, code, visibility, lifecycle, currency
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
  return id;
}

test('task trees and dependencies stay acyclic and gate successor work', (t) => {
  const fixture = operationsFixture(t);
  const { store, projectId, otherProjectId } = fixture;
  const phase = store.createPhase(projectId, {
    title: 'Delivery',
    progressMethod: 'tasks',
  }, actor()).phase;
  const predecessor = store.createTask(projectId, {
    phaseId: phase.id,
    title: 'Foundation',
    weight: 1,
  }, actor()).task;
  const successor = store.createTask(projectId, {
    phaseId: phase.id,
    title: 'Launch',
    weight: 1,
  }, actor()).task;

  store.addDependency(projectId, successor.id, {
    dependsOnTaskId: predecessor.id,
    dependencyType: 'finish_to_start',
  }, actor());
  expectCode(
    () => store.patchTask(
      projectId,
      successor.id,
      { status: 'in_progress', progressPercent: 20 },
      actor(),
    ),
    'UNMET_TASK_DEPENDENCY',
  );
  assert.equal(store.getTask(projectId, successor.id).task.status, 'todo');

  store.patchTask(projectId, predecessor.id, { status: 'done' }, actor());
  store.patchTask(projectId, successor.id, {
    status: 'in_progress',
    progressPercent: 40,
  }, actor());
  assert.equal(store.getPhase(projectId, phase.id).phase.progressPercent, 70);
  expectCode(
    () => store.addDependency(projectId, predecessor.id, {
      dependsOnTaskId: successor.id,
    }, actor()),
    'TASK_DEPENDENCY_CYCLE',
  );

  const parent = store.createTask(projectId, {
    phaseId: phase.id,
    title: 'Parent task',
  }, actor()).task;
  const child = store.createTask(projectId, {
    phaseId: phase.id,
    parentTaskId: parent.id,
    title: 'Child task',
  }, actor()).task;
  expectCode(
    () => store.patchTask(
      projectId,
      parent.id,
      { parentTaskId: child.id },
      actor(),
    ),
    'TASK_PARENT_CYCLE',
  );

  const foreignTask = store.createTask(otherProjectId, {
    title: 'Foreign task',
  }, actor()).task;
  expectCode(
    () => store.addDependency(projectId, successor.id, {
      dependsOnTaskId: foreignTask.id,
    }, actor()),
    'TASK_NOT_FOUND',
  );
});

test('time entries atomically maintain actual task minutes', (t) => {
  const { store, projectId } = operationsFixture(t);
  const task = store.createTask(projectId, {
    title: 'Timed delivery',
  }, actor()).task;
  const created = store.createTimeEntry(projectId, {
    taskId: task.id,
    minutes: 60,
    workedOn: '2026-07-20',
    note: 'First pass',
  }, actor());
  assert.equal(created.task.actualMinutes, 60);

  const patched = store.patchTimeEntry(projectId, created.timeEntry.id, {
    minutes: 95,
  }, actor());
  assert.equal(patched.task.actualMinutes, 95);

  const deleted = store.deleteTimeEntry(
    projectId,
    created.timeEntry.id,
    actor(),
  );
  assert.equal(deleted.task.actualMinutes, 0);
  assert.equal(store.timeEntries(projectId).timeEntries.length, 0);
});

test('resource allocation rejects overlapping capacity and cross-project targets', (t) => {
  const { store, projectId, otherProjectId } = operationsFixture(t);
  const firstTask = store.createTask(projectId, {
    title: 'First allocation task',
  }, actor()).task;
  const secondTask = store.createTask(projectId, {
    title: 'Second allocation task',
  }, actor()).task;
  const foreignTask = store.createTask(otherProjectId, {
    title: 'Other project allocation',
  }, actor()).task;
  const resource = store.createResource(projectId, {
    name: 'Delivery team',
    kind: 'person',
    unit: 'FTE',
    capacity: 10,
  }, actor()).resource;

  store.createAllocation(projectId, {
    resourceId: resource.id,
    taskId: firstTask.id,
    quantity: 6,
    startsOn: '2026-07-01',
    endsOn: '2026-07-10',
  }, actor());
  expectCode(
    () => store.createAllocation(projectId, {
      resourceId: resource.id,
      taskId: secondTask.id,
      quantity: 5,
      startsOn: '2026-07-05',
      endsOn: '2026-07-12',
    }, actor()),
    'RESOURCE_OVERALLOCATED',
  );
  assert.equal(store.allocations(projectId).allocations.length, 1);

  store.createAllocation(projectId, {
    resourceId: resource.id,
    taskId: secondTask.id,
    quantity: 5,
    startsOn: '2026-07-11',
    endsOn: '2026-07-20',
  }, actor());
  expectCode(
    () => store.patchResource(
      projectId,
      resource.id,
      { capacity: 5 },
      actor(),
    ),
    'RESOURCE_OVERALLOCATED',
  );
  assert.equal(store.getResource(projectId, resource.id).resource.capacity, 10);
  expectCode(
    () => store.createAllocation(projectId, {
      resourceId: resource.id,
      taskId: foreignTask.id,
      quantity: 1,
    }, actor()),
    'TASK_NOT_FOUND',
  );
});

test('risk scoring and append-only KPI measurements produce current indicators', (t) => {
  const { store, projectId } = operationsFixture(t);
  const risk = store.createRisk(projectId, {
    title: 'Critical dependency',
    probability: 5,
    impact: 4,
  }, actor()).risk;
  assert.equal(risk.score, 20);
  assert.equal(risk.band, 'critical');
  const issue = store.createRisk(projectId, {
    title: 'Production incident',
    probability: 4,
    impact: 5,
  }, actor({ forcedKind: 'issue' })).risk;
  assert.equal(issue.kind, 'issue');

  const kpi = store.createKpi(projectId, {
    name: 'Adoption',
    unit: 'percent',
    direction: 'increase',
    baselineValue: 0,
    targetValue: 100,
    warningValue: 50,
  }, actor()).kpi;
  store.addKpiMeasurement(projectId, kpi.id, {
    value: 60,
    measuredAt: '2026-07-20T10:00:00.000Z',
  }, actor());
  store.addKpiMeasurement(projectId, kpi.id, {
    value: 40,
    measuredAt: '2026-07-10T10:00:00.000Z',
  }, actor());
  const measured = store.getKpi(projectId, kpi.id).kpi;
  assert.equal(measured.currentValue, 60);
  assert.equal(measured.achievementPercent, 60);
  assert.equal(measured.measurements.length, 2);
  expectCode(
    () => store.addKpiMeasurement(projectId, kpi.id, {
      value: 70,
      measuredAt: '2026-07-20T10:00:00.000Z',
    }, actor()),
    'KPI_MEASUREMENT_EXISTS',
  );
  assert.equal(store.getKpi(projectId, kpi.id).kpi.measurements.length, 2);
  assert.equal('patchKpiMeasurement' in store, false);
  assert.equal('deleteKpiMeasurement' in store, false);
});

test('budget versions approve, revise, and reconcile ledger or legacy actuals', (t) => {
  const fixture = operationsFixture(t);
  const {
    db,
    store,
    organizationId,
  } = fixture;
  const projectId = createIsolatedProject(
    db,
    organizationId,
    'operations-budget-project',
  );
  const budget = store.createBudget(projectId, {
    name: 'FY 2026',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    currency: 'IRR',
  }, actor()).budget;
  const codedLine = store.createBudgetLine(projectId, budget.id, {
    accountCode: '6000',
    title: 'Operating expense',
    plannedAmount: 1000,
  }, actor()).budgetLine;
  const summaryLine = store.createBudgetLine(projectId, budget.id, {
    accountCode: '',
    title: 'All expenses',
    plannedAmount: 500,
  }, actor()).budgetLine;

  db.prepare(`
    INSERT INTO financial_entries(
      id, project_id, type, amount, occurred_on, description,
      stakeholder_id, created_at, reversal_of_entry_id
    ) VALUES(?,?,'expense',100,'2026-03-01','legacy',NULL,?,NULL)
  `).run('legacy-expense', projectId, NOW);
  db.prepare(`
    INSERT INTO financial_entries(
      id, project_id, type, amount, occurred_on, description,
      stakeholder_id, created_at, reversal_of_entry_id
    ) VALUES(?,?,'expense',100,'2026-03-02','reversal',NULL,?,?)
  `).run('legacy-reversal', projectId, NOW, 'legacy-expense');
  db.prepare(`
    INSERT INTO financial_entries(
      id, project_id, type, amount, occurred_on, description,
      stakeholder_id, created_at, reversal_of_entry_id
    ) VALUES(?,?,'expense',50,'2026-03-03','effective',NULL,?,NULL)
  `).run('legacy-effective', projectId, NOW);

  let result = store.getBudget(projectId, budget.id).budget;
  assert.equal(result.actualSource, 'legacy_financial_entries');
  assert.equal(result.actualAmount, 50);
  assert.equal(
    result.budgetLines.find((line) => line.id === codedLine.id).actualAmount,
    null,
  );
  assert.equal(
    result.budgetLines.find((line) => line.id === summaryLine.id).actualAmount,
    50,
  );

  db.prepare(`
    INSERT INTO accounting_accounts(
      id, organization_id, project_id, code, name, account_type,
      currency, created_at, updated_at
    ) VALUES(?,?,?,?,?,'expense','IRR',?,?)
  `).run(
    'operations-expense-account',
    organizationId,
    projectId,
    '6000',
    'Expense',
    NOW,
    NOW,
  );
  db.prepare(`
    INSERT INTO accounting_accounts(
      id, organization_id, project_id, code, name, account_type,
      currency, created_at, updated_at
    ) VALUES(?,?,?,?,?,'asset','IRR',?,?)
  `).run(
    'operations-cash-account',
    organizationId,
    projectId,
    '1000',
    'Cash',
    NOW,
    NOW,
  );
  db.prepare(`
    INSERT INTO journal_entries(
      id, organization_id, project_id, entry_no, occurred_on, description,
      currency, status, created_by_user_id, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,'IRR','draft',?,?,?)
  `).run(
    'operations-journal-entry',
    organizationId,
    projectId,
    900001,
    '2026-04-01',
    'Posted expense',
    USER_ID,
    NOW,
    NOW,
  );
  const insertLine = db.prepare(`
    INSERT INTO journal_lines(
      id, journal_entry_id, account_id, debit, credit, created_at
    ) VALUES(?,?,?,?,?,?)
  `);
  insertLine.run(
    'operations-journal-expense',
    'operations-journal-entry',
    'operations-expense-account',
    70,
    0,
    NOW,
  );
  insertLine.run(
    'operations-journal-cash',
    'operations-journal-entry',
    'operations-cash-account',
    0,
    70,
    NOW,
  );
  db.prepare(`
    UPDATE journal_entries
    SET status='posted', posted_by_user_id=?, posted_at=?, updated_at=?
    WHERE id=?
  `).run(USER_ID, NOW, NOW, 'operations-journal-entry');

  result = store.getBudget(projectId, budget.id).budget;
  assert.equal(result.actualSource, 'journal');
  assert.equal(result.actualAmount, 70);
  assert.equal(result.plannedAmount, 1500);
  assert.equal(result.varianceAmount, 1430);
  assert.equal(
    result.budgetLines.find((line) => line.id === codedLine.id).actualAmount,
    70,
  );
  assert.equal(
    result.budgetLines.find((line) => line.id === summaryLine.id).actualAmount,
    70,
  );

  const approved = store.approveBudget(projectId, budget.id, actor()).budget;
  assert.equal(approved.status, 'approved');
  expectCode(
    () => store.patchBudgetLine(
      projectId,
      budget.id,
      codedLine.id,
      { plannedAmount: 2000 },
      actor(),
    ),
    'BUDGET_NOT_DRAFT',
  );
  const revision = store.reviseBudget(
    projectId,
    budget.id,
    { name: 'FY 2026 revised' },
    actor(),
  ).budget;
  assert.equal(revision.versionNo, 2);
  assert.equal(revision.status, 'draft');
  assert.equal(revision.budgetLines.length, 2);
  store.approveBudget(projectId, revision.id, actor());
  assert.equal(store.getBudget(projectId, budget.id).budget.status, 'superseded');
  assert.equal(store.getBudget(projectId, revision.id).budget.status, 'approved');
});

test('audit failures roll back domain mutations', (t) => {
  const fixture = operationsFixture(t);
  const rollbackStore = createOperationsStore(fixture.db, {
    clock: () => new Date(NOW),
    audit() {
      throw new Error('audit unavailable');
    },
  });
  assert.throws(
    () => rollbackStore.createPhase(fixture.projectId, {
      title: 'Must roll back',
    }, actor()),
    /audit unavailable/,
  );
  const count = Number(fixture.db.prepare(`
    SELECT COUNT(*) AS value
    FROM project_phases
    WHERE project_id=? AND title='Must roll back'
  `).get(fixture.projectId).value);
  assert.equal(count, 0);
});

test('remaining operations CRUD paths and dashboard stay internally consistent', (t) => {
  const { store, projectId } = operationsFixture(t);
  let phase = store.createPhase(projectId, {
    title: 'Manual phase',
    progressMethod: 'manual',
  }, actor()).phase;
  phase = store.patchPhase(projectId, phase.id, {
    title: 'Active manual phase',
    status: 'active',
    manualProgress: 20,
  }, actor()).phase;
  assert.equal(phase.status, 'active');
  assert.equal(phase.progressPercent, 20);

  const prerequisite = store.createTask(projectId, {
    phaseId: phase.id,
    title: 'Removable dependency',
  }, actor()).task;
  const task = store.createTask(projectId, {
    phaseId: phase.id,
    title: 'Progress target',
  }, actor()).task;
  store.addDependency(projectId, task.id, {
    dependsOnTaskId: prerequisite.id,
    dependencyType: 'start_to_start',
  }, actor());
  store.removeDependency(projectId, task.id, prerequisite.id, actor());
  assert.equal(store.getTask(projectId, task.id).task.dependencies.length, 0);

  const progress = store.createProgressUpdate(projectId, {
    phaseId: phase.id,
    taskId: task.id,
    progressPercent: 35,
    summary: 'Work is moving',
  }, actor());
  assert.equal(progress.task.status, 'in_progress');
  assert.equal(progress.task.progressPercent, 35);
  store.createProgressUpdate(projectId, {
    phaseId: phase.id,
    progressPercent: 45,
    summary: 'Phase checkpoint',
  }, actor());
  assert.equal(store.getPhase(projectId, phase.id).phase.progressPercent, 45);
  assert.equal(
    store.progressUpdates(projectId, { taskId: task.id }).progressUpdates.length,
    1,
  );

  const resource = store.createResource(projectId, {
    name: 'Patchable equipment',
    kind: 'equipment',
    capacity: 4,
  }, actor()).resource;
  let allocation = store.createAllocation(projectId, {
    resourceId: resource.id,
    taskId: task.id,
    quantity: 2,
  }, actor()).allocation;
  allocation = store.patchAllocation(projectId, allocation.id, {
    quantity: 3,
    startsOn: '2026-07-01',
    endsOn: '2026-07-02',
  }, actor()).allocation;
  assert.equal(allocation.quantity, 3);
  store.deleteAllocation(projectId, allocation.id, actor());
  assert.equal(store.allocations(projectId).allocations.length, 0);
  assert.equal(
    store.patchResource(projectId, resource.id, {
      name: 'Updated equipment',
      capacity: 3,
    }, actor()).resource.name,
    'Updated equipment',
  );
  assert.equal(
    store.archiveResource(projectId, resource.id, actor()).resource.status,
    'retired',
  );

  let risk = store.createRisk(projectId, {
    title: 'Closable risk',
    probability: 2,
    impact: 3,
  }, actor()).risk;
  risk = store.patchRisk(projectId, risk.id, {
    status: 'resolved',
    probability: 1,
  }, actor()).risk;
  assert.equal(risk.status, 'resolved');
  assert.ok(risk.resolvedAt);
  store.deleteRisk(projectId, risk.id, actor());
  assert.equal(store.risks(projectId).risks.length, 0);

  let kpi = store.createKpi(projectId, {
    name: 'Patchable KPI',
    targetValue: 10,
  }, actor()).kpi;
  kpi = store.patchKpi(projectId, kpi.id, {
    name: 'Updated KPI',
    targetValue: 20,
  }, actor()).kpi;
  assert.equal(kpi.targetValue, 20);
  assert.ok(store.archiveKpi(projectId, kpi.id, actor()).kpi.archivedAt);

  let budget = store.createBudget(projectId, {
    name: 'Cancelable draft',
  }, actor()).budget;
  budget = store.patchBudget(projectId, budget.id, {
    name: 'Updated cancelable draft',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  }, actor()).budget;
  const parentLine = store.createBudgetLine(projectId, budget.id, {
    title: 'Parent line',
    plannedAmount: 0,
  }, actor()).budgetLine;
  let childLine = store.createBudgetLine(projectId, budget.id, {
    parentId: parentLine.id,
    title: 'Child line',
    plannedAmount: 100,
  }, actor()).budgetLine;
  childLine = store.patchBudgetLine(
    projectId,
    budget.id,
    childLine.id,
    { plannedAmount: 120 },
    actor(),
  ).budgetLine;
  assert.equal(childLine.plannedAmount, 120);
  store.deleteBudgetLine(projectId, budget.id, childLine.id, actor());
  store.deleteBudgetLine(projectId, budget.id, parentLine.id, actor());
  assert.equal(
    store.cancelBudget(projectId, budget.id, actor()).budget.status,
    'cancelled',
  );

  const dashboard = store.dashboard(projectId);
  assert.equal(typeof dashboard.executionProgressPercent, 'number');
  assert.equal(dashboard.tasks.total, 2);
  assert.equal(dashboard.recentProgressUpdates.length, 2);

  store.archiveTask(projectId, prerequisite.id, actor());
  store.archiveTask(projectId, task.id, actor());
  assert.ok(store.archivePhase(projectId, phase.id, actor()).phase.archivedAt);
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
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  };
}

test('operations routes authorize reads and finance-controlled budget writes', async (t) => {
  const fixture = operationsFixture(t);
  const calls = [];
  const authorize = async (_context, scope) => {
    calls.push(scope);
    return {
      userId: USER_ID,
      organizationId: fixture.organizationId,
      permissions: ['*'],
      legacy: false,
    };
  };
  let response = responseRecorder();
  let context = {
    request: { method: 'GET', headers: {} },
    response,
    url: new URL(
      `/api/v2/admin/projects/${fixture.projectId}/phases`,
      'https://hamkari.test',
    ),
    config: {
      isProduction: false,
      publicOrigin: 'https://hamkari.test',
    },
    operationsStore: fixture.store,
  };
  assert.equal(await routeOperationsApi(context, authorize), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0], {
    projectId: fixture.projectId,
    permission: 'operations.read',
    mutation: false,
  });

  response = responseRecorder();
  context = {
    ...context,
    request: {
      method: 'POST',
      headers: { origin: 'https://hamkari.test' },
    },
    response,
    url: new URL(
      `/api/v2/admin/projects/${fixture.projectId}/budgets`,
      'https://hamkari.test',
    ),
    readJson: async () => ({ name: 'Authorized budget' }),
  };
  assert.equal(await routeOperationsApi(context, authorize), true);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls[1], {
    projectId: fixture.projectId,
    permission: 'finance.manage',
    mutation: true,
  });
});

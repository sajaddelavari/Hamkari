import { randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from './errors.js';
import { withTransaction } from './database.js';

const PHASE_STATUSES = new Set([
  'planned',
  'active',
  'completed',
  'blocked',
  'cancelled',
]);
const PHASE_PROGRESS_METHODS = new Set(['manual', 'tasks', 'milestones']);
const TASK_STATUSES = new Set([
  'backlog',
  'todo',
  'in_progress',
  'blocked',
  'review',
  'done',
  'cancelled',
]);
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const DEPENDENCY_TYPES = new Set([
  'finish_to_start',
  'start_to_start',
  'finish_to_finish',
  'start_to_finish',
]);
const RESOURCE_KINDS = new Set([
  'person',
  'equipment',
  'facility',
  'material',
  'service',
  'capital',
]);
const RESOURCE_STATUSES = new Set([
  'available',
  'allocated',
  'unavailable',
  'retired',
]);
const RISK_KINDS = new Set(['risk', 'issue', 'assumption', 'dependency']);
const RISK_STATUSES = new Set([
  'open',
  'mitigating',
  'accepted',
  'resolved',
  'closed',
]);
const KPI_DIRECTIONS = new Set(['increase', 'decrease', 'maintain']);
const KPI_FREQUENCIES = new Set([
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'annual',
  'on_demand',
]);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = -MAX_SAFE_BIGINT;
const MAX_WEIGHT = 1_000_000;

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('The operations clock returned an invalid date.');
  }
  return date.toISOString();
}

function validation(message, fields = {}) {
  throw badRequest('VALIDATION_FAILED', message, fields);
}

function text(value, field, {
  required = false,
  minimum = 1,
  maximum = 10_000,
  fallback = '',
} = {}) {
  const selected = value === undefined ? fallback : value;
  const result = String(selected ?? '').trim();
  if ((required && result.length < minimum) || result.length > maximum) {
    validation('اطلاعات واردشده معتبر نیست.', {
      [field]: required
        ? `این فیلد باید حداقل ${minimum} نویسه باشد.`
        : `این فیلد نباید بیشتر از ${maximum} نویسه باشد.`,
    });
  }
  return result;
}

function nullableId(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return text(value, field, { required: true, maximum: 200 });
}

function enumValue(value, allowed, field, fallback) {
  const selected = value === undefined ? fallback : value;
  if (!allowed.has(selected)) {
    validation('مقدار انتخاب‌شده معتبر نیست.', {
      [field]: 'یکی از مقادیر مجاز را انتخاب کنید.',
    });
  }
  return selected;
}

function numberValue(value, field, {
  minimum = -Number.MAX_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
  allowNull = false,
  fallback,
} = {}) {
  const selected = value === undefined ? fallback : value;
  if (allowNull && (selected === null || selected === '')) return null;
  const result = Number(selected);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    validation('عدد واردشده معتبر نیست.', {
      [field]: `عدد باید بین ${minimum} و ${maximum} باشد.`,
    });
  }
  return result;
}

function integerValue(value, field, options = {}) {
  const result = numberValue(value, field, options);
  if (result === null) return null;
  if (!Number.isSafeInteger(result)) {
    validation('عدد صحیح واردشده معتبر نیست.', {
      [field]: 'یک عدد صحیح در محدودهٔ امن وارد کنید.',
    });
  }
  return result;
}

function progressValue(value, field = 'progressPercent', fallback = 0) {
  return numberValue(value, field, {
    minimum: 0,
    maximum: 100,
    fallback,
  });
}

function weightValue(value, field = 'weight', fallback = 1) {
  return numberValue(value, field, {
    minimum: Number.EPSILON,
    maximum: MAX_WEIGHT,
    fallback,
  });
}

function dateValue(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      validation('تاریخ الزامی است.', {
        [field]: 'تاریخ را با قالب YYYY-MM-DD وارد کنید.',
      });
    }
    return null;
  }
  if (typeof value !== 'string') {
    validation('تاریخ معتبر نیست.', {
      [field]: 'تاریخ را با قالب YYYY-MM-DD وارد کنید.',
    });
  }
  const selected = value.trim();
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(selected);
  if (!match) {
    validation('تاریخ معتبر نیست.', {
      [field]: 'تاریخ را با قالب YYYY-MM-DD وارد کنید.',
    });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (day < 1 || day > daysInMonth) {
    validation('روز تقویمی معتبر نیست.', {
      [field]: 'یک روز تقویمی معتبر وارد کنید.',
    });
  }
  return selected;
}

function dateTimeValue(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      validation('زمان الزامی است.', {
        [field]: 'یک زمان ISO 8601 همراه با منطقهٔ زمانی وارد کنید.',
      });
    }
    return null;
  }
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) {
    validation('زمان معتبر نیست.', {
      [field]: 'یک زمان ISO 8601 همراه با منطقهٔ زمانی وارد کنید.',
    });
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    validation('زمان معتبر نیست.', {
      [field]: 'یک زمان ISO 8601 معتبر وارد کنید.',
    });
  }
  return parsed.toISOString();
}

function assertDateOrder(start, end, startField, endField) {
  if (start && end && start > end) {
    validation('بازهٔ زمانی معتبر نیست.', {
      [endField]: `${endField} نباید پیش از ${startField} باشد.`,
    });
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function safeBigInt(value) {
  return value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT
    ? Number(value)
    : null;
}

function sumSafeIntegers(values) {
  const exact = values.reduce((total, value) => total + BigInt(value), 0n);
  return {
    value: safeBigInt(exact),
    exact: exact.toString(),
    overflow: safeBigInt(exact) === null,
  };
}

function rowSnapshot(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' ? value.toString() : value,
  ]));
}

function riskBand(score) {
  if (score >= 20) return 'critical';
  if (score >= 12) return 'high';
  if (score >= 6) return 'medium';
  return 'low';
}

function mapRisk(row) {
  const score = Number(row.probability) * Number(row.impact);
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    category: row.category,
    probability: Number(row.probability),
    impact: Number(row.impact),
    score,
    band: riskBand(score),
    status: row.status,
    responseStrategy: row.response_strategy,
    ownerUserId: row.owner_user_id,
    dueDate: row.due_date,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapResource(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    unit: row.unit,
    capacity: row.capacity === null ? null : Number(row.capacity),
    unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
    currency: row.currency,
    ownerStakeholderId: row.owner_stakeholder_id,
    status: row.status,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAllocation(row) {
  return {
    id: row.id,
    resourceId: row.resource_id,
    taskId: row.task_id,
    phaseId: row.phase_id,
    quantity: Number(row.quantity),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function kpiAchievement(row) {
  if (row.current_value === null || row.current_value === undefined) {
    return { achievementPercent: null, health: 'no_data' };
  }
  const current = Number(row.current_value);
  const target = Number(row.target_value);
  const baseline = row.baseline_value === null
    ? null
    : Number(row.baseline_value);
  const warning = row.warning_value === null
    ? null
    : Number(row.warning_value);
  let achievement;
  let health;

  if (row.direction === 'increase') {
    health = current >= target
      ? 'on_track'
      : warning !== null && current >= warning ? 'warning' : 'off_track';
    const start = baseline ?? 0;
    achievement = target === start
      ? current >= target ? 100 : 0
      : ((current - start) / (target - start)) * 100;
  } else if (row.direction === 'decrease') {
    health = current <= target
      ? 'on_track'
      : warning !== null && current <= warning ? 'warning' : 'off_track';
    if (baseline === null || baseline === target) {
      achievement = current <= target ? 100 : 0;
    } else {
      achievement = ((baseline - current) / (baseline - target)) * 100;
    }
  } else {
    const tolerance = warning === null
      ? Math.max(Math.abs(target) * 0.1, 1)
      : Math.max(Math.abs(warning - target), Number.EPSILON);
    const deviation = Math.abs(current - target);
    achievement = 100 - (deviation / tolerance) * 100;
    health = deviation <= tolerance
      ? 'on_track'
      : deviation <= tolerance * 2 ? 'warning' : 'off_track';
  }

  return {
    achievementPercent: clampPercent(achievement),
    health,
  };
}

function mapKpi(row, measurements = []) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    unit: row.unit,
    direction: row.direction,
    baselineValue: row.baseline_value === null ? null : Number(row.baseline_value),
    targetValue: Number(row.target_value),
    warningValue: row.warning_value === null ? null : Number(row.warning_value),
    currentValue: row.current_value === null ? null : Number(row.current_value),
    frequency: row.frequency,
    ownerUserId: row.owner_user_id,
    startsOn: row.starts_on,
    targetDate: row.target_date,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...kpiAchievement(row),
    measurements,
  };
}

function peakAllocation(rows) {
  if (!rows.length) return 0;
  const points = new Set(['']);
  for (const row of rows) points.add(row.startsOn || '');
  let maximum = 0;
  for (const point of points) {
    let total = 0;
    for (const row of rows) {
      const activeAtPoint = point === ''
        ? !row.startsOn
        : (!row.startsOn || row.startsOn <= point) &&
          (!row.endsOn || row.endsOn >= point);
      if (activeAtPoint) total += Number(row.quantity);
    }
    maximum = Math.max(maximum, total);
  }
  return maximum;
}

export function createOperationsStore(
  db,
  {
    clock = () => new Date(),
    audit = null,
  } = {},
) {
  function requireProject(projectId, { mutable = false } = {}) {
    const row = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!row) {
      throw notFound('PROJECT_NOT_FOUND', 'پروژهٔ موردنظر پیدا نشد.');
    }
    if (mutable && row.archived_at) {
      throw conflict(
        'PROJECT_ARCHIVED',
        'عملیات پروژهٔ بایگانی‌شده قابل تغییر نیست.',
      );
    }
    return row;
  }

  function requireUser(userId) {
    if (!userId) return null;
    const row = db.prepare('SELECT id FROM users WHERE id=?').get(userId);
    if (!row) {
      throw badRequest('INVALID_USER', 'کاربر انتخاب‌شده معتبر نیست.');
    }
    return row;
  }

  function recordAudit({
    projectId,
    resourceType,
    resourceId,
    action,
    before = null,
    after = null,
    metadata = {},
  }) {
    if (typeof audit !== 'function') return;
    const project = db.prepare(`
      SELECT organization_id FROM projects WHERE id=?
    `).get(projectId);
    audit({
      organizationId: project?.organization_id || null,
      projectId,
      resourceType,
      resourceId,
      action,
      before: rowSnapshot(before),
      after: rowSnapshot(after),
      metadata,
      createdAt: nowIso(clock),
    });
  }

  function phaseRow(projectId, id) {
    const row = db.prepare(
      'SELECT * FROM project_phases WHERE id=? AND project_id=?',
    ).get(id, projectId);
    if (!row) {
      throw notFound('PHASE_NOT_FOUND', 'مرحلهٔ پروژه پیدا نشد.');
    }
    return row;
  }

  function taskRow(projectId, id) {
    const row = db.prepare(
      'SELECT * FROM project_tasks WHERE id=? AND project_id=?',
    ).get(id, projectId);
    if (!row) {
      throw notFound('TASK_NOT_FOUND', 'وظیفهٔ پروژه پیدا نشد.');
    }
    return row;
  }

  function resourceRow(projectId, id) {
    const row = db.prepare(
      'SELECT * FROM project_resources WHERE id=? AND project_id=?',
    ).get(id, projectId);
    if (!row) {
      throw notFound('RESOURCE_NOT_FOUND', 'منبع پروژه پیدا نشد.');
    }
    return row;
  }

  function riskRow(projectId, id, kind) {
    const row = db.prepare(`
      SELECT *
      FROM project_risks
      WHERE id=? AND project_id=?
        ${kind ? 'AND kind=?' : ''}
    `).get(...(kind ? [id, projectId, kind] : [id, projectId]));
    if (!row) {
      throw notFound(
        kind === 'issue' ? 'ISSUE_NOT_FOUND' : 'RISK_NOT_FOUND',
        kind === 'issue' ? 'مسئله پیدا نشد.' : 'ریسک پیدا نشد.',
      );
    }
    return row;
  }

  function kpiRow(projectId, id) {
    const row = db.prepare(
      'SELECT * FROM project_kpis WHERE id=? AND project_id=?',
    ).get(id, projectId);
    if (!row) {
      throw notFound('KPI_NOT_FOUND', 'شاخص عملکرد پیدا نشد.');
    }
    return row;
  }

  function budgetRow(projectId, id) {
    const row = db.prepare(
      'SELECT * FROM budget_versions WHERE id=? AND project_id=?',
    ).get(id, projectId);
    if (!row) {
      throw notFound('BUDGET_NOT_FOUND', 'نسخهٔ بودجه پیدا نشد.');
    }
    return row;
  }

  function budgetLineRow(projectId, budgetId, lineId) {
    const row = db.prepare(`
      SELECT l.*
      FROM budget_lines l
      JOIN budget_versions b ON b.id=l.budget_version_id
      WHERE l.id=? AND l.budget_version_id=? AND b.project_id=?
    `).get(lineId, budgetId, projectId);
    if (!row) {
      throw notFound('BUDGET_LINE_NOT_FOUND', 'ردیف بودجه پیدا نشد.');
    }
    return row;
  }

  function documentReference(projectId, documentId) {
    if (!documentId) return null;
    const row = db.prepare(`
      SELECT id
      FROM documents
      WHERE id=? AND (project_id=? OR project_id IS NULL)
    `).get(documentId, projectId);
    if (!row) {
      throw badRequest(
        'INVALID_EVIDENCE_DOCUMENT',
        'سند مدرک به این پروژه تعلق ندارد.',
      );
    }
    return row;
  }

  function computedTaskState(projectId) {
    const rows = db.prepare(`
      SELECT *
      FROM project_tasks
      WHERE project_id=?
      ORDER BY order_no, created_at, id
    `).all(projectId);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const children = new Map();
    for (const row of rows) {
      if (!row.parent_task_id || !rowById.has(row.parent_task_id)) continue;
      const list = children.get(row.parent_task_id) || [];
      list.push(row);
      children.set(row.parent_task_id, list);
    }
    const memo = new Map();
    const visiting = new Set();
    const calculate = (row) => {
      if (memo.has(row.id)) return memo.get(row.id);
      if (visiting.has(row.id)) {
        throw conflict('TASK_PARENT_CYCLE', 'ساختار والد وظایف دارای چرخه است.');
      }
      visiting.add(row.id);
      const activeChildren = (children.get(row.id) || []).filter(
        (child) => !child.archived_at && child.status !== 'cancelled',
      );
      let result;
      if (row.status === 'done') {
        result = 100;
      } else if (activeChildren.length) {
        const totalWeight = activeChildren.reduce(
          (sum, child) => sum + Number(child.weight),
          0,
        );
        result = totalWeight
          ? activeChildren.reduce(
            (sum, child) => sum + calculate(child) * Number(child.weight),
            0,
          ) / totalWeight
          : 0;
      } else {
        result = clampPercent(row.progress_percent);
      }
      visiting.delete(row.id);
      memo.set(row.id, result);
      return result;
    };
    for (const row of rows) calculate(row);
    return { rows, rowById, children, progressById: memo };
  }

  function mapTask(row, state, dependencies = []) {
    return {
      id: row.id,
      projectId: row.project_id,
      phaseId: row.phase_id,
      parentTaskId: row.parent_task_id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      progressPercent: Number(row.progress_percent),
      calculatedProgressPercent: state.progressById.get(row.id) ?? 0,
      weight: Number(row.weight),
      assigneeUserId: row.assignee_user_id,
      plannedStart: row.planned_start,
      dueDate: row.due_date,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      estimatedMinutes: row.estimated_minutes === null
        ? null
        : Number(row.estimated_minutes),
      actualMinutes: Number(row.actual_minutes),
      orderNo: Number(row.order_no),
      archivedAt: row.archived_at,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      dependencies,
    };
  }

  function dependencyRows(projectId) {
    return db.prepare(`
      SELECT d.*
      FROM task_dependencies d
      JOIN project_tasks t ON t.id=d.task_id
      JOIN project_tasks p ON p.id=d.depends_on_task_id
      WHERE t.project_id=? AND p.project_id=?
      ORDER BY d.created_at, d.task_id, d.depends_on_task_id
    `).all(projectId, projectId);
  }

  function tasks(projectId, { includeArchived = false } = {}) {
    requireProject(projectId);
    const state = computedTaskState(projectId);
    const dependencies = dependencyRows(projectId).map((row) => ({
      taskId: row.task_id,
      dependsOnTaskId: row.depends_on_task_id,
      dependencyType: row.dependency_type,
      lagDays: Number(row.lag_days),
      createdAt: row.created_at,
    }));
    const dependenciesByTask = new Map();
    for (const dependency of dependencies) {
      const list = dependenciesByTask.get(dependency.taskId) || [];
      list.push(dependency);
      dependenciesByTask.set(dependency.taskId, list);
    }
    return {
      tasks: state.rows
        .filter((row) => includeArchived || !row.archived_at)
        .map((row) => mapTask(
          row,
          state,
          dependenciesByTask.get(row.id) || [],
        )),
      dependencies,
    };
  }

  function getTask(projectId, taskId) {
    taskRow(projectId, taskId);
    return {
      task: tasks(projectId, { includeArchived: true }).tasks
        .find((item) => item.id === taskId),
    };
  }

  function phaseProgress(row, taskState, latestPhaseUpdates) {
    if (row.status === 'completed') return 100;
    if (row.progress_method === 'manual') {
      return clampPercent(row.manual_progress);
    }
    if (row.progress_method === 'milestones') {
      return clampPercent(
        latestPhaseUpdates.get(row.id) ?? row.manual_progress,
      );
    }
    const candidates = taskState.rows.filter((task) => (
      task.phase_id === row.id &&
      !task.archived_at &&
      task.status !== 'cancelled' &&
      (
        !task.parent_task_id ||
        taskState.rowById.get(task.parent_task_id)?.phase_id !== row.id
      )
    ));
    const totalWeight = candidates.reduce(
      (sum, task) => sum + Number(task.weight),
      0,
    );
    return totalWeight
      ? candidates.reduce(
        (sum, task) =>
          sum + (taskState.progressById.get(task.id) || 0) * Number(task.weight),
        0,
      ) / totalWeight
      : 0;
  }

  function phases(projectId, { includeArchived = false } = {}) {
    requireProject(projectId);
    const rows = db.prepare(`
      SELECT *
      FROM project_phases
      WHERE project_id=?
      ORDER BY order_no, created_at, id
    `).all(projectId);
    const taskState = computedTaskState(projectId);
    const updateRows = db.prepare(`
      SELECT phase_id, progress_percent, reported_at, created_at, id
      FROM progress_updates
      WHERE project_id=? AND phase_id IS NOT NULL AND task_id IS NULL
      ORDER BY reported_at DESC, created_at DESC, id DESC
    `).all(projectId);
    const latestUpdates = new Map();
    for (const update of updateRows) {
      if (!latestUpdates.has(update.phase_id)) {
        latestUpdates.set(update.phase_id, Number(update.progress_percent));
      }
    }
    return {
      phases: rows
        .filter((row) => includeArchived || !row.archived_at)
        .map((row) => ({
          id: row.id,
          projectId: row.project_id,
          title: row.title,
          description: row.description,
          status: row.status,
          progressMethod: row.progress_method,
          manualProgress: Number(row.manual_progress),
          progressPercent: phaseProgress(row, taskState, latestUpdates),
          plannedStart: row.planned_start,
          plannedEnd: row.planned_end,
          actualStart: row.actual_start,
          actualEnd: row.actual_end,
          orderNo: Number(row.order_no),
          archivedAt: row.archived_at,
          createdByUserId: row.created_by_user_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
    };
  }

  function getPhase(projectId, phaseId) {
    phaseRow(projectId, phaseId);
    return {
      phase: phases(projectId, { includeArchived: true }).phases
        .find((item) => item.id === phaseId),
    };
  }

  function createPhase(projectId, input, { actorUserId = null } = {}) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const id = randomUUID();
    const now = nowIso(clock);
    const status = enumValue(
      input.status,
      PHASE_STATUSES,
      'status',
      'planned',
    );
    const progressMethod = enumValue(
      input.progressMethod,
      PHASE_PROGRESS_METHODS,
      'progressMethod',
      'tasks',
    );
    const manualProgress = progressValue(input.manualProgress);
    const plannedStart = dateValue(input.plannedStart, 'plannedStart');
    const plannedEnd = dateValue(input.plannedEnd, 'plannedEnd');
    assertDateOrder(plannedStart, plannedEnd, 'plannedStart', 'plannedEnd');
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO project_phases(
          id, project_id, title, description, status, progress_method,
          manual_progress, planned_start, planned_end, actual_start,
          actual_end, order_no, archived_at, created_by_user_id,
          created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)
      `).run(
        id,
        projectId,
        text(input.title, 'title', {
          required: true,
          minimum: 2,
          maximum: 200,
        }),
        text(input.description, 'description', { maximum: 5_000 }),
        status,
        progressMethod,
        manualProgress,
        plannedStart,
        plannedEnd,
        status === 'active' || status === 'completed' ? now : null,
        status === 'completed' ? now : null,
        integerValue(input.orderNo, 'orderNo', {
          minimum: 0,
          fallback: 0,
        }),
        actorUserId,
        now,
        now,
      );
      const after = phaseRow(projectId, id);
      recordAudit({
        projectId,
        resourceType: 'project_phase',
        resourceId: id,
        action: 'created',
        after,
      });
    });
    return getPhase(projectId, id);
  }

  function patchPhase(
    projectId,
    phaseId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    let result;
    withTransaction(db, () => {
      const current = phaseRow(projectId, phaseId);
      if (current.archived_at) {
        throw conflict('PHASE_ARCHIVED', 'مرحلهٔ بایگانی‌شده قابل تغییر نیست.');
      }
      const status = enumValue(
        input.status,
        PHASE_STATUSES,
        'status',
        current.status,
      );
      const progressMethod = enumValue(
        input.progressMethod,
        PHASE_PROGRESS_METHODS,
        'progressMethod',
        current.progress_method,
      );
      const plannedStart = input.plannedStart === undefined
        ? current.planned_start
        : dateValue(input.plannedStart, 'plannedStart');
      const plannedEnd = input.plannedEnd === undefined
        ? current.planned_end
        : dateValue(input.plannedEnd, 'plannedEnd');
      assertDateOrder(plannedStart, plannedEnd, 'plannedStart', 'plannedEnd');
      const now = nowIso(clock);
      const actualStart = input.actualStart === undefined
        ? current.actual_start ||
          (['active', 'completed'].includes(status) ? now : null)
        : dateTimeValue(input.actualStart, 'actualStart');
      const actualEnd = input.actualEnd === undefined
        ? status === 'completed'
          ? current.actual_end || now
          : status === 'planned' ? null : current.actual_end
        : dateTimeValue(input.actualEnd, 'actualEnd');
      db.prepare(`
        UPDATE project_phases
        SET title=?, description=?, status=?, progress_method=?,
            manual_progress=?, planned_start=?, planned_end=?,
            actual_start=?, actual_end=?, order_no=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        input.title === undefined
          ? current.title
          : text(input.title, 'title', {
            required: true,
            minimum: 2,
            maximum: 200,
          }),
        input.description === undefined
          ? current.description
          : text(input.description, 'description', { maximum: 5_000 }),
        status,
        progressMethod,
        input.manualProgress === undefined
          ? Number(current.manual_progress)
          : progressValue(input.manualProgress),
        plannedStart,
        plannedEnd,
        actualStart,
        actualEnd,
        input.orderNo === undefined
          ? Number(current.order_no)
          : integerValue(input.orderNo, 'orderNo', { minimum: 0 }),
        now,
        phaseId,
        projectId,
      );
      const after = phaseRow(projectId, phaseId);
      recordAudit({
        projectId,
        resourceType: 'project_phase',
        resourceId: phaseId,
        action: 'updated',
        before: current,
        after,
      });
      result = after;
    });
    return {
      phase: phases(projectId, { includeArchived: true }).phases
        .find((item) => item.id === result.id),
    };
  }

  function archivePhase(
    projectId,
    phaseId,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = phaseRow(projectId, phaseId);
      if (current.archived_at) return;
      const activeTask = db.prepare(`
        SELECT id
        FROM project_tasks
        WHERE project_id=? AND phase_id=? AND archived_at IS NULL
          AND status<>'cancelled'
        LIMIT 1
      `).get(projectId, phaseId);
      if (activeTask) {
        throw conflict(
          'PHASE_HAS_ACTIVE_TASKS',
          'پیش از بایگانی مرحله، وظایف فعال آن را منتقل یا لغو کنید.',
        );
      }
      const now = nowIso(clock);
      db.prepare(`
        UPDATE project_phases
        SET status='cancelled', archived_at=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(now, now, phaseId, projectId);
      recordAudit({
        projectId,
        resourceType: 'project_phase',
        resourceId: phaseId,
        action: 'archived',
        before: current,
        after: phaseRow(projectId, phaseId),
      });
    });
    return getPhase(projectId, phaseId);
  }

  function ensureTaskParent(projectId, taskId, parentTaskId, phaseId) {
    if (!parentTaskId) return null;
    const parent = taskRow(projectId, parentTaskId);
    if (parent.archived_at || parent.status === 'cancelled') {
      throw conflict('PARENT_TASK_INACTIVE', 'وظیفهٔ والد فعال نیست.');
    }
    if (taskId && parentTaskId === taskId) {
      throw conflict('TASK_PARENT_CYCLE', 'وظیفه نمی‌تواند والد خودش باشد.');
    }
    if (taskId) {
      let cursor = parent;
      const visited = new Set();
      while (cursor?.parent_task_id) {
        if (cursor.parent_task_id === taskId) {
          throw conflict('TASK_PARENT_CYCLE', 'ساختار والد وظایف چرخه می‌سازد.');
        }
        if (visited.has(cursor.id)) {
          throw conflict('TASK_PARENT_CYCLE', 'ساختار والد وظایف دارای چرخه است.');
        }
        visited.add(cursor.id);
        cursor = db.prepare(
          'SELECT * FROM project_tasks WHERE id=? AND project_id=?',
        ).get(cursor.parent_task_id, projectId);
      }
    }
    if (
      (phaseId || parent.phase_id) &&
      phaseId !== parent.phase_id
    ) {
      throw conflict(
        'TASK_PARENT_PHASE_MISMATCH',
        'وظیفه و والد آن باید در یک مرحله باشند.',
      );
    }
    return parent;
  }

  function predecessorStarted(row) {
    return Boolean(
      row.started_at ||
      ['in_progress', 'blocked', 'review', 'done'].includes(row.status) ||
      Number(row.progress_percent) > 0,
    );
  }

  function assertTaskDependenciesAllow(
    projectId,
    taskId,
    { starting = false, finishing = false } = {},
  ) {
    if (!starting && !finishing) return;
    const rows = db.prepare(`
      SELECT d.dependency_type, p.*
      FROM task_dependencies d
      JOIN project_tasks t ON t.id=d.task_id
      JOIN project_tasks p ON p.id=d.depends_on_task_id
      WHERE d.task_id=? AND t.project_id=? AND p.project_id=?
    `).all(taskId, projectId, projectId);
    const unmet = rows.find((row) => {
      if (row.archived_at || row.status === 'cancelled') return false;
      if (row.dependency_type === 'finish_to_start') {
        return starting && row.status !== 'done';
      }
      if (row.dependency_type === 'start_to_start') {
        return starting && !predecessorStarted(row);
      }
      if (row.dependency_type === 'finish_to_finish') {
        return finishing && row.status !== 'done';
      }
      return finishing && !predecessorStarted(row);
    });
    if (unmet) {
      throw conflict(
        'UNMET_TASK_DEPENDENCY',
        'پیش‌نیاز این وظیفه هنوز به وضعیت لازم نرسیده است.',
        { dependsOnTaskId: unmet.id },
      );
    }
  }

  function createTask(projectId, input, { actorUserId = null } = {}) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const id = randomUUID();
    let response;
    withTransaction(db, () => {
      const phaseId = nullableId(input.phaseId, 'phaseId') ?? null;
      if (phaseId) {
        const phase = phaseRow(projectId, phaseId);
        if (phase.archived_at || phase.status === 'cancelled') {
          throw conflict('PHASE_INACTIVE', 'مرحلهٔ انتخاب‌شده فعال نیست.');
        }
      }
      const requestedParent = nullableId(input.parentTaskId, 'parentTaskId') ?? null;
      const parentCandidate = requestedParent
        ? taskRow(projectId, requestedParent)
        : null;
      const selectedPhaseId = phaseId || parentCandidate?.phase_id || null;
      ensureTaskParent(
        projectId,
        null,
        requestedParent,
        selectedPhaseId,
      );
      requireUser(nullableId(input.assigneeUserId, 'assigneeUserId') ?? null);
      const status = enumValue(
        input.status,
        TASK_STATUSES,
        'status',
        'todo',
      );
      const progress = status === 'done'
        ? 100
        : progressValue(input.progressPercent);
      if (['backlog', 'todo'].includes(status) && progress > 0) {
        validation('وظیفهٔ شروع‌نشده نمی‌تواند پیشرفت داشته باشد.', {
          progressPercent: 'ابتدا وضعیت وظیفه را به در حال انجام تغییر دهید.',
        });
      }
      const plannedStart = dateValue(input.plannedStart, 'plannedStart');
      const dueDate = dateValue(input.dueDate, 'dueDate');
      assertDateOrder(plannedStart, dueDate, 'plannedStart', 'dueDate');
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO project_tasks(
          id, project_id, phase_id, parent_task_id, title, description,
          status, priority, progress_percent, weight, assignee_user_id,
          planned_start, due_date, started_at, completed_at,
          estimated_minutes, actual_minutes, order_no, archived_at,
          created_by_user_id, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,NULL,?,?,?)
      `).run(
        id,
        projectId,
        selectedPhaseId,
        requestedParent,
        text(input.title, 'title', {
          required: true,
          minimum: 2,
          maximum: 240,
        }),
        text(input.description, 'description', { maximum: 10_000 }),
        status,
        enumValue(
          input.priority,
          TASK_PRIORITIES,
          'priority',
          'medium',
        ),
        progress,
        weightValue(input.weight),
        nullableId(input.assigneeUserId, 'assigneeUserId') ?? null,
        plannedStart,
        dueDate,
        ['in_progress', 'blocked', 'review', 'done'].includes(status)
          ? now
          : null,
        status === 'done' ? now : null,
        integerValue(input.estimatedMinutes, 'estimatedMinutes', {
          minimum: 0,
          allowNull: true,
          fallback: null,
        }),
        integerValue(input.orderNo, 'orderNo', {
          minimum: 0,
          fallback: 0,
        }),
        actorUserId,
        now,
        now,
      );
      const after = taskRow(projectId, id);
      recordAudit({
        projectId,
        resourceType: 'project_task',
        resourceId: id,
        action: 'created',
        after,
      });
      response = after;
    });
    return getTask(projectId, response.id);
  }

  function patchTask(
    projectId,
    taskId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = taskRow(projectId, taskId);
      if (current.archived_at) {
        throw conflict('TASK_ARCHIVED', 'وظیفهٔ بایگانی‌شده قابل تغییر نیست.');
      }
      const phaseId = input.phaseId === undefined
        ? current.phase_id
        : nullableId(input.phaseId, 'phaseId');
      if (phaseId) {
        const phase = phaseRow(projectId, phaseId);
        if (phase.archived_at || phase.status === 'cancelled') {
          throw conflict('PHASE_INACTIVE', 'مرحلهٔ انتخاب‌شده فعال نیست.');
        }
      }
      const parentTaskId = input.parentTaskId === undefined
        ? current.parent_task_id
        : nullableId(input.parentTaskId, 'parentTaskId');
      ensureTaskParent(projectId, taskId, parentTaskId, phaseId);
      const mismatchedChild = db.prepare(`
        SELECT id
        FROM project_tasks
        WHERE project_id=? AND parent_task_id=? AND archived_at IS NULL
          AND status<>'cancelled'
          AND NOT (phase_id IS ?)
        LIMIT 1
      `).get(projectId, taskId, phaseId);
      if (mismatchedChild) {
        throw conflict(
          'TASK_CHILD_PHASE_MISMATCH',
          'Child tasks must be moved to the same phase before their parent.',
        );
      }
      const assigneeUserId = input.assigneeUserId === undefined
        ? current.assignee_user_id
        : nullableId(input.assigneeUserId, 'assigneeUserId');
      requireUser(assigneeUserId);
      const status = enumValue(
        input.status,
        TASK_STATUSES,
        'status',
        current.status,
      );
      let progress = input.progressPercent === undefined
        ? Number(current.progress_percent)
        : progressValue(input.progressPercent);
      if (status === 'done') progress = 100;
      if (['backlog', 'todo'].includes(status) && progress > 0) {
        validation('وظیفهٔ شروع‌نشده نمی‌تواند پیشرفت داشته باشد.', {
          progressPercent: 'ابتدا وضعیت وظیفه را به در حال انجام تغییر دهید.',
        });
      }
      const starting = !predecessorStarted(current) && (
        ['in_progress', 'blocked', 'review', 'done'].includes(status) ||
        progress > 0
      );
      const finishing = current.status !== 'done' && status === 'done';
      assertTaskDependenciesAllow(projectId, taskId, { starting, finishing });
      const plannedStart = input.plannedStart === undefined
        ? current.planned_start
        : dateValue(input.plannedStart, 'plannedStart');
      const dueDate = input.dueDate === undefined
        ? current.due_date
        : dateValue(input.dueDate, 'dueDate');
      assertDateOrder(plannedStart, dueDate, 'plannedStart', 'dueDate');
      const now = nowIso(clock);
      const startedAt = starting
        ? current.started_at || now
        : current.started_at;
      const completedAt = status === 'done'
        ? current.completed_at || now
        : current.status === 'done' ? null : current.completed_at;
      db.prepare(`
        UPDATE project_tasks
        SET phase_id=?, parent_task_id=?, title=?, description=?, status=?,
            priority=?, progress_percent=?, weight=?, assignee_user_id=?,
            planned_start=?, due_date=?, started_at=?, completed_at=?,
            estimated_minutes=?, order_no=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        phaseId,
        parentTaskId,
        input.title === undefined
          ? current.title
          : text(input.title, 'title', {
            required: true,
            minimum: 2,
            maximum: 240,
          }),
        input.description === undefined
          ? current.description
          : text(input.description, 'description', { maximum: 10_000 }),
        status,
        enumValue(
          input.priority,
          TASK_PRIORITIES,
          'priority',
          current.priority,
        ),
        progress,
        input.weight === undefined
          ? Number(current.weight)
          : weightValue(input.weight),
        assigneeUserId,
        plannedStart,
        dueDate,
        startedAt,
        completedAt,
        input.estimatedMinutes === undefined
          ? current.estimated_minutes
          : integerValue(input.estimatedMinutes, 'estimatedMinutes', {
            minimum: 0,
            allowNull: true,
          }),
        input.orderNo === undefined
          ? Number(current.order_no)
          : integerValue(input.orderNo, 'orderNo', { minimum: 0 }),
        now,
        taskId,
        projectId,
      );
      recordAudit({
        projectId,
        resourceType: 'project_task',
        resourceId: taskId,
        action: 'updated',
        before: current,
        after: taskRow(projectId, taskId),
      });
    });
    return getTask(projectId, taskId);
  }

  function archiveTask(
    projectId,
    taskId,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = taskRow(projectId, taskId);
      if (current.archived_at) return;
      const activeChild = db.prepare(`
        SELECT id
        FROM project_tasks
        WHERE project_id=? AND parent_task_id=? AND archived_at IS NULL
          AND status<>'cancelled'
        LIMIT 1
      `).get(projectId, taskId);
      if (activeChild) {
        throw conflict(
          'TASK_HAS_ACTIVE_CHILDREN',
          'پیش از بایگانی، وظایف فرزند را منتقل یا لغو کنید.',
        );
      }
      const now = nowIso(clock);
      db.prepare(
        'DELETE FROM task_dependencies WHERE task_id=? OR depends_on_task_id=?',
      ).run(taskId, taskId);
      db.prepare(`
        UPDATE project_tasks
        SET status='cancelled', archived_at=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(now, now, taskId, projectId);
      recordAudit({
        projectId,
        resourceType: 'project_task',
        resourceId: taskId,
        action: 'archived',
        before: current,
        after: taskRow(projectId, taskId),
      });
    });
    return getTask(projectId, taskId);
  }

  function dependencyWouldCycle(taskId, dependsOnTaskId) {
    return Boolean(db.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT depends_on_task_id
        FROM task_dependencies
        WHERE task_id=?
        UNION
        SELECT d.depends_on_task_id
        FROM task_dependencies d
        JOIN ancestors a ON d.task_id=a.id
      )
      SELECT 1
      FROM ancestors
      WHERE id=?
      LIMIT 1
    `).get(dependsOnTaskId, taskId));
  }

  function addDependency(
    projectId,
    taskId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const dependsOnTaskId = text(
      input.dependsOnTaskId,
      'dependsOnTaskId',
      { required: true, maximum: 200 },
    );
    let created;
    withTransaction(db, () => {
      const task = taskRow(projectId, taskId);
      const predecessor = taskRow(projectId, dependsOnTaskId);
      if (task.archived_at || predecessor.archived_at) {
        throw conflict(
          'TASK_ARCHIVED',
          'برای وظیفهٔ بایگانی‌شده نمی‌توان وابستگی ساخت.',
        );
      }
      if (taskId === dependsOnTaskId || dependencyWouldCycle(
        taskId,
        dependsOnTaskId,
      )) {
        throw conflict(
          'TASK_DEPENDENCY_CYCLE',
          'این وابستگی در شبکهٔ وظایف چرخه ایجاد می‌کند.',
        );
      }
      const dependencyType = enumValue(
        input.dependencyType,
        DEPENDENCY_TYPES,
        'dependencyType',
        'finish_to_start',
      );
      const lagDays = integerValue(input.lagDays, 'lagDays', {
        minimum: -3650,
        maximum: 3650,
        fallback: 0,
      });
      const existing = db.prepare(`
        SELECT 1 FROM task_dependencies
        WHERE task_id=? AND depends_on_task_id=?
      `).get(taskId, dependsOnTaskId);
      if (existing) {
        throw conflict(
          'TASK_DEPENDENCY_EXISTS',
          'این وابستگی قبلاً ثبت شده است.',
        );
      }
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO task_dependencies(
          task_id, depends_on_task_id, dependency_type, lag_days, created_at
        ) VALUES(?,?,?,?,?)
      `).run(taskId, dependsOnTaskId, dependencyType, lagDays, now);
      assertTaskDependenciesAllow(projectId, taskId, {
        starting: predecessorStarted(task),
        finishing: task.status === 'done',
      });
      created = {
        taskId,
        dependsOnTaskId,
        dependencyType,
        lagDays,
        createdAt: now,
      };
      recordAudit({
        projectId,
        resourceType: 'task_dependency',
        resourceId: `${taskId}:${dependsOnTaskId}`,
        action: 'created',
        after: created,
      });
    });
    return { dependency: created };
  }

  function removeDependency(
    projectId,
    taskId,
    dependsOnTaskId,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      taskRow(projectId, taskId);
      taskRow(projectId, dependsOnTaskId);
      const current = db.prepare(`
        SELECT *
        FROM task_dependencies
        WHERE task_id=? AND depends_on_task_id=?
      `).get(taskId, dependsOnTaskId);
      if (!current) {
        throw notFound(
          'TASK_DEPENDENCY_NOT_FOUND',
          'وابستگی وظیفه پیدا نشد.',
        );
      }
      db.prepare(`
        DELETE FROM task_dependencies
        WHERE task_id=? AND depends_on_task_id=?
      `).run(taskId, dependsOnTaskId);
      recordAudit({
        projectId,
        resourceType: 'task_dependency',
        resourceId: `${taskId}:${dependsOnTaskId}`,
        action: 'deleted',
        before: current,
      });
    });
    return { deleted: true };
  }

  function timeEntries(projectId, { taskId = null } = {}) {
    requireProject(projectId);
    if (taskId) taskRow(projectId, taskId);
    return {
      timeEntries: db.prepare(`
        SELECT *
        FROM time_entries
        WHERE project_id=? ${taskId ? 'AND task_id=?' : ''}
        ORDER BY worked_on DESC, created_at DESC, id
      `).all(...(taskId ? [projectId, taskId] : [projectId])).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        taskId: row.task_id,
        userId: row.user_id,
        minutes: Number(row.minutes),
        workedOn: row.worked_on,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  function timeEntryRow(projectId, id) {
    const row = db.prepare(
      'SELECT * FROM time_entries WHERE id=? AND project_id=?',
    ).get(id, projectId);
    if (!row) {
      throw notFound('TIME_ENTRY_NOT_FOUND', 'ثبت زمان پیدا نشد.');
    }
    return row;
  }

  function getTimeEntry(projectId, id) {
    timeEntryRow(projectId, id);
    return {
      timeEntry: timeEntries(projectId).timeEntries.find(
        (item) => item.id === id,
      ),
    };
  }

  function recomputeTaskActualMinutes(projectId, taskId) {
    const exact = db.prepare(`
      SELECT COALESCE(SUM(minutes),0) AS total
      FROM time_entries
      WHERE project_id=? AND task_id=?
    `).get(projectId, taskId).total;
    const total = Number(exact);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw conflict(
        'TASK_TIME_OVERFLOW',
        'جمع زمان ثبت‌شده از محدودهٔ عددی امن خارج شده است.',
      );
    }
    db.prepare(`
      UPDATE project_tasks
      SET actual_minutes=?, updated_at=?
      WHERE id=? AND project_id=?
    `).run(total, nowIso(clock), taskId, projectId);
  }

  function createTimeEntry(
    projectId,
    input,
    { actorUserId = null, taskId: routeTaskId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const selectedTaskId = routeTaskId || text(
      input.taskId,
      'taskId',
      { required: true, maximum: 200 },
    );
    const selectedUserId = nullableId(input.userId, 'userId') || actorUserId;
    if (!selectedUserId) {
      validation('کاربر ثبت‌کنندهٔ زمان مشخص نیست.', {
        userId: 'یک کاربر معتبر انتخاب کنید.',
      });
    }
    let id;
    withTransaction(db, () => {
      const task = taskRow(projectId, selectedTaskId);
      if (task.archived_at || task.status === 'cancelled') {
        throw conflict('TASK_INACTIVE', 'برای وظیفهٔ غیرفعال زمان ثبت نمی‌شود.');
      }
      requireUser(selectedUserId);
      id = randomUUID();
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO time_entries(
          id, project_id, task_id, user_id, minutes, worked_on, note,
          created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        projectId,
        selectedTaskId,
        selectedUserId,
        integerValue(input.minutes, 'minutes', {
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
        dateValue(input.workedOn, 'workedOn', { required: true }),
        text(input.note, 'note', { maximum: 2_000 }),
        now,
        now,
      );
      recomputeTaskActualMinutes(projectId, selectedTaskId);
      recordAudit({
        projectId,
        resourceType: 'time_entry',
        resourceId: id,
        action: 'created',
        after: timeEntryRow(projectId, id),
      });
    });
    return {
      timeEntry: timeEntries(projectId).timeEntries.find(
        (item) => item.id === id,
      ),
      task: getTask(projectId, selectedTaskId).task,
    };
  }

  function patchTimeEntry(
    projectId,
    id,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    let newTaskId;
    withTransaction(db, () => {
      const current = timeEntryRow(projectId, id);
      newTaskId = input.taskId === undefined
        ? current.task_id
        : text(input.taskId, 'taskId', { required: true, maximum: 200 });
      const task = taskRow(projectId, newTaskId);
      if (task.archived_at || task.status === 'cancelled') {
        throw conflict('TASK_INACTIVE', 'برای وظیفهٔ غیرفعال زمان ثبت نمی‌شود.');
      }
      const userId = input.userId === undefined
        ? current.user_id
        : text(input.userId, 'userId', { required: true, maximum: 200 });
      requireUser(userId);
      db.prepare(`
        UPDATE time_entries
        SET task_id=?, user_id=?, minutes=?, worked_on=?, note=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        newTaskId,
        userId,
        input.minutes === undefined
          ? Number(current.minutes)
          : integerValue(input.minutes, 'minutes', { minimum: 1 }),
        input.workedOn === undefined
          ? current.worked_on
          : dateValue(input.workedOn, 'workedOn', { required: true }),
        input.note === undefined
          ? current.note
          : text(input.note, 'note', { maximum: 2_000 }),
        nowIso(clock),
        id,
        projectId,
      );
      recomputeTaskActualMinutes(projectId, current.task_id);
      if (newTaskId !== current.task_id) {
        recomputeTaskActualMinutes(projectId, newTaskId);
      }
      recordAudit({
        projectId,
        resourceType: 'time_entry',
        resourceId: id,
        action: 'updated',
        before: current,
        after: timeEntryRow(projectId, id),
      });
    });
    return {
      timeEntry: timeEntries(projectId).timeEntries.find(
        (item) => item.id === id,
      ),
      task: getTask(projectId, newTaskId).task,
    };
  }

  function deleteTimeEntry(
    projectId,
    id,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    let taskId;
    withTransaction(db, () => {
      const current = timeEntryRow(projectId, id);
      taskId = current.task_id;
      db.prepare('DELETE FROM time_entries WHERE id=? AND project_id=?')
        .run(id, projectId);
      recomputeTaskActualMinutes(projectId, taskId);
      recordAudit({
        projectId,
        resourceType: 'time_entry',
        resourceId: id,
        action: 'deleted',
        before: current,
      });
    });
    return { deleted: true, task: getTask(projectId, taskId).task };
  }

  function resources(projectId, { includeArchived = false } = {}) {
    requireProject(projectId);
    const rows = db.prepare(`
      SELECT *
      FROM project_resources
      WHERE project_id=?
      ORDER BY archived_at IS NOT NULL, name, created_at, id
    `).all(projectId);
    const allocationsByResource = new Map();
    for (const allocation of allocations(projectId).allocations) {
      const list = allocationsByResource.get(allocation.resourceId) || [];
      list.push(allocation);
      allocationsByResource.set(allocation.resourceId, list);
    }
    return {
      resources: rows
        .filter((row) => includeArchived || !row.archived_at)
        .map((row) => ({
          ...mapResource(row),
          allocatedQuantityPeak: peakAllocation(
            allocationsByResource.get(row.id) || [],
          ),
        })),
    };
  }

  function getResource(projectId, id) {
    resourceRow(projectId, id);
    return {
      resource: resources(projectId, { includeArchived: true }).resources
        .find((item) => item.id === id),
    };
  }

  function validateStakeholder(projectId, stakeholderId) {
    if (!stakeholderId) return null;
    const row = db.prepare(`
      SELECT id
      FROM project_stakeholders
      WHERE id=? AND project_id=?
    `).get(stakeholderId, projectId);
    if (!row) {
      throw badRequest(
        'INVALID_STAKEHOLDER',
        'ذی‌نفع منبع به این پروژه تعلق ندارد.',
      );
    }
    return row;
  }

  function createResource(
    projectId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const id = randomUUID();
    withTransaction(db, () => {
      const ownerStakeholderId =
        nullableId(input.ownerStakeholderId, 'ownerStakeholderId') ?? null;
      validateStakeholder(projectId, ownerStakeholderId);
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO project_resources(
          id, project_id, name, kind, unit, capacity, unit_cost, currency,
          owner_stakeholder_id, status, archived_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)
      `).run(
        id,
        projectId,
        text(input.name, 'name', {
          required: true,
          minimum: 2,
          maximum: 200,
        }),
        enumValue(input.kind, RESOURCE_KINDS, 'kind'),
        text(input.unit, 'unit', { maximum: 80 }),
        numberValue(input.capacity, 'capacity', {
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          allowNull: true,
          fallback: null,
        }),
        integerValue(input.unitCost, 'unitCost', {
          minimum: 0,
          allowNull: true,
          fallback: null,
        }),
        text(input.currency ?? 'IRR', 'currency', {
          required: true,
          minimum: 3,
          maximum: 3,
        }).toUpperCase(),
        ownerStakeholderId,
        enumValue(
          input.status,
          RESOURCE_STATUSES,
          'status',
          'available',
        ),
        now,
        now,
      );
      recordAudit({
        projectId,
        resourceType: 'project_resource',
        resourceId: id,
        action: 'created',
        after: resourceRow(projectId, id),
      });
    });
    return getResource(projectId, id);
  }

  function validateResourceCapacity(resource, rows) {
    if (resource.capacity === null) return;
    const peak = peakAllocation(rows);
    if (peak > Number(resource.capacity) + Number.EPSILON) {
      throw conflict(
        'RESOURCE_OVERALLOCATED',
        'جمع تخصیص‌های هم‌پوشان از ظرفیت منبع بیشتر است.',
        {
          capacity: String(resource.capacity),
          requestedPeak: String(peak),
        },
      );
    }
  }

  function patchResource(
    projectId,
    id,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = resourceRow(projectId, id);
      if (current.archived_at) {
        throw conflict('RESOURCE_ARCHIVED', 'منبع بایگانی‌شده قابل تغییر نیست.');
      }
      const ownerStakeholderId = input.ownerStakeholderId === undefined
        ? current.owner_stakeholder_id
        : nullableId(input.ownerStakeholderId, 'ownerStakeholderId');
      validateStakeholder(projectId, ownerStakeholderId);
      const capacity = input.capacity === undefined
        ? current.capacity
        : numberValue(input.capacity, 'capacity', {
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          allowNull: true,
        });
      const prospective = allocations(projectId, { resourceId: id }).allocations;
      validateResourceCapacity({ ...current, capacity }, prospective);
      db.prepare(`
        UPDATE project_resources
        SET name=?, kind=?, unit=?, capacity=?, unit_cost=?, currency=?,
            owner_stakeholder_id=?, status=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        input.name === undefined
          ? current.name
          : text(input.name, 'name', {
            required: true,
            minimum: 2,
            maximum: 200,
          }),
        enumValue(input.kind, RESOURCE_KINDS, 'kind', current.kind),
        input.unit === undefined
          ? current.unit
          : text(input.unit, 'unit', { maximum: 80 }),
        capacity,
        input.unitCost === undefined
          ? current.unit_cost
          : integerValue(input.unitCost, 'unitCost', {
            minimum: 0,
            allowNull: true,
          }),
        input.currency === undefined
          ? current.currency
          : text(input.currency, 'currency', {
            required: true,
            minimum: 3,
            maximum: 3,
          }).toUpperCase(),
        ownerStakeholderId,
        enumValue(
          input.status,
          RESOURCE_STATUSES,
          'status',
          current.status,
        ),
        nowIso(clock),
        id,
        projectId,
      );
      recordAudit({
        projectId,
        resourceType: 'project_resource',
        resourceId: id,
        action: 'updated',
        before: current,
        after: resourceRow(projectId, id),
      });
    });
    return getResource(projectId, id);
  }

  function archiveResource(
    projectId,
    id,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = resourceRow(projectId, id);
      if (current.archived_at) return;
      const now = nowIso(clock);
      db.prepare(`
        UPDATE project_resources
        SET status='retired', archived_at=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(now, now, id, projectId);
      recordAudit({
        projectId,
        resourceType: 'project_resource',
        resourceId: id,
        action: 'archived',
        before: current,
        after: resourceRow(projectId, id),
      });
    });
    return getResource(projectId, id);
  }

  function allocations(
    projectId,
    { resourceId = null, taskId = null, phaseId = null } = {},
  ) {
    requireProject(projectId);
    const rows = db.prepare(`
      SELECT a.*
      FROM resource_allocations a
      JOIN project_resources r ON r.id=a.resource_id
      LEFT JOIN project_tasks t ON t.id=a.task_id
      LEFT JOIN project_phases p ON p.id=a.phase_id
      WHERE r.project_id=?
        AND (a.task_id IS NULL OR t.project_id=?)
        AND (a.phase_id IS NULL OR p.project_id=?)
        ${resourceId ? 'AND a.resource_id=?' : ''}
        ${taskId ? 'AND a.task_id=?' : ''}
        ${phaseId ? 'AND a.phase_id=?' : ''}
      ORDER BY a.starts_on, a.ends_on, a.created_at, a.id
    `).all(
      projectId,
      projectId,
      projectId,
      ...[resourceId, taskId, phaseId].filter(Boolean),
    );
    return { allocations: rows.map(mapAllocation) };
  }

  function allocationRow(projectId, id) {
    const row = db.prepare(`
      SELECT a.*
      FROM resource_allocations a
      JOIN project_resources r ON r.id=a.resource_id
      WHERE a.id=? AND r.project_id=?
    `).get(id, projectId);
    if (!row) {
      throw notFound('ALLOCATION_NOT_FOUND', 'تخصیص منبع پیدا نشد.');
    }
    return row;
  }

  function getAllocation(projectId, id) {
    allocationRow(projectId, id);
    return {
      allocation: allocations(projectId).allocations.find(
        (item) => item.id === id,
      ),
    };
  }

  function allocationInput(projectId, input, current = null) {
    const resourceId = input.resourceId === undefined
      ? current?.resource_id
      : text(input.resourceId, 'resourceId', {
        required: true,
        maximum: 200,
      });
    if (!resourceId) {
      validation('A resource is required for an allocation.', {
        resourceId: 'Select a project resource.',
      });
    }
    const resource = resourceRow(projectId, resourceId);
    if (
      resource.archived_at ||
      ['unavailable', 'retired'].includes(resource.status)
    ) {
      throw conflict('RESOURCE_UNAVAILABLE', 'منبع انتخاب‌شده در دسترس نیست.');
    }
    const taskId = input.taskId === undefined
      ? current?.task_id ?? null
      : nullableId(input.taskId, 'taskId');
    const phaseId = input.phaseId === undefined
      ? current?.phase_id ?? null
      : nullableId(input.phaseId, 'phaseId');
    if (!taskId && !phaseId) {
      validation('تخصیص باید به وظیفه یا مرحله متصل باشد.', {
        taskId: 'وظیفه یا مرحله را انتخاب کنید.',
      });
    }
    const task = taskId ? taskRow(projectId, taskId) : null;
    const phase = phaseId ? phaseRow(projectId, phaseId) : null;
    if (task?.archived_at || phase?.archived_at) {
      throw conflict('ALLOCATION_TARGET_INACTIVE', 'هدف تخصیص فعال نیست.');
    }
    if (task && phase && task.phase_id && task.phase_id !== phase.id) {
      throw conflict(
        'ALLOCATION_PHASE_MISMATCH',
        'وظیفه و مرحلهٔ تخصیص با هم سازگار نیستند.',
      );
    }
    const startsOn = input.startsOn === undefined
      ? current?.starts_on ?? null
      : dateValue(input.startsOn, 'startsOn');
    const endsOn = input.endsOn === undefined
      ? current?.ends_on ?? null
      : dateValue(input.endsOn, 'endsOn');
    assertDateOrder(startsOn, endsOn, 'startsOn', 'endsOn');
    return {
      resource,
      resourceId,
      taskId,
      phaseId,
      quantity: input.quantity === undefined && current
        ? Number(current.quantity)
        : numberValue(input.quantity, 'quantity', {
          minimum: Number.EPSILON,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
      startsOn,
      endsOn,
      note: input.note === undefined
        ? current?.note ?? ''
        : text(input.note, 'note', { maximum: 2_000 }),
    };
  }

  function validateProspectiveAllocation(projectId, selected, excludeId = null) {
    const rows = allocations(projectId, {
      resourceId: selected.resourceId,
    }).allocations
      .filter((item) => item.id !== excludeId)
      .map((item) => ({
        quantity: item.quantity,
        startsOn: item.startsOn,
        endsOn: item.endsOn,
      }));
    rows.push(selected);
    validateResourceCapacity(selected.resource, rows);
  }

  function createAllocation(
    projectId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    let id;
    withTransaction(db, () => {
      const selected = allocationInput(projectId, input);
      validateProspectiveAllocation(projectId, selected);
      id = randomUUID();
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO resource_allocations(
          id, resource_id, task_id, phase_id, quantity, starts_on, ends_on,
          note, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        selected.resourceId,
        selected.taskId,
        selected.phaseId,
        selected.quantity,
        selected.startsOn,
        selected.endsOn,
        selected.note,
        now,
        now,
      );
      const after = allocationRow(projectId, id);
      recordAudit({
        projectId,
        resourceType: 'resource_allocation',
        resourceId: id,
        action: 'created',
        after,
      });
    });
    return {
      allocation: allocations(projectId).allocations.find(
        (item) => item.id === id,
      ),
    };
  }

  function patchAllocation(
    projectId,
    id,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = allocationRow(projectId, id);
      const selected = allocationInput(projectId, input, current);
      validateProspectiveAllocation(projectId, selected, id);
      db.prepare(`
        UPDATE resource_allocations
        SET resource_id=?, task_id=?, phase_id=?, quantity=?, starts_on=?,
            ends_on=?, note=?, updated_at=?
        WHERE id=?
      `).run(
        selected.resourceId,
        selected.taskId,
        selected.phaseId,
        selected.quantity,
        selected.startsOn,
        selected.endsOn,
        selected.note,
        nowIso(clock),
        id,
      );
      recordAudit({
        projectId,
        resourceType: 'resource_allocation',
        resourceId: id,
        action: 'updated',
        before: current,
        after: allocationRow(projectId, id),
      });
    });
    return {
      allocation: allocations(projectId).allocations.find(
        (item) => item.id === id,
      ),
    };
  }

  function deleteAllocation(
    projectId,
    id,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = allocationRow(projectId, id);
      db.prepare('DELETE FROM resource_allocations WHERE id=?').run(id);
      recordAudit({
        projectId,
        resourceType: 'resource_allocation',
        resourceId: id,
        action: 'deleted',
        before: current,
      });
    });
    return { deleted: true };
  }

  function risks(projectId, { kind = null } = {}) {
    requireProject(projectId);
    if (kind) enumValue(kind, RISK_KINDS, 'kind');
    return {
      risks: db.prepare(`
        SELECT *
        FROM project_risks
        WHERE project_id=? ${kind ? 'AND kind=?' : ''}
        ORDER BY
          CASE status WHEN 'open' THEN 1 WHEN 'mitigating' THEN 2 ELSE 3 END,
          probability * impact DESC,
          due_date,
          created_at,
          id
      `).all(...(kind ? [projectId, kind] : [projectId])).map(mapRisk),
    };
  }

  function getRisk(projectId, id, kind = null) {
    const row = riskRow(projectId, id, kind);
    return { risk: mapRisk(row) };
  }

  function createRisk(
    projectId,
    input,
    { actorUserId = null, forcedKind = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    requireUser(nullableId(input.ownerUserId, 'ownerUserId') ?? null);
    const id = randomUUID();
    withTransaction(db, () => {
      const now = nowIso(clock);
      const status = enumValue(
        input.status,
        RISK_STATUSES,
        'status',
        'open',
      );
      db.prepare(`
        INSERT INTO project_risks(
          id, project_id, kind, title, description, category, probability,
          impact, status, response_strategy, owner_user_id, due_date,
          resolved_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        projectId,
        forcedKind || enumValue(input.kind, RISK_KINDS, 'kind', 'risk'),
        text(input.title, 'title', {
          required: true,
          minimum: 2,
          maximum: 240,
        }),
        text(input.description, 'description', { maximum: 10_000 }),
        text(input.category, 'category', { maximum: 120 }),
        integerValue(input.probability, 'probability', {
          minimum: 1,
          maximum: 5,
          fallback: 1,
        }),
        integerValue(input.impact, 'impact', {
          minimum: 1,
          maximum: 5,
          fallback: 1,
        }),
        status,
        text(input.responseStrategy, 'responseStrategy', { maximum: 5_000 }),
        nullableId(input.ownerUserId, 'ownerUserId') ?? null,
        dateValue(input.dueDate, 'dueDate'),
        ['resolved', 'closed'].includes(status) ? now : null,
        now,
        now,
      );
      recordAudit({
        projectId,
        resourceType: forcedKind === 'issue' ? 'project_issue' : 'project_risk',
        resourceId: id,
        action: 'created',
        after: riskRow(projectId, id),
      });
    });
    return getRisk(projectId, id, forcedKind);
  }

  function patchRisk(
    projectId,
    id,
    input,
    { actorUserId = null, forcedKind = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = riskRow(projectId, id, forcedKind);
      const ownerUserId = input.ownerUserId === undefined
        ? current.owner_user_id
        : nullableId(input.ownerUserId, 'ownerUserId');
      requireUser(ownerUserId);
      const status = enumValue(
        input.status,
        RISK_STATUSES,
        'status',
        current.status,
      );
      const now = nowIso(clock);
      db.prepare(`
        UPDATE project_risks
        SET kind=?, title=?, description=?, category=?, probability=?,
            impact=?, status=?, response_strategy=?, owner_user_id=?,
            due_date=?, resolved_at=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        forcedKind || enumValue(input.kind, RISK_KINDS, 'kind', current.kind),
        input.title === undefined
          ? current.title
          : text(input.title, 'title', {
            required: true,
            minimum: 2,
            maximum: 240,
          }),
        input.description === undefined
          ? current.description
          : text(input.description, 'description', { maximum: 10_000 }),
        input.category === undefined
          ? current.category
          : text(input.category, 'category', { maximum: 120 }),
        input.probability === undefined
          ? Number(current.probability)
          : integerValue(input.probability, 'probability', {
            minimum: 1,
            maximum: 5,
          }),
        input.impact === undefined
          ? Number(current.impact)
          : integerValue(input.impact, 'impact', {
            minimum: 1,
            maximum: 5,
          }),
        status,
        input.responseStrategy === undefined
          ? current.response_strategy
          : text(input.responseStrategy, 'responseStrategy', {
            maximum: 5_000,
          }),
        ownerUserId,
        input.dueDate === undefined
          ? current.due_date
          : dateValue(input.dueDate, 'dueDate'),
        ['resolved', 'closed'].includes(status)
          ? current.resolved_at || now
          : null,
        now,
        id,
        projectId,
      );
      recordAudit({
        projectId,
        resourceType: forcedKind === 'issue' ? 'project_issue' : 'project_risk',
        resourceId: id,
        action: 'updated',
        before: current,
        after: riskRow(projectId, id),
      });
    });
    return getRisk(projectId, id, forcedKind);
  }

  function deleteRisk(
    projectId,
    id,
    { actorUserId = null, forcedKind = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = riskRow(projectId, id, forcedKind);
      db.prepare(
        'DELETE FROM project_risks WHERE id=? AND project_id=?',
      ).run(id, projectId);
      recordAudit({
        projectId,
        resourceType: forcedKind === 'issue' ? 'project_issue' : 'project_risk',
        resourceId: id,
        action: 'deleted',
        before: current,
      });
    });
    return { deleted: true };
  }

  function measurementRows(kpiId) {
    return db.prepare(`
      SELECT *
      FROM kpi_measurements
      WHERE kpi_id=?
      ORDER BY measured_at DESC, created_at DESC, id DESC
    `).all(kpiId).map((row) => ({
      id: row.id,
      kpiId: row.kpi_id,
      value: Number(row.value),
      measuredAt: row.measured_at,
      note: row.note,
      evidenceDocumentId: row.evidence_document_id,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
    }));
  }

  function kpis(projectId, { includeArchived = false } = {}) {
    requireProject(projectId);
    const rows = db.prepare(`
      SELECT *
      FROM project_kpis
      WHERE project_id=?
      ORDER BY archived_at IS NOT NULL, target_date, created_at, id
    `).all(projectId);
    return {
      kpis: rows
        .filter((row) => includeArchived || !row.archived_at)
        .map((row) => mapKpi(row, measurementRows(row.id))),
    };
  }

  function getKpi(projectId, id) {
    const row = kpiRow(projectId, id);
    return { kpi: mapKpi(row, measurementRows(id)) };
  }

  function createKpi(projectId, input, { actorUserId = null } = {}) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const ownerUserId = nullableId(input.ownerUserId, 'ownerUserId') ?? null;
    requireUser(ownerUserId);
    const id = randomUUID();
    withTransaction(db, () => {
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO project_kpis(
          id, project_id, name, description, unit, direction, baseline_value,
          target_value, warning_value, current_value, frequency, owner_user_id,
          starts_on, target_date, archived_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,NULL,?,?)
      `).run(
        id,
        projectId,
        text(input.name, 'name', {
          required: true,
          minimum: 2,
          maximum: 200,
        }),
        text(input.description, 'description', { maximum: 5_000 }),
        text(input.unit, 'unit', { maximum: 80 }),
        enumValue(
          input.direction,
          KPI_DIRECTIONS,
          'direction',
          'increase',
        ),
        numberValue(input.baselineValue, 'baselineValue', {
          allowNull: true,
          fallback: null,
        }),
        numberValue(input.targetValue, 'targetValue'),
        numberValue(input.warningValue, 'warningValue', {
          allowNull: true,
          fallback: null,
        }),
        enumValue(
          input.frequency,
          KPI_FREQUENCIES,
          'frequency',
          'monthly',
        ),
        ownerUserId,
        dateValue(input.startsOn, 'startsOn'),
        dateValue(input.targetDate, 'targetDate'),
        now,
        now,
      );
      recordAudit({
        projectId,
        resourceType: 'project_kpi',
        resourceId: id,
        action: 'created',
        after: kpiRow(projectId, id),
      });
    });
    return getKpi(projectId, id);
  }

  function patchKpi(
    projectId,
    id,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = kpiRow(projectId, id);
      if (current.archived_at) {
        throw conflict('KPI_ARCHIVED', 'شاخص بایگانی‌شده قابل تغییر نیست.');
      }
      const ownerUserId = input.ownerUserId === undefined
        ? current.owner_user_id
        : nullableId(input.ownerUserId, 'ownerUserId');
      requireUser(ownerUserId);
      db.prepare(`
        UPDATE project_kpis
        SET name=?, description=?, unit=?, direction=?, baseline_value=?,
            target_value=?, warning_value=?, frequency=?, owner_user_id=?,
            starts_on=?, target_date=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        input.name === undefined
          ? current.name
          : text(input.name, 'name', {
            required: true,
            minimum: 2,
            maximum: 200,
          }),
        input.description === undefined
          ? current.description
          : text(input.description, 'description', { maximum: 5_000 }),
        input.unit === undefined
          ? current.unit
          : text(input.unit, 'unit', { maximum: 80 }),
        enumValue(
          input.direction,
          KPI_DIRECTIONS,
          'direction',
          current.direction,
        ),
        input.baselineValue === undefined
          ? current.baseline_value
          : numberValue(input.baselineValue, 'baselineValue', {
            allowNull: true,
          }),
        input.targetValue === undefined
          ? Number(current.target_value)
          : numberValue(input.targetValue, 'targetValue'),
        input.warningValue === undefined
          ? current.warning_value
          : numberValue(input.warningValue, 'warningValue', {
            allowNull: true,
          }),
        enumValue(
          input.frequency,
          KPI_FREQUENCIES,
          'frequency',
          current.frequency,
        ),
        ownerUserId,
        input.startsOn === undefined
          ? current.starts_on
          : dateValue(input.startsOn, 'startsOn'),
        input.targetDate === undefined
          ? current.target_date
          : dateValue(input.targetDate, 'targetDate'),
        nowIso(clock),
        id,
        projectId,
      );
      recordAudit({
        projectId,
        resourceType: 'project_kpi',
        resourceId: id,
        action: 'updated',
        before: current,
        after: kpiRow(projectId, id),
      });
    });
    return getKpi(projectId, id);
  }

  function archiveKpi(
    projectId,
    id,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = kpiRow(projectId, id);
      if (current.archived_at) return;
      const now = nowIso(clock);
      db.prepare(`
        UPDATE project_kpis
        SET archived_at=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(now, now, id, projectId);
      recordAudit({
        projectId,
        resourceType: 'project_kpi',
        resourceId: id,
        action: 'archived',
        before: current,
        after: kpiRow(projectId, id),
      });
    });
    return getKpi(projectId, id);
  }

  function addKpiMeasurement(
    projectId,
    kpiId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const evidenceDocumentId =
      nullableId(input.evidenceDocumentId, 'evidenceDocumentId') ?? null;
    let id;
    withTransaction(db, () => {
      const kpi = kpiRow(projectId, kpiId);
      if (kpi.archived_at) {
        throw conflict('KPI_ARCHIVED', 'برای شاخص بایگانی‌شده اندازه‌گیری ثبت نمی‌شود.');
      }
      documentReference(projectId, evidenceDocumentId);
      id = randomUUID();
      const value = numberValue(input.value, 'value');
      const measuredAt = dateTimeValue(
        input.measuredAt,
        'measuredAt',
        { required: true },
      );
      const existing = db.prepare(`
        SELECT 1 FROM kpi_measurements
        WHERE kpi_id=? AND measured_at=?
      `).get(kpiId, measuredAt);
      if (existing) {
        throw conflict(
          'KPI_MEASUREMENT_EXISTS',
          'برای این زمان قبلاً اندازه‌گیری ثبت شده است.',
        );
      }
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO kpi_measurements(
          id, kpi_id, value, measured_at, note, evidence_document_id,
          created_by_user_id, created_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `).run(
        id,
        kpiId,
        value,
        measuredAt,
        text(input.note, 'note', { maximum: 2_000 }),
        evidenceDocumentId,
        actorUserId,
        now,
      );
      const latest = db.prepare(`
        SELECT value
        FROM kpi_measurements
        WHERE kpi_id=?
        ORDER BY measured_at DESC, created_at DESC, id DESC
        LIMIT 1
      `).get(kpiId);
      db.prepare(`
        UPDATE project_kpis
        SET current_value=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(Number(latest.value), now, kpiId, projectId);
      const after = db.prepare(
        'SELECT * FROM kpi_measurements WHERE id=?',
      ).get(id);
      recordAudit({
        projectId,
        resourceType: 'kpi_measurement',
        resourceId: id,
        action: 'recorded',
        after,
        metadata: { kpiId },
      });
    });
    return {
      measurement: measurementRows(kpiId).find((item) => item.id === id),
      kpi: getKpi(projectId, kpiId).kpi,
    };
  }

  function progressUpdates(projectId, { phaseId = null, taskId = null } = {}) {
    requireProject(projectId);
    if (phaseId) phaseRow(projectId, phaseId);
    if (taskId) taskRow(projectId, taskId);
    return {
      progressUpdates: db.prepare(`
        SELECT *
        FROM progress_updates
        WHERE project_id=?
          ${phaseId ? 'AND phase_id=?' : ''}
          ${taskId ? 'AND task_id=?' : ''}
        ORDER BY reported_at DESC, created_at DESC, id DESC
      `).all(
        projectId,
        ...[phaseId, taskId].filter(Boolean),
      ).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        phaseId: row.phase_id,
        taskId: row.task_id,
        progressPercent: Number(row.progress_percent),
        summary: row.summary,
        blockers: row.blockers,
        nextSteps: row.next_steps,
        evidenceDocumentId: row.evidence_document_id,
        reportedByUserId: row.reported_by_user_id,
        reportedAt: row.reported_at,
        createdAt: row.created_at,
      })),
    };
  }

  function createProgressUpdate(
    projectId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const phaseId = nullableId(input.phaseId, 'phaseId') ?? null;
    const taskId = nullableId(input.taskId, 'taskId') ?? null;
    if (!phaseId && !taskId) {
      validation('گزارش پیشرفت باید به مرحله یا وظیفه متصل باشد.', {
        phaseId: 'یک مرحله یا وظیفه انتخاب کنید.',
      });
    }
    const evidenceDocumentId =
      nullableId(input.evidenceDocumentId, 'evidenceDocumentId') ?? null;
    let id;
    withTransaction(db, () => {
      const phase = phaseId ? phaseRow(projectId, phaseId) : null;
      const task = taskId ? taskRow(projectId, taskId) : null;
      if (phase?.archived_at || task?.archived_at) {
        throw conflict(
          'PROGRESS_TARGET_INACTIVE',
          'هدف گزارش پیشرفت فعال نیست.',
        );
      }
      if (phase && task && task.phase_id && task.phase_id !== phase.id) {
        throw conflict(
          'PROGRESS_PHASE_MISMATCH',
          'وظیفه به مرحلهٔ انتخاب‌شده تعلق ندارد.',
        );
      }
      documentReference(projectId, evidenceDocumentId);
      const progress = progressValue(input.progressPercent);
      if (task) {
        const starting = !predecessorStarted(task) && progress > 0;
        const finishing = task.status !== 'done' && progress === 100;
        assertTaskDependenciesAllow(projectId, taskId, { starting, finishing });
      }
      id = randomUUID();
      const now = nowIso(clock);
      const reportedAt = input.reportedAt === undefined
        ? now
        : dateTimeValue(input.reportedAt, 'reportedAt', { required: true });
      db.prepare(`
        INSERT INTO progress_updates(
          id, project_id, phase_id, task_id, progress_percent, summary,
          blockers, next_steps, evidence_document_id, reported_by_user_id,
          reported_at, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        projectId,
        phaseId,
        taskId,
        progress,
        text(input.summary, 'summary', {
          required: true,
          minimum: 2,
          maximum: 5_000,
        }),
        text(input.blockers, 'blockers', { maximum: 5_000 }),
        text(input.nextSteps, 'nextSteps', { maximum: 5_000 }),
        evidenceDocumentId,
        actorUserId,
        reportedAt,
        now,
      );
      if (task) {
        const status = progress === 100
          ? 'done'
          : progress > 0 && ['backlog', 'todo'].includes(task.status)
            ? 'in_progress'
            : task.status;
        db.prepare(`
          UPDATE project_tasks
          SET progress_percent=?, status=?,
              started_at=CASE
                WHEN ? > 0 THEN COALESCE(started_at,?)
                ELSE started_at
              END,
              completed_at=CASE WHEN ?=100 THEN COALESCE(completed_at,?)
                                WHEN status='done' THEN NULL
                                ELSE completed_at END,
              updated_at=?
          WHERE id=? AND project_id=?
        `).run(
          progress,
          status,
          progress,
          reportedAt,
          progress,
          reportedAt,
          now,
          taskId,
          projectId,
        );
      }
      if (phase && !task && phase.progress_method === 'manual') {
        db.prepare(`
          UPDATE project_phases
          SET manual_progress=?, updated_at=?
          WHERE id=? AND project_id=?
        `).run(progress, now, phaseId, projectId);
      }
      const after = db.prepare(
        'SELECT * FROM progress_updates WHERE id=?',
      ).get(id);
      recordAudit({
        projectId,
        resourceType: 'progress_update',
        resourceId: id,
        action: 'created',
        after,
      });
    });
    return {
      progressUpdate: progressUpdates(projectId).progressUpdates.find(
        (item) => item.id === id,
      ),
      ...(taskId ? { task: getTask(projectId, taskId).task } : {}),
      ...(phaseId ? { phase: getPhase(projectId, phaseId).phase } : {}),
    };
  }

  function actualExpense(projectId, budget, lines) {
    const dateArguments = [];
    let dateClause = '';
    if (budget.period_start) {
      dateClause += ' AND e.occurred_on>=?';
      dateArguments.push(budget.period_start);
    }
    if (budget.period_end) {
      dateClause += ' AND e.occurred_on<=?';
      dateArguments.push(budget.period_end);
    }
    const journalRows = db.prepare(`
      SELECT a.code, l.debit, l.credit
      FROM journal_entries e
      JOIN journal_lines l ON l.journal_entry_id=e.id
      JOIN accounting_accounts a ON a.id=l.account_id
      WHERE e.project_id=?
        AND e.status IN ('posted','reversed')
        AND e.currency=?
        AND a.organization_id=e.organization_id
        AND (a.project_id=e.project_id OR a.project_id IS NULL)
        AND a.account_type='expense'
        ${dateClause}
    `).all(projectId, budget.currency, ...dateArguments);
    const journalEntryCount = Number(db.prepare(`
      SELECT COUNT(*) AS value
      FROM journal_entries e
      WHERE e.project_id=?
        AND e.status IN ('posted','reversed')
        AND e.currency=?
        ${dateClause}
    `).get(projectId, budget.currency, ...dateArguments).value);
    if (journalEntryCount) {
      const byCode = new Map();
      let total = 0n;
      for (const row of journalRows) {
        const amount = BigInt(Number(row.debit)) - BigInt(Number(row.credit));
        total += amount;
        byCode.set(row.code, (byCode.get(row.code) || 0n) + amount);
      }
      return {
        source: 'journal',
        totalActualAmount: safeBigInt(total),
        totalActualExact: total.toString(),
        overflow: safeBigInt(total) === null,
        byLineId: new Map(lines.map((line) => {
          const exact = line.account_code
            ? byCode.get(line.account_code) || 0n
            : total;
          return [line.id, {
            value: safeBigInt(exact),
            exact: exact.toString(),
            overflow: safeBigInt(exact) === null,
          }];
        })),
      };
    }

    const legacyArguments = [projectId];
    let legacyDateClause = '';
    if (budget.period_start) {
      legacyDateClause += ' AND occurred_on>=?';
      legacyArguments.push(budget.period_start);
    }
    if (budget.period_end) {
      legacyDateClause += ' AND occurred_on<=?';
      legacyArguments.push(budget.period_end);
    }
    const legacyRows = db.prepare(`
      SELECT amount, reversal_of_entry_id
      FROM financial_entries
      WHERE project_id=? AND type='expense'
        ${legacyDateClause}
    `).all(...legacyArguments);
    let legacyTotal = 0n;
    for (const row of legacyRows) {
      legacyTotal += BigInt(Number(row.amount)) *
        (row.reversal_of_entry_id ? -1n : 1n);
    }
    return {
      source: 'legacy_financial_entries',
      totalActualAmount: safeBigInt(legacyTotal),
      totalActualExact: legacyTotal.toString(),
      overflow: safeBigInt(legacyTotal) === null,
      byLineId: new Map(lines.map((line) => (
        line.account_code
          ? [line.id, null]
          : [line.id, {
            value: safeBigInt(legacyTotal),
            exact: legacyTotal.toString(),
            overflow: safeBigInt(legacyTotal) === null,
          }]
      ))),
    };
  }

  function budgetLines(projectId, budgetId) {
    const budget = budgetRow(projectId, budgetId);
    const rows = db.prepare(`
      SELECT *
      FROM budget_lines
      WHERE budget_version_id=?
      ORDER BY order_no, created_at, id
    `).all(budgetId);
    const actual = actualExpense(projectId, budget, rows);
    return {
      budgetLines: rows.map((row) => {
        const lineActual = actual.byLineId.get(row.id);
        return {
          id: row.id,
          budgetVersionId: row.budget_version_id,
          parentId: row.parent_id,
          accountCode: row.account_code,
          title: row.title,
          category: row.category,
          plannedAmount: Number(row.planned_amount),
          actualAmount: lineActual?.value ?? null,
          actualExact: lineActual?.exact,
          actualOverflow: lineActual?.overflow || false,
          notes: row.notes,
          orderNo: Number(row.order_no),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
      actual,
    };
  }

  function mapBudget(projectId, row) {
    const lineResult = budgetLines(projectId, row.id);
    const planned = sumSafeIntegers(
      lineResult.budgetLines.map((line) => line.plannedAmount),
    );
    const actual = lineResult.actual;
    const varianceExact =
      BigInt(planned.exact) - BigInt(actual.totalActualExact);
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      versionNo: Number(row.version_no),
      status: row.status,
      currency: row.currency,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      approvedByUserId: row.approved_by_user_id,
      approvedAt: row.approved_at,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      plannedAmount: planned.value,
      plannedExact: planned.exact,
      plannedOverflow: planned.overflow,
      actualAmount: actual.totalActualAmount,
      actualExact: actual.totalActualExact,
      actualOverflow: actual.overflow,
      actualSource: actual.source,
      varianceAmount: safeBigInt(varianceExact),
      varianceExact: varianceExact.toString(),
      budgetLines: lineResult.budgetLines,
    };
  }

  function budgets(projectId) {
    requireProject(projectId);
    return {
      budgets: db.prepare(`
        SELECT *
        FROM budget_versions
        WHERE project_id=?
        ORDER BY version_no DESC, created_at DESC, id
      `).all(projectId).map((row) => mapBudget(projectId, row)),
    };
  }

  function getBudget(projectId, id) {
    const row = budgetRow(projectId, id);
    return { budget: mapBudget(projectId, row) };
  }

  function getBudgetLine(projectId, budgetId, lineId) {
    budgetLineRow(projectId, budgetId, lineId);
    return {
      budgetLine: getBudget(projectId, budgetId).budget.budgetLines
        .find((line) => line.id === lineId),
    };
  }

  function createBudget(
    projectId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const id = randomUUID();
    withTransaction(db, () => {
      const versionNo = Number(db.prepare(`
        SELECT COALESCE(MAX(version_no),0)+1 AS value
        FROM budget_versions
        WHERE project_id=?
      `).get(projectId).value);
      const periodStart = dateValue(input.periodStart, 'periodStart');
      const periodEnd = dateValue(input.periodEnd, 'periodEnd');
      assertDateOrder(periodStart, periodEnd, 'periodStart', 'periodEnd');
      const project = requireProject(projectId);
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO budget_versions(
          id, project_id, name, version_no, status, currency, period_start,
          period_end, approved_by_user_id, approved_at, created_by_user_id,
          created_at, updated_at
        ) VALUES(?,?,?,?,'draft',?,?,?,NULL,NULL,?,?,?)
      `).run(
        id,
        projectId,
        text(input.name, 'name', {
          required: true,
          minimum: 2,
          maximum: 200,
        }),
        versionNo,
        text(input.currency ?? project.currency ?? 'IRR', 'currency', {
          required: true,
          minimum: 3,
          maximum: 3,
        }).toUpperCase(),
        periodStart,
        periodEnd,
        actorUserId,
        now,
        now,
      );
      recordAudit({
        projectId,
        resourceType: 'budget_version',
        resourceId: id,
        action: 'created',
        after: budgetRow(projectId, id),
      });
    });
    return getBudget(projectId, id);
  }

  function assertDraftBudget(budget) {
    if (budget.status !== 'draft') {
      throw conflict(
        'BUDGET_NOT_DRAFT',
        'فقط نسخهٔ پیش‌نویس بودجه قابل ویرایش است.',
      );
    }
  }

  function patchBudget(
    projectId,
    id,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = budgetRow(projectId, id);
      assertDraftBudget(current);
      const periodStart = input.periodStart === undefined
        ? current.period_start
        : dateValue(input.periodStart, 'periodStart');
      const periodEnd = input.periodEnd === undefined
        ? current.period_end
        : dateValue(input.periodEnd, 'periodEnd');
      assertDateOrder(periodStart, periodEnd, 'periodStart', 'periodEnd');
      db.prepare(`
        UPDATE budget_versions
        SET name=?, currency=?, period_start=?, period_end=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        input.name === undefined
          ? current.name
          : text(input.name, 'name', {
            required: true,
            minimum: 2,
            maximum: 200,
          }),
        input.currency === undefined
          ? current.currency
          : text(input.currency, 'currency', {
            required: true,
            minimum: 3,
            maximum: 3,
          }).toUpperCase(),
        periodStart,
        periodEnd,
        nowIso(clock),
        id,
        projectId,
      );
      recordAudit({
        projectId,
        resourceType: 'budget_version',
        resourceId: id,
        action: 'updated',
        before: current,
        after: budgetRow(projectId, id),
      });
    });
    return getBudget(projectId, id);
  }

  function ensureBudgetLineParent(
    projectId,
    budgetId,
    lineId,
    parentId,
  ) {
    if (!parentId) return;
    budgetLineRow(projectId, budgetId, parentId);
    if (parentId === lineId) {
      throw conflict(
        'BUDGET_LINE_CYCLE',
        'ردیف بودجه نمی‌تواند والد خودش باشد.',
      );
    }
    let cursorId = parentId;
    const visited = new Set();
    while (cursorId) {
      if (cursorId === lineId) {
        throw conflict(
          'BUDGET_LINE_CYCLE',
          'ساختار ردیف‌های بودجه چرخه ایجاد می‌کند.',
        );
      }
      if (visited.has(cursorId)) {
        throw conflict(
          'BUDGET_LINE_CYCLE',
          'ساختار ردیف‌های بودجه دارای چرخه است.',
        );
      }
      visited.add(cursorId);
      const cursor = db.prepare(`
        SELECT parent_id
        FROM budget_lines
        WHERE id=? AND budget_version_id=?
      `).get(cursorId, budgetId);
      cursorId = cursor?.parent_id || null;
    }
  }

  function createBudgetLine(
    projectId,
    budgetId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    const id = randomUUID();
    withTransaction(db, () => {
      const budget = budgetRow(projectId, budgetId);
      assertDraftBudget(budget);
      const parentId = nullableId(input.parentId, 'parentId') ?? null;
      ensureBudgetLineParent(projectId, budgetId, id, parentId);
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO budget_lines(
          id, budget_version_id, parent_id, account_code, title, category,
          planned_amount, notes, order_no, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        budgetId,
        parentId,
        text(input.accountCode, 'accountCode', { maximum: 80 }),
        text(input.title, 'title', {
          required: true,
          minimum: 2,
          maximum: 240,
        }),
        text(input.category, 'category', { maximum: 120 }),
        integerValue(input.plannedAmount, 'plannedAmount', { minimum: 0 }),
        text(input.notes, 'notes', { maximum: 5_000 }),
        integerValue(input.orderNo, 'orderNo', {
          minimum: 0,
          fallback: 0,
        }),
        now,
        now,
      );
      recordAudit({
        projectId,
        resourceType: 'budget_line',
        resourceId: id,
        action: 'created',
        after: budgetLineRow(projectId, budgetId, id),
        metadata: { budgetId },
      });
    });
    return {
      budgetLine: getBudget(projectId, budgetId).budget.budgetLines
        .find((line) => line.id === id),
      budget: getBudget(projectId, budgetId).budget,
    };
  }

  function patchBudgetLine(
    projectId,
    budgetId,
    lineId,
    input,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const budget = budgetRow(projectId, budgetId);
      assertDraftBudget(budget);
      const current = budgetLineRow(projectId, budgetId, lineId);
      const parentId = input.parentId === undefined
        ? current.parent_id
        : nullableId(input.parentId, 'parentId');
      ensureBudgetLineParent(projectId, budgetId, lineId, parentId);
      db.prepare(`
        UPDATE budget_lines
        SET parent_id=?, account_code=?, title=?, category=?,
            planned_amount=?, notes=?, order_no=?, updated_at=?
        WHERE id=? AND budget_version_id=?
      `).run(
        parentId,
        input.accountCode === undefined
          ? current.account_code
          : text(input.accountCode, 'accountCode', { maximum: 80 }),
        input.title === undefined
          ? current.title
          : text(input.title, 'title', {
            required: true,
            minimum: 2,
            maximum: 240,
          }),
        input.category === undefined
          ? current.category
          : text(input.category, 'category', { maximum: 120 }),
        input.plannedAmount === undefined
          ? Number(current.planned_amount)
          : integerValue(input.plannedAmount, 'plannedAmount', { minimum: 0 }),
        input.notes === undefined
          ? current.notes
          : text(input.notes, 'notes', { maximum: 5_000 }),
        input.orderNo === undefined
          ? Number(current.order_no)
          : integerValue(input.orderNo, 'orderNo', { minimum: 0 }),
        nowIso(clock),
        lineId,
        budgetId,
      );
      recordAudit({
        projectId,
        resourceType: 'budget_line',
        resourceId: lineId,
        action: 'updated',
        before: current,
        after: budgetLineRow(projectId, budgetId, lineId),
        metadata: { budgetId },
      });
    });
    return {
      budgetLine: getBudget(projectId, budgetId).budget.budgetLines
        .find((line) => line.id === lineId),
      budget: getBudget(projectId, budgetId).budget,
    };
  }

  function deleteBudgetLine(
    projectId,
    budgetId,
    lineId,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const budget = budgetRow(projectId, budgetId);
      assertDraftBudget(budget);
      const current = budgetLineRow(projectId, budgetId, lineId);
      const child = db.prepare(`
        SELECT id FROM budget_lines
        WHERE budget_version_id=? AND parent_id=?
        LIMIT 1
      `).get(budgetId, lineId);
      if (child) {
        throw conflict(
          'BUDGET_LINE_HAS_CHILDREN',
          'پیش از حذف ردیف، ردیف‌های فرزند را منتقل کنید.',
        );
      }
      db.prepare(`
        DELETE FROM budget_lines
        WHERE id=? AND budget_version_id=?
      `).run(lineId, budgetId);
      recordAudit({
        projectId,
        resourceType: 'budget_line',
        resourceId: lineId,
        action: 'deleted',
        before: current,
        metadata: { budgetId },
      });
    });
    return { deleted: true, budget: getBudget(projectId, budgetId).budget };
  }

  function approveBudget(
    projectId,
    budgetId,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    if (!actorUserId) {
      validation('تأییدکنندهٔ بودجه مشخص نیست.', {
        actorUserId: 'تأیید بودجه به کاربر احراز هویت‌شده نیاز دارد.',
      });
    }
    withTransaction(db, () => {
      const current = budgetRow(projectId, budgetId);
      assertDraftBudget(current);
      const lineCount = Number(db.prepare(`
        SELECT COUNT(*) AS value
        FROM budget_lines
        WHERE budget_version_id=?
      `).get(budgetId).value);
      if (!lineCount) {
        throw conflict(
          'BUDGET_EMPTY',
          'بودجهٔ بدون ردیف قابل تأیید نیست.',
        );
      }
      const now = nowIso(clock);
      db.prepare(`
        UPDATE budget_versions
        SET status='superseded', updated_at=?
        WHERE project_id=? AND status='approved' AND id<>?
      `).run(now, projectId, budgetId);
      db.prepare(`
        UPDATE budget_versions
        SET status='approved', approved_by_user_id=?, approved_at=?,
            updated_at=?
        WHERE id=? AND project_id=?
      `).run(actorUserId, now, now, budgetId, projectId);
      recordAudit({
        projectId,
        resourceType: 'budget_version',
        resourceId: budgetId,
        action: 'approved',
        before: current,
        after: budgetRow(projectId, budgetId),
      });
    });
    return getBudget(projectId, budgetId);
  }

  function reviseBudget(
    projectId,
    budgetId,
    input = {},
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    let revisedId;
    withTransaction(db, () => {
      const source = budgetRow(projectId, budgetId);
      if (!['approved', 'superseded'].includes(source.status)) {
        throw conflict(
          'BUDGET_NOT_REVISION_SOURCE',
          'فقط بودجهٔ تأییدشده یا جایگزین‌شده قابل بازنگری است.',
        );
      }
      revisedId = randomUUID();
      const versionNo = Number(db.prepare(`
        SELECT COALESCE(MAX(version_no),0)+1 AS value
        FROM budget_versions
        WHERE project_id=?
      `).get(projectId).value);
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO budget_versions(
          id, project_id, name, version_no, status, currency, period_start,
          period_end, approved_by_user_id, approved_at, created_by_user_id,
          created_at, updated_at
        ) VALUES(?,?,?,?,'draft',?,?,?,NULL,NULL,?,?,?)
      `).run(
        revisedId,
        projectId,
        input.name === undefined
          ? `${source.name} - بازنگری ${versionNo}`
          : text(input.name, 'name', {
            required: true,
            minimum: 2,
            maximum: 200,
          }),
        versionNo,
        source.currency,
        source.period_start,
        source.period_end,
        actorUserId,
        now,
        now,
      );
      const sourceLines = db.prepare(`
        SELECT *
        FROM budget_lines
        WHERE budget_version_id=?
        ORDER BY order_no, created_at, id
      `).all(budgetId);
      const newIds = new Map(
        sourceLines.map((line) => [line.id, randomUUID()]),
      );
      const insert = db.prepare(`
        INSERT INTO budget_lines(
          id, budget_version_id, parent_id, account_code, title, category,
          planned_amount, notes, order_no, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const line of sourceLines) {
        insert.run(
          newIds.get(line.id),
          revisedId,
          line.parent_id ? newIds.get(line.parent_id) || null : null,
          line.account_code,
          line.title,
          line.category,
          line.planned_amount,
          line.notes,
          line.order_no,
          now,
          now,
        );
      }
      recordAudit({
        projectId,
        resourceType: 'budget_version',
        resourceId: revisedId,
        action: 'revised',
        after: budgetRow(projectId, revisedId),
        metadata: { sourceBudgetId: budgetId },
      });
    });
    return getBudget(projectId, revisedId);
  }

  function cancelBudget(
    projectId,
    budgetId,
    { actorUserId = null } = {},
  ) {
    requireProject(projectId, { mutable: true });
    requireUser(actorUserId);
    withTransaction(db, () => {
      const current = budgetRow(projectId, budgetId);
      if (current.status === 'approved') {
        throw conflict(
          'APPROVED_BUDGET_CANNOT_CANCEL',
          'بودجهٔ تأییدشده باید با نسخهٔ بازنگری جایگزین شود.',
        );
      }
      if (current.status === 'cancelled') return;
      db.prepare(`
        UPDATE budget_versions
        SET status='cancelled', updated_at=?
        WHERE id=? AND project_id=?
      `).run(nowIso(clock), budgetId, projectId);
      recordAudit({
        projectId,
        resourceType: 'budget_version',
        resourceId: budgetId,
        action: 'cancelled',
        before: current,
        after: budgetRow(projectId, budgetId),
      });
    });
    return getBudget(projectId, budgetId);
  }

  function dashboard(projectId) {
    requireProject(projectId);
    const phaseItems = phases(projectId).phases.filter(
      (phase) => phase.status !== 'cancelled',
    );
    const taskItems = tasks(projectId).tasks.filter(
      (task) => task.status !== 'cancelled',
    );
    const phaseProgress = phaseItems.length
      ? phaseItems.reduce((sum, phase) => sum + phase.progressPercent, 0) /
        phaseItems.length
      : (() => {
        const state = computedTaskState(projectId);
        const topLevel = state.rows.filter((task) => (
          !task.archived_at &&
          task.status !== 'cancelled' &&
          !task.phase_id &&
          !task.parent_task_id
        ));
        const weight = topLevel.reduce(
          (sum, task) => sum + Number(task.weight),
          0,
        );
        return weight
          ? topLevel.reduce(
            (sum, task) =>
              sum + (state.progressById.get(task.id) || 0) * Number(task.weight),
            0,
          ) / weight
          : 0;
      })();
    const today = nowIso(clock).slice(0, 10);
    const riskItems = risks(projectId).risks;
    const kpiItems = kpis(projectId).kpis;
    const measuredKpis = kpiItems.filter(
      (kpi) => kpi.achievementPercent !== null,
    );
    const approvedBudget = budgets(projectId).budgets.find(
      (budget) => budget.status === 'approved',
    ) || null;
    return {
      executionProgressPercent: phaseProgress,
      progressCalculation: phaseItems.length
        ? 'equal_weighted_phases'
        : 'weighted_unphased_tasks',
      phases: {
        total: phaseItems.length,
        completed: phaseItems.filter((phase) => phase.status === 'completed').length,
        blocked: phaseItems.filter((phase) => phase.status === 'blocked').length,
        items: phaseItems,
      },
      tasks: {
        total: taskItems.length,
        done: taskItems.filter((task) => task.status === 'done').length,
        blocked: taskItems.filter((task) => task.status === 'blocked').length,
        overdue: taskItems.filter((task) => (
          task.dueDate &&
          task.dueDate < today &&
          !['done', 'cancelled'].includes(task.status)
        )).length,
      },
      resources: {
        total: resources(projectId).resources.length,
        overallocated: resources(projectId).resources.filter((resource) => (
          resource.capacity !== null &&
          resource.allocatedQuantityPeak > resource.capacity
        )).length,
      },
      risks: {
        total: riskItems.length,
        open: riskItems.filter((risk) =>
          ['open', 'mitigating', 'accepted'].includes(risk.status)).length,
        critical: riskItems.filter((risk) => (
          risk.band === 'critical' &&
          !['resolved', 'closed'].includes(risk.status)
        )).length,
        issues: riskItems.filter((risk) => risk.kind === 'issue').length,
      },
      kpis: {
        total: kpiItems.length,
        measured: measuredKpis.length,
        onTrack: measuredKpis.filter((kpi) => kpi.health === 'on_track').length,
        achievementPercent: measuredKpis.length
          ? measuredKpis.reduce(
            (sum, kpi) => sum + kpi.achievementPercent,
            0,
          ) / measuredKpis.length
          : null,
      },
      budget: approvedBudget,
      recentProgressUpdates: progressUpdates(projectId).progressUpdates.slice(0, 10),
    };
  }

  return Object.freeze({
    phases,
    getPhase,
    createPhase,
    patchPhase,
    archivePhase,
    tasks,
    getTask,
    createTask,
    patchTask,
    archiveTask,
    addDependency,
    removeDependency,
    timeEntries,
    getTimeEntry,
    createTimeEntry,
    patchTimeEntry,
    deleteTimeEntry,
    resources,
    getResource,
    createResource,
    patchResource,
    archiveResource,
    allocations,
    getAllocation,
    createAllocation,
    patchAllocation,
    deleteAllocation,
    risks,
    getRisk,
    createRisk,
    patchRisk,
    deleteRisk,
    kpis,
    getKpi,
    createKpi,
    patchKpi,
    archiveKpi,
    addKpiMeasurement,
    progressUpdates,
    createProgressUpdate,
    budgets,
    getBudget,
    getBudgetLine,
    createBudget,
    patchBudget,
    createBudgetLine,
    patchBudgetLine,
    deleteBudgetLine,
    approveBudget,
    reviseBudget,
    cancelBudget,
    dashboard,
  });
}

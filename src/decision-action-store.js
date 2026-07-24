import { randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from './errors.js';
import { withTransaction } from './database.js';

const STATUSES = new Set([
  'open',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
]);
const PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const TRANSITIONS = Object.freeze({
  open: new Set(['in_progress', 'cancelled']),
  in_progress: new Set(['blocked', 'completed', 'cancelled']),
  blocked: new Set(['in_progress', 'completed', 'cancelled']),
  completed: new Set(['open']),
  cancelled: new Set(['open']),
});
const CREATE_FIELDS = new Set([
  'title',
  'description',
  'assigneeUserId',
  'dueDate',
  'priority',
  'meetingId',
  'resolutionId',
]);
const PATCH_FIELDS = new Set([
  'title',
  'description',
  'assigneeUserId',
  'dueDate',
  'priority',
]);
const TRANSITION_FIELDS = new Set(['toStatus', 'note']);

function nowIso(clock) {
  const value = clock();
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new Error('The decision action clock returned an invalid date.');
  }
  return result.toISOString();
}

function failValidation(message, fields = {}) {
  throw badRequest('VALIDATION_FAILED', message, fields);
}

function inputObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failValidation('بدنهٔ درخواست باید یک شیء معتبر باشد.', {
      body: 'یک شیء JSON معتبر ارسال کنید.',
    });
  }
  return value;
}

function assertOnlyFields(input, allowed) {
  const unknown = Object.keys(input).filter((field) => !allowed.has(field));
  if (unknown.length) {
    failValidation('برخی فیلدهای درخواست پشتیبانی نمی‌شوند.', Object.fromEntries(
      unknown.map((field) => [field, 'این فیلد قابل ثبت یا تغییر نیست.']),
    ));
  }
}

function text(value, field, {
  required = false,
  maximum = 10_000,
  fallback = '',
} = {}) {
  const selected = value === undefined ? fallback : value;
  const result = String(selected ?? '').trim();
  if ((required && !result) || result.length > maximum) {
    failValidation('اطلاعات واردشده معتبر نیست.', {
      [field]: required && !result
        ? 'این فیلد الزامی است.'
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

function dateValue(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    failValidation('تاریخ معتبر نیست.', {
      [field]: 'تاریخ را با قالب YYYY-MM-DD وارد کنید.',
    });
  }
  const selected = value.trim();
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(selected);
  if (!match) {
    failValidation('تاریخ معتبر نیست.', {
      [field]: 'تاریخ را با قالب YYYY-MM-DD وارد کنید.',
    });
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3])
  ) {
    failValidation('تاریخ معتبر نیست.', {
      [field]: 'یک روز تقویمی معتبر وارد کنید.',
    });
  }
  return selected;
}

function enumValue(value, allowed, field, fallback) {
  const selected = value === undefined ? fallback : String(value);
  if (!allowed.has(selected)) {
    failValidation('مقدار انتخاب‌شده معتبر نیست.', {
      [field]: 'یکی از مقادیر مجاز را انتخاب کنید.',
    });
  }
  return selected;
}

function boundedInteger(value, field, fallback, minimum, maximum) {
  const selected = value === undefined || value === null || value === ''
    ? fallback
    : Number(value);
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    failValidation('عدد واردشده معتبر نیست.', {
      [field]: `یک عدد صحیح بین ${minimum} و ${maximum} وارد کنید.`,
    });
  }
  return selected;
}

function parseBoolean(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  failValidation('مقدار منطقی معتبر نیست.', {
    [field]: 'مقدار باید true یا false باشد.',
  });
}

function physicalStatus(status) {
  if (status === 'completed') return 'done';
  if (status === 'blocked') return 'in_progress';
  return status;
}

function actorIdentity(actor) {
  if (actor?.apiKey) {
    return {
      actorType: 'api_key',
      actorId: actor.apiKey.id || null,
      actorUserId: actor.userId || null,
    };
  }
  if (actor?.legacy) {
    return {
      actorType: 'legacy_admin',
      actorId: actor.userId || null,
      actorUserId: actor.userId || null,
    };
  }
  if (actor?.userId) {
    return {
      actorType: actor.actorType || 'user',
      actorId: actor.userId,
      actorUserId: actor.userId,
    };
  }
  return {
    actorType: actor?.actorType || 'system',
    actorId: actor?.actorId || null,
    actorUserId: null,
  };
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function mapAction(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    meetingId: row.meeting_id,
    resolutionId: row.resolution_id,
    title: row.title,
    description: row.description || '',
    assigneeUserId: row.assignee_user_id,
    assignee: row.assignee_user_id
      ? {
        id: row.assignee_user_id,
        fullName: row.assignee_full_name || '',
        email: row.assignee_email || '',
      }
      : null,
    dueDate: row.due_date,
    priority: row.priority || 'medium',
    status: row.workflow_status ||
      (row.status === 'done' ? 'completed' : row.status),
    completedAt: row.completed_at,
    blockedAt: row.blocked_at || null,
    cancelledAt: row.cancelled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHistory(row) {
  return {
    id: row.id,
    actionId: row.decision_action_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorUserId: row.actor_user_id,
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    metadata: parseJson(row.metadata_json, {}),
    audit: row.audit_event_id
      ? {
        eventId: row.audit_event_id,
        eventHash: row.audit_event_hash,
        hmacLinked: Boolean(row.audit_event_hash),
      }
      : null,
    createdAt: row.created_at,
  };
}

function ensureDecisionActionSchema(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(decision_actions)').all().map((row) => row.name),
  );
  if (!columns.size) {
    throw new Error('decision_actions table is missing; apply enterprise migrations first.');
  }
  const hadWorkflowStatus = columns.has('workflow_status');
  if (!columns.has('description')) {
    db.exec("ALTER TABLE decision_actions ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('priority')) {
    db.exec("ALTER TABLE decision_actions ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'");
  }
  if (!hadWorkflowStatus) {
    db.exec("ALTER TABLE decision_actions ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'open'");
  }
  if (!columns.has('blocked_at')) {
    db.exec('ALTER TABLE decision_actions ADD COLUMN blocked_at TEXT');
  }
  if (!columns.has('cancelled_at')) {
    db.exec('ALTER TABLE decision_actions ADD COLUMN cancelled_at TEXT');
  }
  if (!hadWorkflowStatus) {
    db.exec(`
      UPDATE decision_actions
      SET workflow_status=CASE status
        WHEN 'done' THEN 'completed'
        WHEN 'cancelled' THEN 'cancelled'
        WHEN 'in_progress' THEN 'in_progress'
        ELSE 'open'
      END
    `);
  } else {
    db.exec(`
      UPDATE decision_actions
      SET workflow_status=CASE status
        WHEN 'done' THEN 'completed'
        WHEN 'cancelled' THEN 'cancelled'
        WHEN 'in_progress' THEN 'in_progress'
        ELSE 'open'
      END
      WHERE workflow_status NOT IN (
        'open','in_progress','blocked','completed','cancelled'
      ) OR workflow_status IS NULL
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_action_history (
      id TEXT PRIMARY KEY,
      decision_action_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      actor_user_id TEXT,
      before_json TEXT,
      after_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      audit_event_id TEXT,
      audit_event_hash TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(decision_action_id)
        REFERENCES decision_actions(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS decision_actions_workflow
      ON decision_actions(project_id, workflow_status, priority, due_date);
    CREATE INDEX IF NOT EXISTS decision_action_history_action
      ON decision_action_history(decision_action_id, created_at DESC, id DESC);
  `);
}

/**
 * Decision actions bridge board/management resolutions to accountable work.
 *
 * The legacy table stores `done` and cannot represent `blocked`; therefore this
 * module adds a non-destructive `workflow_status` compatibility column and
 * keeps the legacy `status` column synchronized for old readers.
 */
export function createDecisionActionStore(
  db,
  {
    clock = () => new Date(),
    audit = () => {},
  } = {},
) {
  ensureDecisionActionSchema(db);
  const at = () => nowIso(clock);

  function requireProject(projectId, { mutable = false } = {}) {
    const project = db.prepare(`
      SELECT id, organization_id, archived_at
      FROM projects
      WHERE id=?
    `).get(projectId);
    if (!project) {
      throw notFound('PROJECT_NOT_FOUND', 'پروژهٔ موردنظر پیدا نشد.');
    }
    if (mutable && project.archived_at) {
      throw conflict(
        'PROJECT_ARCHIVED',
        'اقدام‌های پروژهٔ بایگانی‌شده قابل تغییر نیستند.',
      );
    }
    return project;
  }

  function actionRow(projectId, actionId) {
    const row = db.prepare(`
      SELECT a.*,u.full_name AS assignee_full_name,u.email AS assignee_email
      FROM decision_actions a
      LEFT JOIN users u ON u.id=a.assignee_user_id
      WHERE a.id=? AND a.project_id=?
    `).get(actionId, projectId);
    if (!row) {
      throw notFound('DECISION_ACTION_NOT_FOUND', 'اقدام موردنظر پیدا نشد.');
    }
    return row;
  }

  function requireAssignee(project, userId) {
    if (!userId) return null;
    const user = db.prepare(`
      SELECT u.id
      FROM users u
      JOIN organization_memberships om
        ON om.user_id=u.id
       AND om.organization_id=?
       AND om.status='active'
      WHERE u.id=? AND u.status='active'
    `).get(project.organization_id, userId);
    if (!user) {
      throw badRequest(
        'INVALID_ASSIGNEE',
        'مسئول اقدام باید کاربر فعال همین سازمان باشد.',
        { assigneeUserId: 'یک عضو فعال همین سازمان را انتخاب کنید.' },
      );
    }
    return user.id;
  }

  function resolveGovernanceScope(projectId, meetingId, resolutionId) {
    let meeting = null;
    let resolution = null;
    if (meetingId) {
      meeting = db.prepare(`
        SELECT id,project_id
        FROM project_meetings
        WHERE id=? AND project_id=?
      `).get(meetingId, projectId);
      if (!meeting) {
        throw badRequest(
          'INVALID_MEETING',
          'جلسه باید به همین پروژه تعلق داشته باشد.',
          { meetingId: 'جلسهٔ معتبر همین پروژه را انتخاب کنید.' },
        );
      }
    }
    if (resolutionId) {
      resolution = db.prepare(`
        SELECT r.id,r.meeting_id,m.project_id
        FROM meeting_resolutions r
        JOIN project_meetings m ON m.id=r.meeting_id
        WHERE r.id=? AND m.project_id=?
      `).get(resolutionId, projectId);
      if (!resolution) {
        throw badRequest(
          'INVALID_RESOLUTION',
          'مصوبه باید به همین پروژه تعلق داشته باشد.',
          { resolutionId: 'مصوبهٔ معتبر همین پروژه را انتخاب کنید.' },
        );
      }
      if (meeting && resolution.meeting_id !== meeting.id) {
        throw badRequest(
          'RESOLUTION_MEETING_MISMATCH',
          'مصوبه به جلسهٔ انتخاب‌شده تعلق ندارد.',
          { resolutionId: 'مصوبه‌ای از همین جلسه را انتخاب کنید.' },
        );
      }
      if (!meeting) {
        meeting = { id: resolution.meeting_id, project_id: projectId };
      }
    }
    return {
      meetingId: meeting?.id || null,
      resolutionId: resolution?.id || null,
    };
  }

  function recordChange({
    project,
    actionId,
    eventType,
    actor,
    before,
    after,
    fromStatus = null,
    toStatus = null,
    metadata = {},
    createdAt,
  }) {
    const identity = actorIdentity(actor);
    const auditResult = audit({
      organizationId: project.organization_id,
      projectId: project.id,
      resourceType: 'decision_action',
      resourceId: actionId,
      action: eventType,
      ...identity,
      before,
      after,
      metadata,
      createdAt,
    }) || {};
    db.prepare(`
      INSERT INTO decision_action_history(
        id,decision_action_id,event_type,from_status,to_status,
        actor_type,actor_id,actor_user_id,before_json,after_json,
        metadata_json,audit_event_id,audit_event_hash,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      randomUUID(),
      actionId,
      eventType,
      fromStatus,
      toStatus,
      identity.actorType,
      identity.actorId,
      identity.actorUserId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      JSON.stringify(metadata),
      auditResult.id || null,
      auditResult.hash || null,
      createdAt,
    );
  }

  function get(projectId, actionId) {
    requireProject(projectId);
    return {
      action: mapAction(actionRow(projectId, actionId)),
    };
  }

  function list(projectId, filters = {}) {
    requireProject(projectId);
    const clauses = ['a.project_id=?'];
    const values = [projectId];

    if (filters.status !== undefined && filters.status !== '') {
      const selectedStatuses = Array.isArray(filters.status)
        ? filters.status
        : String(filters.status).split(',');
      const statuses = [...new Set(selectedStatuses.map((item) => (
        enumValue(item.trim(), STATUSES, 'status')
      )))];
      clauses.push(`a.workflow_status IN (${statuses.map(() => '?').join(',')})`);
      values.push(...statuses);
    }
    if (filters.priority !== undefined && filters.priority !== '') {
      const selectedPriorities = Array.isArray(filters.priority)
        ? filters.priority
        : String(filters.priority).split(',');
      const priorities = [...new Set(selectedPriorities.map((item) => (
        enumValue(item.trim(), PRIORITIES, 'priority')
      )))];
      clauses.push(`a.priority IN (${priorities.map(() => '?').join(',')})`);
      values.push(...priorities);
    }
    const assigneeUserId = nullableId(filters.assigneeUserId, 'assigneeUserId');
    if (assigneeUserId === null || assigneeUserId === 'unassigned') {
      clauses.push('a.assignee_user_id IS NULL');
    } else if (assigneeUserId) {
      clauses.push('a.assignee_user_id=?');
      values.push(assigneeUserId);
    }
    const meetingId = nullableId(filters.meetingId, 'meetingId');
    if (meetingId) {
      clauses.push('a.meeting_id=?');
      values.push(meetingId);
    }
    const resolutionId = nullableId(filters.resolutionId, 'resolutionId');
    if (resolutionId) {
      clauses.push('a.resolution_id=?');
      values.push(resolutionId);
    }
    const dueFrom = dateValue(filters.dueFrom, 'dueFrom');
    if (dueFrom) {
      clauses.push('a.due_date>=?');
      values.push(dueFrom);
    }
    const dueTo = dateValue(filters.dueTo, 'dueTo');
    if (dueTo) {
      clauses.push('a.due_date<=?');
      values.push(dueTo);
    }
    if (dueFrom && dueTo && dueFrom > dueTo) {
      failValidation('بازهٔ سررسید معتبر نیست.', {
        dueTo: 'تاریخ پایان نباید پیش از تاریخ شروع باشد.',
      });
    }
    const overdue = parseBoolean(filters.overdue, 'overdue');
    if (overdue === true) {
      clauses.push("a.due_date<? AND a.workflow_status NOT IN ('completed','cancelled')");
      values.push(at().slice(0, 10));
    } else if (overdue === false) {
      clauses.push(`(
        a.due_date IS NULL OR a.due_date>=? OR
        a.workflow_status IN ('completed','cancelled')
      )`);
      values.push(at().slice(0, 10));
    }
    if (filters.q !== undefined && String(filters.q).trim()) {
      const query = text(filters.q, 'q', { maximum: 200 });
      clauses.push(`(
        a.title LIKE ? COLLATE NOCASE OR
        a.description LIKE ? COLLATE NOCASE
      )`);
      values.push(`%${query}%`, `%${query}%`);
    }

    const limit = boundedInteger(filters.limit, 'limit', 100, 1, 200);
    const offset = boundedInteger(filters.offset, 'offset', 0, 0, 1_000_000);
    const where = clauses.join(' AND ');
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM decision_actions a
      WHERE ${where}
    `).get(...values).count);
    const rows = db.prepare(`
      SELECT a.*,u.full_name AS assignee_full_name,u.email AS assignee_email
      FROM decision_actions a
      LEFT JOIN users u ON u.id=a.assignee_user_id
      WHERE ${where}
      ORDER BY
        CASE a.priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          ELSE 3
        END,
        a.due_date IS NULL,
        a.due_date,
        a.created_at DESC,
        a.id
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset);
    const summary = Object.fromEntries(
      [...STATUSES].map((status) => [status, 0]),
    );
    for (const row of db.prepare(`
      SELECT workflow_status AS status,COUNT(*) AS count
      FROM decision_actions
      WHERE project_id=?
      GROUP BY workflow_status
    `).all(projectId)) {
      if (STATUSES.has(row.status)) summary[row.status] = Number(row.count);
    }
    return {
      actions: rows.map(mapAction),
      total,
      limit,
      offset,
      summary,
    };
  }

  function create(projectId, input, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    inputObject(input);
    assertOnlyFields(input, CREATE_FIELDS);
    const title = text(input.title, 'title', {
      required: true,
      maximum: 300,
    });
    const description = text(input.description, 'description', {
      maximum: 20_000,
    });
    const assigneeUserId = nullableId(input.assigneeUserId, 'assigneeUserId') ?? null;
    requireAssignee(project, assigneeUserId);
    const dueDate = dateValue(input.dueDate, 'dueDate') ?? null;
    const priority = enumValue(input.priority, PRIORITIES, 'priority', 'medium');
    const scope = resolveGovernanceScope(
      projectId,
      nullableId(input.meetingId, 'meetingId'),
      nullableId(input.resolutionId, 'resolutionId'),
    );
    const id = randomUUID();
    const createdAt = at();
    let action;
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO decision_actions(
          id,project_id,meeting_id,resolution_id,title,description,
          assignee_user_id,due_date,priority,status,workflow_status,
          completed_at,blocked_at,cancelled_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'open','open',NULL,NULL,NULL,?,?)
      `).run(
        id,
        projectId,
        scope.meetingId,
        scope.resolutionId,
        title,
        description,
        assigneeUserId,
        dueDate,
        priority,
        createdAt,
        createdAt,
      );
      action = mapAction(actionRow(projectId, id));
      recordChange({
        project,
        actionId: id,
        eventType: 'created',
        actor,
        before: null,
        after: action,
        toStatus: action.status,
        metadata: {
          meetingId: action.meetingId,
          resolutionId: action.resolutionId,
        },
        createdAt,
      });
    });
    return { action };
  }

  function patch(projectId, actionId, input, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    inputObject(input);
    assertOnlyFields(input, PATCH_FIELDS);
    if (!Object.keys(input).length) {
      failValidation('حداقل یک فیلد برای تغییر ارسال کنید.', {
        body: 'هیچ تغییری ارسال نشده است.',
      });
    }
    const currentRow = actionRow(projectId, actionId);
    const before = mapAction(currentRow);
    const next = {
      title: Object.hasOwn(input, 'title')
        ? text(input.title, 'title', { required: true, maximum: 300 })
        : before.title,
      description: Object.hasOwn(input, 'description')
        ? text(input.description, 'description', { maximum: 20_000 })
        : before.description,
      assigneeUserId: Object.hasOwn(input, 'assigneeUserId')
        ? nullableId(input.assigneeUserId, 'assigneeUserId')
        : before.assigneeUserId,
      dueDate: Object.hasOwn(input, 'dueDate')
        ? dateValue(input.dueDate, 'dueDate')
        : before.dueDate,
      priority: Object.hasOwn(input, 'priority')
        ? enumValue(input.priority, PRIORITIES, 'priority')
        : before.priority,
    };
    requireAssignee(project, next.assigneeUserId);
    const changedFields = Object.keys(next).filter(
      (field) => next[field] !== before[field],
    );
    if (!changedFields.length) return { action: before, changed: false };

    const updatedAt = at();
    let action;
    withTransaction(db, () => {
      db.prepare(`
        UPDATE decision_actions
        SET title=?,description=?,assignee_user_id=?,due_date=?,priority=?,
            updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        next.title,
        next.description,
        next.assigneeUserId,
        next.dueDate,
        next.priority,
        updatedAt,
        actionId,
        projectId,
      );
      action = mapAction(actionRow(projectId, actionId));
      recordChange({
        project,
        actionId,
        eventType: 'updated',
        actor,
        before,
        after: action,
        fromStatus: before.status,
        toStatus: action.status,
        metadata: { changedFields },
        createdAt: updatedAt,
      });
    });
    return { action, changed: true };
  }

  function transition(projectId, actionId, input, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    inputObject(input);
    assertOnlyFields(input, TRANSITION_FIELDS);
    const toStatus = enumValue(input.toStatus, STATUSES, 'toStatus');
    const note = text(input.note, 'note', { maximum: 4_000 });
    const currentRow = actionRow(projectId, actionId);
    const before = mapAction(currentRow);
    if (toStatus === before.status) {
      throw conflict(
        'DECISION_ACTION_STATUS_UNCHANGED',
        'اقدام هم‌اکنون در همین وضعیت است.',
      );
    }
    if (!TRANSITIONS[before.status]?.has(toStatus)) {
      throw conflict(
        'INVALID_DECISION_ACTION_TRANSITION',
        `تغییر وضعیت از ${before.status} به ${toStatus} مجاز نیست.`,
        { toStatus: 'یک گذار معتبر انتخاب کنید.' },
      );
    }
    const updatedAt = at();
    const completedAt = toStatus === 'completed'
      ? updatedAt
      : before.status === 'completed' ? null : before.completedAt;
    const blockedAt = toStatus === 'blocked'
      ? updatedAt
      : before.status === 'blocked' ? null : before.blockedAt;
    const cancelledAt = toStatus === 'cancelled'
      ? updatedAt
      : before.status === 'cancelled' ? null : before.cancelledAt;
    let action;
    withTransaction(db, () => {
      db.prepare(`
        UPDATE decision_actions
        SET status=?,workflow_status=?,completed_at=?,blocked_at=?,
            cancelled_at=?,updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        physicalStatus(toStatus),
        toStatus,
        completedAt,
        blockedAt,
        cancelledAt,
        updatedAt,
        actionId,
        projectId,
      );
      action = mapAction(actionRow(projectId, actionId));
      recordChange({
        project,
        actionId,
        eventType: toStatus === 'open' ? 'reopened' : 'status_changed',
        actor,
        before,
        after: action,
        fromStatus: before.status,
        toStatus,
        metadata: { note },
        createdAt: updatedAt,
      });
    });
    return { action };
  }

  function history(projectId, actionId, { limit = 100, offset = 0 } = {}) {
    requireProject(projectId);
    actionRow(projectId, actionId);
    const selectedLimit = boundedInteger(limit, 'limit', 100, 1, 500);
    const selectedOffset = boundedInteger(offset, 'offset', 0, 0, 1_000_000);
    const rows = db.prepare(`
      SELECT h.*
      FROM decision_action_history h
      JOIN decision_actions a ON a.id=h.decision_action_id
      WHERE h.decision_action_id=? AND a.project_id=?
      ORDER BY h.created_at DESC,h.rowid DESC
      LIMIT ? OFFSET ?
    `).all(actionId, projectId, selectedLimit, selectedOffset);
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM decision_action_history h
      JOIN decision_actions a ON a.id=h.decision_action_id
      WHERE h.decision_action_id=? AND a.project_id=?
    `).get(actionId, projectId).count);
    return {
      history: rows.map(mapHistory),
      total,
      limit: selectedLimit,
      offset: selectedOffset,
    };
  }

  return Object.freeze({
    list,
    get,
    create,
    patch,
    transition,
    history,
  });
}

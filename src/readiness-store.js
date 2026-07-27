import { randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from './errors.js';
import { withTransaction } from './database.js';

const ACTION_TYPES = new Set(['manual', 'form', 'document', 'task', 'resolution']);
const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'select', 'checkbox']);
const RULE_TYPES = new Set([
  'manual_checkbox',
  'form_field',
  'document_exists',
  'task_status',
  'resolution_approved',
]);
const OPERATORS = new Set(['eq', 'neq', 'filled', 'true', 'gte', 'lte', 'in']);

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function requiredText(value, field, maximum = 300) {
  const selected = typeof value === 'string' ? value.trim() : '';
  if (!selected || selected.length > maximum) {
    throw badRequest('VALIDATION_FAILED', 'اطلاعات فرایند معتبر نیست.', {
      [field]: `این فیلد الزامی و حداکثر ${maximum} نویسه است.`,
    });
  }
  return selected;
}

function optionalText(value, field, maximum = 5000) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > maximum) {
    throw badRequest('VALIDATION_FAILED', 'اطلاعات فرایند معتبر نیست.', {
      [field]: `حداکثر ${maximum} نویسه مجاز است.`,
    });
  }
  return value.trim();
}

function booleanValue(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw badRequest('VALIDATION_FAILED', 'اطلاعات فرایند معتبر نیست.', {
      [field]: 'مقدار باید بله یا خیر باشد.',
    });
  }
  return value;
}

function positionValue(value, fallback = 0) {
  if (value === undefined) return fallback;
  const selected = Number(value);
  if (!Number.isInteger(selected) || selected < 0 || selected > 10_000) {
    throw badRequest('VALIDATION_FAILED', 'ترتیب مرحله معتبر نیست.', {
      position: 'ترتیب باید عددی بین صفر تا ۱۰۰۰۰ باشد.',
    });
  }
  return selected;
}

function keyValue(value, field = 'key') {
  const selected = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(selected)) {
    throw badRequest('VALIDATION_FAILED', 'کلید فیلد معتبر نیست.', {
      [field]: 'کلید باید با حرف انگلیسی آغاز شود و فقط حرف، عدد و زیرخط داشته باشد.',
    });
  }
  return selected;
}

function normalizeFormSchema(value) {
  const fields = value === undefined ? [] : value;
  if (!Array.isArray(fields) || fields.length > 30) {
    throw badRequest('VALIDATION_FAILED', 'ساختار فرم معتبر نیست.', {
      formSchema: 'فرم باید حداکثر ۳۰ فیلد داشته باشد.',
    });
  }
  const keys = new Set();
  return fields.map((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw badRequest('VALIDATION_FAILED', 'ساختار فرم معتبر نیست.', {
        [`formSchema.${index}`]: 'تعریف فیلد معتبر نیست.',
      });
    }
    const key = keyValue(field.key, `formSchema.${index}.key`);
    if (keys.has(key)) {
      throw badRequest('VALIDATION_FAILED', 'کلیدهای فرم باید یکتا باشند.', {
        [`formSchema.${index}.key`]: 'این کلید تکراری است.',
      });
    }
    keys.add(key);
    const type = String(field.type || 'text');
    if (!FIELD_TYPES.has(type)) {
      throw badRequest('VALIDATION_FAILED', 'نوع فیلد فرم پشتیبانی نمی‌شود.', {
        [`formSchema.${index}.type`]: 'نوع فیلد معتبر نیست.',
      });
    }
    const options = type === 'select'
      ? (Array.isArray(field.options) ? field.options : []).map((item) =>
        requiredText(String(item), `formSchema.${index}.options`, 120))
      : [];
    if (type === 'select' && (!options.length || options.length > 50)) {
      throw badRequest('VALIDATION_FAILED', 'گزینه‌های فیلد انتخابی معتبر نیست.', {
        [`formSchema.${index}.options`]: 'بین ۱ تا ۵۰ گزینه تعریف کنید.',
      });
    }
    if (new Set(options).size !== options.length) {
      throw badRequest('VALIDATION_FAILED', 'گزینه‌های فیلد انتخابی باید یکتا باشند.', {
        [`formSchema.${index}.options`]: 'گزینهٔ تکراری را حذف کنید.',
      });
    }
    const maximum = field.maxLength === undefined ? 2000 : Number(field.maxLength);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 20_000) {
      throw badRequest('VALIDATION_FAILED', 'حداکثر طول فیلد معتبر نیست.', {
        [`formSchema.${index}.maxLength`]: 'عدد باید بین ۱ تا ۲۰۰۰۰ باشد.',
      });
    }
    const minimum = field.min !== undefined && field.min !== null && field.min !== '' && Number.isFinite(Number(field.min))
      ? Number(field.min) : null;
    const maximumValue = field.max !== undefined && field.max !== null && field.max !== '' && Number.isFinite(Number(field.max))
      ? Number(field.max) : null;
    if (minimum !== null && maximumValue !== null && minimum > maximumValue) {
      throw badRequest('VALIDATION_FAILED', 'محدودهٔ عددی فیلد معتبر نیست.', {
        [`formSchema.${index}.min`]: 'حداقل نمی‌تواند از حداکثر بیشتر باشد.',
      });
    }
    return {
      key,
      label: requiredText(field.label, `formSchema.${index}.label`, 160),
      type,
      required: booleanValue(field.required, `formSchema.${index}.required`, false),
      options,
      min: minimum,
      max: maximumValue,
      maxLength: maximum,
      help: optionalText(field.help, `formSchema.${index}.help`, 300),
    };
  });
}

function normalizeRules(value, formSchema = []) {
  const rules = value === undefined ? [] : value;
  if (!Array.isArray(rules) || rules.length > 30) {
    throw badRequest('VALIDATION_FAILED', 'قواعد مرحله معتبر نیست.', {
      gateRules: 'حداکثر ۳۰ قاعده برای هر مرحله مجاز است.',
    });
  }
  const fieldKeys = new Set(formSchema.map((field) => field.key));
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw badRequest('VALIDATION_FAILED', 'قاعده معتبر نیست.', {
        [`gateRules.${index}`]: 'تعریف قاعده معتبر نیست.',
      });
    }
    const type = String(rule.type || '');
    if (!RULE_TYPES.has(type)) {
      throw badRequest('VALIDATION_FAILED', 'نوع قاعده پشتیبانی نمی‌شود.', {
        [`gateRules.${index}.type`]: 'نوع قاعده معتبر نیست.',
      });
    }
    const result = {
      type,
      label: optionalText(rule.label, `gateRules.${index}.label`, 200),
    };
    if (type === 'manual_checkbox' || type === 'form_field') {
      result.fieldKey = keyValue(rule.fieldKey, `gateRules.${index}.fieldKey`);
      if (!fieldKeys.has(result.fieldKey)) {
        throw badRequest('VALIDATION_FAILED', 'قاعده به فیلد ناشناخته اشاره می‌کند.', {
          [`gateRules.${index}.fieldKey`]: 'ابتدا این فیلد را در فرم مرحله تعریف کنید.',
        });
      }
      if (
        type === 'manual_checkbox' &&
        formSchema.find((field) => field.key === result.fieldKey)?.type !== 'checkbox'
      ) {
        throw badRequest('VALIDATION_FAILED', 'قاعدهٔ تأیید فقط برای چک‌باکس معتبر است.', {
          [`gateRules.${index}.fieldKey`]: 'یک فیلد از نوع بله/خیر انتخاب کنید.',
        });
      }
    }
    if (type === 'form_field') {
      result.operator = String(rule.operator || 'eq');
      if (!OPERATORS.has(result.operator)) {
        throw badRequest('VALIDATION_FAILED', 'عملگر قاعده معتبر نیست.', {
          [`gateRules.${index}.operator`]: 'عملگر پشتیبانی نمی‌شود.',
        });
      }
      result.value = rule.value ?? null;
      if (
        !['filled', 'true'].includes(result.operator) &&
        (result.value === null || result.value === undefined || result.value === '')
      ) {
        throw badRequest('VALIDATION_FAILED', 'مقدار مقایسهٔ قاعده وارد نشده است.', {
          [`gateRules.${index}.value`]: 'برای این عملگر یک مقدار تعیین کنید.',
        });
      }
      if (result.operator === 'in' && (!Array.isArray(result.value) || !result.value.length || result.value.length > 50)) {
        throw badRequest('VALIDATION_FAILED', 'فهرست مقادیر قاعده معتبر نیست.', {
          [`gateRules.${index}.value`]: 'بین ۱ تا ۵۰ مقدار مجاز تعریف کنید.',
        });
      }
    }
    if (type === 'document_exists') {
      result.documentId = optionalText(rule.documentId, `gateRules.${index}.documentId`, 120) || null;
      result.category = optionalText(rule.category, `gateRules.${index}.category`, 80) || null;
    }
    if (type === 'task_status') {
      result.taskId = requiredText(rule.taskId, `gateRules.${index}.taskId`, 120);
      result.status = String(rule.status || 'done');
      if (!['done', 'completed'].includes(result.status)) {
        throw badRequest('VALIDATION_FAILED', 'وضعیت هدف وظیفه معتبر نیست.', {
          [`gateRules.${index}.status`]: 'وضعیت هدف باید done یا completed باشد.',
        });
      }
    }
    if (type === 'resolution_approved') {
      result.resolutionId = requiredText(
        rule.resolutionId,
        `gateRules.${index}.resolutionId`,
        120,
      );
    }
    return result;
  });
}

function normalizeStep(input, current = null) {
  const actionType = input.actionType === undefined
    ? current?.action_type || 'form'
    : String(input.actionType);
  if (!ACTION_TYPES.has(actionType)) {
    throw badRequest('VALIDATION_FAILED', 'نوع اقدام مرحله معتبر نیست.', {
      actionType: 'نوع اقدام پشتیبانی نمی‌شود.',
    });
  }
  const formSchema = normalizeFormSchema(
    input.formSchema === undefined
      ? parseJson(current?.form_schema_json || '[]', [])
      : input.formSchema,
  );
  const gateRules = normalizeRules(
    input.gateRules === undefined
      ? parseJson(current?.gate_rules_json || '[]', [])
      : input.gateRules,
    formSchema,
  );
  if (
    actionType === 'task' &&
    !gateRules.some((rule) => rule.type === 'task_status')
  ) {
    throw badRequest('VALIDATION_FAILED', 'مرحلهٔ وظیفه باید حداقل یک قاعدهٔ وظیفه داشته باشد.', {
      gateRules: 'یک وظیفهٔ اجرایی انتخاب کنید.',
    });
  }
  if (
    actionType === 'resolution' &&
    !gateRules.some((rule) => rule.type === 'resolution_approved')
  ) {
    throw badRequest('VALIDATION_FAILED', 'مرحلهٔ مصوبه باید قاعدهٔ تصویب داشته باشد.', {
      gateRules: 'یک مصوبه انتخاب کنید.',
    });
  }
  return {
    title: input.title === undefined
      ? current?.title
      : requiredText(input.title, 'title', 240),
    description: input.description === undefined
      ? current?.description || ''
      : optionalText(input.description, 'description', 3000),
    position: positionValue(input.position, current?.position || 0),
    actionType,
    required: booleanValue(input.required, 'required', current ? Boolean(current.required) : true),
    approvalRequired: booleanValue(
      input.approvalRequired,
      'approvalRequired',
      current ? Boolean(current.approval_required) : false,
    ),
    formSchema,
    gateRules,
  };
}

function mapTemplateStep(row) {
  return {
    id: row.id,
    templateId: row.template_id,
    title: row.title,
    description: row.description,
    position: row.position,
    actionType: row.action_type,
    required: Boolean(row.required),
    approvalRequired: Boolean(row.approval_required),
    formSchema: parseJson(row.form_schema_json, []),
    gateRules: parseJson(row.gate_rules_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTemplate(row, steps = []) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    projectKind: row.project_kind,
    industry: row.industry,
    active: Boolean(row.active),
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    steps,
  };
}

function mapRunStep(row) {
  return {
    id: row.id,
    runId: row.run_id,
    templateStepId: row.template_step_id,
    title: row.title,
    description: row.description,
    position: row.position,
    actionType: row.action_type,
    required: Boolean(row.required),
    approvalRequired: Boolean(row.approval_required),
    status: row.status,
    formSchema: parseJson(row.form_schema_json, []),
    gateRules: parseJson(row.gate_rules_json, []),
    submission: parseJson(row.submission_json, {}),
    evidenceDocumentId: row.evidence_document_id,
    assignedUserId: row.assigned_user_id,
    submittedByUserId: row.submitted_by_user_id,
    submittedAt: row.submitted_at,
    completedByUserId: row.completed_by_user_id,
    completedAt: row.completed_at,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorUserId: row.actor_user_id,
    note: row.note,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function normalizeSubmission(schema, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw badRequest('VALIDATION_FAILED', 'پاسخ فرم معتبر نیست.', {
      values: 'پاسخ‌های فرم را ارسال کنید.',
    });
  }
  const result = {};
  const fields = {};
  for (const definition of schema) {
    const raw = values[definition.key];
    const missing = raw === undefined || raw === null || raw === '';
    if (definition.required && (missing || (definition.type === 'checkbox' && raw !== true))) {
      fields[definition.key] = 'تکمیل این فیلد الزامی است.';
      continue;
    }
    if (missing) {
      result[definition.key] = definition.type === 'checkbox' ? false : null;
      continue;
    }
    if (definition.type === 'checkbox') {
      if (typeof raw !== 'boolean') fields[definition.key] = 'مقدار باید بله یا خیر باشد.';
      else result[definition.key] = raw;
    } else if (definition.type === 'number') {
      const selected = Number(raw);
      if (
        !Number.isFinite(selected) ||
        (definition.min !== null && selected < definition.min) ||
        (definition.max !== null && selected > definition.max)
      ) fields[definition.key] = 'عدد واردشده خارج از محدوده مجاز است.';
      else result[definition.key] = selected;
    } else if (definition.type === 'date') {
      const selected = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || Number.isNaN(Date.parse(`${selected}T00:00:00Z`))) {
        fields[definition.key] = 'تاریخ معتبر وارد کنید.';
      } else result[definition.key] = selected;
    } else if (definition.type === 'select') {
      const selected = String(raw);
      if (!definition.options.includes(selected)) fields[definition.key] = 'یکی از گزینه‌های مجاز را انتخاب کنید.';
      else result[definition.key] = selected;
    } else {
      const selected = String(raw).trim();
      if (selected.length > definition.maxLength) fields[definition.key] = 'متن از حد مجاز طولانی‌تر است.';
      else result[definition.key] = selected;
    }
  }
  if (Object.keys(fields).length) {
    throw badRequest('VALIDATION_FAILED', 'پاسخ‌های فرم را بررسی کنید.', fields);
  }
  return result;
}

export function createReadinessStore(db, { clock = () => new Date(), audit = () => {} } = {}) {
  const now = () => clock().toISOString();

  function requireProject(projectId, { mutable = false } = {}) {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!project || (mutable && project.archived_at)) {
      throw notFound('PROJECT_NOT_FOUND', 'پروژهٔ موردنظر پیدا نشد.');
    }
    return project;
  }

  function requireTemplate(organizationId, templateId, { mutable = false } = {}) {
    const row = db.prepare(`
      SELECT * FROM readiness_templates
      WHERE id=? AND organization_id=?
    `).get(templateId, organizationId);
    if (!row || (mutable && row.archived_at)) {
      throw notFound('READINESS_TEMPLATE_NOT_FOUND', 'قالب فرایند پیدا نشد.');
    }
    return row;
  }

  function templateSteps(templateId) {
    return db.prepare(`
      SELECT * FROM readiness_template_steps
      WHERE template_id=? ORDER BY position,id
    `).all(templateId).map(mapTemplateStep);
  }

  function getTemplate(organizationId, templateId) {
    const row = requireTemplate(organizationId, templateId);
    return { template: mapTemplate(row, templateSteps(templateId)) };
  }

  function listTemplates(organizationId, { includeArchived = false } = {}) {
    const rows = db.prepare(`
      SELECT * FROM readiness_templates
      WHERE organization_id=? ${includeArchived ? '' : 'AND archived_at IS NULL'}
      ORDER BY active DESC, updated_at DESC, id
    `).all(organizationId);
    return { templates: rows.map((row) => mapTemplate(row, templateSteps(row.id))) };
  }

  function createTemplate(organizationId, input, actor = {}) {
    const organization = db.prepare(`
      SELECT id FROM organizations WHERE id=? AND archived_at IS NULL
    `).get(organizationId);
    if (!organization) throw notFound('ORGANIZATION_NOT_FOUND', 'سازمان پیدا نشد.');
    const id = randomUUID();
    const createdAt = now();
    const name = requiredText(input.name, 'name', 200);
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO readiness_templates(
          id,organization_id,name,description,project_kind,industry,active,version,
          created_by_user_id,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        organizationId,
        name,
        optionalText(input.description, 'description', 3000),
        optionalText(input.projectKind, 'projectKind', 120) || null,
        optionalText(input.industry, 'industry', 120) || null,
        booleanValue(input.active, 'active', true) ? 1 : 0,
        1,
        actor.userId || null,
        createdAt,
        createdAt,
      );
      audit({
        organizationId,
        actor,
        action: 'readiness_template.created',
        resourceType: 'readiness_template',
        resourceId: id,
        after: { name },
      });
    });
    return getTemplate(organizationId, id);
  }

  function patchTemplate(organizationId, templateId, input, actor = {}) {
    const current = requireTemplate(organizationId, templateId, { mutable: true });
    const updatedAt = now();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE readiness_templates SET
          name=?,description=?,project_kind=?,industry=?,active=?,version=version+1,updated_at=?
        WHERE id=?
      `).run(
        input.name === undefined ? current.name : requiredText(input.name, 'name', 200),
        input.description === undefined ? current.description : optionalText(input.description, 'description', 3000),
        input.projectKind === undefined ? current.project_kind : optionalText(input.projectKind, 'projectKind', 120) || null,
        input.industry === undefined ? current.industry : optionalText(input.industry, 'industry', 120) || null,
        booleanValue(input.active, 'active', Boolean(current.active)) ? 1 : 0,
        updatedAt,
        templateId,
      );
      audit({
        organizationId,
        actor,
        action: 'readiness_template.updated',
        resourceType: 'readiness_template',
        resourceId: templateId,
        before: mapTemplate(current),
        after: getTemplate(organizationId, templateId).template,
      });
    });
    return getTemplate(organizationId, templateId);
  }

  function archiveTemplate(organizationId, templateId, actor = {}) {
    const current = requireTemplate(organizationId, templateId, { mutable: true });
    const archivedAt = now();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE readiness_templates SET archived_at=?,active=0,version=version+1,updated_at=?
        WHERE id=?
      `).run(archivedAt, archivedAt, templateId);
      audit({
        organizationId,
        actor,
        action: 'readiness_template.archived',
        resourceType: 'readiness_template',
        resourceId: templateId,
        before: mapTemplate(current),
        after: { archivedAt },
      });
    });
    return { id: templateId, archived: true, archivedAt };
  }

  function createTemplateStep(organizationId, templateId, input, actor = {}) {
    const template = requireTemplate(organizationId, templateId, { mutable: true });
    const normalized = normalizeStep(input);
    const id = randomUUID();
    const createdAt = now();
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO readiness_template_steps(
          id,template_id,title,description,position,action_type,required,
          approval_required,form_schema_json,gate_rules_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,templateId,normalized.title,normalized.description,normalized.position,
        normalized.actionType,normalized.required ? 1 : 0,
        normalized.approvalRequired ? 1 : 0,JSON.stringify(normalized.formSchema),
        JSON.stringify(normalized.gateRules),createdAt,createdAt,
      );
      db.prepare(`
        UPDATE readiness_templates SET version=version+1,updated_at=? WHERE id=?
      `).run(createdAt, templateId);
      audit({
        organizationId,
        actor,
        action: 'readiness_template_step.created',
        resourceType: 'readiness_template_step',
        resourceId: id,
        after: normalized,
        metadata: { templateId: template.id },
      });
    });
    return { step: templateSteps(templateId).find((item) => item.id === id) };
  }

  function patchTemplateStep(organizationId, templateId, stepId, input, actor = {}) {
    requireTemplate(organizationId, templateId, { mutable: true });
    const current = db.prepare(`
      SELECT * FROM readiness_template_steps WHERE id=? AND template_id=?
    `).get(stepId, templateId);
    if (!current) throw notFound('READINESS_STEP_NOT_FOUND', 'مرحله پیدا نشد.');
    const normalized = normalizeStep(input, current);
    const updatedAt = now();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE readiness_template_steps SET
          title=?,description=?,position=?,action_type=?,required=?,approval_required=?,
          form_schema_json=?,gate_rules_json=?,updated_at=?
        WHERE id=? AND template_id=?
      `).run(
        normalized.title,normalized.description,normalized.position,normalized.actionType,
        normalized.required ? 1 : 0,normalized.approvalRequired ? 1 : 0,
        JSON.stringify(normalized.formSchema),JSON.stringify(normalized.gateRules),updatedAt,
        stepId,templateId,
      );
      db.prepare(`UPDATE readiness_templates SET version=version+1,updated_at=? WHERE id=?`)
        .run(updatedAt, templateId);
      audit({
        organizationId,
        actor,
        action: 'readiness_template_step.updated',
        resourceType: 'readiness_template_step',
        resourceId: stepId,
        before: mapTemplateStep(current),
        after: normalized,
        metadata: { templateId },
      });
    });
    return { step: templateSteps(templateId).find((item) => item.id === stepId) };
  }

  function deleteTemplateStep(organizationId, templateId, stepId, actor = {}) {
    requireTemplate(organizationId, templateId, { mutable: true });
    const current = db.prepare(`
      SELECT * FROM readiness_template_steps WHERE id=? AND template_id=?
    `).get(stepId, templateId);
    if (!current) throw notFound('READINESS_STEP_NOT_FOUND', 'مرحله پیدا نشد.');
    const updatedAt = now();
    withTransaction(db, () => {
      db.prepare('DELETE FROM readiness_template_steps WHERE id=? AND template_id=?')
        .run(stepId, templateId);
      db.prepare('UPDATE readiness_templates SET version=version+1,updated_at=? WHERE id=?')
        .run(updatedAt, templateId);
      audit({
        organizationId,
        actor,
        action: 'readiness_template_step.deleted',
        resourceType: 'readiness_template_step',
        resourceId: stepId,
        before: mapTemplateStep(current),
        metadata: { templateId },
      });
    });
    return { id: stepId, deleted: true };
  }

  function requireRun(projectId) {
    const run = db.prepare(`
      SELECT * FROM project_readiness_runs WHERE project_id=?
    `).get(projectId);
    if (!run) throw notFound('READINESS_NOT_INITIALIZED', 'فرایند آمادگی این پروژه هنوز آغاز نشده است.');
    return run;
  }

  function participation(projectId) {
    const row = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN EXISTS(
          SELECT 1 FROM proposals p WHERE p.need_id=n.id AND p.status='accepted'
        ) THEN 1 ELSE 0 END) AS committed
      FROM needs n WHERE n.project_id=? AND n.archived_at IS NULL
    `).get(projectId);
    const total = Number(row.total || 0);
    const committed = Number(row.committed || 0);
    return {
      totalNeeds: total,
      committedNeeds: committed,
      percent: total ? (committed / total) * 100 : 0,
      passed: total > 0 && committed === total,
    };
  }

  function evaluateRule(projectId, step, rule) {
    const values = step.submission?.values || {};
    if (rule.type === 'manual_checkbox') {
      const passed = values[rule.fieldKey] === true;
      return { ...rule, passed, message: passed ? 'تأیید شده است.' : 'تأیید دستی انجام نشده است.' };
    }
    if (rule.type === 'form_field') {
      const actual = values[rule.fieldKey];
      let passed = false;
      if (rule.operator === 'eq') passed = actual === rule.value;
      if (rule.operator === 'neq') passed = actual !== rule.value;
      if (rule.operator === 'filled') passed = actual !== null && actual !== undefined && actual !== '';
      if (rule.operator === 'true') passed = actual === true;
      if (rule.operator === 'gte') passed = Number(actual) >= Number(rule.value);
      if (rule.operator === 'lte') passed = Number(actual) <= Number(rule.value);
      if (rule.operator === 'in') passed = Array.isArray(rule.value) && rule.value.includes(actual);
      return { ...rule, passed, actual, message: passed ? 'شرط فرم برقرار است.' : 'شرط فرم برقرار نیست.' };
    }
    if (rule.type === 'document_exists') {
      const documentId = rule.documentId || step.evidenceDocumentId;
      const document = documentId
        ? db.prepare(`
          SELECT id,category FROM documents
          WHERE id=? AND project_id=? AND archived_at IS NULL AND status='active'
            AND current_version_no>0
        `).get(documentId, projectId)
        : null;
      const passed = Boolean(document && (!rule.category || document.category === rule.category));
      return { ...rule, documentId, passed, message: passed ? 'سند معتبر پیوست شده است.' : 'سند معتبر موردنیاز موجود نیست.' };
    }
    if (rule.type === 'task_status') {
      const task = db.prepare(`
        SELECT id,status FROM project_tasks
        WHERE id=? AND project_id=? AND archived_at IS NULL
      `).get(rule.taskId, projectId);
      const passed = Boolean(task && task.status === 'done');
      return { ...rule, actual: task?.status || null, passed, message: passed ? 'وظیفه تکمیل شده است.' : 'وظیفه هنوز تکمیل نشده است.' };
    }
    if (rule.type === 'resolution_approved') {
      const resolution = db.prepare(`
        SELECT r.status,r.result_json
        FROM meeting_resolutions r
        JOIN project_meetings m ON m.id=r.meeting_id
        WHERE r.id=? AND m.project_id=?
      `).get(rule.resolutionId, projectId);
      const result = parseJson(resolution?.result_json || '{}', {});
      const passed = Boolean(
        resolution?.status === 'closed' &&
        result.outcome === 'approved' &&
        (result.quorumMet === true || result.quorum?.quorumMet === true),
      );
      return { ...rule, outcome: result.outcome || null, passed, message: passed ? 'مصوبه با حدنصاب تصویب شده است.' : 'مصوبه هنوز تصویب نهایی نشده است.' };
    }
    return { ...rule, passed: false, message: 'قاعده قابل ارزیابی نیست.' };
  }

  function evaluate(projectId) {
    const project = requireProject(projectId);
    const run = requireRun(projectId);
    const steps = db.prepare(`
      SELECT * FROM project_readiness_steps WHERE run_id=? ORDER BY position,id
    `).all(run.id).map(mapRunStep);
    const participationResult = participation(projectId);
    const evaluatedSteps = steps.map((step) => {
      const rules = step.gateRules.map((rule) => evaluateRule(projectId, step, rule));
      if (step.actionType === 'document' && !step.gateRules.some((rule) => rule.type === 'document_exists')) {
        rules.push(evaluateRule(projectId, step, { type: 'document_exists', label: 'سند شاهد' }));
      }
      const rulesPassed = rules.every((rule) => rule.passed);
      const passed = (!step.required || step.status === 'waived') ||
        (step.status === 'completed' && rulesPassed);
      return { ...step, rules, rulesPassed, passed };
    });
    const requiredSteps = evaluatedSteps.filter((step) => step.required);
    const completedRequiredSteps = requiredSteps.filter((step) => step.passed);
    const participationPassed = !run.participation_required || participationResult.passed;
    const eligibleToOperate =
      participationPassed &&
      requiredSteps.length > 0 &&
      completedRequiredSteps.length === requiredSteps.length;
    let effectiveStatus = run.status;
    if (run.status === 'operating' && !eligibleToOperate) effectiveStatus = 'attention_required';
    else if (!['operating', 'suspended'].includes(run.status)) {
      effectiveStatus = eligibleToOperate ? 'ready' : 'in_progress';
    }
    return {
      project: {
        id: project.id,
        title: project.title,
        kind: project.kind,
        industry: project.industry,
        lifecycle: project.lifecycle,
        stage: project.stage,
      },
      run: {
        id: run.id,
        projectId: run.project_id,
        templateId: run.template_id,
        templateVersion: run.template_version,
        templateName: run.template_name,
        status: run.status,
        effectiveStatus,
        participationRequired: Boolean(run.participation_required),
        startedAt: run.started_at,
        readyAt: run.ready_at,
        operatingAt: run.operating_at,
        suspendedAt: run.suspended_at,
        suspensionNote: run.suspension_note,
        updatedAt: run.updated_at,
      },
      participation: { ...participationResult, required: Boolean(run.participation_required), passed: participationPassed },
      progress: {
        totalRequiredSteps: requiredSteps.length,
        completedRequiredSteps: completedRequiredSteps.length,
        percent: requiredSteps.length ? (completedRequiredSteps.length / requiredSteps.length) * 100 : 0,
      },
      steps: evaluatedSteps,
      eligibleToOperate,
      blockers: [
        ...(!participationPassed ? [{ code: 'PARTICIPATION_INCOMPLETE', message: 'مشارکت همهٔ نیازهای فعال هنوز قطعی نشده است.' }] : []),
        ...requiredSteps.filter((step) => !step.passed).map((step) => ({ code: 'STEP_INCOMPLETE', stepId: step.id, message: `مرحلهٔ «${step.title}» کامل نیست.` })),
        ...(requiredSteps.length ? [] : [{ code: 'NO_REQUIRED_STEPS', message: 'قالب باید حداقل یک مرحلهٔ الزامی داشته باشد.' }]),
      ],
    };
  }

  function appendEvent(runId, eventType, actor, data = {}) {
    db.prepare(`
      INSERT INTO project_readiness_events(
        run_id,step_id,event_type,from_status,to_status,actor_user_id,note,metadata_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      runId,data.stepId || null,eventType,data.fromStatus || null,data.toStatus || null,
      actor.userId || null,data.note || '',JSON.stringify(data.metadata || {}),now(),
    );
  }

  function initialize(projectId, input = {}, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    if (db.prepare('SELECT id FROM project_readiness_runs WHERE project_id=?').get(projectId)) {
      throw conflict('READINESS_ALREADY_INITIALIZED', 'فرایند آمادگی این پروژه قبلاً آغاز شده است.');
    }
    let template;
    if (input.templateId) {
      template = requireTemplate(project.organization_id, input.templateId, { mutable: true });
    } else {
      template = db.prepare(`
        SELECT * FROM readiness_templates
        WHERE organization_id=? AND active=1 AND archived_at IS NULL
          AND (project_kind IS NULL OR project_kind='' OR project_kind=?)
          AND (industry IS NULL OR industry='' OR industry=?)
        ORDER BY
          CASE WHEN project_kind=? THEN 2 ELSE 0 END +
          CASE WHEN industry=? THEN 1 ELSE 0 END DESC,
          updated_at DESC
        LIMIT 1
      `).get(project.organization_id, project.kind, project.industry, project.kind, project.industry);
      if (!template) throw notFound('READINESS_TEMPLATE_NOT_FOUND', 'قالب فعالی متناسب با این پروژه پیدا نشد.');
    }
    const steps = db.prepare(`
      SELECT * FROM readiness_template_steps WHERE template_id=? ORDER BY position,id
    `).all(template.id);
    if (!steps.length) throw conflict('READINESS_TEMPLATE_EMPTY', 'قالب انتخاب‌شده هیچ مرحله‌ای ندارد.');
    const runId = randomUUID();
    const createdAt = now();
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO project_readiness_runs(
          id,project_id,template_id,template_version,template_name,status,
          participation_required,started_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,'in_progress',?,?,?,?)
      `).run(
        runId,projectId,template.id,template.version,template.name,
        booleanValue(input.participationRequired, 'participationRequired', true) ? 1 : 0,
        createdAt,createdAt,createdAt,
      );
      const insert = db.prepare(`
        INSERT INTO project_readiness_steps(
          id,run_id,template_step_id,title,description,position,action_type,required,
          approval_required,status,form_schema_json,gate_rules_json,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)
      `);
      for (const step of steps) {
        insert.run(
          randomUUID(),runId,step.id,step.title,step.description,step.position,
          step.action_type,step.required,step.approval_required,step.form_schema_json,
          step.gate_rules_json,createdAt,
        );
      }
      appendEvent(runId, 'initialized', actor, { metadata: { templateId: template.id, templateVersion: template.version } });
      audit({
        organizationId: project.organization_id,
        projectId,
        actor,
        action: 'project_readiness.initialized',
        resourceType: 'project_readiness_run',
        resourceId: runId,
        after: { templateId: template.id, templateVersion: template.version, stepCount: steps.length },
      });
    });
    return details(projectId);
  }

  function syncStatus(projectId, actor) {
    const result = evaluate(projectId);
    if (['operating', 'suspended'].includes(result.run.status)) return result;
    const next = result.eligibleToOperate ? 'ready' : 'in_progress';
    if (next !== result.run.status) {
      const changedAt = now();
      db.prepare(`
        UPDATE project_readiness_runs SET status=?,ready_at=?,updated_at=? WHERE id=?
      `).run(next, next === 'ready' ? changedAt : null, changedAt, result.run.id);
      if (next === 'ready') appendEvent(result.run.id, 'ready', actor, { fromStatus: result.run.status, toStatus: next });
    }
    return evaluate(projectId);
  }

  function requireRunStep(projectId, stepId) {
    const run = requireRun(projectId);
    const step = db.prepare(`
      SELECT s.* FROM project_readiness_steps s
      WHERE s.id=? AND s.run_id=?
    `).get(stepId, run.id);
    if (!step) throw notFound('READINESS_STEP_NOT_FOUND', 'مرحلهٔ فرایند پیدا نشد.');
    if (run.status === 'operating') {
      throw conflict('READINESS_RUN_LOCKED', 'فرایند فعال یا متوقف‌شده قابل ویرایش نیست.');
    }
    return { run, step };
  }

  function submitStep(projectId, stepId, input, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    const { run, step } = requireRunStep(projectId, stepId);
    const formSchema = parseJson(step.form_schema_json, []);
    const values = normalizeSubmission(formSchema, input.values || {});
    const note = optionalText(input.note, 'note', 3000);
    const evidenceDocumentId = optionalText(input.evidenceDocumentId, 'evidenceDocumentId', 120) || null;
    if (evidenceDocumentId) {
      const document = db.prepare(`
        SELECT id FROM documents WHERE id=? AND project_id=? AND archived_at IS NULL
      `).get(evidenceDocumentId, projectId);
      if (!document) throw badRequest('INVALID_EVIDENCE_DOCUMENT', 'سند شاهد متعلق به این پروژه نیست.');
    }
    const submittedAt = now();
    const nextStatus = step.approval_required ? 'submitted' : 'completed';
    withTransaction(db, () => {
      db.prepare(`
        UPDATE project_readiness_steps SET
          status=?,submission_json=?,evidence_document_id=?,submitted_by_user_id=?,
          submitted_at=?,completed_by_user_id=?,completed_at=?,approved_by_user_id=NULL,
          approved_at=NULL,note=?,updated_at=?
        WHERE id=?
      `).run(
        nextStatus,JSON.stringify({ values }),evidenceDocumentId,actor.userId || null,
        submittedAt,nextStatus === 'completed' ? actor.userId || null : null,
        nextStatus === 'completed' ? submittedAt : null,note,submittedAt,stepId,
      );
      const evaluated = evaluate(projectId).steps.find((item) => item.id === stepId);
      if (!evaluated.rulesPassed) {
        throw conflict('READINESS_RULES_FAILED', 'شرایط مرحله هنوز برقرار نشده است.', {
          rules: evaluated.rules.filter((rule) => !rule.passed).map((rule) => rule.message),
        });
      }
      appendEvent(run.id, nextStatus === 'completed' ? 'completed' : 'submitted', actor, {
        stepId,fromStatus: step.status,toStatus: nextStatus,note,
      });
      audit({
        organizationId: project.organization_id,projectId,actor,
        action: `project_readiness_step.${nextStatus}`,
        resourceType: 'project_readiness_step',resourceId: stepId,
        before: { status: step.status },after: { status: nextStatus },
      });
    });
    syncStatus(projectId, actor);
    return details(projectId);
  }

  function approveStep(projectId, stepId, input = {}, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    const { run, step } = requireRunStep(projectId, stepId);
    if (!step.approval_required || step.status !== 'submitted') {
      throw conflict('READINESS_STEP_NOT_AWAITING_APPROVAL', 'این مرحله در انتظار تأیید نیست.');
    }
    const currentEvaluation = evaluate(projectId).steps.find((item) => item.id === stepId);
    if (!currentEvaluation.rulesPassed) {
      throw conflict('READINESS_RULES_FAILED', 'شرایط مرحله هنوز برقرار نشده است.', {
        rules: currentEvaluation.rules.filter((rule) => !rule.passed).map((rule) => rule.message),
      });
    }
    const approvedAt = now();
    const note = optionalText(input.note, 'note', 3000) || step.note;
    withTransaction(db, () => {
      db.prepare(`
        UPDATE project_readiness_steps SET status='completed',completed_by_user_id=?,
          completed_at=?,approved_by_user_id=?,approved_at=?,note=?,updated_at=? WHERE id=?
      `).run(actor.userId || null,approvedAt,actor.userId || null,approvedAt,note,approvedAt,stepId);
      appendEvent(run.id, 'approved', actor, { stepId,fromStatus: step.status,toStatus: 'completed',note });
      audit({
        organizationId: project.organization_id,projectId,actor,
        action: 'project_readiness_step.approved',resourceType: 'project_readiness_step',
        resourceId: stepId,before: { status: step.status },after: { status: 'completed' },
      });
    });
    syncStatus(projectId, actor);
    return details(projectId);
  }

  function reopenStep(projectId, stepId, input = {}, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    const { run, step } = requireRunStep(projectId, stepId);
    if (!['completed', 'submitted', 'blocked', 'waived'].includes(step.status)) {
      throw conflict('READINESS_STEP_NOT_REOPENABLE', 'این مرحله قابل بازگشایی نیست.');
    }
    const changedAt = now();
    const note = requiredText(input.note, 'note', 3000);
    withTransaction(db, () => {
      db.prepare(`
        UPDATE project_readiness_steps SET status='in_progress',completed_by_user_id=NULL,
          completed_at=NULL,approved_by_user_id=NULL,approved_at=NULL,note=?,updated_at=? WHERE id=?
      `).run(note, changedAt, stepId);
      appendEvent(run.id, 'reopened', actor, { stepId,fromStatus: step.status,toStatus: 'in_progress',note });
      audit({
        organizationId: project.organization_id,projectId,actor,
        action: 'project_readiness_step.reopened',resourceType: 'project_readiness_step',
        resourceId: stepId,before: { status: step.status },after: { status: 'in_progress', note },
      });
    });
    syncStatus(projectId, actor);
    return details(projectId);
  }

  function activate(projectId, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    const result = evaluate(projectId);
    if (result.run.status === 'operating') return details(projectId);
    if (!result.eligibleToOperate) {
      appendEvent(result.run.id, 'evaluation_failed', actor, { metadata: { blockers: result.blockers } });
      throw conflict('PROJECT_NOT_READY_TO_OPERATE', 'همهٔ شروط بهره‌برداری برقرار نشده است.', {
        blockers: result.blockers.map((blocker) => blocker.message),
      });
    }
    const activatedAt = now();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE project_readiness_runs SET status='operating',ready_at=COALESCE(ready_at,?),
          operating_at=?,activated_by_user_id=?,suspended_at=NULL,suspension_note='',updated_at=?
        WHERE id=?
      `).run(activatedAt,activatedAt,actor.userId || null,activatedAt,result.run.id);
      db.prepare(`
        UPDATE projects SET lifecycle='operating',stage='operating',updated_at=? WHERE id=?
      `).run(activatedAt, projectId);
      appendEvent(result.run.id, 'activated', actor, { fromStatus: result.run.status,toStatus: 'operating' });
      audit({
        organizationId: project.organization_id,projectId,actor,
        action: 'project_readiness.activated',resourceType: 'project_readiness_run',
        resourceId: result.run.id,before: { lifecycle: project.lifecycle, status: result.run.status },
        after: { lifecycle: 'operating', status: 'operating' },
      });
    });
    return details(projectId);
  }

  function suspend(projectId, input, actor = {}) {
    const project = requireProject(projectId, { mutable: true });
    const run = requireRun(projectId);
    if (run.status !== 'operating') {
      throw conflict('PROJECT_NOT_OPERATING', 'پروژه در وضعیت بهره‌برداری نیست.');
    }
    const note = requiredText(input.note, 'note', 3000);
    const suspendedAt = now();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE project_readiness_runs SET status='suspended',suspended_at=?,
          suspended_by_user_id=?,suspension_note=?,updated_at=? WHERE id=?
      `).run(suspendedAt,actor.userId || null,note,suspendedAt,run.id);
      db.prepare(`
        UPDATE projects SET lifecycle='paused',stage='on_hold',updated_at=? WHERE id=?
      `).run(suspendedAt, projectId);
      appendEvent(run.id, 'suspended', actor, { fromStatus: run.status,toStatus: 'suspended',note });
      audit({
        organizationId: project.organization_id,projectId,actor,
        action: 'project_readiness.suspended',resourceType: 'project_readiness_run',
        resourceId: run.id,before: { lifecycle: project.lifecycle, status: run.status },
        after: { lifecycle: 'paused', status: 'suspended', note },
      });
    });
    return details(projectId);
  }

  function details(projectId) {
    const evaluation = evaluate(projectId);
    const events = db.prepare(`
      SELECT * FROM project_readiness_events WHERE run_id=?
      ORDER BY created_at DESC,id DESC LIMIT 200
    `).all(evaluation.run.id).map(mapEvent);
    return { ...evaluation, events };
  }

  function projectSummary(projectId) {
    const run = db.prepare(`SELECT id FROM project_readiness_runs WHERE project_id=?`).get(projectId);
    if (!run) return { initialized: false, status: 'not_started', eligibleToOperate: false };
    const result = evaluate(projectId);
    return {
      initialized: true,
      status: result.run.effectiveStatus,
      templateName: result.run.templateName,
      eligibleToOperate: result.eligibleToOperate,
      participationPercent: result.participation.percent,
      stepsPercent: result.progress.percent,
      completedRequiredSteps: result.progress.completedRequiredSteps,
      totalRequiredSteps: result.progress.totalRequiredSteps,
      operatingAt: result.run.operatingAt,
      updatedAt: result.run.updatedAt,
    };
  }

  return Object.freeze({
    listTemplates,getTemplate,createTemplate,patchTemplate,archiveTemplate,
    createTemplateStep,patchTemplateStep,deleteTemplateStep,
    initialize,details,submitStep,approveStep,reopenStep,activate,suspend,
    evaluate,projectSummary,
  });
}

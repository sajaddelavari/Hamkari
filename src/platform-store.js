import { randomUUID } from 'node:crypto';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { withTransaction } from './database.js';
import { syncLegacyFinance } from './enterprise-schema.js';
import { hashToken, normalizeIranMobile } from './security.js';

const PROJECT_STATUSES = new Set(['draft', 'published']);
const PROJECT_VISIBILITIES = new Set(['public', 'unlisted', 'private']);
const PROJECT_LIFECYCLES = new Set([
  'idea',
  'planning',
  'fundraising',
  'executing',
  'operating',
  'completed',
  'paused',
  'cancelled',
]);
const PROJECT_STAGES = new Set([
  'idea',
  'feasibility',
  'fundraising',
  'pilot',
  'execution',
  'construction',
  'operating',
  'on_hold',
  'completed',
]);
const STAKEHOLDER_KINDS = new Set(['person', 'organization']);
const STAKEHOLDER_ROLES = new Set(['owner', 'board', 'manager', 'investor', 'partner']);
const TRANSFER_STATUSES = new Set(['draft', 'pending', 'approved', 'rejected', 'cancelled']);
const FINANCIAL_TYPES = new Set([
  'revenue',
  'expense',
  'investment',
  'distribution',
  'valuation',
]);
const GOAL_STATUSES = new Set(['planned', 'active', 'completed', 'cancelled']);
const MEETING_STATUSES = new Set(['scheduled', 'held', 'cancelled']);
const RESOLUTION_STATUSES = new Set(['draft', 'open', 'closed']);
const VOTE_CHOICES = new Set(['yes', 'no', 'abstain']);
const RESOLUTION_OPERATION_TYPES = new Set([
  'corporate_action',
  'share_transfer',
]);
const CORPORATE_RESOLUTION_ACTION_TYPES = new Set([
  'issuance',
  'capital_increase',
  'split',
  'reverse_split',
  'conversion',
  'buyback',
  'cancellation',
  'rights_issue',
]);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_PRACTICAL_WEIGHT = 1_000_000;
const TEHRAN_DATE_FORMATTER = new Intl.DateTimeFormat(
  'en-US-u-ca-gregory-nu-latn',
  {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  },
);

function nowIso(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function tehranCalendarDate(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(
    TEHRAN_DATE_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function text(value, field, { required = false, min = 1, max = 10_000 } = {}) {
  const result = String(value ?? '').trim();
  if ((required && result.length < min) || result.length > max) {
    throw badRequest('VALIDATION_FAILED', 'اطلاعات واردشده معتبر نیست.', {
      [field]: required
        ? `این فیلد باید حداقل ${min} نویسه باشد.`
        : `این فیلد نباید بیشتر از ${max} نویسه باشد.`,
    });
  }
  return result;
}

function nullableText(value, field, max = 10_000) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return text(value, field, { max });
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function optionalMobile(value) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  const normalized = normalizeIranMobile(value);
  if (!normalized) {
    throw badRequest('VALIDATION_FAILED', 'شماره موبایل معتبر نیست.', {
      mobile: 'شماره موبایل ایران را با قالب درست وارد کنید.',
    });
  }
  return normalized;
}

function optionalEmail(value) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  const email = String(value).trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  ) {
    throw badRequest('VALIDATION_FAILED', 'نشانی ایمیل معتبر نیست.', {
      email: 'یک نشانی ایمیل معتبر وارد کنید.',
    });
  }
  return email;
}

function enumValue(value, allowed, field, fallback) {
  const result = value === undefined ? fallback : value;
  if (!allowed.has(result)) {
    throw badRequest('VALIDATION_FAILED', 'اطلاعات واردشده معتبر نیست.', {
      [field]: 'مقدار انتخاب‌شده معتبر نیست.',
    });
  }
  return result;
}

function integer(
  value,
  field,
  { minimum = 0, allowNull = false, fallback } = {},
) {
  const selected = value === undefined ? fallback : value;
  if (allowNull && (selected === null || selected === '')) return null;
  const result = Number(selected);
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw badRequest('VALIDATION_FAILED', 'اطلاعات واردشده معتبر نیست.', {
      [field]: `یک عدد صحیح حداقل ${minimum} وارد کنید.`,
    });
  }
  return result;
}

function positiveNumber(value, field, fallback) {
  const result = Number(value === undefined ? fallback : value);
  if (
    !Number.isFinite(result) ||
    result <= 0 ||
    result > MAX_PRACTICAL_WEIGHT
  ) {
    throw badRequest('VALIDATION_FAILED', 'اطلاعات واردشده معتبر نیست.', {
      [field]: `یک عدد بزرگ‌تر از صفر و حداکثر ${MAX_PRACTICAL_WEIGHT} وارد کنید.`,
    });
  }
  return result;
}

function votingWeightValue(value, fallback = 1) {
  const result = Number(value === undefined ? fallback : value);
  if (
    !Number.isFinite(result) ||
    result < 0 ||
    result > MAX_PRACTICAL_WEIGHT
  ) {
    throw badRequest('VALIDATION_FAILED', 'وزن رأی معتبر نیست.', {
      votingWeight: `وزن رأی باید بین صفر و ${MAX_PRACTICAL_WEIGHT} باشد.`,
    });
  }
  return result;
}

function booleanValue(value, field, fallback = false) {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== 'boolean') {
    throw badRequest('VALIDATION_FAILED', 'مقدار بله/خیر معتبر نیست.', {
      [field]: 'مقدار باید boolean واقعی باشد.',
    });
  }
  return selected;
}

function booleanInteger(value, fallback = false, field = 'publicVisible') {
  return booleanValue(value, field, fallback) ? 1 : 0;
}

function dateValidationError(field, type = 'date') {
  throw badRequest(
    'VALIDATION_FAILED',
    'اطلاعات واردشده معتبر نیست.',
    {
      [field]: type === 'datetime'
        ? 'زمان باید یک ISO 8601 datetime معتبر همراه با منطقهٔ زمانی باشد.'
        : 'تاریخ باید با قالب YYYY-MM-DD و یک روز تقویمی معتبر باشد.',
    },
  );
}

function isoDate(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) dateValidationError(field);
    return null;
  }
  if (typeof value !== 'string') dateValidationError(field);
  const selected = value.trim();
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(selected);
  if (!match) dateValidationError(field);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (day < 1 || day > daysInMonth) dateValidationError(field);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function optionalIsoDate(value, field) {
  if (value === undefined) return undefined;
  return isoDate(value, field);
}

function isoDateTime(value, field) {
  if (typeof value !== 'string') dateValidationError(field, 'datetime');
  const selected = value.trim();
  const match = /^([1-9]\d{3}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    selected,
  );
  if (!match) dateValidationError(field, 'datetime');
  isoDate(match[1], field, { required: true });
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offset = match[6];
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (
      offset !== 'Z' &&
      (
        Number(offset.slice(1, 3)) > 23 ||
        Number(offset.slice(4, 6)) > 59
      )
    )
  ) {
    dateValidationError(field, 'datetime');
  }
  const timestamp = Date.parse(selected);
  if (!Number.isFinite(timestamp)) dateValidationError(field, 'datetime');
  return new Date(timestamp).toISOString();
}

function slugValue(value) {
  const slug = text(value, 'slug', { required: true, max: 100 }).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw badRequest('VALIDATION_FAILED', 'نشانی پروژه معتبر نیست.', {
      slug: 'فقط حروف انگلیسی کوچک، عدد و خط تیره مجاز است.',
    });
  }
  if (slug === 'current') {
    throw badRequest('VALIDATION_FAILED', 'این نشانی برای مسیر سیستمی رزرو شده است.', {
      slug: 'نشانی current قابل استفاده برای پروژه نیست.',
    });
  }
  return slug;
}

function safeIntegerAdd(left, right) {
  if (
    left === null ||
    right === null ||
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right)
  ) {
    return null;
  }
  const result = BigInt(left) + BigInt(right);
  if (
    result > MAX_SAFE_INTEGER_BIGINT ||
    result < -MAX_SAFE_INTEGER_BIGINT
  ) {
    return null;
  }
  return Number(result);
}

function safeBigIntToNumber(value) {
  if (
    value > MAX_SAFE_INTEGER_BIGINT ||
    value < -MAX_SAFE_INTEGER_BIGINT
  ) {
    return null;
  }
  return Number(value);
}

function currencyValue(value, fallback = 'IRR') {
  const currency = text(value ?? fallback, 'currency', {
    required: true,
    max: 3,
  }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw badRequest('VALIDATION_FAILED', 'واحد پول معتبر نیست.', {
      currency: 'کد سه‌حرفی استاندارد مانند IRR وارد کنید.',
    });
  }
  return currency;
}

function canonicalOperationScope({
  operationType,
  actionType,
  projectId,
  shareClassId = null,
  fromStakeholderId = null,
  toStakeholderId = null,
  stakeholderId = null,
  destinationShareClassId = null,
  units = null,
  amount = null,
  currency = null,
  ratioNumerator = null,
  ratioDenominator = null,
  recordDate = null,
  effectiveDate = null,
}) {
  return {
    version: 1,
    operationType,
    actionType,
    projectId,
    shareClassId,
    fromStakeholderId,
    toStakeholderId,
    stakeholderId,
    destinationShareClassId,
    units,
    amount,
    currency,
    ratioNumerator,
    ratioDenominator,
    recordDate,
    effectiveDate,
  };
}

function mapProject(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    code: row.code,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    industry: row.industry,
    sector: row.sector,
    kind: row.kind,
    stage: row.stage,
    currency: row.currency,
    budgetAmount: row.budget_amount,
    valuationAmount: row.valuation_amount,
    location: row.location,
    timeline: row.timeline,
    startDate: row.start_date,
    targetDate: row.target_date || null,
    leaderName: row.leader_name,
    leaderDescription: row.leader_description,
    processDescription: row.process_description,
    status: row.status,
    visibility: row.visibility,
    lifecycle: row.lifecycle,
    plannedEndDate: row.planned_end_date,
    actualEndDate: row.actual_end_date,
    ownerUserId: row.owner_user_id,
    published: row.status === 'published',
    isDefault: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapStakeholder(row) {
  return {
    id: row.id,
    userId: row.user_id || null,
    name: row.name,
    kind: row.kind,
    role: row.role,
    mobile: row.mobile,
    email: row.email,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapShareClass(row) {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    authorizedUnits: Number(row.authorized_units),
    votingWeight: Number(row.voting_weight),
    createdAt: row.created_at,
  };
}

function mapTransfer(row) {
  return {
    id: row.id,
    shareClassId: row.share_class_id,
    offerId: row.offer_id,
    fromStakeholderId: row.from_stakeholder_id,
    toStakeholderId: row.to_stakeholder_id,
    units: Number(row.units),
    priceAmount: row.price_amount,
    status: row.status,
    note: row.note,
    decisionNote: row.decision_note,
    resolutionId: row.resolution_id || null,
    contractId: row.contract_id || null,
    paymentIntentId: row.payment_intent_id || null,
    createdByUserId: row.created_by_user_id || null,
    approvedByUserId: row.approved_by_user_id || null,
    approvedAt: row.approved_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

function mapOffer(row) {
  return {
    id: row.id,
    shareClassId: row.share_class_id,
    side: row.side,
    sellerStakeholderId: row.seller_stakeholder_id,
    buyerStakeholderId: row.buyer_stakeholder_id,
    units: Number(row.units),
    remainingUnits: Number(row.remaining_units),
    unitPrice: Number(row.unit_price),
    availableUntil: row.available_until,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFinancial(row) {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    occurredOn: row.occurred_on,
    description: row.description,
    stakeholderId: row.stakeholder_id,
    reversalOfEntryId: row.reversal_of_entry_id,
    isReversal: Boolean(row.reversal_of_entry_id),
    createdAt: row.created_at,
  };
}

export function createPlatformStore(
  db,
  {
    clock = () => new Date(),
    audit: enterpriseAudit = null,
    operationsStore = null,
    financeStore = null,
  } = {},
) {
  function requireProject(id, { publicOnly = false, includeArchived = false } = {}) {
    const row = db.prepare(`
      SELECT *
      FROM projects
      WHERE id=?
        ${includeArchived ? '' : 'AND archived_at IS NULL'}
        ${publicOnly ? "AND status='published' AND visibility<>'private'" : ''}
    `).get(id);
    if (!row) {
      throw notFound('PROJECT_NOT_FOUND', 'پروژه موردنظر پیدا نشد.');
    }
    return row;
  }

  function audit(projectId, resourceType, resourceId, action, details = {}) {
    const createdAt = nowIso(clock);
    const project = db.prepare(`
      SELECT organization_id FROM projects WHERE id=?
    `).get(projectId);
    db.prepare(`
      INSERT INTO audit_events(
        project_id, resource_type, resource_id, action, actor_type,
        details_json, created_at
      ) VALUES(?,?,?,?, 'admin', ?,?)
    `).run(
      projectId,
      resourceType,
      resourceId,
      action,
      JSON.stringify(details),
      createdAt,
    );
    if (typeof enterpriseAudit === 'function') {
      enterpriseAudit({
        organizationId: project?.organization_id || null,
        projectId,
        action: `legacy.${resourceType}.${action}`,
        resourceType,
        resourceId,
        metadata: details,
        createdAt,
      });
    }
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(createdAt, projectId);
  }

  function operationRequestHash(value) {
    return hashToken(JSON.stringify(value));
  }

  function normalizeResolutionOperationScope(project, value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'دامنهٔ عملیاتی مصوبه باید یک شیء معتبر باشد.',
        { operationScope: 'یک شیء JSON معتبر ارسال کنید.' },
      );
    }
    const operationType = enumValue(
      value.operationType,
      RESOLUTION_OPERATION_TYPES,
      'operationScope.operationType',
    );
    const actionType = operationType === 'share_transfer'
      ? 'share_transfer'
      : enumValue(
        value.actionType,
        CORPORATE_RESOLUTION_ACTION_TYPES,
        'operationScope.actionType',
      );
    if (value.projectId && String(value.projectId) !== project.id) {
      throw badRequest(
        'RESOLUTION_SCOPE_PROJECT_MISMATCH',
        'دامنهٔ مصوبه باید به همان پروژه تعلق داشته باشد.',
      );
    }
    const optionalId = (field) => (
      nullableText(value[field], `operationScope.${field}`, 200) ?? null
    );
    const requiredId = (field) => {
      const selected = optionalId(field);
      if (!selected) {
        throw badRequest(
          'VALIDATION_FAILED',
          'دامنهٔ مصوبه ناقص است.',
          { [`operationScope.${field}`]: 'این فیلد الزامی است.' },
        );
      }
      return selected;
    };
    const shareClassId = requiredId('shareClassId');
    ensureProjectReference(
      project.id,
      'share_classes',
      shareClassId,
      'INVALID_REFERENCE',
      'ردهٔ سهام دامنهٔ مصوبه به همان پروژه تعلق ندارد.',
    );
    const units = integer(value.units, 'operationScope.units', {
      minimum: 1,
      allowNull: true,
      fallback: null,
    });
    const amount = integer(value.amount, 'operationScope.amount', {
      minimum: 0,
      allowNull: true,
      fallback: null,
    });
    const scope = canonicalOperationScope({
      operationType,
      actionType,
      projectId: project.id,
      shareClassId,
      fromStakeholderId: operationType === 'share_transfer'
        ? requiredId('fromStakeholderId')
        : null,
      toStakeholderId: operationType === 'share_transfer'
        ? requiredId('toStakeholderId')
        : null,
      stakeholderId: operationType === 'corporate_action'
        ? optionalId('stakeholderId')
        : null,
      destinationShareClassId: operationType === 'corporate_action'
        ? optionalId('destinationShareClassId')
        : null,
      units,
      amount,
      currency: currencyValue(value.currency, project.currency),
      ratioNumerator: integer(
        value.ratioNumerator,
        'operationScope.ratioNumerator',
        { minimum: 1, allowNull: true, fallback: null },
      ),
      ratioDenominator: integer(
        value.ratioDenominator,
        'operationScope.ratioDenominator',
        { minimum: 1, allowNull: true, fallback: null },
      ),
      recordDate: optionalIsoDate(
        value.recordDate,
        'operationScope.recordDate',
      ) ?? null,
      effectiveDate: optionalIsoDate(
        value.effectiveDate,
        'operationScope.effectiveDate',
      ) ?? null,
    });
    if (
      operationType === 'share_transfer' &&
      (
        scope.units === null ||
        scope.fromStakeholderId === scope.toStakeholderId
      )
    ) {
      throw badRequest(
        'VALIDATION_FAILED',
        'دامنهٔ انتقال سهام معتبر نیست.',
      );
    }
    if (scope.currency !== project.currency) {
      throw conflict(
        'PROJECT_CURRENCY_MISMATCH',
        'ارز دامنهٔ مصوبه باید با ارز پروژه یکسان باشد.',
      );
    }
    return {
      operationType,
      scope,
      requestHash: operationRequestHash(scope),
    };
  }

  function shareTransferOperationScope(project, transfer) {
    return canonicalOperationScope({
      operationType: 'share_transfer',
      actionType: 'share_transfer',
      projectId: project.id,
      shareClassId: transfer.share_class_id,
      fromStakeholderId: transfer.from_stakeholder_id,
      toStakeholderId: transfer.to_stakeholder_id,
      units: Number(transfer.units),
      amount: transfer.price_amount === null
        ? null
        : Number(transfer.price_amount),
      currency: project.currency,
    });
  }

  function replayOperationReceipt(scope, projectId, keyHash, requestHash) {
    const receipt = db.prepare(`
      SELECT request_hash, response_json
      FROM operation_receipts
      WHERE scope=? AND project_id=? AND idempotency_key_hash=?
    `).get(scope, projectId, keyHash);
    if (!receipt) return null;
    if (receipt.request_hash !== requestHash) {
      throw conflict(
        'IDEMPOTENCY_CONFLICT',
        'این کلید قبلاً برای درخواست متفاوتی استفاده شده است.',
      );
    }
    return {
      ...JSON.parse(receipt.response_json),
      idempotentReplay: true,
    };
  }

  function saveOperationReceipt(
    scope,
    projectId,
    keyHash,
    requestHash,
    resourceId,
    response,
  ) {
    db.prepare(`
      INSERT INTO operation_receipts(
        scope, project_id, idempotency_key_hash, request_hash,
        resource_id, response_json, created_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      scope,
      projectId,
      keyHash,
      requestHash,
      resourceId,
      JSON.stringify(response),
      nowIso(clock),
    );
  }

  function assertFinancialDerivedCapacity(projectId, candidate) {
    const totals = new Map();
    const rows = db.prepare(`
      SELECT type, amount, reversal_of_entry_id
      FROM financial_entries
      WHERE project_id=?
    `).all(projectId);
    for (const row of rows) {
      const amount = Number(row.amount);
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw conflict(
          'FINANCIAL_AGGREGATE_INVALID',
          'جمع مالی موجود پروژه خارج از محدودهٔ عددی امن است.',
        );
      }
      const signedAmount = row.reversal_of_entry_id
        ? -BigInt(amount)
        : BigInt(amount);
      totals.set(row.type, (totals.get(row.type) || 0n) + signedAmount);
    }
    const candidateAmount = BigInt(candidate.amount) *
      (candidate.isReversal ? -1n : 1n);
    totals.set(
      candidate.type,
      (totals.get(candidate.type) || 0n) + candidateAmount,
    );
    const revenue = totals.get('revenue') || 0n;
    const expense = totals.get('expense') || 0n;
    const investment = totals.get('investment') || 0n;
    const distribution = totals.get('distribution') || 0n;
    const derived = [
      ...totals.values(),
      revenue - expense,
      revenue + investment - expense - distribution,
    ];
    if (derived.some((value) => safeBigIntToNumber(value) === null)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'ثبت این مبلغ یکی از جمع‌های مالی پروژه را از محدودهٔ عددی امن خارج می‌کند.',
        {
          amount: 'جمع‌ها و شاخص‌های مالی پروژه باید در محدودهٔ عدد صحیح امن بمانند.',
        },
      );
    }
  }

  function capitalRangeError(field) {
    if (field) {
      throw badRequest(
        'VALIDATION_FAILED',
        'این تغییر جمع سرمایه یا قدرت رأی پروژه را از محدودهٔ عددی امن خارج می‌کند.',
        {
          [field]: 'جمع واحدها و قدرت رأی پروژه باید در محدودهٔ عددی امن باقی بماند.',
        },
      );
    }
    throw conflict(
      'CAPITAL_AGGREGATE_INVALID',
      'جمع سرمایه یا قدرت رأی ثبت‌شدهٔ پروژه خارج از محدودهٔ عددی امن است.',
    );
  }

  function readCapitalState(projectId) {
    const classes = db.prepare(`
      SELECT id, name, symbol, authorized_units, voting_weight, created_at
      FROM share_classes
      WHERE project_id=?
      ORDER BY created_at, id
    `).all(projectId);
    const stakeholders = db.prepare(`
      SELECT id, name
      FROM project_stakeholders
      WHERE project_id=?
    `).all(projectId);
    const classById = new Map(classes.map((row) => [row.id, row]));
    const stakeholderById = new Map(stakeholders.map((row) => [row.id, row]));
    const classUnits = new Map(classes.map((row) => [row.id, 0n]));
    const holdingUnits = new Map();
    const ledgerRows = db.prepare(`
      SELECT share_class_id, stakeholder_id, units
      FROM share_ledger
      WHERE project_id=?
      ORDER BY created_at, id
    `).all(projectId);
    for (const row of ledgerRows) {
      const units = Number(row.units);
      if (
        !Number.isSafeInteger(units) ||
        !classById.has(row.share_class_id) ||
        !stakeholderById.has(row.stakeholder_id)
      ) {
        capitalRangeError();
      }
      const delta = BigInt(units);
      classUnits.set(
        row.share_class_id,
        classUnits.get(row.share_class_id) + delta,
      );
      const key = `${row.stakeholder_id}\u0000${row.share_class_id}`;
      holdingUnits.set(key, (holdingUnits.get(key) || 0n) + delta);
    }
    return {
      classes,
      classById,
      stakeholderById,
      classUnits,
      holdingUnits,
    };
  }

  function assertCapitalBounds(state, field) {
    let totalUnits = 0n;
    let totalVotingPower = 0;
    const votingPowerByStakeholder = new Map();
    for (const shareClass of state.classes) {
      const authorizedUnits = Number(shareClass.authorized_units);
      const votingWeight = Number(shareClass.voting_weight);
      const issuedUnits = state.classUnits.get(shareClass.id) || 0n;
      if (
        !Number.isSafeInteger(authorizedUnits) ||
        authorizedUnits <= 0 ||
        !Number.isFinite(votingWeight) ||
        votingWeight < 0 ||
        votingWeight > MAX_PRACTICAL_WEIGHT ||
        issuedUnits < 0n ||
        issuedUnits > BigInt(authorizedUnits)
      ) {
        capitalRangeError(field);
      }
      totalUnits += issuedUnits;
      const issuedNumber = safeBigIntToNumber(issuedUnits);
      if (issuedNumber === null) capitalRangeError(field);
      const classVotingPower = issuedNumber * votingWeight;
      const nextVotingPower = totalVotingPower + classVotingPower;
      if (
        !Number.isFinite(classVotingPower) ||
        classVotingPower > Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(nextVotingPower) ||
        nextVotingPower > Number.MAX_SAFE_INTEGER
      ) {
        capitalRangeError(field);
      }
      totalVotingPower = nextVotingPower;
    }
    if (safeBigIntToNumber(totalUnits) === null) capitalRangeError(field);

    for (const [key, unitsValue] of state.holdingUnits) {
      const separator = key.indexOf('\u0000');
      const stakeholderId = key.slice(0, separator);
      const shareClassId = key.slice(separator + 1);
      const shareClass = state.classById.get(shareClassId);
      const units = safeBigIntToNumber(unitsValue);
      if (!shareClass || units === null || units < 0) capitalRangeError(field);
      const votingPower = units * Number(shareClass.voting_weight);
      const nextPower =
        (votingPowerByStakeholder.get(stakeholderId) || 0) + votingPower;
      if (
        !Number.isFinite(votingPower) ||
        votingPower > Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(nextPower) ||
        nextPower > Number.MAX_SAFE_INTEGER
      ) {
        capitalRangeError(field);
      }
      votingPowerByStakeholder.set(stakeholderId, nextPower);
    }
    return {
      totalUnits: Number(totalUnits),
      totalVotingPower,
      votingPowerByStakeholder,
    };
  }

  function holdingUnits(state, stakeholderId, shareClassId) {
    const key = `${stakeholderId}\u0000${shareClassId}`;
    return safeBigIntToNumber(state.holdingUnits.get(key) || 0n);
  }

  function assertWeightAggregateCapacity(table, parentColumn, parentId, id, weight) {
    const rows = db.prepare(`
      SELECT id, weight
      FROM ${table}
      WHERE ${parentColumn}=?
    `).all(parentId);
    let total = weight;
    for (const row of rows) {
      if (row.id !== id) total += Number(row.weight);
    }
    if (
      !Number.isFinite(total) ||
      total > MAX_PRACTICAL_WEIGHT
    ) {
      throw badRequest(
        'VALIDATION_FAILED',
        'جمع وزن‌ها معتبر نیست.',
        {
          weight: `جمع وزن‌ها نباید بیشتر از ${MAX_PRACTICAL_WEIGHT} باشد.`,
        },
      );
    }
  }

  function ensureProjectReference(projectId, table, id, code, message) {
    const row = db.prepare(
      `SELECT * FROM ${table} WHERE id=? AND project_id=?`,
    ).get(id, projectId);
    if (!row) throw badRequest(code, message);
    return row;
  }

  function ensureActiveStakeholder(projectId, id, message) {
    const row = db.prepare(`
      SELECT *
      FROM project_stakeholders
      WHERE id=? AND project_id=? AND archived_at IS NULL
    `).get(id, projectId);
    if (!row) {
      throw badRequest(
        'INVALID_STAKEHOLDER',
        message || 'عضو فعال متعلق به این پروژه نیست.',
      );
    }
    return row;
  }

  function assertVotingRecordDateUnlocked(projectId) {
    const openResolution = db.prepare(`
      SELECT r.id
      FROM meeting_resolutions r
      JOIN project_meetings m ON m.id=r.meeting_id
      WHERE m.project_id=? AND r.status='open'
      ORDER BY r.created_at, r.id
      LIMIT 1
    `).get(projectId);
    if (openResolution) {
      throw conflict(
        'VOTING_RECORD_DATE_LOCKED',
        'تا زمان بسته‌شدن مصوبه‌های باز، عرضه و مالکیت سهام و وزن رأی پروژه ثابت می‌ماند.',
      );
    }
  }

  function getProject(id, options) {
    return { project: mapProject(requireProject(id, options)) };
  }

  function portfolioMetricMap(projectIds, { publicOnly = false } = {}) {
    const result = new Map(projectIds.map((id) => [id, {
      financial: {
        revenue: 0,
        expense: 0,
        investedCapital: 0,
        investment: 0,
        distribution: 0,
        netProfit: 0,
        margin: 0,
        roi: null,
        marginPercent: 0,
        roiPercent: null,
        netCash: 0,
        overflow: false,
      },
      capital: { totalIssuedUnits: 0, classCount: 0 },
      goals: { count: 0, completedCount: 0, goalProgressPercent: 0 },
      participation: {
        totalNeeds: 0,
        committedNeeds: 0,
        participationCompletionPercent: 0,
      },
      governance: { meetings: 0, openResolutions: 0 },
      counts: { needs: 0, goals: 0, meetings: 0, openShareOffers: 0 },
    }]));
    if (!projectIds.length) return result;
    const placeholders = projectIds.map(() => '?').join(',');

    const financialRows = db.prepare(`
      SELECT project_id, type, amount, reversal_of_entry_id
      FROM financial_entries
      WHERE project_id IN (${placeholders})
    `).all(...projectIds);
    const financialTotals = new Map();
    for (const row of financialRows) {
      const key = `${row.project_id}\u0000${row.type}`;
      const signedAmount = row.reversal_of_entry_id
        ? -BigInt(Number(row.amount))
        : BigInt(Number(row.amount));
      financialTotals.set(key, (financialTotals.get(key) || 0n) + signedAmount);
    }
    for (const [key, total] of financialTotals) {
      const separator = key.indexOf('\u0000');
      const projectId = key.slice(0, separator);
      const type = key.slice(separator + 1);
      const amount = safeBigIntToNumber(total);
      const metrics = result.get(projectId);
      if (amount === null) {
        metrics.financial.overflow = true;
        metrics.financial[type] = null;
        continue;
      }
      if (type === 'investment') {
        metrics.financial.investedCapital = amount;
        metrics.financial.investment = amount;
      } else if (type !== 'valuation') {
        metrics.financial[type] = amount;
      }
    }

    const needRows = db.prepare(`
      SELECT
        n.project_id,
        COUNT(*) AS total,
        SUM(CASE WHEN EXISTS(
          SELECT 1 FROM proposals p
          WHERE p.need_id=n.id AND p.status='accepted'
        ) THEN 1 ELSE 0 END) AS committed
      FROM needs n
      WHERE n.archived_at IS NULL AND n.project_id IN (${placeholders})
      GROUP BY n.project_id
    `).all(...projectIds);
    for (const row of needRows) {
      const metrics = result.get(row.project_id);
      const total = Number(row.total);
      const committed = Number(row.committed || 0);
      metrics.participation = {
        totalNeeds: total,
        committedNeeds: committed,
        participationCompletionPercent: total ? (committed / total) * 100 : 0,
      };
      metrics.counts.needs = total;
    }

    const goalRows = db.prepare(`
      SELECT
        g.project_id,
        g.id,
        g.weight,
        g.status,
        COALESCE(SUM(m.weight), 0) AS milestone_weight,
        COALESCE(SUM(CASE WHEN m.completed_at IS NOT NULL THEN m.weight ELSE 0 END), 0)
          AS completed_weight
      FROM project_goals g
      LEFT JOIN goal_milestones m ON m.goal_id=g.id
      WHERE g.status<>'cancelled' AND g.project_id IN (${placeholders})
      GROUP BY g.id
    `).all(...projectIds);
    const goalsByProject = new Map();
    for (const row of goalRows) {
      const progress = Number(row.milestone_weight)
        ? (Number(row.completed_weight) / Number(row.milestone_weight)) * 100
        : row.status === 'completed' ? 100 : 0;
      const current = goalsByProject.get(row.project_id) || [];
      current.push({ weight: Number(row.weight), progress });
      goalsByProject.set(row.project_id, current);
    }
    for (const [projectId, projectGoals] of goalsByProject) {
      const metrics = result.get(projectId);
      const totalWeight = projectGoals.reduce((sum, goal) => sum + goal.weight, 0);
      metrics.goals = {
        count: projectGoals.length,
        completedCount: projectGoals.filter((goal) => goal.progress === 100).length,
        goalProgressPercent: totalWeight
          ? projectGoals.reduce(
            (sum, goal) => sum + goal.weight * goal.progress,
            0,
          ) / totalWeight
          : 0,
      };
      metrics.counts.goals = projectGoals.length;
    }

    for (const projectId of projectIds) {
      const capitalState = readCapitalState(projectId);
      const capitalTotals = assertCapitalBounds(capitalState);
      const metrics = result.get(projectId);
      metrics.capital = {
        totalIssuedUnits: capitalTotals.totalUnits,
        classCount: capitalState.classes.length,
      };
    }

    const meetingVisibility = publicOnly ? 'AND m.public_visible=1' : '';
    const resolutionVisibility = publicOnly
      ? 'AND m.public_visible=1 AND r.public_visible=1'
      : '';
    const governanceRows = db.prepare(`
      SELECT
        p.id AS project_id,
        (SELECT COUNT(*)
         FROM project_meetings m
         WHERE m.project_id=p.id ${meetingVisibility}) AS meetings,
        (SELECT COUNT(*)
         FROM meeting_resolutions r
         JOIN project_meetings m ON m.id=r.meeting_id
         WHERE m.project_id=p.id
           ${resolutionVisibility}
           AND r.status='open') AS open_resolutions,
        (SELECT COUNT(*)
         FROM share_offers o
         WHERE o.project_id=p.id
           AND o.status IN ('open','partially_filled')
           AND (o.available_until IS NULL OR o.available_until>=?))
          AS open_offers
      FROM projects p
      WHERE p.id IN (${placeholders})
    `).all(tehranCalendarDate(clock), ...projectIds);
    for (const row of governanceRows) {
      const metrics = result.get(row.project_id);
      metrics.governance = {
        meetings: Number(row.meetings),
        openResolutions: Number(row.open_resolutions),
      };
      metrics.counts.meetings = Number(row.meetings);
      metrics.counts.openShareOffers = Number(row.open_offers);
    }

    for (const metrics of result.values()) {
      const financial = metrics.financial;
      if (financial.overflow) {
        financial.netProfit = null;
        financial.margin = null;
        financial.roi = null;
        financial.marginPercent = null;
        financial.roiPercent = null;
        financial.netCash = null;
        continue;
      }
      financial.netProfit = financial.revenue - financial.expense;
      financial.margin = financial.revenue
        ? financial.netProfit / financial.revenue
        : 0;
      financial.roi = financial.investedCapital
        ? financial.netProfit / financial.investedCapital
        : null;
      financial.marginPercent = financial.margin * 100;
      financial.roiPercent = financial.roi === null
        ? null
        : financial.roi * 100;
      financial.netCash = financial.revenue + financial.investedCapital
        - financial.expense - financial.distribution;
      metrics.goalProgressPercent = metrics.goals.goalProgressPercent;
      metrics.participationCompletionPercent =
        metrics.participation.participationCompletionPercent;
      metrics.overallProgressSource = metrics.goals.count ? 'goals' : 'participation';
      metrics.overallProgressPercent = metrics.goals.count
        ? metrics.goalProgressPercent
        : metrics.participationCompletionPercent;
    }
    return result;
  }

  function portfolio(
    publicOnly = false,
    { includeArchived = false, limit = 100 } = {},
  ) {
    const safeLimit = Math.min(integer(limit, 'limit', {
      minimum: 1,
      fallback: 100,
    }), 100);
    const rows = db.prepare(`
      SELECT *
      FROM projects
      WHERE 1=1
        ${includeArchived ? '' : 'AND archived_at IS NULL'}
        ${publicOnly ? "AND status='published' AND visibility='public'" : ''}
      ORDER BY
        CASE stage
          WHEN 'operating' THEN 1
          WHEN 'construction' THEN 2
          WHEN 'pilot' THEN 3
          WHEN 'fundraising' THEN 4
          ELSE 5
        END,
        updated_at DESC,
        id
      LIMIT ?
    `).all(safeLimit);
    const metricsByProject = portfolioMetricMap(
      rows.map((row) => row.id),
      { publicOnly },
    );
    const projects = rows.map((row) => {
        const project = mapProject(row);
        project.metrics = metricsByProject.get(row.id);
        const execution = row.archived_at ? null : enterpriseExecution(row.id);
        if (execution) {
          project.metrics.execution = execution;
          project.metrics.overallProgressSource = 'operations';
          project.metrics.overallProgressPercent =
            execution.executionProgressPercent;
          if (
            execution.budget?.plannedAmount !== null &&
            execution.budget?.plannedAmount !== undefined
          ) {
            project.budgetAmount = execution.budget.plannedAmount;
          }
        }
        const enterpriseFinancial = row.archived_at
          ? null
          : enterpriseFinancialSummary(row.id);
        if (enterpriseFinancial) {
          project.metrics.financial = enterpriseFinancial;
        }
        project.metrics.capital.valuation =
          enterpriseFinancial?.valuation ?? row.valuation_amount;
        return project;
      });
    const summaryProjects = projects.filter((project) => !project.archivedAt);
    const visibleMetrics = summaryProjects
      .map((project) => project.metrics)
      .filter(Boolean);
    const byCurrency = {};
    for (const project of summaryProjects) {
      const currency = project.currency || 'IRR';
      const metrics = project.metrics;
      const totals = byCurrency[currency] || {
        projectCount: 0,
        totalBudgetAmount: 0,
        totalValuationAmount: 0,
        totalRevenue: 0,
        totalExpense: 0,
        totalNetProfit: 0,
        totalInvestedCapital: 0,
        totalDistribution: 0,
        totalNetCash: 0,
      };
      totals.projectCount += 1;
      totals.totalBudgetAmount = safeIntegerAdd(
        totals.totalBudgetAmount,
        Number(project.budgetAmount || 0),
      );
      totals.totalValuationAmount = safeIntegerAdd(
        totals.totalValuationAmount,
        Number(metrics.financial.valuation ?? project.valuationAmount ?? 0),
      );
      totals.totalRevenue = safeIntegerAdd(
        totals.totalRevenue,
        metrics.financial.revenue,
      );
      totals.totalExpense = safeIntegerAdd(
        totals.totalExpense,
        metrics.financial.expense,
      );
      totals.totalNetProfit = safeIntegerAdd(
        totals.totalNetProfit,
        metrics.financial.netProfit,
      );
      totals.totalInvestedCapital = safeIntegerAdd(
        totals.totalInvestedCapital,
        metrics.financial.investedCapital,
      );
      totals.totalDistribution = safeIntegerAdd(
        totals.totalDistribution,
        metrics.financial.distribution,
      );
      totals.totalNetCash = safeIntegerAdd(
        totals.totalNetCash,
        metrics.financial.netCash,
      );
      byCurrency[currency] = totals;
    }
    const currencyKeys = Object.keys(byCurrency);
    const baseCurrency = currencyKeys.length === 1 ? currencyKeys[0] : null;
    const baseTotals = baseCurrency ? byCurrency[baseCurrency] : null;
    return {
      projects,
      summary: {
        projectCount: summaryProjects.length,
        returnedProjectCount: projects.length,
        publishedCount: summaryProjects.filter(
          (project) => project.status === 'published',
        ).length,
        byCurrency,
        baseCurrency,
        totalBudgetAmount: baseTotals?.totalBudgetAmount ?? null,
        totalValuationAmount: baseTotals?.totalValuationAmount ?? null,
        totalRevenue: baseTotals?.totalRevenue ?? null,
        totalExpense: baseTotals?.totalExpense ?? null,
        totalNetProfit: baseTotals?.totalNetProfit ?? null,
        averageOverallProgressPercent: visibleMetrics.length
          ? visibleMetrics.reduce(
            (sum, metrics) => sum + metrics.overallProgressPercent,
            0,
          ) / visibleMetrics.length
          : 0,
      },
    };
  }

  function createProject(input) {
    const id = randomUUID();
    const now = nowIso(clock);
    const slug = slugValue(input.slug);
    if (db.prepare('SELECT 1 FROM projects WHERE slug=?').get(slug)) {
      throw conflict('PROJECT_SLUG_TAKEN', 'این نشانی قبلاً استفاده شده است.');
    }
    const status = enumValue(input.status, PROJECT_STATUSES, 'status', 'draft');
    const budgetAmount = integer(input.budgetAmount, 'budgetAmount', {
      minimum: 0,
      allowNull: true,
      fallback: null,
    });
    const valuationAmount = integer(input.valuationAmount, 'valuationAmount', {
      minimum: 0,
      allowNull: true,
      fallback: null,
    });
    const isDefault = booleanValue(input.isDefault, 'isDefault', false);
    const targetDate = optionalIsoDate(input.targetDate, 'targetDate') ?? '';
    const startDate = optionalIsoDate(input.startDate, 'startDate') ?? null;
    const organizationId = text(
      input.organizationId || 'default-organization',
      'organizationId',
      { required: true, max: 120 },
    );
    if (!db.prepare(`
      SELECT 1 FROM organizations WHERE id=? AND status='active' AND archived_at IS NULL
    `).get(organizationId)) {
      throw notFound('ORGANIZATION_NOT_FOUND', 'سازمان پیدا نشد.');
    }
    const code = text(input.code, 'code', { max: 40 }).toUpperCase();
    const visibility = enumValue(
      input.visibility,
      PROJECT_VISIBILITIES,
      'visibility',
      'public',
    );
    const lifecycle = enumValue(
      input.lifecycle,
      PROJECT_LIFECYCLES,
      'lifecycle',
      'planning',
    );
    const plannedEndDate =
      optionalIsoDate(input.plannedEndDate, 'plannedEndDate') ?? null;
    const actualEndDate =
      optionalIsoDate(input.actualEndDate, 'actualEndDate') ?? null;
    const ownerUserId = nullableText(input.ownerUserId, 'ownerUserId', 120) ?? null;
    withTransaction(db, () => {
      if (isDefault) {
        db.prepare(
          'UPDATE projects SET active=0 WHERE organization_id=? AND active=1',
        ).run(organizationId);
      }
      db.prepare(`
        INSERT INTO projects(
          id, slug, title, subtitle, location, summary, leader_name,
          leader_description, timeline, process_description, target_date,
          status, active, industry, sector, kind, stage, currency,
          budget_amount, valuation_amount, start_date, archived_at,
          created_at, updated_at, organization_id, code, visibility, lifecycle,
          planned_end_date, actual_end_date, owner_user_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        slug,
        text(input.title, 'title', { required: true, min: 2, max: 200 }),
        text(input.subtitle, 'subtitle', { max: 500 }),
        text(input.location, 'location', { max: 300 }),
        text(input.summary, 'summary', { max: 5_000 }),
        text(input.leaderName, 'leaderName', { max: 200 }),
        text(input.leaderDescription, 'leaderDescription', { max: 2_000 }),
        text(input.timeline, 'timeline', { max: 2_000 }),
        text(input.processDescription, 'processDescription', { max: 5_000 }),
        targetDate,
        status,
        isDefault ? 1 : 0,
        text(input.industry, 'industry', { max: 120 }),
        text(input.sector, 'sector', { max: 120 }),
        text(input.kind, 'kind', { max: 120 }),
        enumValue(input.stage, PROJECT_STAGES, 'stage', 'idea'),
        currencyValue(input.currency),
        budgetAmount,
        valuationAmount,
        startDate,
        null,
        now,
        now,
        organizationId,
        code,
        visibility,
        lifecycle,
        plannedEndDate,
        actualEndDate,
        ownerUserId,
      );
      audit(id, 'project', id, 'created', { status, isDefault });
    });
    return getProject(id);
  }

  function updateProject(id, input) {
    const current = requireProject(id, { includeArchived: true });
    const now = nowIso(clock);
    const slug = input.slug === undefined ? current.slug : slugValue(input.slug);
    const slugOwner = db.prepare(
      'SELECT id FROM projects WHERE slug=? AND id<>?',
    ).get(slug, id);
    if (slugOwner) {
      throw conflict('PROJECT_SLUG_TAKEN', 'این نشانی قبلاً استفاده شده است.');
    }
    const requestedStatus = enumValue(
      input.status,
      PROJECT_STATUSES,
      'status',
      current.status,
    );
    const budgetAmount = input.budgetAmount === undefined
      ? current.budget_amount
      : integer(input.budgetAmount, 'budgetAmount', { minimum: 0, allowNull: true });
    const valuationAmount = input.valuationAmount === undefined
      ? current.valuation_amount
      : integer(input.valuationAmount, 'valuationAmount', { minimum: 0, allowNull: true });
    const archiveFlag = input.archived === undefined
      ? undefined
      : booleanValue(input.archived, 'archived');
    const archivedAt = archiveFlag === true
      ? current.archived_at || now
      : archiveFlag === false
        ? null
        : current.archived_at;
    const requestedDefault = booleanValue(
      input.isDefault,
      'isDefault',
      Boolean(current.active),
    );
    if (archiveFlag === true && input.isDefault === true) {
      throw badRequest(
        'VALIDATION_FAILED',
        'پروژهٔ بایگانی‌شده نمی‌تواند پروژهٔ پیش‌فرض باشد.',
        { isDefault: 'هنگام بایگانی، isDefault باید false باشد.' },
      );
    }
    const isDefault = archiveFlag === true ? false : requestedDefault;
    if (isDefault && archivedAt) {
      throw conflict(
        'ARCHIVED_PROJECT_DEFAULT',
        'ابتدا پروژه را از بایگانی خارج کنید و سپس آن را پیش‌فرض کنید.',
      );
    }
    const status = archiveFlag === true ? 'draft' : requestedStatus;
    const startDate = input.startDate === undefined
      ? current.start_date
      : optionalIsoDate(input.startDate, 'startDate');
    const targetDate = input.targetDate === undefined
      ? current.target_date
      : optionalIsoDate(input.targetDate, 'targetDate') ?? '';
    const code = input.code === undefined
      ? current.code
      : text(input.code, 'code', { max: 40 }).toUpperCase();
    const visibility = enumValue(
      input.visibility,
      PROJECT_VISIBILITIES,
      'visibility',
      current.visibility,
    );
    const lifecycle = enumValue(
      input.lifecycle,
      PROJECT_LIFECYCLES,
      'lifecycle',
      current.lifecycle,
    );
    const plannedEndDate = input.plannedEndDate === undefined
      ? current.planned_end_date
      : optionalIsoDate(input.plannedEndDate, 'plannedEndDate');
    const actualEndDate = input.actualEndDate === undefined
      ? current.actual_end_date
      : optionalIsoDate(input.actualEndDate, 'actualEndDate');
    const ownerUserId = input.ownerUserId === undefined
      ? current.owner_user_id
      : nullableText(input.ownerUserId, 'ownerUserId', 120);
    withTransaction(db, () => {
      if (isDefault) {
        db.prepare(`
          UPDATE projects SET active=0
          WHERE id<>? AND organization_id=? AND active=1
        `).run(id, current.organization_id);
      }
      db.prepare(`
        UPDATE projects SET
          slug=?, title=?, subtitle=?, summary=?, industry=?, sector=?, kind=?,
          stage=?, currency=?, budget_amount=?, valuation_amount=?, location=?,
          timeline=?, start_date=?, target_date=?, leader_name=?,
          leader_description=?, process_description=?, status=?, active=?,
          archived_at=?, updated_at=?, code=?, visibility=?, lifecycle=?,
          planned_end_date=?, actual_end_date=?, owner_user_id=?
        WHERE id=?
      `).run(
        slug,
        input.title === undefined
          ? current.title
          : text(input.title, 'title', { required: true, min: 2, max: 200 }),
        input.subtitle === undefined
          ? current.subtitle
          : text(input.subtitle, 'subtitle', { max: 500 }),
        input.summary === undefined
          ? current.summary
          : text(input.summary, 'summary', { max: 5_000 }),
        input.industry === undefined
          ? current.industry
          : text(input.industry, 'industry', { max: 120 }),
        input.sector === undefined
          ? current.sector
          : text(input.sector, 'sector', { max: 120 }),
        input.kind === undefined ? current.kind : text(input.kind, 'kind', { max: 120 }),
        enumValue(input.stage, PROJECT_STAGES, 'stage', current.stage),
        input.currency === undefined
          ? current.currency
          : currencyValue(input.currency),
        budgetAmount,
        valuationAmount,
        input.location === undefined
          ? current.location
          : text(input.location, 'location', { max: 300 }),
        input.timeline === undefined
          ? current.timeline
          : text(input.timeline, 'timeline', { max: 2_000 }),
        startDate,
        targetDate,
        input.leaderName === undefined
          ? current.leader_name
          : text(input.leaderName, 'leaderName', { max: 200 }),
        input.leaderDescription === undefined
          ? current.leader_description
          : text(input.leaderDescription, 'leaderDescription', { max: 2_000 }),
        input.processDescription === undefined
          ? current.process_description
          : text(input.processDescription, 'processDescription', { max: 5_000 }),
        status,
        isDefault ? 1 : 0,
        archivedAt,
        now,
        code,
        visibility,
        lifecycle,
        plannedEndDate,
        actualEndDate,
        ownerUserId,
        id,
      );
      audit(id, 'project', id, 'updated', { status, isDefault });
    });
    return getProject(id, { includeArchived: true });
  }

  function archiveProject(id) {
    requireProject(id);
    const now = nowIso(clock);
    db.prepare(`
      UPDATE projects
      SET archived_at=?, status='draft', active=0, updated_at=?
      WHERE id=?
    `).run(now, now, id);
    audit(id, 'project', id, 'archived');
    return { id, archived: true, archivedAt: now };
  }

  function stakeholders(projectId) {
    requireProject(projectId);
    return {
      stakeholders: db.prepare(`
        SELECT *
        FROM project_stakeholders
        WHERE project_id=?
        ORDER BY archived_at IS NOT NULL, name, id
      `).all(projectId).map(mapStakeholder),
    };
  }

  function stakeholderUserLink(projectId, value, currentStakeholderId = null) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const userId = text(value, 'userId', { required: true, max: 200 });
    const user = db.prepare(`
      SELECT user.id
      FROM projects project
      JOIN organization_memberships membership
        ON membership.organization_id=project.organization_id
       AND membership.user_id=?
       AND membership.status='active'
      JOIN users user
        ON user.id=membership.user_id
       AND user.status='active'
      WHERE project.id=?
      LIMIT 1
    `).get(userId, projectId);
    if (!user) {
      throw badRequest(
        'INVALID_STAKEHOLDER_USER',
        'کاربر متصل‌شده باید عضو فعال همان سازمان باشد.',
        { userId: 'یک کاربر فعال از همان سازمان را انتخاب کنید.' },
      );
    }
    const duplicate = db.prepare(`
      SELECT id
      FROM project_stakeholders
      WHERE project_id=? AND user_id=? AND id<>COALESCE(?, '')
      LIMIT 1
    `).get(projectId, userId, currentStakeholderId);
    if (duplicate) {
      throw conflict(
        'STAKEHOLDER_USER_ALREADY_LINKED',
        'این کاربر قبلاً به یک ذی‌نفع در همین پروژه متصل شده است.',
      );
    }
    return user.id;
  }

  function createStakeholder(projectId, input) {
    requireProject(projectId);
    assertVotingRecordDateUnlocked(projectId);
    const id = randomUUID();
    const now = nowIso(clock);
    const role = enumValue(input.role, STAKEHOLDER_ROLES, 'role');
    const kind = enumValue(input.kind, STAKEHOLDER_KINDS, 'kind', 'person');
    const userId = stakeholderUserLink(projectId, input.userId) ?? null;
    if (userId && kind !== 'person') {
      throw badRequest(
        'INVALID_STAKEHOLDER_USER',
        'اتصال کاربر فقط برای ذی‌نفع حقیقی مجاز است.',
      );
    }
    db.prepare(`
      INSERT INTO project_stakeholders(
        id, project_id, name, kind, role, mobile, email, user_id, archived_at,
        created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      projectId,
      text(input.name, 'name', { required: true, min: 2, max: 200 }),
      kind,
      role,
      optionalMobile(input.mobile) ?? null,
      optionalEmail(input.email) ?? null,
      userId,
      null,
      now,
      now,
    );
    audit(projectId, 'stakeholder', id, 'created', { role, kind });
    return {
      stakeholder: stakeholders(projectId).stakeholders.find((item) => item.id === id),
    };
  }

  function patchStakeholder(projectId, id, input) {
    requireProject(projectId);
    const current = ensureProjectReference(
      projectId,
      'project_stakeholders',
      id,
      'INVALID_STAKEHOLDER',
      'عضو موردنظر متعلق به این پروژه نیست.',
    );
    const role = enumValue(input.role, STAKEHOLDER_ROLES, 'role', current.role);
    const kind = enumValue(input.kind, STAKEHOLDER_KINDS, 'kind', current.kind);
    const userId = input.userId === undefined
      ? current.user_id
      : stakeholderUserLink(projectId, input.userId, id);
    if (userId && kind !== 'person') {
      throw badRequest(
        'INVALID_STAKEHOLDER_USER',
        'اتصال کاربر فقط برای ذی‌نفع حقیقی مجاز است.',
      );
    }
    const archiveFlag = input.archived === undefined
      ? undefined
      : booleanValue(input.archived, 'archived');
    const now = nowIso(clock);
    const archivedAt = archiveFlag === true
      ? current.archived_at || now
      : archiveFlag === false
        ? null
        : current.archived_at;
    const activeStateChanged =
      (current.archived_at === null) !== (archivedAt === null);
    if (
      role !== current.role ||
      activeStateChanged ||
      userId !== current.user_id
    ) {
      assertVotingRecordDateUnlocked(projectId);
    }
    db.prepare(`
      UPDATE project_stakeholders SET
        name=?, kind=?, role=?, mobile=?, email=?, user_id=?,
        archived_at=?, updated_at=?
      WHERE id=? AND project_id=?
    `).run(
      input.name === undefined
        ? current.name
        : text(input.name, 'name', { required: true, min: 2, max: 200 }),
      kind,
      role,
      input.mobile === undefined
        ? current.mobile
        : optionalMobile(input.mobile),
      input.email === undefined
        ? current.email
        : optionalEmail(input.email),
      userId,
      archivedAt,
      now,
      id,
      projectId,
    );
    audit(projectId, 'stakeholder', id, 'updated', { role, kind });
    return {
      stakeholder: stakeholders(projectId).stakeholders.find((item) => item.id === id),
    };
  }

  function shareClasses(projectId) {
    requireProject(projectId);
    return {
      shareClasses: db.prepare(`
        SELECT *
        FROM share_classes
        WHERE project_id=?
        ORDER BY created_at, id
      `).all(projectId).map(mapShareClass),
    };
  }

  function createShareClass(projectId, input) {
    requireProject(projectId);
    const id = randomUUID();
    const now = nowIso(clock);
    const authorizedUnits = integer(input.authorizedUnits, 'authorizedUnits', { minimum: 1 });
    const votingWeight = votingWeightValue(input.votingWeight);
    const symbol = text(input.symbol, 'symbol', {
      required: true,
      max: 20,
    }).toUpperCase();
    if (db.prepare(
      'SELECT 1 FROM share_classes WHERE project_id=? AND symbol=?',
    ).get(projectId, symbol)) {
      throw conflict('SHARE_CLASS_SYMBOL_TAKEN', 'نماد این رده سهام تکراری است.');
    }
    db.prepare(`
      INSERT INTO share_classes(
        id, project_id, name, symbol, authorized_units, voting_weight, created_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      id,
      projectId,
      text(input.name, 'name', { required: true, max: 120 }),
      symbol,
      authorizedUnits,
      votingWeight,
      now,
    );
    audit(projectId, 'share_class', id, 'created', {
      authorizedUnits,
      votingWeight,
    });
    return {
      shareClass: shareClasses(projectId).shareClasses.find((item) => item.id === id),
    };
  }

  function patchShareClass(projectId, id, input) {
    requireProject(projectId);
    const current = ensureProjectReference(
      projectId,
      'share_classes',
      id,
      'INVALID_SHARE_CLASS',
      'رده سهام متعلق به این پروژه نیست.',
    );
    const authorizedUnits = input.authorizedUnits === undefined
      ? Number(current.authorized_units)
      : integer(input.authorizedUnits, 'authorizedUnits', { minimum: 1 });
    const capitalState = readCapitalState(projectId);
    assertCapitalBounds(capitalState);
    const issuedUnits = safeBigIntToNumber(
      capitalState.classUnits.get(id) || 0n,
    );
    if (authorizedUnits < issuedUnits) {
      throw conflict(
        'AUTHORIZED_UNITS_BELOW_ISSUED',
        'سقف مجاز نمی‌تواند کمتر از سهام منتشرشده باشد.',
      );
    }
    const votingWeight = input.votingWeight === undefined
      ? Number(current.voting_weight)
      : votingWeightValue(input.votingWeight);
    if (votingWeight !== Number(current.voting_weight)) {
      assertVotingRecordDateUnlocked(projectId);
    }
    const stateClass = capitalState.classById.get(id);
    stateClass.authorized_units = authorizedUnits;
    stateClass.voting_weight = votingWeight;
    assertCapitalBounds(
      capitalState,
      input.votingWeight === undefined ? 'authorizedUnits' : 'votingWeight',
    );
    const symbol = input.symbol === undefined
      ? current.symbol
      : text(input.symbol, 'symbol', { required: true, max: 20 }).toUpperCase();
    if (db.prepare(`
      SELECT 1 FROM share_classes
      WHERE project_id=? AND symbol=? AND id<>?
    `).get(projectId, symbol, id)) {
      throw conflict('SHARE_CLASS_SYMBOL_TAKEN', 'نماد این رده سهام تکراری است.');
    }
    db.prepare(`
      UPDATE share_classes
      SET name=?, symbol=?, authorized_units=?, voting_weight=?
      WHERE id=? AND project_id=?
    `).run(
      input.name === undefined
        ? current.name
        : text(input.name, 'name', { required: true, max: 120 }),
      symbol,
      authorizedUnits,
      votingWeight,
      id,
      projectId,
    );
    audit(projectId, 'share_class', id, 'updated', {
      authorizedUnits,
      votingWeight,
    });
    return {
      shareClass: shareClasses(projectId).shareClasses.find((item) => item.id === id),
    };
  }

  function capTable(projectId) {
    requireProject(projectId);
    const state = readCapitalState(projectId);
    const totals = assertCapitalBounds(state);
    const classes = state.classes.map((row) => {
      const issuedUnits = safeBigIntToNumber(state.classUnits.get(row.id) || 0n);
      return {
        id: row.id,
        name: row.name,
        symbol: row.symbol,
        authorizedUnits: Number(row.authorized_units),
        issuedUnits,
        availableUnits: Number(row.authorized_units) - issuedUnits,
        votingWeight: Number(row.voting_weight),
      };
    });
    const issuedByClass = new Map(classes.map((item) => [item.id, item.issuedUnits]));
    const holdings = [...state.holdingUnits.entries()]
      .map(([key, unitsValue]) => {
        const separator = key.indexOf('\u0000');
        const stakeholderId = key.slice(0, separator);
        const shareClassId = key.slice(separator + 1);
        const units = safeBigIntToNumber(unitsValue);
        const shareClass = state.classById.get(shareClassId);
        const stakeholder = state.stakeholderById.get(stakeholderId);
        const classTotal = issuedByClass.get(shareClassId) || 0;
        return {
          stakeholderId,
          stakeholderName: stakeholder.name,
          shareClassId,
          className: shareClass.name,
          symbol: shareClass.symbol,
          units,
          ownershipPercent: classTotal ? (units / classTotal) * 100 : 0,
        };
      })
      .filter((holding) => holding.units !== 0)
      .sort((left, right) => (
        left.symbol.localeCompare(right.symbol, 'fa') ||
        left.stakeholderName.localeCompare(right.stakeholderName, 'fa') ||
        left.stakeholderId.localeCompare(right.stakeholderId)
      ));
    return {
      classes,
      holdings,
      totalUnits: totals.totalUnits,
    };
  }

  function issueShares(projectId, input, idempotencyKey) {
    const project = requireProject(projectId);
    const units = integer(input.units, 'units', { minimum: 1 });
    const note = nullableText(input.note, 'note', 2_000) ?? null;
    const keyHash = hashToken(idempotencyKey);
    const requestHash = operationRequestHash({
      shareClassId: String(input.shareClassId || ''),
      stakeholderId: String(input.stakeholderId || ''),
      units,
      note,
    });
    let result;
    withTransaction(db, () => {
      const replay = replayOperationReceipt(
        'share_issuance',
        projectId,
        keyHash,
        requestHash,
      );
      if (replay) {
        result = replay;
        return;
      }
      const enterpriseGovernanceActive = Boolean(db.prepare(`
        SELECT 1
        FROM organization_memberships
        WHERE organization_id=? AND role_key='owner' AND status='active'
        LIMIT 1
      `).get(project.organization_id));
      if (enterpriseGovernanceActive) {
        throw conflict(
          'CORPORATE_ACTION_REQUIRED',
          'صدور مستقیم سهام پس از راه‌اندازی فضای سازمانی غیرفعال است؛ صدور را با مصوبهٔ معتبر و اقدام شرکتی انجام دهید.',
        );
      }
      assertVotingRecordDateUnlocked(projectId);
      const shareClass = ensureProjectReference(
        projectId,
        'share_classes',
        input.shareClassId,
        'INVALID_REFERENCE',
        'رده سهام متعلق به این پروژه نیست.',
      );
      ensureActiveStakeholder(
        projectId,
        input.stakeholderId,
        'سهام‌دار متعلق به این پروژه نیست.',
      );
      const capitalState = readCapitalState(projectId);
      assertCapitalBounds(capitalState);
      const issued = capitalState.classUnits.get(shareClass.id) || 0n;
      const nextIssued = issued + BigInt(units);
      if (nextIssued > BigInt(Number(shareClass.authorized_units))) {
        throw conflict('AUTHORIZED_UNITS_EXCEEDED', 'سقف واحد مجاز کافی نیست.');
      }
      capitalState.classUnits.set(shareClass.id, nextIssued);
      const holdingKey = `${input.stakeholderId}\u0000${shareClass.id}`;
      capitalState.holdingUnits.set(
        holdingKey,
        (capitalState.holdingUnits.get(holdingKey) || 0n) + BigInt(units),
      );
      assertCapitalBounds(capitalState, 'units');
      const id = randomUUID();
      db.prepare(`
        INSERT INTO share_ledger(
          id, project_id, share_class_id, stakeholder_id, entry_type,
          units, related_transfer_id, note, created_at
        ) VALUES(?,?,?,?, 'issuance', ?,NULL,?,?)
      `).run(
        id,
        projectId,
        shareClass.id,
        input.stakeholderId,
        units,
        note,
        nowIso(clock),
      );
      audit(projectId, 'share_ledger', id, 'shares_issued', {
        shareClassId: shareClass.id,
        stakeholderId: input.stakeholderId,
        units,
      });
      const response = { entryId: id, capTable: capTable(projectId) };
      saveOperationReceipt(
        'share_issuance',
        projectId,
        keyHash,
        requestHash,
        id,
        response,
      );
      result = { ...response, idempotentReplay: false };
    });
    return result;
  }

  function shareOffers(projectId) {
    requireProject(projectId);
    const today = tehranCalendarDate(clock);
    return {
      shareOffers: db.prepare(`
        SELECT *
        FROM share_offers
        WHERE project_id=?
        ORDER BY
          CASE status WHEN 'open' THEN 1 WHEN 'partially_filled' THEN 2 ELSE 3 END,
          created_at DESC,
          id
      `).all(projectId).map((row) => {
        const offer = mapOffer(row);
        const expired = (
          ['open', 'partially_filled'].includes(offer.status) &&
          offer.availableUntil &&
          offer.availableUntil < today
        );
        return {
          ...offer,
          expired: Boolean(expired),
          effectiveStatus: expired ? 'expired' : offer.status,
        };
      }),
    };
  }

  function createShareOffer(projectId, input, idempotencyKey) {
    requireProject(projectId);
    const side = enumValue(input.side, new Set(['sell', 'buy']), 'side');
    const shareClassId = String(input.shareClassId || '');
    const sellerId = input.sellerStakeholderId
      ? String(input.sellerStakeholderId)
      : null;
    const buyerId = input.buyerStakeholderId
      ? String(input.buyerStakeholderId)
      : null;
    const units = integer(input.units, 'units', { minimum: 1 });
    const unitPrice = integer(input.unitPrice, 'unitPrice', { minimum: 0 });
    const availableUntil =
      optionalIsoDate(input.availableUntil, 'availableUntil') ?? null;
    const note = nullableText(input.note, 'note', 2_000) ?? null;
    const keyHash = hashToken(idempotencyKey);
    const requestHash = operationRequestHash({
      shareClassId,
      side,
      sellerId,
      buyerId,
      units,
      unitPrice,
      availableUntil,
      note,
    });
    let result;
    withTransaction(db, () => {
      const replay = replayOperationReceipt(
        'share_offer',
        projectId,
        keyHash,
        requestHash,
      );
      if (replay) {
        result = replay;
        return;
      }
      const shareClass = ensureProjectReference(
        projectId,
        'share_classes',
        shareClassId,
        'INVALID_REFERENCE',
        'رده سهام متعلق به این پروژه نیست.',
      );
      if (sellerId) {
        ensureActiveStakeholder(
          projectId,
          sellerId,
          'فروشنده متعلق به این پروژه نیست.',
        );
      }
      if (buyerId) {
        ensureActiveStakeholder(
          projectId,
          buyerId,
          'خریدار متعلق به این پروژه نیست.',
        );
      }
      if ((side === 'sell' && !sellerId) || (side === 'buy' && !buyerId)) {
        throw badRequest(
          'VALIDATION_FAILED',
          side === 'sell'
            ? 'برای پیشنهاد فروش، فروشنده الزامی است.'
            : 'برای پیشنهاد خرید، خریدار الزامی است.',
        );
      }
      if (availableUntil && availableUntil < tehranCalendarDate(clock)) {
        throw badRequest(
          'VALIDATION_FAILED',
          'مهلت پیشنهاد سهام نمی‌تواند در گذشته باشد.',
          { availableUntil: 'امروز یا یک تاریخ آینده را وارد کنید.' },
        );
      }
      if (side === 'sell') {
        const capitalState = readCapitalState(projectId);
        assertCapitalBounds(capitalState);
        const balance = holdingUnits(capitalState, sellerId, shareClass.id);
        if (balance < units) {
          throw conflict('INSUFFICIENT_SHARES', 'موجودی سهام فروشنده کافی نیست.');
        }
      }
      const id = randomUUID();
      const now = nowIso(clock);
      db.prepare(`
        INSERT INTO share_offers(
          id, project_id, share_class_id, side, seller_stakeholder_id,
          buyer_stakeholder_id, units, remaining_units, unit_price,
          available_until, status, note, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?, 'open', ?,?,?)
      `).run(
        id,
        projectId,
        shareClass.id,
        side,
        sellerId,
        buyerId,
        units,
        units,
        unitPrice,
        availableUntil,
        note,
        now,
        now,
      );
      audit(projectId, 'share_offer', id, 'created', {
        side,
        shareClassId: shareClass.id,
        units,
      });
      const response = {
        shareOffer: shareOffers(projectId).shareOffers.find(
          (item) => item.id === id,
        ),
      };
      saveOperationReceipt(
        'share_offer',
        projectId,
        keyHash,
        requestHash,
        id,
        response,
      );
      result = { ...response, idempotentReplay: false };
    });
    return result;
  }

  function patchShareOffer(projectId, id, input) {
    requireProject(projectId);
    let result;
    withTransaction(db, () => {
      const current = ensureProjectReference(
        projectId,
        'share_offers',
        id,
        'INVALID_SHARE_OFFER',
        'پیشنهاد سهام متعلق به این پروژه نیست.',
      );
      if (['filled', 'cancelled'].includes(current.status)) {
        throw conflict('SHARE_OFFER_CLOSED', 'پیشنهاد بسته‌شده قابل ویرایش نیست.');
      }
      const nextStatus = input.status ?? current.status;
      if (![current.status, 'cancelled'].includes(nextStatus)) {
        throw conflict(
          'INVALID_STATUS_TRANSITION',
          'وضعیت انجام فقط از طریق تأیید انتقال تغییر می‌کند.',
        );
      }
      const unitPrice = input.unitPrice === undefined
        ? current.unit_price
        : integer(input.unitPrice, 'unitPrice', { minimum: 0 });
      const availableUntil = input.availableUntil === undefined
        ? current.available_until
        : optionalIsoDate(input.availableUntil, 'availableUntil');
      if (
        ['open', 'partially_filled'].includes(nextStatus) &&
        availableUntil &&
        availableUntil < tehranCalendarDate(clock)
      ) {
        throw badRequest(
          'VALIDATION_FAILED',
          'مهلت پیشنهاد سهام نمی‌تواند در گذشته باشد.',
          { availableUntil: 'امروز یا یک تاریخ آینده را وارد کنید.' },
        );
      }
      const now = nowIso(clock);
      db.prepare(`
        UPDATE share_offers
        SET unit_price=?, available_until=?, note=?, status=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        unitPrice,
        availableUntil,
        input.note === undefined
          ? current.note
          : nullableText(input.note, 'note', 2_000),
        nextStatus,
        now,
        id,
        projectId,
      );
      audit(projectId, 'share_offer', id, 'updated', { status: nextStatus });
      result = {
        shareOffer: shareOffers(projectId).shareOffers.find(
          (item) => item.id === id,
        ),
      };
    });
    return result;
  }

  function shareTransfers(projectId) {
    requireProject(projectId);
    return {
      shareTransfers: db.prepare(`
        SELECT *
        FROM share_transfers
        WHERE project_id=?
        ORDER BY created_at DESC, id
      `).all(projectId).map(mapTransfer),
    };
  }

  function enterpriseCapitalPolicyActive(project) {
    return Boolean(db.prepare(`
      SELECT 1
      FROM organization_memberships membership
      JOIN users user ON user.id=membership.user_id
      WHERE membership.organization_id=?
        AND membership.role_key='owner'
        AND membership.status='active'
        AND user.status='active'
      LIMIT 1
    `).get(project.organization_id));
  }

  function requireInteractiveCapitalActor(project, authorization) {
    const userId = authorization?.user?.id || null;
    if (authorization?.apiKey || authorization?.actorType === 'api_key' || !userId) {
      throw forbidden(
        'CAPITAL_INTERACTIVE_USER_REQUIRED',
        'ثبت و تأیید انتقال سهام فقط با نشست تعاملی کاربر مجاز است.',
      );
    }
    const active = db.prepare(`
      SELECT 1
      FROM users user
      JOIN organization_memberships membership
        ON membership.user_id=user.id
       AND membership.organization_id=?
      WHERE user.id=? AND user.status='active'
        AND membership.status='active'
      LIMIT 1
    `).get(project.organization_id, userId);
    if (!active) {
      throw forbidden(
        'CAPITAL_ACTOR_INACTIVE',
        'کاربر فعال و عضو سازمان برای این عملیات لازم است.',
      );
    }
    return userId;
  }

  function requireApprovedTransferResolution(
    project,
    resolutionId,
    transfer,
    operationId,
    { bind = false, consume = false } = {},
  ) {
    if (!resolutionId) {
      throw conflict(
        'SHARE_TRANSFER_RESOLUTION_REQUIRED',
        'تأیید انتقال سهام به مصوبهٔ معتبر همان پروژه نیاز دارد.',
      );
    }
    const row = db.prepare(`
      SELECT
        resolution.id,
        resolution.status AS resolution_status,
        resolution.result_json,
        resolution.operation_type,
        resolution.operation_scope_json,
        resolution.operation_request_hash,
        meeting.status AS meeting_status
      FROM meeting_resolutions resolution
      JOIN project_meetings meeting ON meeting.id=resolution.meeting_id
      WHERE resolution.id=? AND meeting.project_id=?
      LIMIT 1
    `).get(resolutionId, project.id);
    const result = parseJson(row?.result_json, {});
    const quorumMet =
      result.quorumMet === true || result.quorum?.quorumMet === true;
    if (
      !row ||
      row.meeting_status !== 'held' ||
      row.resolution_status !== 'closed' ||
      result.outcome !== 'approved' ||
      !quorumMet
    ) {
      throw conflict(
        'SHARE_TRANSFER_RESOLUTION_INVALID',
        'جلسه باید برگزار، مصوبه بسته، حد نصاب برقرار و نتیجه تصویب‌شده باشد.',
      );
    }
    const expectedScope = shareTransferOperationScope(project, transfer);
    const expectedHash = operationRequestHash(expectedScope);
    const storedScope = parseJson(row.operation_scope_json, null);
    if (
      row.operation_type !== 'share_transfer' ||
      !storedScope ||
      operationRequestHash(storedScope) !== row.operation_request_hash ||
      row.operation_request_hash !== expectedHash
    ) {
      throw conflict(
        'SHARE_TRANSFER_RESOLUTION_SCOPE_MISMATCH',
        'مصوبه باید به‌صورت ساختاری به همین طرفین، ردهٔ سهام، تعداد و مبلغ انتقال محدود شده باشد.',
      );
    }
    const binding = db.prepare(`
      SELECT *
      FROM resolution_operation_bindings
      WHERE resolution_id=?
    `).get(resolutionId);
    if (!binding && bind) {
      db.prepare(`
        INSERT INTO resolution_operation_bindings(
          resolution_id, project_id, operation_type, operation_id,
          request_hash, bound_at, consumed_at
        ) VALUES(?,?,'share_transfer',?,?,?,NULL)
      `).run(
        resolutionId,
        project.id,
        operationId,
        expectedHash,
        nowIso(clock),
      );
    } else if (
      !binding ||
      binding.project_id !== project.id ||
      binding.operation_type !== 'share_transfer' ||
      binding.operation_id !== operationId ||
      binding.request_hash !== expectedHash
    ) {
      throw conflict(
        'RESOLUTION_ALREADY_BOUND',
        'این مصوبه قبلاً به عملیات دیگری محدود شده است.',
      );
    }
    const selectedBinding = binding || db.prepare(`
      SELECT * FROM resolution_operation_bindings WHERE resolution_id=?
    `).get(resolutionId);
    if (selectedBinding.consumed_at) {
      throw conflict(
        'RESOLUTION_ALREADY_CONSUMED',
        'این مصوبه قبلاً مصرف شده است.',
      );
    }
    if (consume) {
      db.prepare(`
        UPDATE resolution_operation_bindings
        SET consumed_at=?
        WHERE resolution_id=? AND consumed_at IS NULL
      `).run(nowIso(clock), resolutionId);
    }
    return {
      resolutionId,
      requestHash: expectedHash,
    };
  }

  function requireVerifiedTransferKyc(project, stakeholderId) {
    const today = tehranCalendarDate(clock);
    const verified = db.prepare(`
      SELECT 1
      FROM kyc_cases
      WHERE organization_id=?
        AND subject_type='stakeholder'
        AND subject_id=?
        AND (project_id=? OR project_id IS NULL)
        AND status='verified'
        AND (expires_at IS NULL OR substr(expires_at,1,10)>=?)
      ORDER BY reviewed_at DESC, created_at DESC
      LIMIT 1
    `).get(
      project.organization_id,
      stakeholderId,
      project.id,
      today,
    );
    if (!verified) {
      throw conflict(
        'SHARE_TRANSFER_KYC_REQUIRED',
        'احراز هویت معتبر هر دو طرف برای تأیید انتقال سهام الزامی است.',
        { stakeholderId },
      );
    }
  }

  function requireTransferContract(project, transfer) {
    if (!transfer.contract_id) {
      throw conflict(
        'SHARE_TRANSFER_CONTRACT_REQUIRED',
        'قرارداد امضاشدهٔ انتقال سهام الزامی است.',
      );
    }
    const today = tehranCalendarDate(clock);
    const contract = db.prepare(`
      SELECT contract.id, contract.value_amount, contract.currency
      FROM contracts contract
      WHERE contract.id=? AND contract.project_id=?
        AND contract.organization_id=?
        AND contract.status='active'
        AND (contract.effective_on IS NULL OR contract.effective_on<=?)
        AND (contract.expires_on IS NULL OR contract.expires_on>=?)
        AND EXISTS(
          SELECT 1 FROM contract_parties party
          WHERE party.contract_id=contract.id
            AND party.party_type='stakeholder'
            AND party.party_id=?
        )
        AND EXISTS(
          SELECT 1 FROM contract_parties party
          WHERE party.contract_id=contract.id
            AND party.party_type='stakeholder'
            AND party.party_id=?
        )
      LIMIT 1
    `).get(
      transfer.contract_id,
      project.id,
      project.organization_id,
      today,
      today,
      transfer.from_stakeholder_id,
      transfer.to_stakeholder_id,
    );
    if (!contract) {
      throw conflict(
        'SHARE_TRANSFER_CONTRACT_INVALID',
        'قرارداد باید فعال، معتبر و شامل هر دو طرف انتقال باشد.',
      );
    }
    const price = Number(transfer.price_amount || 0);
    if (
      price > 0 &&
      (
        contract.currency !== project.currency ||
        contract.value_amount === null ||
        Number(contract.value_amount) < price
      )
    ) {
      throw conflict(
        'SHARE_TRANSFER_CONTRACT_VALUE_MISMATCH',
        'ارز و مبلغ قرارداد باید معاملهٔ ثبت‌شده را پوشش دهد.',
      );
    }
  }

  function transferPaymentPurposeHash(project, transferId, amount) {
    return operationRequestHash({
      purposeType: 'share_transfer',
      purposeId: transferId,
      projectId: project.id,
      amount,
      currency: project.currency,
      direction: 'incoming',
    });
  }

  function bindTransferPayment(project, transferId, paymentIntentId, amount) {
    if (!paymentIntentId) return null;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw conflict(
        'SHARE_TRANSFER_PAYMENT_NOT_APPLICABLE',
        'سند پرداخت فقط برای انتقال دارای مبلغ مثبت مجاز است.',
      );
    }
    const payment = db.prepare(`
      SELECT *
      FROM payment_intents
      WHERE id=? AND organization_id=? AND project_id=?
      LIMIT 1
    `).get(paymentIntentId, project.organization_id, project.id);
    if (
      !payment ||
      payment.invoice_id ||
      payment.direction !== 'incoming' ||
      Number(payment.amount) !== amount ||
      payment.currency !== project.currency
    ) {
      throw conflict(
        'SHARE_TRANSFER_PAYMENT_INVALID',
        'پرداخت انتقال باید مستقل از صورت‌حساب، هم‌پروژه، واردشونده و با مبلغ و ارز دقیق باشد.',
      );
    }
    const purposeHash = transferPaymentPurposeHash(
      project,
      transferId,
      amount,
    );
    if (payment.purpose_type === null) {
      db.prepare(`
        UPDATE payment_intents
        SET purpose_type='share_transfer', purpose_id=?, purpose_hash=?
        WHERE id=? AND purpose_type IS NULL
      `).run(transferId, purposeHash, payment.id);
    } else if (
      payment.purpose_type !== 'share_transfer' ||
      payment.purpose_id !== transferId ||
      payment.purpose_hash !== purposeHash
    ) {
      throw conflict(
        'SHARE_TRANSFER_PAYMENT_ALREADY_BOUND',
        'این پرداخت به منبع یا عملیات دیگری محدود شده است.',
      );
    }
    return purposeHash;
  }

  function requireTransferPayment(project, transfer) {
    const price = Number(transfer.price_amount || 0);
    if (price === 0) return;
    if (!transfer.payment_intent_id) {
      throw conflict(
        'SHARE_TRANSFER_PAYMENT_REQUIRED',
        'برای معاملهٔ دارای مبلغ، پرداخت موفق و اختصاصی الزامی است.',
      );
    }
    const payment = db.prepare(`
      SELECT id, invoice_id, purpose_type, purpose_id, purpose_hash
      FROM payment_intents
      WHERE id=? AND organization_id=? AND project_id=?
        AND direction='incoming' AND status='succeeded'
        AND amount=? AND currency=?
      LIMIT 1
    `).get(
      transfer.payment_intent_id,
      project.organization_id,
      project.id,
      price,
      project.currency,
    );
    if (!payment) {
      throw conflict(
        'SHARE_TRANSFER_PAYMENT_INVALID',
        'پرداخت باید موفق، هم‌ارز و دقیقاً برابر مبلغ معامله باشد.',
      );
    }
    const expectedPurposeHash = transferPaymentPurposeHash(
      project,
      transfer.id,
      price,
    );
    if (
      payment.invoice_id ||
      payment.purpose_type !== 'share_transfer' ||
      payment.purpose_id !== transfer.id ||
      payment.purpose_hash !== expectedPurposeHash
    ) {
      throw conflict(
        'SHARE_TRANSFER_PAYMENT_PURPOSE_MISMATCH',
        'پرداخت باید به‌صورت غیرقابل‌تغییر به همین انتقال سهام محدود شده باشد.',
      );
    }
    const used = db.prepare(`
      SELECT id
      FROM share_transfers
      WHERE payment_intent_id=? AND id<>? AND status='approved'
      LIMIT 1
    `).get(transfer.payment_intent_id, transfer.id);
    if (used) {
      throw conflict(
        'SHARE_TRANSFER_PAYMENT_ALREADY_USED',
        'این پرداخت قبلاً برای انتقال دیگری مصرف شده است.',
      );
    }
  }

  function validateEnterpriseTransferCompliance(project, transfer) {
    requireApprovedTransferResolution(
      project,
      transfer.resolution_id,
      transfer,
      transfer.id,
      { consume: true },
    );
    requireVerifiedTransferKyc(project, transfer.from_stakeholder_id);
    requireVerifiedTransferKyc(project, transfer.to_stakeholder_id);
    requireTransferContract(project, transfer);
    requireTransferPayment(project, transfer);
  }

  function validateTransferReferences(projectId, input) {
    const shareClass = ensureProjectReference(
      projectId,
      'share_classes',
      input.shareClassId,
      'INVALID_REFERENCE',
      'رده سهام متعلق به این پروژه نیست.',
    );
    const from = ensureActiveStakeholder(
      projectId,
      input.fromStakeholderId,
      'فروشنده متعلق به این پروژه نیست.',
    );
    const to = ensureActiveStakeholder(
      projectId,
      input.toStakeholderId,
      'خریدار متعلق به این پروژه نیست.',
    );
    if (from.id === to.id) {
      throw badRequest('VALIDATION_FAILED', 'فروشنده و خریدار نمی‌توانند یکسان باشند.');
    }
    let offer = null;
    if (input.offerId) {
      offer = ensureProjectReference(
        projectId,
        'share_offers',
        input.offerId,
        'INVALID_REFERENCE',
        'پیشنهاد سهام متعلق به این پروژه نیست.',
      );
      if (offer.share_class_id !== shareClass.id) {
        throw badRequest('INVALID_REFERENCE', 'رده سهام انتقال با پیشنهاد یکسان نیست.');
      }
      if (
        (
          offer.seller_stakeholder_id &&
          offer.seller_stakeholder_id !== from.id
        ) ||
        (
          offer.buyer_stakeholder_id &&
          offer.buyer_stakeholder_id !== to.id
        )
      ) {
        throw badRequest('INVALID_REFERENCE', 'طرفین انتقال با پیشنهاد سهام یکسان نیستند.');
      }
    }
    return { shareClass, from, to, offer };
  }

  function createShareTransfer(
    projectId,
    input,
    idempotencyKey,
    authorization = null,
  ) {
    const project = requireProject(projectId);
    const shareClassId = String(input.shareClassId || '');
    const fromStakeholderId = String(input.fromStakeholderId || '');
    const toStakeholderId = String(input.toStakeholderId || '');
    const offerId = input.offerId ? String(input.offerId) : null;
    const units = integer(input.units, 'units', { minimum: 1 });
    const status = enumValue(
      input.status,
      new Set(['draft', 'pending']),
      'status',
      'draft',
    );
    const requestedPriceAmount = integer(input.priceAmount, 'priceAmount', {
      minimum: 0,
      allowNull: true,
      fallback: null,
    });
    const note = nullableText(input.note, 'note', 2_000) ?? null;
    const resolutionId =
      nullableText(input.resolutionId, 'resolutionId', 200) ?? null;
    const contractId =
      nullableText(input.contractId, 'contractId', 200) ?? null;
    const paymentIntentId =
      nullableText(input.paymentIntentId, 'paymentIntentId', 200) ?? null;
    const keyHash = hashToken(idempotencyKey);
    const requestHash = operationRequestHash({
      shareClassId,
      fromStakeholderId,
      toStakeholderId,
      offerId,
      units,
      status,
      priceAmount: requestedPriceAmount,
      note,
      resolutionId,
      contractId,
      paymentIntentId,
    });
    let result;
    withTransaction(db, () => {
      const replay = replayOperationReceipt(
        'share_transfer',
        projectId,
        keyHash,
        requestHash,
      );
      if (replay) {
        const canonical = replay.shareTransfer?.id
          ? shareTransfers(projectId).shareTransfers.find(
            (item) => item.id === replay.shareTransfer.id,
          )
          : null;
        result = canonical
          ? { ...replay, shareTransfer: canonical }
          : replay;
        return;
      }
      const policyActive = enterpriseCapitalPolicyActive(project);
      const createdByUserId = policyActive
        ? requireInteractiveCapitalActor(project, authorization)
        : null;
      const references = validateTransferReferences(projectId, {
        shareClassId,
        fromStakeholderId,
        toStakeholderId,
        offerId,
      });
      if (references.offer) {
        if (!['open', 'partially_filled'].includes(references.offer.status)) {
          throw conflict('SHARE_OFFER_CLOSED', 'پیشنهاد سهام بسته شده است.');
        }
        if (
          references.offer.available_until &&
          references.offer.available_until < tehranCalendarDate(clock)
        ) {
          throw conflict('SHARE_OFFER_EXPIRED', 'مهلت پیشنهاد سهام پایان یافته است.');
        }
        if (units > Number(references.offer.remaining_units)) {
          throw conflict(
            'OFFER_UNITS_EXCEEDED',
            'تعداد انتقال از مانده پیشنهاد بیشتر است.',
          );
        }
      }
      let priceAmount = requestedPriceAmount;
      if (references.offer) {
        const listedTotal = Number(references.offer.unit_price) * units;
        if (!Number.isSafeInteger(listedTotal)) {
          throw badRequest(
            'VALIDATION_FAILED',
            'مبلغ کل انتقال از محدوده عددی امن خارج است.',
          );
        }
        if (priceAmount === null) priceAmount = listedTotal;
        if (priceAmount !== listedTotal) {
          throw conflict(
            'OFFER_PRICE_MISMATCH',
            'مبلغ کل انتقال باید برابر قیمت واحد پیشنهاد ضرب‌در تعداد واحد باشد.',
          );
        }
      }
      const id = randomUUID();
      const now = nowIso(clock);
      const transferScope = {
        id,
        share_class_id: references.shareClass.id,
        from_stakeholder_id: references.from.id,
        to_stakeholder_id: references.to.id,
        units,
        price_amount: priceAmount,
        contract_id: contractId,
        payment_intent_id: paymentIntentId,
      };
      if (
        policyActive &&
        status === 'pending' &&
        (
          !resolutionId ||
          !contractId ||
          (Number(priceAmount || 0) > 0 && !paymentIntentId)
        )
      ) {
        throw conflict(
          'SHARE_TRANSFER_EVIDENCE_REQUIRED',
          'A scoped resolution, contract, and payment evidence are required before review.',
        );
      }
      if (policyActive && resolutionId) {
        requireApprovedTransferResolution(
          project,
          resolutionId,
          transferScope,
          id,
          { bind: true },
        );
      }
      if (paymentIntentId) {
        bindTransferPayment(
          project,
          id,
          paymentIntentId,
          Number(priceAmount || 0),
        );
      }
      if (policyActive && status === 'pending') {
        requireVerifiedTransferKyc(project, references.from.id);
        requireVerifiedTransferKyc(project, references.to.id);
        requireTransferContract(project, transferScope);
      }
      db.prepare(`
        INSERT INTO share_transfers(
          id, project_id, share_class_id, from_stakeholder_id,
          to_stakeholder_id, units, price_amount, status, note,
          decision_note, created_at, updated_at, decided_at, offer_id,
          resolution_id, contract_id, payment_intent_id, created_by_user_id
        ) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,?,?,?,?,?)
      `).run(
        id,
        projectId,
        references.shareClass.id,
        references.from.id,
        references.to.id,
        units,
        priceAmount,
        status,
        note,
        now,
        now,
        references.offer?.id ?? null,
        resolutionId,
        contractId,
        paymentIntentId,
        createdByUserId,
      );
      audit(projectId, 'share_transfer', id, 'created', {
        units,
        status,
        offerId: references.offer?.id ?? null,
        resolutionId,
        contractId,
        paymentIntentId,
      });
      const response = {
        shareTransfer: shareTransfers(projectId).shareTransfers.find(
          (item) => item.id === id,
        ),
      };
      saveOperationReceipt(
        'share_transfer',
        projectId,
        keyHash,
        requestHash,
        id,
        response,
      );
      result = { ...response, idempotentReplay: false };
    });
    return result;
  }

  function patchShareTransfer(
    projectId,
    id,
    input,
    authorization = null,
  ) {
    const project = requireProject(projectId);
    withTransaction(db, () => {
      let current = db.prepare(`
        SELECT *
        FROM share_transfers
        WHERE id=? AND project_id=?
      `).get(id, projectId);
      if (!current) {
        throw badRequest(
          'INVALID_SHARE_TRANSFER',
          'انتقال متعلق به این پروژه نیست.',
        );
      }
      const nextStatus = enumValue(
        input.status,
        TRANSFER_STATUSES,
        'status',
        current.status,
      );
      const allowed = {
        draft: new Set(['draft', 'pending', 'cancelled']),
        pending: new Set(['pending', 'approved', 'rejected', 'cancelled']),
        approved: new Set(['approved']),
        rejected: new Set(['rejected']),
        cancelled: new Set(['cancelled']),
      };
      if (!allowed[current.status].has(nextStatus)) {
        throw conflict('INVALID_STATUS_TRANSITION', 'تغییر وضعیت انتقال مجاز نیست.');
      }
      const decisionNote = input.decisionNote === undefined
        ? current.decision_note
        : nullableText(input.decisionNote, 'decisionNote', 2_000);
      const evidenceChanged = [
        'resolutionId',
        'contractId',
        'paymentIntentId',
      ].some((field) => input[field] !== undefined);
      if (evidenceChanged && current.status !== 'draft') {
        throw conflict(
          'SHARE_TRANSFER_EVIDENCE_IMMUTABLE',
          'شواهد انتقال فقط در وضعیت پیش‌نویس قابل تغییر است.',
        );
      }
      const policyActive = enterpriseCapitalPolicyActive(project);
      const interactiveUserId = policyActive
        ? requireInteractiveCapitalActor(project, authorization)
        : null;
      let createdByUserId = current.created_by_user_id;
      if (
        policyActive &&
        (
          evidenceChanged ||
          (current.status === 'draft' && nextStatus === 'pending')
        )
      ) {
        const actingUserId = interactiveUserId;
        if (createdByUserId && createdByUserId !== actingUserId) {
          throw forbidden(
            'SHARE_TRANSFER_MAKER_MISMATCH',
            'فقط سازندهٔ درخواست می‌تواند شواهد پیش‌نویس را تکمیل و آن را ارسال کند.',
          );
        }
        createdByUserId = actingUserId;
      }
      const nextResolutionId = input.resolutionId === undefined
        ? current.resolution_id
        : nullableText(input.resolutionId, 'resolutionId', 200) ?? null;
      const nextContractId = input.contractId === undefined
        ? current.contract_id
        : nullableText(input.contractId, 'contractId', 200) ?? null;
      const nextPaymentIntentId = input.paymentIntentId === undefined
        ? current.payment_intent_id
        : nullableText(input.paymentIntentId, 'paymentIntentId', 200) ?? null;
      if (evidenceChanged || createdByUserId !== current.created_by_user_id) {
        db.prepare(`
          UPDATE share_transfers
          SET resolution_id=?, contract_id=?, payment_intent_id=?,
              created_by_user_id=?, updated_at=?
          WHERE id=? AND project_id=? AND status='draft'
        `).run(
          nextResolutionId,
          nextContractId,
          nextPaymentIntentId,
          createdByUserId,
          nowIso(clock),
          id,
          projectId,
        );
        current = db.prepare(`
          SELECT * FROM share_transfers WHERE id=? AND project_id=?
        `).get(id, projectId);
      }
      if (policyActive && current.status === 'draft' && nextStatus === 'pending') {
        if (
          !current.resolution_id ||
          !current.contract_id ||
          (Number(current.price_amount || 0) > 0 && !current.payment_intent_id)
        ) {
          throw conflict(
            'SHARE_TRANSFER_EVIDENCE_REQUIRED',
            'مصوبه، قرارداد و برای معاملهٔ دارای مبلغ، سند پرداخت پیش از ارسال الزامی است.',
          );
        }
        requireApprovedTransferResolution(
          project,
          current.resolution_id,
          current,
          current.id,
          { bind: true },
        );
        requireVerifiedTransferKyc(project, current.from_stakeholder_id);
        requireVerifiedTransferKyc(project, current.to_stakeholder_id);
        requireTransferContract(project, current);
        if (current.payment_intent_id) {
          bindTransferPayment(
            project,
            current.id,
            current.payment_intent_id,
            Number(current.price_amount || 0),
          );
        }
      }

      // Repeating an approval is an idempotent read of the already-final result.
      // The unique ledger index is a second database-level guard.
      if (current.status === 'approved' && nextStatus === 'approved') return;

      if (nextStatus === 'approved') {
        let approvedByUserId = null;
        if (policyActive) {
          approvedByUserId = interactiveUserId;
          if (current.created_by_user_id === approvedByUserId) {
            throw forbidden(
              'SHARE_TRANSFER_FOUR_EYES_REQUIRED',
              'سازندهٔ درخواست انتقال نمی‌تواند همان انتقال را تأیید کند.',
            );
          }
          validateEnterpriseTransferCompliance(project, current);
        }
        assertVotingRecordDateUnlocked(projectId);
        // Re-check every invariant while holding an IMMEDIATE transaction. This
        // prevents concurrent approvals from overspending the same balance.
        const references = validateTransferReferences(projectId, {
          shareClassId: current.share_class_id,
          fromStakeholderId: current.from_stakeholder_id,
          toStakeholderId: current.to_stakeholder_id,
          offerId: current.offer_id,
        });
        const capitalState = readCapitalState(projectId);
        assertCapitalBounds(capitalState);
        const balance = holdingUnits(
          capitalState,
          current.from_stakeholder_id,
          current.share_class_id,
        );
        if (balance < Number(current.units)) {
          throw conflict('INSUFFICIENT_SHARES', 'موجودی سهام فروشنده کافی نیست.');
        }
        if (references.offer) {
          if (!['open', 'partially_filled'].includes(references.offer.status)) {
            throw conflict('SHARE_OFFER_CLOSED', 'پیشنهاد سهام بسته شده است.');
          }
          if (
            references.offer.available_until &&
            references.offer.available_until < tehranCalendarDate(clock)
          ) {
            throw conflict('SHARE_OFFER_EXPIRED', 'مهلت پیشنهاد سهام پایان یافته است.');
          }
          if (Number(references.offer.remaining_units) < Number(current.units)) {
            throw conflict('OFFER_UNITS_EXCEEDED', 'مانده پیشنهاد کافی نیست.');
          }
          const listedTotal =
            Number(references.offer.unit_price) * Number(current.units);
          if (!Number.isSafeInteger(listedTotal)) {
            throw badRequest(
              'VALIDATION_FAILED',
              'مبلغ کل انتقال از محدوده عددی امن خارج است.',
            );
          }
          if (Number(current.price_amount) !== listedTotal) {
            throw conflict(
              'OFFER_PRICE_CHANGED',
              'قیمت عرضه پس از ثبت انتقال تغییر کرده است؛ انتقال تازه‌ای ثبت کنید.',
            );
          }
        }
        const createdAt = nowIso(clock);
        const insertLedger = db.prepare(`
          INSERT INTO share_ledger(
            id, project_id, share_class_id, stakeholder_id, entry_type,
            units, related_transfer_id, note, created_at
          ) VALUES(?,?,?,?,?,?,?,?,?)
        `);
        insertLedger.run(
          randomUUID(),
          projectId,
          current.share_class_id,
          current.from_stakeholder_id,
          'transfer_out',
          -Number(current.units),
          id,
          decisionNote,
          createdAt,
        );
        insertLedger.run(
          randomUUID(),
          projectId,
          current.share_class_id,
          current.to_stakeholder_id,
          'transfer_in',
          Number(current.units),
          id,
          decisionNote,
          createdAt,
        );
        if (references.offer) {
          const remaining = Number(references.offer.remaining_units) - Number(current.units);
          db.prepare(`
            UPDATE share_offers
            SET remaining_units=?,
                status=CASE WHEN ?=0 THEN 'filled' ELSE 'partially_filled' END,
                updated_at=?
            WHERE id=? AND project_id=?
          `).run(remaining, remaining, createdAt, references.offer.id, projectId);
          audit(projectId, 'share_offer', references.offer.id, 'filled', {
            transferId: id,
            units: Number(current.units),
            remainingUnits: remaining,
          });
        }
        if (approvedByUserId) {
          db.prepare(`
            UPDATE share_transfers
            SET approved_by_user_id=?, approved_at=?
            WHERE id=? AND project_id=?
          `).run(
            approvedByUserId,
            createdAt,
            id,
            projectId,
          );
        }
      }
      const decidedAt = ['approved', 'rejected', 'cancelled'].includes(nextStatus)
        ? nowIso(clock)
        : null;
      db.prepare(`
        UPDATE share_transfers
        SET status=?, decision_note=?, updated_at=?, decided_at=?
        WHERE id=? AND project_id=?
      `).run(
        nextStatus,
        decisionNote,
        nowIso(clock),
        decidedAt,
        id,
        projectId,
      );
      audit(projectId, 'share_transfer', id, 'status_changed', {
        from: current.status,
        to: nextStatus,
      });
    });
    return {
      shareTransfer: shareTransfers(projectId).shareTransfers.find(
        (item) => item.id === id,
      ),
      capTable: capTable(projectId),
    };
  }

  function financialEntries(projectId) {
    requireProject(projectId);
    return {
      financialEntries: db.prepare(`
        SELECT *
        FROM financial_entries
        WHERE project_id=?
        ORDER BY occurred_on DESC, created_at DESC, id
      `).all(projectId).map(mapFinancial),
    };
  }

  function createFinancialEntry(projectId, input, idempotencyKey) {
    const project = requireProject(projectId);
    const type = enumValue(input.type, FINANCIAL_TYPES, 'type');
    const amount = integer(input.amount, 'amount', { minimum: 0 });
    const occurredOn = isoDate(input.occurredOn, 'occurredOn', {
      required: true,
    });
    const description = text(input.description, 'description', { max: 2_000 });
    const stakeholderId = input.stakeholderId || null;
    const keyHash = hashToken(idempotencyKey);
    const requestHash = operationRequestHash({
      type,
      amount,
      occurredOn,
      description,
      stakeholderId,
    });
    let result;
    withTransaction(db, () => {
      const replay = replayOperationReceipt(
        'financial_entry',
        projectId,
        keyHash,
        requestHash,
      );
      if (replay) {
        result = replay;
        return;
      }
      if (enterpriseCapitalPolicyActive(project)) {
        throw conflict(
          'DOUBLE_ENTRY_FINANCE_REQUIRED',
          'پس از راه‌اندازی فضای سازمانی، ثبت مالی قدیمی غیرفعال است؛ از سند حسابداری دوطرفه استفاده کنید.',
        );
      }
      if (stakeholderId) {
        ensureActiveStakeholder(
          projectId,
          stakeholderId,
          'ذی‌نفع متعلق به این پروژه نیست.',
        );
      }
      assertFinancialDerivedCapacity(projectId, {
        type,
        amount,
        isReversal: false,
      });
      const id = randomUUID();
      db.prepare(`
        INSERT INTO financial_entries(
          id, project_id, type, amount, occurred_on, description,
          stakeholder_id, created_at, reversal_of_entry_id
        ) VALUES(?,?,?,?,?,?,?,?,NULL)
      `).run(
        id,
        projectId,
        type,
        amount,
        occurredOn,
        description,
        stakeholderId,
        nowIso(clock),
      );
      syncLegacyFinance(db, nowIso(clock));
      audit(projectId, 'financial_entry', id, 'posted', { type, amount });
      const response = {
        financialEntry: financialEntries(projectId).financialEntries.find(
          (item) => item.id === id,
        ),
      };
      saveOperationReceipt(
        'financial_entry',
        projectId,
        keyHash,
        requestHash,
        id,
        response,
      );
      result = { ...response, idempotentReplay: false };
    });
    return result;
  }

  function reverseFinancialEntry(projectId, id, input = {}) {
    const project = requireProject(projectId);
    if (enterpriseCapitalPolicyActive(project)) {
      throw conflict(
        'DOUBLE_ENTRY_FINANCE_REQUIRED',
        'اصلاح ثبت مالی قدیمی پس از راه‌اندازی فضای سازمانی غیرفعال است؛ از سند اصلاحی حسابداری دوطرفه استفاده کنید.',
      );
    }
    const reversalId = randomUUID();
    const occurredOn = input.occurredOn === undefined
      ? nowIso(clock).slice(0, 10)
      : isoDate(input.occurredOn, 'occurredOn', { required: true });
    const description = text(
      input.description ?? `اصلاح ثبت ${id}`,
      'description',
      { max: 2_000 },
    );
    withTransaction(db, () => {
      const original = ensureProjectReference(
        projectId,
        'financial_entries',
        id,
        'INVALID_FINANCIAL_ENTRY',
        'ثبت مالی متعلق به این پروژه نیست.',
      );
      if (original.reversal_of_entry_id) {
        throw conflict('REVERSAL_OF_REVERSAL', 'ثبت اصلاحی قابل اصلاح دوباره نیست.');
      }
      if (db.prepare(
        'SELECT 1 FROM financial_entries WHERE reversal_of_entry_id=?',
      ).get(id)) {
        throw conflict('ENTRY_ALREADY_REVERSED', 'این ثبت قبلاً اصلاح شده است.');
      }
      assertFinancialDerivedCapacity(projectId, {
        type: original.type,
        amount: Number(original.amount),
        isReversal: true,
      });
      db.prepare(`
        INSERT INTO financial_entries(
          id, project_id, type, amount, occurred_on, description,
          stakeholder_id, created_at, reversal_of_entry_id
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `).run(
        reversalId,
        projectId,
        original.type,
        original.amount,
        occurredOn,
        description,
        original.stakeholder_id,
        nowIso(clock),
        id,
      );
      syncLegacyFinance(db, nowIso(clock));
      audit(projectId, 'financial_entry', reversalId, 'reversal_posted', {
        reversalOfEntryId: id,
        type: original.type,
        amount: Number(original.amount),
      });
    });
    return {
      financialEntry: financialEntries(projectId).financialEntries.find(
        (item) => item.id === reversalId,
      ),
    };
  }

  function goals(projectId) {
    requireProject(projectId);
    const goalRows = db.prepare(`
      SELECT *
      FROM project_goals
      WHERE project_id=?
      ORDER BY created_at, id
    `).all(projectId);
    const milestoneStatement = db.prepare(`
      SELECT *
      FROM goal_milestones
      WHERE goal_id=?
      ORDER BY created_at, id
    `);
    return {
      goals: goalRows.map((row) => {
        const milestones = milestoneStatement.all(row.id).map((milestone) => ({
          id: milestone.id,
          title: milestone.title,
          weight: Number(milestone.weight),
          completed: Boolean(milestone.completed_at),
          completedAt: milestone.completed_at,
          createdAt: milestone.created_at,
          updatedAt: milestone.updated_at,
        }));
        const totalWeight = milestones.reduce((sum, item) => sum + item.weight, 0);
        const completedWeight = milestones
          .filter((item) => item.completed)
          .reduce((sum, item) => sum + item.weight, 0);
        const progressPercent = totalWeight
          ? (completedWeight / totalWeight) * 100
          : row.status === 'completed' ? 100 : 0;
        return {
          id: row.id,
          title: row.title,
          description: row.description,
          weight: Number(row.weight),
          status: row.status,
          dueDate: row.due_date,
          progressPercent,
          milestones,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    };
  }

  function createGoal(projectId, input) {
    requireProject(projectId);
    const id = randomUUID();
    const now = nowIso(clock);
    const status = enumValue(input.status, GOAL_STATUSES, 'status', 'planned');
    const weight = positiveNumber(input.weight, 'weight', 1);
    assertWeightAggregateCapacity(
      'project_goals',
      'project_id',
      projectId,
      id,
      weight,
    );
    db.prepare(`
      INSERT INTO project_goals(
        id, project_id, title, description, weight, status,
        due_date, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      projectId,
      text(input.title, 'title', { required: true, max: 200 }),
      text(input.description, 'description', { max: 2_000 }),
      weight,
      status,
      optionalIsoDate(input.dueDate, 'dueDate') ?? null,
      now,
      now,
    );
    audit(projectId, 'goal', id, 'created', { status, weight });
    return { goal: goals(projectId).goals.find((item) => item.id === id) };
  }

  function patchGoal(projectId, id, input) {
    requireProject(projectId);
    const current = ensureProjectReference(
      projectId,
      'project_goals',
      id,
      'INVALID_GOAL',
      'هدف متعلق به این پروژه نیست.',
    );
    const status = enumValue(input.status, GOAL_STATUSES, 'status', current.status);
    const weight = input.weight === undefined
      ? Number(current.weight)
      : positiveNumber(input.weight, 'weight');
    assertWeightAggregateCapacity(
      'project_goals',
      'project_id',
      projectId,
      id,
      weight,
    );
    db.prepare(`
      UPDATE project_goals
      SET title=?, description=?, weight=?, status=?, due_date=?, updated_at=?
      WHERE id=? AND project_id=?
    `).run(
      input.title === undefined
        ? current.title
        : text(input.title, 'title', { required: true, max: 200 }),
      input.description === undefined
        ? current.description
        : text(input.description, 'description', { max: 2_000 }),
      weight,
      status,
      input.dueDate === undefined
        ? current.due_date
        : optionalIsoDate(input.dueDate, 'dueDate'),
      nowIso(clock),
      id,
      projectId,
    );
    audit(projectId, 'goal', id, 'updated', { status, weight });
    return { goal: goals(projectId).goals.find((item) => item.id === id) };
  }

  function createMilestone(projectId, goalId, input) {
    requireProject(projectId);
    ensureProjectReference(
      projectId,
      'project_goals',
      goalId,
      'INVALID_GOAL',
      'هدف متعلق به این پروژه نیست.',
    );
    const id = randomUUID();
    const now = nowIso(clock);
    const weight = positiveNumber(input.weight, 'weight', 1);
    assertWeightAggregateCapacity(
      'goal_milestones',
      'goal_id',
      goalId,
      id,
      weight,
    );
    const completed = booleanValue(input.completed, 'completed', false);
    db.prepare(`
      INSERT INTO goal_milestones(
        id, goal_id, title, weight, completed_at, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      id,
      goalId,
      text(input.title, 'title', { required: true, max: 200 }),
      weight,
      completed ? now : null,
      now,
      now,
    );
    audit(projectId, 'goal_milestone', id, 'created', { goalId, weight });
    return {
      milestone: goals(projectId).goals
        .find((goal) => goal.id === goalId)
        ?.milestones.find((item) => item.id === id),
    };
  }

  function patchMilestone(projectId, goalId, id, input) {
    requireProject(projectId);
    const milestone = db.prepare(`
      SELECT m.*
      FROM goal_milestones m
      JOIN project_goals g ON g.id=m.goal_id
      WHERE m.id=? AND m.goal_id=? AND g.project_id=?
    `).get(id, goalId, projectId);
    if (!milestone) {
      throw badRequest('INVALID_MILESTONE', 'مرحله متعلق به این هدف و پروژه نیست.');
    }
    const now = nowIso(clock);
    const completed = booleanValue(
      input.completed,
      'completed',
      Boolean(milestone.completed_at),
    );
    const weight = input.weight === undefined
      ? Number(milestone.weight)
      : positiveNumber(input.weight, 'weight');
    assertWeightAggregateCapacity(
      'goal_milestones',
      'goal_id',
      goalId,
      id,
      weight,
    );
    db.prepare(`
      UPDATE goal_milestones
      SET title=?, weight=?, completed_at=?, updated_at=?
      WHERE id=? AND goal_id=?
    `).run(
      input.title === undefined
        ? milestone.title
        : text(input.title, 'title', { required: true, max: 200 }),
      weight,
      completed
        ? milestone.completed_at || now
        : null,
      now,
      id,
      goalId,
    );
    audit(projectId, 'goal_milestone', id, 'updated', { goalId });
    return {
      milestone: goals(projectId).goals
        .find((goal) => goal.id === goalId)
        ?.milestones.find((item) => item.id === id),
    };
  }

  function resolutionTallies(resolutionId) {
    const rows = db.prepare(`
      SELECT choice, voting_power
      FROM resolution_votes
      WHERE resolution_id=?
      ORDER BY created_at, id
    `).all(resolutionId);
    const result = {
      yes: { voters: 0, votingPower: 0 },
      no: { voters: 0, votingPower: 0 },
      abstain: { voters: 0, votingPower: 0 },
    };
    for (const row of rows) {
      const votingPower = Number(row.voting_power);
      const choiceTally = result[row.choice];
      const nextPower = choiceTally?.votingPower + votingPower;
      if (
        !choiceTally ||
        !Number.isFinite(votingPower) ||
        votingPower < 0 ||
        votingPower > Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(nextPower) ||
        nextPower > Number.MAX_SAFE_INTEGER
      ) {
        throw conflict(
          'VOTING_AGGREGATE_INVALID',
          'جمع قدرت رأی این مصوبه خارج از محدودهٔ عددی امن است.',
        );
      }
      choiceTally.voters += 1;
      choiceTally.votingPower = nextPower;
    }
    return result;
  }

  function meetings(projectId, { publicOnly = false } = {}) {
    requireProject(projectId, { publicOnly });
    const meetingRows = db.prepare(`
      SELECT *
      FROM project_meetings
      WHERE project_id=?
        ${publicOnly ? 'AND public_visible=1' : ''}
      ORDER BY scheduled_at DESC, id
    `).all(projectId);
    const attendeeStatement = db.prepare(`
      SELECT a.*, s.name, s.role
      FROM meeting_attendees a
      JOIN project_stakeholders s ON s.id=a.stakeholder_id
      WHERE a.meeting_id=?
      ORDER BY s.name, s.id
    `);
    const resolutionStatement = db.prepare(`
      SELECT *
      FROM meeting_resolutions
      WHERE meeting_id=?
        ${publicOnly ? 'AND public_visible=1' : ''}
      ORDER BY created_at, id
    `);
    return {
      meetings: meetingRows.map((meeting) => ({
        id: meeting.id,
        title: meeting.title,
        scheduledAt: meeting.scheduled_at,
        location: meeting.location,
        minutes: publicOnly && !meeting.public_visible ? '' : meeting.minutes,
        status: meeting.status,
        publicVisible: Boolean(meeting.public_visible),
        attendees: publicOnly
          ? undefined
          : attendeeStatement.all(meeting.id).map((attendee) => ({
            stakeholderId: attendee.stakeholder_id,
            stakeholderName: attendee.name,
            stakeholderRole: attendee.role,
            attendance: attendee.attendance,
            createdAt: attendee.created_at,
            updatedAt: attendee.updated_at,
          })),
        resolutions: resolutionStatement.all(meeting.id).map((resolution) => ({
          id: resolution.id,
          title: resolution.title,
          description: resolution.description,
          status: resolution.status,
          decision: resolution.decision,
          decidedAt: resolution.decided_at,
          result: parseJson(resolution.result_json, {}),
          operationType: resolution.operation_type || null,
          operationScope: resolution.operation_type
            ? parseJson(resolution.operation_scope_json, {})
            : null,
          operationRequestHash: resolution.operation_request_hash || null,
          publicVisible: Boolean(resolution.public_visible),
          tally: resolutionTallies(resolution.id),
          createdAt: resolution.created_at,
          updatedAt: resolution.updated_at,
        })),
        createdAt: meeting.created_at,
        updatedAt: meeting.updated_at,
      })),
    };
  }

  function createMeeting(projectId, input) {
    requireProject(projectId);
    const status = enumValue(input.status, MEETING_STATUSES, 'status', 'scheduled');
    const id = randomUUID();
    const now = nowIso(clock);
    db.prepare(`
      INSERT INTO project_meetings(
        id, project_id, title, scheduled_at, location, minutes, status,
        created_at, updated_at, public_visible
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      projectId,
      text(input.title, 'title', { required: true, max: 200 }),
      isoDateTime(input.scheduledAt, 'scheduledAt'),
      text(input.location, 'location', { max: 300 }),
      text(input.minutes, 'minutes', { max: 20_000 }),
      status,
      now,
      now,
      booleanInteger(input.publicVisible),
    );
    audit(projectId, 'meeting', id, 'created', { status });
    return {
      meeting: meetings(projectId).meetings.find((item) => item.id === id),
    };
  }

  function patchMeeting(projectId, id, input) {
    requireProject(projectId);
    const current = ensureProjectReference(
      projectId,
      'project_meetings',
      id,
      'INVALID_MEETING',
      'جلسه متعلق به این پروژه نیست.',
    );
    const status = enumValue(input.status, MEETING_STATUSES, 'status', current.status);
    db.prepare(`
      UPDATE project_meetings
      SET title=?, scheduled_at=?, location=?, minutes=?, status=?,
          public_visible=?, updated_at=?
      WHERE id=? AND project_id=?
    `).run(
      input.title === undefined
        ? current.title
        : text(input.title, 'title', { required: true, max: 200 }),
      input.scheduledAt === undefined
        ? current.scheduled_at
        : isoDateTime(input.scheduledAt, 'scheduledAt'),
      input.location === undefined
        ? current.location
        : text(input.location, 'location', { max: 300 }),
      input.minutes === undefined
        ? current.minutes
        : text(input.minutes, 'minutes', { max: 20_000 }),
      status,
      booleanInteger(input.publicVisible, Boolean(current.public_visible)),
      nowIso(clock),
      id,
      projectId,
    );
    audit(projectId, 'meeting', id, 'updated', { status });
    return {
      meeting: meetings(projectId).meetings.find((item) => item.id === id),
    };
  }

  function setAttendance(projectId, meetingId, stakeholderId, input) {
    requireProject(projectId);
    ensureProjectReference(
      projectId,
      'project_meetings',
      meetingId,
      'INVALID_MEETING',
      'جلسه متعلق به این پروژه نیست.',
    );
    ensureActiveStakeholder(
      projectId,
      stakeholderId,
      'عضو متعلق به این پروژه نیست.',
    );
    const attendance = enumValue(
      input.attendance,
      new Set(['invited', 'present', 'absent']),
      'attendance',
    );
    const now = nowIso(clock);
    db.prepare(`
      INSERT INTO meeting_attendees(
        meeting_id, stakeholder_id, attendance, created_at, updated_at
      ) VALUES(?,?,?,?,?)
      ON CONFLICT(meeting_id, stakeholder_id) DO UPDATE SET
        attendance=excluded.attendance,
        updated_at=excluded.updated_at
    `).run(meetingId, stakeholderId, attendance, now, now);
    audit(projectId, 'meeting_attendance', `${meetingId}:${stakeholderId}`, 'recorded', {
      attendance,
    });
    return {
      meeting: meetings(projectId).meetings.find((item) => item.id === meetingId),
    };
  }

  function createResolution(projectId, meetingId, input) {
    const project = requireProject(projectId);
    ensureProjectReference(
      projectId,
      'project_meetings',
      meetingId,
      'INVALID_MEETING',
      'جلسه متعلق به این پروژه نیست.',
    );
    const status = enumValue(input.status, RESOLUTION_STATUSES, 'status', 'draft');
    if (status === 'closed') {
      throw conflict(
        'INVALID_STATUS_TRANSITION',
        'مصوبه باید پیش از بسته‌شدن، وارد وضعیت رأی‌گیری باز شود.',
      );
    }
    const id = randomUUID();
    const now = nowIso(clock);
    const decision = nullableText(input.decision, 'decision', 5_000) ?? null;
    const operation = normalizeResolutionOperationScope(
      project,
      input.operationScope,
    );
    db.prepare(`
      INSERT INTO meeting_resolutions(
        id, meeting_id, title, description, status, created_at, updated_at,
        public_visible, decision, decided_at, operation_type,
        operation_scope_json, operation_request_hash
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      meetingId,
      text(input.title, 'title', { required: true, max: 300 }),
      text(input.description, 'description', { max: 5_000 }),
      status,
      now,
      now,
      booleanInteger(input.publicVisible),
      decision,
      status === 'closed' ? now : null,
      operation?.operationType || null,
      operation ? JSON.stringify(operation.scope) : '{}',
      operation?.requestHash || null,
    );
    audit(projectId, 'resolution', id, 'created', { meetingId, status });
    return {
      resolution: meetings(projectId).meetings
        .find((item) => item.id === meetingId)
        ?.resolutions.find((item) => item.id === id),
    };
  }

  function patchResolution(projectId, meetingId, id, input) {
    const project = requireProject(projectId);
    const current = db.prepare(`
      SELECT r.*
      FROM meeting_resolutions r
      JOIN project_meetings m ON m.id=r.meeting_id
      WHERE r.id=? AND r.meeting_id=? AND m.project_id=?
    `).get(id, meetingId, projectId);
    if (!current) {
      throw badRequest('INVALID_RESOLUTION', 'مصوبه متعلق به این جلسه و پروژه نیست.');
    }
    const status = enumValue(input.status, RESOLUTION_STATUSES, 'status', current.status);
    const allowed = {
      draft: new Set(['draft', 'open']),
      open: new Set(['open', 'closed']),
      closed: new Set(['closed']),
    };
    if (!allowed[current.status].has(status)) {
      throw conflict('INVALID_STATUS_TRANSITION', 'تغییر وضعیت مصوبه مجاز نیست.');
    }
    if (input.operationScope !== undefined && current.status !== 'draft') {
      throw conflict(
        'RESOLUTION_SCOPE_IMMUTABLE',
        'The operation scope cannot change after resolution voting opens.',
      );
    }
    const operation = input.operationScope === undefined
      ? {
        operationType: current.operation_type,
        scopeJson: current.operation_scope_json || '{}',
        requestHash: current.operation_request_hash,
      }
      : (() => {
        const normalized = normalizeResolutionOperationScope(
          project,
          input.operationScope,
        );
        return {
          operationType: normalized?.operationType || null,
          scopeJson: normalized ? JSON.stringify(normalized.scope) : '{}',
          requestHash: normalized?.requestHash || null,
        };
      })();
    const title = input.title === undefined
      ? current.title
      : text(input.title, 'title', { required: true, max: 300 });
    const description = input.description === undefined
      ? current.description
      : text(input.description, 'description', { max: 5_000 });
    const publicVisible = booleanInteger(
      input.publicVisible,
      Boolean(current.public_visible),
    );
    const decision = input.decision === undefined
      ? current.decision
      : nullableText(input.decision, 'decision', 5_000);
    if (current.status === 'open' && status === 'closed') {
      if (typeof financeStore?.finalizeResolutionOutcome !== 'function') {
        throw conflict(
          'RESOLUTION_FINALIZATION_REQUIRED',
          'The resolution outcome must be calculated and closed atomically.',
        );
      }
      financeStore.finalizeResolutionOutcome(
        projectId,
        meetingId,
        id,
        { decision },
      );
    }
    const now = nowIso(clock);
    db.prepare(`
      UPDATE meeting_resolutions
      SET title=?, description=?, status=?, public_visible=?, decision=?,
          decided_at=?, operation_type=?, operation_scope_json=?,
          operation_request_hash=?, updated_at=?
      WHERE id=? AND meeting_id=?
    `).run(
      title,
      description,
      status,
      publicVisible,
      decision,
      status === 'closed'
        ? current.decided_at || now
        : null,
      operation.operationType,
      operation.scopeJson,
      operation.requestHash,
      now,
      id,
      meetingId,
    );
    audit(projectId, 'resolution', id, 'updated', {
      meetingId,
      from: current.status,
      to: status,
    });
    return {
      resolution: meetings(projectId).meetings
        .find((item) => item.id === meetingId)
        ?.resolutions.find((item) => item.id === id),
    };
  }

  function vote(
    projectId,
    meetingId,
    resolutionId,
    input,
    authorization = null,
  ) {
    const project = requireProject(projectId);
    const resolution = db.prepare(`
      SELECT r.id, r.meeting_id
      FROM meeting_resolutions r
      JOIN project_meetings m ON m.id=r.meeting_id
      WHERE r.id=? AND r.meeting_id=? AND m.project_id=? AND r.status='open'
    `).get(resolutionId, meetingId, projectId);
    if (!resolution) {
      throw conflict('RESOLUTION_NOT_OPEN', 'مصوبه باز نیست.');
    }
    const stakeholder = ensureActiveStakeholder(
      projectId,
      input.stakeholderId,
      'رأی‌دهنده متعلق به این پروژه نیست.',
    );
    let actingUserId = null;
    let proxy = null;
    if (enterpriseCapitalPolicyActive(project)) {
      actingUserId = requireInteractiveCapitalActor(project, authorization);
      if (stakeholder.user_id !== actingUserId) {
        const currentTime = nowIso(clock);
        proxy = db.prepare(`
          SELECT proxy.*
          FROM governance_proxies proxy
          JOIN project_stakeholders proxy_holder
            ON proxy_holder.id=proxy.proxy_stakeholder_id
           AND proxy_holder.project_id=proxy.project_id
           AND proxy_holder.archived_at IS NULL
          WHERE proxy.project_id=?
            AND proxy.meeting_id=?
            AND proxy.grantor_stakeholder_id=?
            AND proxy_holder.user_id=?
            AND proxy.status='active'
            AND proxy.granted_at<=?
            AND (proxy.expires_at IS NULL OR proxy.expires_at>?)
            AND (
              proxy.scope='meeting' OR
              (proxy.scope='resolution' AND proxy.resolution_id=?)
            )
          ORDER BY proxy.created_at DESC, proxy.id
          LIMIT 1
        `).get(
          projectId,
          meetingId,
          stakeholder.id,
          actingUserId,
          currentTime,
          currentTime,
          resolutionId,
        );
        if (!proxy) {
          throw forbidden(
            'VOTE_STAKEHOLDER_IDENTITY_REQUIRED',
            'A vote requires the linked stakeholder user or a valid proxy.',
          );
        }
      }
    }
    const choice = enumValue(input.choice, VOTE_CHOICES, 'choice');
    const capitalState = readCapitalState(projectId);
    const capitalTotals = assertCapitalBounds(capitalState);
    const calculatedPower =
      capitalTotals.votingPowerByStakeholder.get(input.stakeholderId) || 0;
    // Non-equity board members keep one governance vote. Equity holders use the
    // immutable ledger-derived snapshot at the instant the vote is recorded.
    let calculatedSnapshot = calculatedPower;
    if (calculatedSnapshot <= 0) {
      if (stakeholder.role !== 'board') {
        throw conflict(
          'NO_VOTING_POWER',
          'این عضو در تاریخ ثبت رأی، سهام دارای حق رأی یا نقش هیئت‌مدیره ندارد.',
        );
      }
      calculatedSnapshot = 1;
    }
    if (proxy) {
      const delegatedPower = Number(proxy.voting_power);
      if (!Number.isSafeInteger(delegatedPower) || delegatedPower <= 0) {
        throw conflict(
          'PROXY_VOTING_POWER_INVALID',
          'The delegated voting power is outside the safe numeric range.',
        );
      }
      if (delegatedPower !== calculatedSnapshot) {
        throw conflict(
          'PARTIAL_PROXY_NOT_SUPPORTED',
          'The proxy must represent the stakeholder full voting power because split voting is not supported.',
        );
      }
      calculatedSnapshot = delegatedPower;
    }
    const now = nowIso(clock);
    const previous = db.prepare(`
      SELECT id, voting_power FROM resolution_votes
      WHERE resolution_id=? AND stakeholder_id=?
    `).get(resolutionId, input.stakeholderId);
    const votingPower = proxy
      ? calculatedSnapshot
      : previous
        ? Number(previous.voting_power)
        : calculatedSnapshot;
    const otherVotes = db.prepare(`
      SELECT voting_power
      FROM resolution_votes
      WHERE resolution_id=? AND stakeholder_id<>?
    `).all(resolutionId, input.stakeholderId);
    let resolutionVotingPower = votingPower;
    for (const row of otherVotes) {
      resolutionVotingPower += Number(row.voting_power);
    }
    if (
      !Number.isFinite(votingPower) ||
      votingPower < 0 ||
      votingPower > Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(resolutionVotingPower) ||
      resolutionVotingPower > Number.MAX_SAFE_INTEGER
    ) {
      throw conflict(
        'VOTING_POWER_LIMIT_EXCEEDED',
        'ثبت این رأی جمع قدرت رأی مصوبه را از محدودهٔ عددی امن خارج می‌کند.',
      );
    }
    db.prepare(`
      INSERT INTO resolution_votes(
        id, resolution_id, stakeholder_id, choice, voting_power,
        created_at, updated_at, cast_by_user_id, proxy_id
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(resolution_id, stakeholder_id) DO UPDATE SET
        choice=excluded.choice,
        voting_power=excluded.voting_power,
        cast_by_user_id=excluded.cast_by_user_id,
        proxy_id=excluded.proxy_id,
        updated_at=excluded.updated_at
    `).run(
      previous?.id || randomUUID(),
      resolutionId,
      input.stakeholderId,
      choice,
      votingPower,
      now,
      now,
      actingUserId,
      proxy?.id || null,
    );
    audit(projectId, 'resolution_vote', `${resolutionId}:${input.stakeholderId}`, 'recorded', {
      choice,
      votingPower,
      castByUserId: actingUserId,
      proxyId: proxy?.id || null,
    });
    return {
      resolutionId,
      choice,
      votingPower,
      castByUserId: actingUserId,
      proxyId: proxy?.id || null,
      tally: resolutionTallies(resolutionId),
    };
  }

  function participationMetrics(projectId) {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(
          CASE WHEN EXISTS(
            SELECT 1
            FROM proposals p
            WHERE p.need_id=n.id AND p.status='accepted'
          ) THEN 1 ELSE 0 END
        ) AS completed
      FROM needs n
      WHERE n.project_id=? AND n.archived_at IS NULL
    `).get(projectId);
    const total = Number(row.total);
    const completed = Number(row.completed || 0);
    return {
      totalNeeds: total,
      committedNeeds: completed,
      participationCompletionPercent: total ? (completed / total) * 100 : 0,
    };
  }

  function enterpriseExecution(projectId) {
    if (!operationsStore) return null;
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM project_tasks
         WHERE project_id=? AND archived_at IS NULL AND status<>'cancelled') AS tasks,
        (SELECT COUNT(*) FROM project_phases
         WHERE project_id=? AND archived_at IS NULL AND status<>'cancelled') AS phases
    `).get(projectId, projectId);
    if (!Number(counts.tasks) && !Number(counts.phases)) return null;
    return operationsStore.dashboard(projectId);
  }

  function enterpriseFinancialSummary(projectId) {
    if (!financeStore) return null;
    const pnl = financeStore.profitAndLoss(projectId);
    const returns = financeStore.returnsReport(projectId, {
      asOf: nowIso(clock).slice(0, 10),
    });
    const investedCapital = returns.investedCapital;
    const distribution = returns.distributions.paid;
    const valuation = returns.latestValuation?.amount ??
      requireProject(projectId, { includeArchived: true }).valuation_amount ??
      null;
    const margin = pnl.revenue ? pnl.netIncome / pnl.revenue : 0;
    const roi = investedCapital ? pnl.netIncome / investedCapital : null;
    const periodRows = db.prepare(`
      SELECT
        substr(j.occurred_on,1,7) AS period,
        a.account_type,
        CAST(l.debit AS TEXT) AS debit_text,
        CAST(l.credit AS TEXT) AS credit_text
      FROM journal_entries j
      JOIN journal_lines l ON l.journal_entry_id=j.id
      JOIN accounting_accounts a ON a.id=l.account_id
      WHERE j.project_id=? AND j.status IN ('posted','reversed')
        AND a.account_type IN ('revenue','expense')
      ORDER BY j.occurred_on, j.entry_no, l.id
    `).all(projectId);
    const periodTotals = new Map();
    for (const row of periodRows) {
      const current = periodTotals.get(row.period) || {
        revenue: 0n,
        expense: 0n,
      };
      if (row.account_type === 'revenue') {
        current.revenue +=
          BigInt(row.credit_text) - BigInt(row.debit_text);
      } else {
        current.expense +=
          BigInt(row.debit_text) - BigInt(row.credit_text);
      }
      periodTotals.set(row.period, current);
    }
    const periods = [...periodTotals]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-12)
      .map(([period, totals]) => {
      const revenue = safeBigIntToNumber(totals.revenue);
      const expense = safeBigIntToNumber(totals.expense);
      const netProfit = revenue === null || expense === null
        ? null
        : safeIntegerAdd(revenue, -expense);
      const overflow =
        revenue === null || expense === null || netProfit === null;
      return {
        period,
        revenue,
        expense,
        investment: 0,
        distribution: 0,
        netProfit,
        cashFlow: netProfit,
        overflow,
        ...(overflow
          ? {
              exact: {
                revenue: totals.revenue.toString(),
                expense: totals.expense.toString(),
              },
            }
          : {}),
      };
    });
    return {
      revenue: pnl.revenue,
      expense: pnl.expense,
      investedCapital,
      investment: investedCapital,
      distribution,
      distributionEntitlements: returns.distributions.total,
      valuation,
      netProfit: pnl.netIncome,
      margin,
      roi,
      marginPercent: margin * 100,
      roiPercent: roi === null ? null : roi * 100,
      netCash: pnl.revenue + investedCapital - pnl.expense - distribution,
      overflow: false,
      periods,
      source: 'posted_double_entry',
      asOf: returns.asOf,
    };
  }

  function financialSummary(projectId) {
    const enterprise = enterpriseFinancialSummary(projectId);
    if (enterprise) return enterprise;
    const entries = financialEntries(projectId).financialEntries;
    const effectiveAmount = (entry) => entry.isReversal
      ? -BigInt(entry.amount)
      : BigInt(entry.amount);
    const sum = (type) => safeBigIntToNumber(entries
      .filter((entry) => entry.type === type)
      .reduce((total, entry) => total + effectiveAmount(entry), 0n));
    const revenue = sum('revenue');
    const expense = sum('expense');
    const investedCapital = sum('investment');
    const distribution = sum('distribution');
    const overflow = [revenue, expense, investedCapital, distribution]
      .some((value) => value === null);
    const netProfit = overflow ? null : safeIntegerAdd(revenue, -expense);
    const latestValuation = entries
      .filter((entry) => entry.type === 'valuation' && !entry.isReversal)
      .find((entry) => !entries.some(
        (candidate) => candidate.reversalOfEntryId === entry.id,
      ));
    const periodMap = new Map();
    for (const entry of entries) {
      const period = /^\d{4}-\d{2}/.exec(entry.occurredOn)?.[0];
      if (!period || entry.type === 'valuation') continue;
      const current = periodMap.get(period) || {
        period,
        revenue: 0n,
        expense: 0n,
        investment: 0n,
        distribution: 0n,
      };
      current[entry.type] += effectiveAmount(entry);
      periodMap.set(period, current);
    }
    const periods = [...periodMap.values()]
      .sort((left, right) => left.period.localeCompare(right.period))
      .slice(-12)
      .map((period) => {
        const netProfitExact = period.revenue - period.expense;
        const cashFlowExact = period.revenue + period.investment
          - period.expense - period.distribution;
        const revenueValue = safeBigIntToNumber(period.revenue);
        const expenseValue = safeBigIntToNumber(period.expense);
        const investmentValue = safeBigIntToNumber(period.investment);
        const distributionValue = safeBigIntToNumber(period.distribution);
        const netProfitValue = safeBigIntToNumber(netProfitExact);
        const cashFlowValue = safeBigIntToNumber(cashFlowExact);
        const periodOverflow = [
          revenueValue,
          expenseValue,
          investmentValue,
          distributionValue,
          netProfitValue,
          cashFlowValue,
        ].some((value) => value === null);
        return {
          period: period.period,
          revenue: revenueValue,
          expense: expenseValue,
          investment: investmentValue,
          distribution: distributionValue,
          netProfit: netProfitValue,
          cashFlow: cashFlowValue,
          overflow: periodOverflow,
          exact: periodOverflow
            ? {
              revenue: period.revenue.toString(),
              expense: period.expense.toString(),
              investment: period.investment.toString(),
              distribution: period.distribution.toString(),
              netProfit: netProfitExact.toString(),
              cashFlow: cashFlowExact.toString(),
            }
            : undefined,
        };
      });
    const projectValuation = requireProject(projectId, {
      includeArchived: true,
    }).valuation_amount;
    return {
      revenue,
      expense,
      investedCapital,
      investment: investedCapital,
      distribution,
      valuation: latestValuation?.amount ?? projectValuation ?? null,
      netProfit,
      margin: overflow ? null : revenue ? netProfit / revenue : 0,
      roi: overflow ? null : investedCapital ? netProfit / investedCapital : null,
      marginPercent: overflow ? null : revenue ? (netProfit / revenue) * 100 : 0,
      roiPercent: overflow
        ? null
        : investedCapital ? (netProfit / investedCapital) * 100 : null,
      netCash: overflow
        ? null
        : safeBigIntToNumber(
          BigInt(revenue) + BigInt(investedCapital)
            - BigInt(expense) - BigInt(distribution),
        ),
      overflow,
      periods,
    };
  }

  function stakeholderReturns(projectId, valuation) {
    const stakeholderRows = db.prepare(`
      SELECT id, name, role
      FROM project_stakeholders
      WHERE project_id=?
      ORDER BY archived_at IS NOT NULL, name, id
    `).all(projectId);
    const financialRows = db.prepare(`
      SELECT
        stakeholder_id,
        type,
        amount,
        reversal_of_entry_id
      FROM financial_entries
      WHERE project_id=? AND stakeholder_id IS NOT NULL
        AND type IN ('investment','distribution')
    `).all(projectId);
    const holdingsRows = db.prepare(`
      SELECT stakeholder_id, units
      FROM share_ledger
      WHERE project_id=?
    `).all(projectId);
    const financeByStakeholder = new Map();
    for (const row of financialRows) {
      const current = financeByStakeholder.get(row.stakeholder_id) || {
        investment: 0n,
        distribution: 0n,
      };
      current[row.type] += row.reversal_of_entry_id
        ? -BigInt(Number(row.amount))
        : BigInt(Number(row.amount));
      financeByStakeholder.set(row.stakeholder_id, current);
    }
    const unitTotals = new Map();
    for (const row of holdingsRows) {
      const units = Number(row.units);
      if (!Number.isSafeInteger(units)) capitalRangeError();
      unitTotals.set(
        row.stakeholder_id,
        (unitTotals.get(row.stakeholder_id) || 0n) + BigInt(units),
      );
    }
    const unitsByStakeholder = new Map();
    let totalUnitsBigInt = 0n;
    for (const [stakeholderId, units] of unitTotals) {
      const safeUnits = safeBigIntToNumber(units);
      if (safeUnits === null || safeUnits < 0) capitalRangeError();
      unitsByStakeholder.set(stakeholderId, safeUnits);
      totalUnitsBigInt += units;
    }
    const totalUnits = safeBigIntToNumber(totalUnitsBigInt);
    if (totalUnits === null) capitalRangeError();
    return stakeholderRows.map((stakeholder) => {
      const financeTotals = financeByStakeholder.get(stakeholder.id) || {
        investment: 0n,
        distribution: 0n,
      };
      const finance = {
        investedCapital: safeBigIntToNumber(financeTotals.investment),
        distributions: safeBigIntToNumber(financeTotals.distribution),
      };
      const units = unitsByStakeholder.get(stakeholder.id) || 0;
      const ownershipPercent = totalUnits ? (units / totalUnits) * 100 : 0;
      const ownershipValue = valuation === null || !totalUnits
        ? null
        : Number(valuation) * (units / totalUnits);
      const roiPercent = finance.investedCapital && ownershipValue !== null
        ? (
          (
            finance.distributions +
            ownershipValue -
            finance.investedCapital
          ) / finance.investedCapital
        ) * 100
        : null;
      return {
        stakeholderId: stakeholder.id,
        stakeholderName: stakeholder.name,
        stakeholderRole: stakeholder.role,
        investedCapital: finance.investedCapital,
        distributions: finance.distributions,
        distribution: finance.distributions,
        units,
        ownershipPercent,
        ownershipValue,
        estimatedValue: ownershipValue,
        roiPercent,
        estimate: true,
        estimateBasis: 'aggregate-unit-share-of-latest-valuation',
      };
    });
  }

  function goalMetrics(projectId) {
    const activeGoals = goals(projectId).goals.filter(
      (goal) => goal.status !== 'cancelled',
    );
    const totalWeight = activeGoals.reduce((sum, goal) => sum + goal.weight, 0);
    const goalProgressPercent = totalWeight
      ? activeGoals.reduce(
        (sum, goal) => sum + goal.weight * goal.progressPercent,
        0,
      ) / totalWeight
      : 0;
    return {
      count: activeGoals.length,
      completedCount: activeGoals.filter((goal) => goal.progressPercent === 100).length,
      goalProgressPercent,
    };
  }

  function governanceMetrics(projectId, publicOnly = false) {
    const visibility = publicOnly ? 'AND m.public_visible=1' : '';
    const meetingsCount = Number(db.prepare(`
      SELECT COUNT(*) AS value
      FROM project_meetings m
      WHERE m.project_id=? ${visibility}
    `).get(projectId).value);
    const resolutionVisibility = publicOnly
      ? 'AND m.public_visible=1 AND r.public_visible=1'
      : '';
    const resolutionCounts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN r.status='open' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN r.status='closed' THEN 1 ELSE 0 END) AS closed
      FROM meeting_resolutions r
      JOIN project_meetings m ON m.id=r.meeting_id
      WHERE m.project_id=? ${resolutionVisibility}
    `).get(projectId);
    return {
      meetings: meetingsCount,
      resolutions: Number(resolutionCounts.total),
      openResolutions: Number(resolutionCounts.open || 0),
      closedResolutions: Number(resolutionCounts.closed || 0),
    };
  }

  function dashboard(projectId) {
    const project = mapProject(requireProject(projectId, { includeArchived: true }));
    const capital = capTable(projectId);
    const financial = financialSummary(projectId);
    const goalProgress = goalMetrics(projectId);
    const participation = participationMetrics(projectId);
    const execution = enterpriseExecution(projectId);
    const overallProgressSource = execution
      ? 'operations'
      : goalProgress.count ? 'goals' : 'participation';
    const overallProgressPercent = execution
      ? execution.executionProgressPercent
      : goalProgress.count
        ? goalProgress.goalProgressPercent
        : participation.participationCompletionPercent;
    const enterpriseReturns = financeStore
      ? financeStore.returnsReport(projectId, {
        asOf: nowIso(clock).slice(0, 10),
      })
      : null;
    return {
      project,
      capital,
      financial,
      goals: goalProgress,
      participation,
      goalProgressPercent: goalProgress.goalProgressPercent,
      participationCompletionPercent: participation.participationCompletionPercent,
      overallProgressPercent,
      overallProgressSource,
      execution,
      governance: governanceMetrics(projectId),
      stakeholderReturns: enterpriseReturns?.stakeholderReturns ||
        stakeholderReturns(projectId, financial.valuation),
    };
  }

  function publicSummary(projectId) {
    requireProject(projectId, { publicOnly: true });
    const full = dashboard(projectId);
    const goalItems = goals(projectId).goals.filter(
      (goal) => goal.status !== 'cancelled',
    );
    const classById = new Map(
      full.capital.classes.map((shareClass) => [shareClass.id, shareClass]),
    );
    const publicOffers = db.prepare(`
      SELECT *
      FROM share_offers
      WHERE project_id=? AND status IN ('open','partially_filled')
        AND (available_until IS NULL OR available_until>=?)
      ORDER BY created_at DESC, id
    `).all(projectId, tehranCalendarDate(clock)).map((offer) => {
      const shareClass = classById.get(offer.share_class_id);
      return {
        id: offer.id,
        side: offer.side,
        shareClassId: offer.share_class_id,
        className: shareClass?.name || '',
        symbol: shareClass?.symbol || '',
        units: Number(offer.units),
        remainingUnits: Number(offer.remaining_units),
        unitPrice: Number(offer.unit_price),
        availableUntil: offer.available_until,
        status: offer.status,
      };
    });
    return {
      capital: {
        classes: full.capital.classes,
        totalIssuedUnits: full.capital.totalUnits,
        shareOffers: publicOffers,
      },
      financial: full.financial,
      goals: {
        ...full.goals,
        items: goalItems,
      },
      participation: full.participation,
      goalProgressPercent: full.goalProgressPercent,
      participationCompletionPercent: full.participationCompletionPercent,
      overallProgressPercent: full.overallProgressPercent,
      overallProgressSource: full.overallProgressSource,
      execution: full.execution,
      governance: {
        ...governanceMetrics(projectId, true),
        meetings: meetings(projectId, { publicOnly: true }).meetings,
      },
    };
  }

  function auditEvents(projectId, { limit = 200 } = {}) {
    requireProject(projectId);
    const safeLimit = integer(limit, 'limit', { minimum: 1, fallback: 200 });
    if (safeLimit > 500) {
      throw badRequest('VALIDATION_FAILED', 'حداکثر ۵۰۰ رویداد قابل دریافت است.');
    }
    return {
      auditEvents: db.prepare(`
        SELECT *
        FROM audit_events
        WHERE project_id=?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(projectId, safeLimit).map((row) => ({
        id: Number(row.id),
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        action: row.action,
        actorType: row.actor_type,
        details: JSON.parse(row.details_json),
        createdAt: row.created_at,
      })),
    };
  }

  return Object.freeze({
    getProject,
    portfolio,
    createProject,
    updateProject,
    archiveProject,
    stakeholders,
    createStakeholder,
    patchStakeholder,
    shareClasses,
    createShareClass,
    patchShareClass,
    capTable,
    issueShares,
    shareOffers,
    createShareOffer,
    patchShareOffer,
    shareTransfers,
    createShareTransfer,
    patchShareTransfer,
    financialEntries,
    createFinancialEntry,
    reverseFinancialEntry,
    goals,
    createGoal,
    patchGoal,
    createMilestone,
    patchMilestone,
    meetings,
    createMeeting,
    patchMeeting,
    setAttendance,
    createResolution,
    patchResolution,
    vote,
    dashboard,
    publicSummary,
    auditEvents,
  });
}

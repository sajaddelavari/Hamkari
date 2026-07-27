import { createHash, randomUUID } from 'node:crypto';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { withTransaction } from './database.js';

const ACCOUNT_TYPES = new Set(['asset', 'liability', 'equity', 'revenue', 'expense']);
const PERIOD_STATUSES = new Set(['open', 'closing', 'closed']);
const JOURNAL_STATUSES = new Set(['draft', 'posted', 'reversed']);
const INVOICE_KINDS = new Set(['receivable', 'payable']);
const PAYMENT_DIRECTIONS = new Set(['incoming', 'outgoing']);
const PAYMENT_PURPOSE_TYPES = new Set([
  'invoice',
  'share_transfer',
  'preemptive_right',
  'distribution',
  'general',
]);
const LOCAL_PROVIDERS = new Set(['manual', 'sandbox']);
const KYC_SUBJECT_TYPES = new Set(['user', 'stakeholder', 'organization']);
const KYC_LEVELS = new Set(['basic', 'enhanced']);
const KYC_CHECK_STATUSES = new Set(['pending', 'passed', 'failed', 'needs_review']);
const KYC_CASE_DECISIONS = new Set(['verified', 'rejected']);
const PARTY_TYPES = new Set(['organization', 'user', 'stakeholder', 'external']);
const CORPORATE_ACTION_TYPES = new Set([
  'issuance',
  'capital_increase',
  'split',
  'reverse_split',
  'conversion',
  'buyback',
  'cancellation',
  'rights_issue',
]);
const CAPITAL_MUTATING_ACTION_TYPES = new Set(CORPORATE_ACTION_TYPES);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function nowIso(clock) {
  return clock().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('base64url');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function requestHash(value) {
  return sha256(JSON.stringify(stableValue(value)));
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

function operationScopeHash(scope) {
  return sha256(JSON.stringify(scope));
}

function corporateActionApprovalSnapshot(preview, resolutionEvidence) {
  const action = preview.corporateAction;
  const byStakeholder = (items) => items
    .map((item) => ({
      stakeholderId: item.stakeholderId,
      units: Number(item.units),
    }))
    .sort((left, right) => left.stakeholderId.localeCompare(right.stakeholderId));
  return {
    version: 1,
    action: {
      id: action.id,
      projectId: action.projectId,
      shareClassId: action.shareClassId,
      actionType: action.actionType,
      title: action.title,
      recordDate: action.recordDate,
      effectiveDate: action.effectiveDate,
      ratioNumerator: action.ratioNumerator,
      ratioDenominator: action.ratioDenominator,
      units: action.units,
      unitPrice: action.unitPrice,
      resolutionId: action.resolutionId,
      note: action.note,
      stakeholderId: action.stakeholderId,
      destinationShareClassId: action.destinationShareClassId,
    },
    shareClass: {
      id: preview.shareClass.id,
      authorizedUnitsBefore: preview.shareClass.authorizedUnitsBefore,
      authorizedUnitsAfter: preview.shareClass.authorizedUnitsAfter,
      issuedUnitsBefore: preview.shareClass.issuedUnitsBefore,
      issuedUnitsAfter: preview.shareClass.issuedUnitsAfter,
    },
    before: byStakeholder(preview.before),
    after: byStakeholder(preview.after),
    entitlements: preview.entitlements
      .map((item) => ({
        stakeholderId: item.stakeholderId,
        entitledUnits: Number(item.entitledUnits),
      }))
      .sort((left, right) => left.stakeholderId.localeCompare(right.stakeholderId)),
    resolution: resolutionEvidence,
  };
}

function requiredText(value, field, max = 2_000) {
  const selected = String(value ?? '').trim();
  if (!selected || selected.length > max) {
    throw badRequest(
      'VALIDATION_FAILED',
      'اطلاعات واردشده معتبر نیست.',
      { [field]: `این فیلد الزامی است و حداکثر ${max} نویسه می‌پذیرد.` },
    );
  }
  return selected;
}

function optionalText(value, field, max = 10_000) {
  if (value === undefined || value === null) return '';
  const selected = String(value).trim();
  if (selected.length > max) {
    throw badRequest(
      'VALIDATION_FAILED',
      'اطلاعات واردشده معتبر نیست.',
      { [field]: `حداکثر طول مجاز ${max} نویسه است.` },
    );
  }
  return selected;
}

function enumValue(value, allowed, field, fallback) {
  const selected = value === undefined ? fallback : String(value);
  if (!allowed.has(selected)) {
    throw badRequest(
      'VALIDATION_FAILED',
      'مقدار انتخاب‌شده معتبر نیست.',
      { [field]: 'یک مقدار معتبر انتخاب کنید.' },
    );
  }
  return selected;
}

function safeInteger(
  value,
  field,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, allowNull = false } = {},
) {
  if ((value === null || value === undefined || value === '') && allowNull) return null;
  const selected = Number(value);
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw badRequest(
      'VALIDATION_FAILED',
      'عدد واردشده معتبر نیست.',
      { [field]: `عدد صحیحی بین ${minimum} و ${maximum} وارد کنید.` },
    );
  }
  return selected;
}

function positiveRatio(value, field) {
  return safeInteger(value, field, { minimum: 1 });
}

function isoDate(value, field) {
  const selected = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(selected);
  if (!match) {
    throw badRequest('VALIDATION_FAILED', 'تاریخ معتبر نیست.', {
      [field]: 'تاریخ را با قالب YYYY-MM-DD وارد کنید.',
    });
  }
  const date = new Date(`${selected}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw badRequest('VALIDATION_FAILED', 'تاریخ معتبر نیست.', {
      [field]: 'یک تاریخ تقویمی معتبر وارد کنید.',
    });
  }
  return selected;
}

function optionalIsoDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return isoDate(value, field);
}

function currencyValue(value, fallback = 'IRR') {
  const selected = String(value ?? fallback).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(selected)) {
    throw badRequest('VALIDATION_FAILED', 'واحد پول معتبر نیست.', {
      currency: 'کد سه‌حرفی مانند IRR وارد کنید.',
    });
  }
  return selected;
}

function actorUserId(actor) {
  return actor?.userId || null;
}

function safeBigIntNumber(value, code = 'NUMERIC_LIMIT_EXCEEDED') {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) {
    throw conflict(code, 'جمع محاسبه‌شده از محدوده عددی امن خارج است.');
  }
  return Number(value);
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function idempotencyHash(key, required = false) {
  const selected = String(key || '').trim();
  if (!selected) {
    if (!required) return null;
    throw badRequest(
      'IDEMPOTENCY_KEY_REQUIRED',
      'برای این عملیات هدر Idempotency-Key الزامی است.',
    );
  }
  if (selected.length < 8 || selected.length > 200) {
    throw badRequest(
      'INVALID_IDEMPOTENCY_KEY',
      'کلید تکرارپذیری باید بین ۸ تا ۲۰۰ نویسه باشد.',
    );
  }
  return sha256(selected);
}

function mapAccount(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    parentId: row.parent_id,
    currency: row.currency,
    active: Boolean(row.active),
    systemKey: row.system_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPeriod(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    name: row.name,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    closedByUserId: row.closed_by_user_id,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJournalLine(row) {
  return {
    id: row.id,
    journalEntryId: row.journal_entry_id,
    accountId: row.account_id,
    stakeholderId: row.stakeholder_id,
    description: row.description,
    debit: Number(row.debit),
    credit: Number(row.credit),
    createdAt: row.created_at,
  };
}

function mapJournal(row, lines = []) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    fiscalPeriodId: row.fiscal_period_id,
    entryNo: Number(row.entry_no),
    occurredOn: row.occurred_on,
    description: row.description,
    currency: row.currency,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reversalOfId: row.reversal_of_id,
    createdByUserId: row.created_by_user_id,
    postedByUserId: row.posted_by_user_id,
    postedAt: row.posted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
  };
}

function mapInvoice(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    kind: row.kind,
    counterpartyType: row.counterparty_type,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    invoiceNo: row.invoice_no,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    currency: row.currency,
    subtotal: Number(row.subtotal),
    taxAmount: Number(row.tax_amount),
    discountAmount: Number(row.discount_amount),
    totalAmount: Number(row.total_amount),
    paidAmount: Number(row.paid_amount),
    status: row.status,
    journalEntryId: row.journal_entry_id,
    documentId: row.document_id,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPayment(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    invoiceId: row.invoice_id,
    purposeType: row.purpose_type || null,
    purposeId: row.purpose_id || null,
    purposeHash: row.purpose_hash || null,
    direction: row.direction,
    provider: row.provider,
    providerReference: row.provider_reference,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    failureReason: row.failure_reason,
    initiatedByUserId: row.initiated_by_user_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKycCase(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    level: row.level,
    provider: row.provider,
    providerReference: row.provider_reference,
    status: row.status,
    riskRating: row.risk_rating,
    decisionReason: row.decision_reason,
    requestedAt: row.requested_at,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContract(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    contractType: row.contract_type,
    status: row.status,
    documentId: row.document_id,
    effectiveOn: row.effective_on,
    expiresOn: row.expires_on,
    valueAmount: row.value_amount === null ? null : Number(row.value_amount),
    currency: row.currency,
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCorporateAction(row) {
  const details = parseJson(row.notes, { note: row.notes || '' });
  return {
    id: row.id,
    projectId: row.project_id,
    shareClassId: row.share_class_id,
    actionType: row.action_type,
    title: row.title,
    status: row.status,
    recordDate: row.record_date,
    effectiveDate: row.effective_date,
    ratioNumerator: row.ratio_numerator === null ? null : Number(row.ratio_numerator),
    ratioDenominator: row.ratio_denominator === null ? null : Number(row.ratio_denominator),
    units: row.units === null ? null : Number(row.units),
    unitPrice: row.unit_price === null ? null : Number(row.unit_price),
    resolutionId: row.resolution_id,
    note: details.note || '',
    stakeholderId: details.stakeholderId || null,
    destinationShareClassId: details.destinationShareClassId || null,
    approvedByUserId: row.approved_by_user_id || null,
    approvedAt: row.approved_at || null,
    executedByUserId: row.executed_by_user_id || null,
    approvedPreviewHash: row.approved_preview_hash || null,
    executedAt: row.executed_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapValuation(row) {
  const amount = safeBigIntNumber(
    BigInt(row.amount_text ?? row.amount),
    'VALUATION_NUMERIC_LIMIT_EXCEEDED',
  );
  return {
    id: row.id,
    projectId: row.project_id,
    amount,
    currency: row.currency,
    valuedOn: row.valued_on,
    description: row.description,
    methodology: row.methodology,
    sourceType: row.source_type,
    documentId: row.document_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

function unavailableMetric(reason, basis, extra = {}) {
  return {
    available: false,
    value: null,
    unit: 'percent',
    reason,
    basis,
    ...extra,
  };
}

function percentageMetric(numerator, denominator, basis) {
  if (denominator <= 0n) {
    return unavailableMetric(
      'NO_DOCUMENTED_INVESTED_CAPITAL',
      basis,
      {
        numerator: safeBigIntNumber(numerator),
        denominator: safeBigIntNumber(denominator),
      },
    );
  }
  // Four decimal places of percentage precision, calculated entirely as
  // integers so a large monetary basis is never coerced through a float.
  const scaled = (numerator * 1_000_000n) / denominator;
  if (scaled > MAX_SAFE_BIGINT || scaled < -MAX_SAFE_BIGINT) {
    return unavailableMetric('NUMERIC_RANGE_EXCEEDED', basis);
  }
  return {
    available: true,
    value: Number(scaled) / 10_000,
    unit: 'percent',
    reason: null,
    basis,
    numerator: safeBigIntNumber(numerator),
    denominator: safeBigIntNumber(denominator),
  };
}

function dateToEpochDay(value) {
  return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000);
}

function annualizedReturnMetric(cashFlows, basis) {
  const combined = new Map();
  for (const flow of cashFlows) {
    combined.set(flow.date, (combined.get(flow.date) || 0n) + flow.amount);
  }
  const flows = [...combined]
    .map(([date, amount]) => ({ date, amount }))
    .filter((flow) => flow.amount !== 0n)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!flows.some((flow) => flow.amount < 0n)) {
    return unavailableMetric('NO_DOCUMENTED_INVESTED_CAPITAL', basis);
  }
  if (!flows.some((flow) => flow.amount > 0n)) {
    return unavailableMetric('NO_POSITIVE_TERMINAL_VALUE', basis);
  }
  if (flows.length < 2 || flows[0].date === flows.at(-1).date) {
    return unavailableMetric('INSUFFICIENT_HOLDING_PERIOD', basis);
  }
  if (flows[0].amount >= 0n) {
    return unavailableMetric('INVALID_CASH_FLOW_ORDER', basis);
  }

  let signChanges = 0;
  for (let index = 1; index < flows.length; index += 1) {
    if ((flows[index - 1].amount < 0n) !== (flows[index].amount < 0n)) {
      signChanges += 1;
    }
  }
  if (signChanges !== 1) {
    return unavailableMetric('NON_CONVENTIONAL_CASH_FLOWS', basis);
  }

  const scale = flows.reduce((maximum, flow) => {
    const absolute = flow.amount < 0n ? -flow.amount : flow.amount;
    return absolute > maximum ? absolute : maximum;
  }, 1n);
  const baseDay = dateToEpochDay(flows[0].date);
  const normalized = flows.map((flow) => ({
    years: (dateToEpochDay(flow.date) - baseDay) / 365,
    amount: Number(flow.amount) / Number(scale),
  }));
  const npv = (rate) => normalized.reduce((sum, flow) => {
    const divisor = Math.exp(Math.log1p(rate) * flow.years);
    return sum + flow.amount / divisor;
  }, 0);

  let low = -0.999999999;
  let high = 1;
  let lowValue = npv(low);
  let highValue = npv(high);
  for (
    let attempt = 0;
    attempt < 64 &&
      Number.isFinite(highValue) &&
      Math.sign(lowValue) === Math.sign(highValue);
    attempt += 1
  ) {
    high = high * 2 + 1;
    if (high > 1_000_000_000_000) break;
    highValue = npv(high);
  }
  if (
    Number.isNaN(lowValue) ||
    Number.isNaN(highValue) ||
    Math.sign(lowValue) === Math.sign(highValue)
  ) {
    return unavailableMetric('RETURN_OUT_OF_NUMERIC_RANGE', basis);
  }

  for (let iteration = 0; iteration < 180; iteration += 1) {
    const midpoint = (low + high) / 2;
    const value = npv(midpoint);
    if (Number.isNaN(value)) {
      return unavailableMetric('RETURN_OUT_OF_NUMERIC_RANGE', basis);
    }
    if (Math.abs(value) < 1e-12) {
      low = midpoint;
      high = midpoint;
      break;
    }
    if (Math.sign(value) === Math.sign(lowValue)) {
      low = midpoint;
      lowValue = value;
    } else {
      high = midpoint;
      highValue = value;
    }
  }
  const rate = (low + high) / 2;
  const percentage = rate * 100;
  if (!Number.isFinite(percentage) || Math.abs(percentage) > Number.MAX_SAFE_INTEGER) {
    return unavailableMetric('RETURN_OUT_OF_NUMERIC_RANGE', basis);
  }
  return {
    available: true,
    value: Math.round(percentage * 1_000_000) / 1_000_000,
    unit: 'percent',
    reason: null,
    basis,
    estimate: true,
  };
}

/**
 * Enterprise finance/legal/corporate domain store.
 *
 * All state-changing methods use BEGIN IMMEDIATE and invoke the injected audit
 * callback before commit. Provider-specific verification is intentionally not
 * emulated: the server policy enables exactly one explicit manual or
 * deterministic sandbox mode, and production configuration permits manual
 * evidence only until a verified live adapter is installed.
 */
export function createEnterpriseFinanceStore(
  db,
  {
    clock = () => new Date(),
    audit = () => {},
    paymentProviderMode = 'manual',
    distributionKycRequired = true,
  } = {},
) {
  const at = () => nowIso(clock);
  const configuredPaymentProvider = enumValue(
    paymentProviderMode,
    LOCAL_PROVIDERS,
    'paymentProviderMode',
    'manual',
  );

  function paymentProvider(value) {
    const selected = enumValue(
      value,
      LOCAL_PROVIDERS,
      'provider',
      configuredPaymentProvider,
    );
    if (selected !== configuredPaymentProvider) {
      throw conflict(
        'PAYMENT_PROVIDER_DISABLED',
        'ارائه‌دهندهٔ انتخاب‌شده در سیاست فعلی سرور فعال نیست.',
      );
    }
    return selected;
  }

  function requireProject(projectId) {
    const project = db.prepare(`
      SELECT id, organization_id, currency, title, code, archived_at
      FROM projects
      WHERE id=? AND archived_at IS NULL
    `).get(projectId);
    if (!project) {
      throw notFound('PROJECT_NOT_FOUND', 'پروژه موردنظر پیدا نشد.');
    }
    return project;
  }

  function corporateGovernancePolicyActive(project) {
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

  function requireCorporateGovernanceActor(project, actor) {
    if (actor?.actorType === 'api_key' || !actorUserId(actor)) {
      throw forbidden(
        'CORPORATE_ACTION_USER_REQUIRED',
        'ایجاد، تصویب و اجرای رویداد سرمایه فقط با نشست تعاملی یک کاربر واقعی مجاز است.',
      );
    }
    const user = db.prepare(`
      SELECT user.id
      FROM users user
      JOIN organization_memberships membership
        ON membership.user_id=user.id
       AND membership.organization_id=?
      WHERE user.id=?
        AND user.status='active'
        AND membership.status='active'
      LIMIT 1
    `).get(project.organization_id, actor.userId);
    if (!user) {
      throw forbidden(
        'CORPORATE_ACTION_USER_INACTIVE',
        'کاربر فعال و عضو سازمان برای این عملیات لازم است.',
      );
    }
    return user.id;
  }

  function corporateActionOperationScope(project, action) {
    return canonicalOperationScope({
      operationType: 'corporate_action',
      actionType: action.actionType,
      projectId: project.id,
      shareClassId: action.shareClassId,
      stakeholderId: action.stakeholderId || null,
      destinationShareClassId: action.destinationShareClassId || null,
      units: action.units === null || action.units === undefined
        ? null
        : Number(action.units),
      amount: action.unitPrice === null || action.unitPrice === undefined
        ? null
        : Number(action.unitPrice),
      currency: project.currency,
      ratioNumerator:
        action.ratioNumerator === null ||
        action.ratioNumerator === undefined
          ? null
          : Number(action.ratioNumerator),
      ratioDenominator:
        action.ratioDenominator === null ||
        action.ratioDenominator === undefined
          ? null
          : Number(action.ratioDenominator),
      recordDate: action.recordDate || null,
      effectiveDate: action.effectiveDate || null,
    });
  }

  function requireApprovedCorporateResolution(
    project,
    actionOrInput,
    { bind = false, consume = false } = {},
  ) {
    if (!CAPITAL_MUTATING_ACTION_TYPES.has(actionOrInput.actionType)) return null;
    const resolutionId = actionOrInput.resolutionId || null;
    if (!resolutionId) {
      throw conflict(
        'CORPORATE_ACTION_RESOLUTION_REQUIRED',
        'برای هر رویداد تغییردهنده سرمایه، مصوبه معتبر هیئت‌مدیره الزامی است.',
      );
    }
    const resolution = db.prepare(`
      SELECT
        resolution.id,
        resolution.meeting_id,
        resolution.status AS resolution_status,
        resolution.result_json,
        resolution.operation_type,
        resolution.operation_scope_json,
        resolution.operation_request_hash,
        meeting.project_id,
        meeting.status AS meeting_status
      FROM meeting_resolutions resolution
      JOIN project_meetings meeting ON meeting.id=resolution.meeting_id
      WHERE resolution.id=?
      LIMIT 1
    `).get(resolutionId);
    if (!resolution || resolution.project_id !== project.id) {
      throw conflict(
        'CORPORATE_ACTION_RESOLUTION_INVALID',
        'مصوبه باید متعلق به همان پروژه رویداد سرمایه باشد.',
      );
    }
    if (resolution.meeting_status !== 'held') {
      throw conflict(
        'CORPORATE_ACTION_MEETING_NOT_HELD',
        'جلسه مرتبط با مصوبه باید برگزار شده باشد.',
      );
    }
    if (resolution.resolution_status !== 'closed') {
      throw conflict(
        'CORPORATE_ACTION_RESOLUTION_NOT_CLOSED',
        'مصوبه باید پیش از استفاده بسته شده باشد.',
      );
    }
    const decision = parseJson(resolution.result_json, {});
    const quorumMet = decision.quorumMet === true
      || decision.quorum?.quorumMet === true;
    if (!quorumMet) {
      throw conflict(
        'CORPORATE_ACTION_RESOLUTION_QUORUM_REQUIRED',
        'حد نصاب مصوبه برای تغییر سرمایه احراز نشده است.',
      );
    }
    if (decision.outcome !== 'approved') {
      throw conflict(
        'CORPORATE_ACTION_RESOLUTION_NOT_APPROVED',
        'مصوبه تغییر سرمایه تصویب نشده است.',
      );
    }
    const operationScope = corporateActionOperationScope(
      project,
      actionOrInput,
    );
    const expectedHash = operationScopeHash(operationScope);
    const storedScope = parseJson(resolution.operation_scope_json, null);
    if (
      resolution.operation_type !== 'corporate_action' ||
      !storedScope ||
      operationScopeHash(storedScope) !== resolution.operation_request_hash ||
      resolution.operation_request_hash !== expectedHash
    ) {
      throw conflict(
        'CORPORATE_ACTION_RESOLUTION_SCOPE_MISMATCH',
        'مصوبه باید به‌صورت ساختاری به همین نوع رویداد، ردهٔ سهام، تعداد، نسبت و مبلغ محدود شده باشد.',
      );
    }
    const operationId = actionOrInput.id || null;
    if (!operationId) {
      throw conflict(
        'CORPORATE_ACTION_BINDING_REQUIRED',
        'رویداد سرمایه باید پیش از اتصال مصوبه ثبت شده باشد.',
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
        ) VALUES(?,?,'corporate_action',?,?,?,NULL)
      `).run(
        resolutionId,
        project.id,
        operationId,
        expectedHash,
        at(),
      );
    } else if (
      !binding ||
      binding.project_id !== project.id ||
      binding.operation_type !== 'corporate_action' ||
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
      `).run(at(), resolutionId);
    }
    return {
      id: resolution.id,
      meetingId: resolution.meeting_id,
      meetingStatus: resolution.meeting_status,
      resolutionStatus: resolution.resolution_status,
      outcome: decision.outcome,
      quorumMet,
      resultHash: requestHash(decision),
      operationRequestHash: expectedHash,
    };
  }

  function auditEvent(project, resourceType, resourceId, action, actor, before, after, metadata = {}) {
    const userId = actorUserId(actor);
    audit({
      organizationId: project.organization_id,
      projectId: project.id,
      resourceType,
      resourceId,
      action,
      actorType: actor?.actorType || (userId ? 'user' : 'system'),
      actorId: actor?.actorType === 'api_key' ? actor.apiKey?.id || null : userId,
      actorUserId: userId,
      before: before ?? null,
      after: after ?? null,
      metadata,
      createdAt: at(),
    });
  }

  function requireAccount(project, accountId, { active = true } = {}) {
    const row = db.prepare(`
      SELECT *
      FROM accounting_accounts
      WHERE id=? AND organization_id=?
        AND (project_id=? OR project_id IS NULL)
        ${active ? 'AND active=1' : ''}
    `).get(accountId, project.organization_id, project.id);
    if (!row) {
      throw badRequest(
        'INVALID_ACCOUNT',
        'حساب انتخاب‌شده متعلق به این پروژه یا سازمان نیست.',
      );
    }
    if (row.currency !== project.currency) {
      throw conflict(
        'ACCOUNT_CURRENCY_MISMATCH',
        'واحد پول حساب با واحد پول پروژه یکسان نیست.',
      );
    }
    return row;
  }

  function requirePeriod(project, periodId) {
    const row = db.prepare(`
      SELECT *
      FROM fiscal_periods
      WHERE id=? AND organization_id=?
        AND (project_id=? OR project_id IS NULL)
    `).get(periodId, project.organization_id, project.id);
    if (!row) {
      throw badRequest('INVALID_FISCAL_PERIOD', 'دوره مالی معتبر نیست.');
    }
    return row;
  }

  function periodForDate(project, occurredOn, requestedId) {
    if (requestedId) return requirePeriod(project, requestedId);
    const rows = db.prepare(`
      SELECT *
      FROM fiscal_periods
      WHERE organization_id=?
        AND (project_id=? OR project_id IS NULL)
        AND starts_on<=? AND ends_on>=?
      ORDER BY project_id IS NULL, starts_on DESC, id
    `).all(project.organization_id, project.id, occurredOn, occurredOn);
    if (!rows.length) {
      throw conflict(
        'FISCAL_PERIOD_REQUIRED',
        'برای تاریخ سند یک دوره مالی تعریف کنید.',
      );
    }
    if (rows.length > 1 && rows[0].project_id === rows[1].project_id) {
      throw conflict(
        'AMBIGUOUS_FISCAL_PERIOD',
        'بیش از یک دوره مالی تاریخ سند را پوشش می‌دهد.',
      );
    }
    return rows[0];
  }

  function nextEntryNo(organizationId) {
    const row = db.prepare(`
      SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_no
      FROM journal_entries
      WHERE organization_id=?
    `).get(organizationId);
    return safeInteger(row.next_no, 'entryNo', { minimum: 1 });
  }

  function journalRow(projectId, entryId) {
    const row = db.prepare(`
      SELECT *
      FROM journal_entries
      WHERE id=? AND project_id=?
    `).get(entryId, projectId);
    if (!row) throw notFound('JOURNAL_NOT_FOUND', 'سند حسابداری پیدا نشد.');
    return row;
  }

  function journalResult(row) {
    const lines = db.prepare(`
      SELECT *
      FROM journal_lines
      WHERE journal_entry_id=?
      ORDER BY created_at, id
    `).all(row.id).map(mapJournalLine);
    return mapJournal(row, lines);
  }

  function validateJournalLines(project, lines) {
    if (!Array.isArray(lines) || lines.length < 2) {
      throw badRequest(
        'JOURNAL_LINES_REQUIRED',
        'سند حسابداری باید حداقل دو سطر داشته باشد.',
      );
    }
    let debit = 0n;
    let credit = 0n;
    const normalized = lines.map((line, index) => {
      const account = requireAccount(project, line.accountId);
      const debitAmount = safeInteger(line.debit ?? 0, `lines.${index}.debit`);
      const creditAmount = safeInteger(line.credit ?? 0, `lines.${index}.credit`);
      if (
        (debitAmount > 0 && creditAmount > 0) ||
        (debitAmount === 0 && creditAmount === 0)
      ) {
        throw badRequest(
          'VALIDATION_FAILED',
          'هر سطر باید فقط بدهکار یا فقط بستانکار باشد.',
          { [`lines.${index}`]: 'یکی از بدهکار یا بستانکار باید مثبت باشد.' },
        );
      }
      if (line.stakeholderId) {
        const stakeholder = db.prepare(`
          SELECT id FROM project_stakeholders
          WHERE id=? AND project_id=?
        `).get(line.stakeholderId, project.id);
        if (!stakeholder) {
          throw badRequest('INVALID_STAKEHOLDER', 'ذی‌نفع سطر معتبر نیست.');
        }
      }
      debit += BigInt(debitAmount);
      credit += BigInt(creditAmount);
      safeBigIntNumber(debit);
      safeBigIntNumber(credit);
      return {
        account,
        stakeholderId: line.stakeholderId || null,
        description: optionalText(line.description, `lines.${index}.description`, 2_000),
        debit: debitAmount,
        credit: creditAmount,
      };
    });
    if (debit <= 0n || debit !== credit) {
      throw conflict(
        'UNBALANCED_JOURNAL',
        'جمع بدهکار و بستانکار سند برابر نیست.',
        {
          debit: safeBigIntNumber(debit),
          credit: safeBigIntNumber(credit),
        },
      );
    }
    return normalized;
  }

  function insertJournalLines(entryId, lines, createdAt) {
    const insert = db.prepare(`
      INSERT INTO journal_lines(
        id, journal_entry_id, account_id, stakeholder_id,
        description, debit, credit, created_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `);
    for (const line of lines) {
      insert.run(
        randomUUID(),
        entryId,
        line.account.id,
        line.stakeholderId,
        line.description,
        line.debit,
        line.credit,
        createdAt,
      );
    }
  }

  function postJournalInside(project, entryId, actor) {
    const current = journalRow(project.id, entryId);
    if (current.status !== 'draft') {
      if (['posted', 'reversed'].includes(current.status)) return current;
      throw conflict('JOURNAL_NOT_DRAFT', 'فقط سند پیش‌نویس قابل ثبت است.');
    }
    const period = requirePeriod(project, current.fiscal_period_id);
    if (period.status !== 'open') {
      throw conflict('FISCAL_PERIOD_CLOSED', 'دوره مالی سند باز نیست.');
    }
    if (current.occurred_on < period.starts_on || current.occurred_on > period.ends_on) {
      throw conflict(
        'JOURNAL_OUTSIDE_PERIOD',
        'تاریخ سند خارج از بازه دوره مالی است.',
      );
    }
    const lines = db.prepare(`
      SELECT l.*, a.organization_id, a.project_id, a.active, a.currency
      FROM journal_lines l
      JOIN accounting_accounts a ON a.id=l.account_id
      WHERE l.journal_entry_id=?
      ORDER BY l.created_at, l.id
    `).all(entryId);
    validateJournalLines(project, lines.map((line) => ({
      accountId: line.account_id,
      stakeholderId: line.stakeholder_id,
      description: line.description,
      debit: Number(line.debit),
      credit: Number(line.credit),
    })));
    const postedAt = at();
    db.prepare(`
      UPDATE journal_entries
      SET status='posted', posted_by_user_id=?, posted_at=?, updated_at=?
      WHERE id=? AND project_id=? AND status='draft'
    `).run(actorUserId(actor), postedAt, postedAt, entryId, project.id);
    return journalRow(project.id, entryId);
  }

  function createDraftInside(project, input, actor, keyHash = null, hash = null) {
    const occurredOn = isoDate(input.occurredOn, 'occurredOn');
    const period = periodForDate(project, occurredOn, input.fiscalPeriodId);
    if (occurredOn < period.starts_on || occurredOn > period.ends_on) {
      throw badRequest(
        'JOURNAL_OUTSIDE_PERIOD',
        'تاریخ سند خارج از دوره انتخاب‌شده است.',
      );
    }
    const currency = currencyValue(input.currency, project.currency);
    if (currency !== project.currency) {
      throw conflict(
        'PROJECT_CURRENCY_MISMATCH',
        'نسخه تک‌سرور تنها ارز اصلی پروژه را ثبت می‌کند.',
      );
    }
    const normalizedLines = validateJournalLines(project, input.lines);
    const id = randomUUID();
    const createdAt = at();
    db.prepare(`
      INSERT INTO journal_entries(
        id, organization_id, project_id, fiscal_period_id, entry_no,
        occurred_on, description, currency, status, source_type, source_id,
        reversal_of_id, idempotency_key_hash, request_hash,
        created_by_user_id, posted_by_user_id, posted_at, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?, 'draft', ?,?,NULL,?,?,?,NULL,NULL,?,?)
    `).run(
      id,
      project.organization_id,
      project.id,
      period.id,
      nextEntryNo(project.organization_id),
      occurredOn,
      requiredText(input.description, 'description', 2_000),
      currency,
      optionalText(input.sourceType || 'manual', 'sourceType', 100) || 'manual',
      input.sourceId ? String(input.sourceId) : null,
      keyHash,
      hash,
      actorUserId(actor),
      createdAt,
      createdAt,
    );
    insertJournalLines(id, normalizedLines, createdAt);
    return journalRow(project.id, id);
  }

  function idempotentJournal(project, keyHash, hash) {
    if (!keyHash) return null;
    const existing = db.prepare(`
      SELECT *
      FROM journal_entries
      WHERE organization_id=? AND idempotency_key_hash=?
    `).get(project.organization_id, keyHash);
    if (!existing) return null;
    if (existing.request_hash !== hash) {
      throw conflict(
        'IDEMPOTENCY_CONFLICT',
        'این کلید قبلاً برای درخواست متفاوتی استفاده شده است.',
      );
    }
    return existing;
  }

  function createAccount(projectId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const code = requiredText(input.code, 'code', 40).toUpperCase();
    const name = requiredText(input.name, 'name', 200);
    const accountType = enumValue(input.accountType, ACCOUNT_TYPES, 'accountType');
    const currency = currencyValue(input.currency, project.currency);
    if (currency !== project.currency) {
      throw conflict('PROJECT_CURRENCY_MISMATCH', 'ارز حساب باید با ارز پروژه یکسان باشد.');
    }
    let result;
    withTransaction(db, () => {
      let parentId = null;
      if (input.parentId) parentId = requireAccount(project, input.parentId, { active: false }).id;
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO accounting_accounts(
          id, organization_id, project_id, code, name, account_type,
          parent_id, currency, active, system_key, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,1,?,?,?)
      `).run(
        id,
        project.organization_id,
        project.id,
        code,
        name,
        accountType,
        parentId,
        currency,
        optionalText(input.systemKey, 'systemKey', 80),
        createdAt,
        createdAt,
      );
      const row = db.prepare('SELECT * FROM accounting_accounts WHERE id=?').get(id);
      result = mapAccount(row);
      auditEvent(project, 'accounting_account', id, 'created', actor, null, result);
    });
    return { account: result };
  }

  function accounts(projectId, { includeInactive = false } = {}) {
    const project = requireProject(projectId);
    return {
      accounts: db.prepare(`
        SELECT *
        FROM accounting_accounts
        WHERE organization_id=?
          AND (project_id=? OR project_id IS NULL)
          ${includeInactive ? '' : 'AND active=1'}
        ORDER BY code, name, id
      `).all(project.organization_id, project.id).map(mapAccount),
    };
  }

  function patchAccount(projectId, accountId, input, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    withTransaction(db, () => {
      const current = requireAccount(project, accountId, { active: false });
      const before = mapAccount(current);
      const accountType = input.accountType === undefined
        ? current.account_type
        : enumValue(input.accountType, ACCOUNT_TYPES, 'accountType');
      const hasLines = Boolean(db.prepare(
        'SELECT 1 FROM journal_lines WHERE account_id=? LIMIT 1',
      ).get(accountId));
      if (hasLines && accountType !== current.account_type) {
        throw conflict(
          'ACCOUNT_TYPE_LOCKED',
          'نوع حسابی که گردش دارد قابل تغییر نیست.',
        );
      }
      let parentId = current.parent_id;
      if (input.parentId !== undefined) {
        parentId = input.parentId
          ? requireAccount(project, input.parentId, { active: false }).id
          : null;
        if (parentId === accountId) {
          throw badRequest('INVALID_ACCOUNT_PARENT', 'حساب نمی‌تواند والد خودش باشد.');
        }
      }
      const active = input.active === undefined ? Number(current.active) : (input.active ? 1 : 0);
      if (!active && hasLines) {
        // Deactivation is safe; existing reports retain the account.
      }
      const updatedAt = at();
      db.prepare(`
        UPDATE accounting_accounts
        SET code=?, name=?, account_type=?, parent_id=?, active=?,
            system_key=?, updated_at=?
        WHERE id=?
      `).run(
        input.code === undefined
          ? current.code
          : requiredText(input.code, 'code', 40).toUpperCase(),
        input.name === undefined
          ? current.name
          : requiredText(input.name, 'name', 200),
        accountType,
        parentId,
        active,
        input.systemKey === undefined
          ? current.system_key
          : optionalText(input.systemKey, 'systemKey', 80),
        updatedAt,
        accountId,
      );
      result = mapAccount(db.prepare(
        'SELECT * FROM accounting_accounts WHERE id=?',
      ).get(accountId));
      auditEvent(project, 'accounting_account', accountId, 'updated', actor, before, result);
    });
    return { account: result };
  }

  function createFiscalPeriod(projectId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const startsOn = isoDate(input.startsOn, 'startsOn');
    const endsOn = isoDate(input.endsOn, 'endsOn');
    if (startsOn > endsOn) {
      throw badRequest('VALIDATION_FAILED', 'شروع دوره بعد از پایان آن است.');
    }
    let result;
    withTransaction(db, () => {
      const overlap = db.prepare(`
        SELECT id
        FROM fiscal_periods
        WHERE organization_id=?
          AND (project_id=? OR (project_id IS NULL AND ? IS NULL))
          AND starts_on<=? AND ends_on>=?
        LIMIT 1
      `).get(project.organization_id, project.id, project.id, endsOn, startsOn);
      if (overlap) {
        throw conflict('FISCAL_PERIOD_OVERLAP', 'دوره مالی با دوره دیگری هم‌پوشانی دارد.');
      }
      const id = randomUUID();
      const createdAt = at();
      const status = enumValue(input.status, PERIOD_STATUSES, 'status', 'open');
      db.prepare(`
        INSERT INTO fiscal_periods(
          id, organization_id, project_id, name, starts_on, ends_on,
          status, closed_by_user_id, closed_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?)
      `).run(
        id,
        project.organization_id,
        project.id,
        requiredText(input.name, 'name', 150),
        startsOn,
        endsOn,
        status,
        createdAt,
        createdAt,
      );
      result = mapPeriod(db.prepare('SELECT * FROM fiscal_periods WHERE id=?').get(id));
      auditEvent(project, 'fiscal_period', id, 'created', actor, null, result);
    });
    return { fiscalPeriod: result };
  }

  function fiscalPeriods(projectId) {
    const project = requireProject(projectId);
    return {
      fiscalPeriods: db.prepare(`
        SELECT *
        FROM fiscal_periods
        WHERE organization_id=? AND (project_id=? OR project_id IS NULL)
        ORDER BY starts_on DESC, id
      `).all(project.organization_id, project.id).map(mapPeriod),
    };
  }

  function setFiscalPeriodStatus(projectId, periodId, status, { actor } = {}) {
    const project = requireProject(projectId);
    const next = enumValue(status, PERIOD_STATUSES, 'status');
    let result;
    withTransaction(db, () => {
      const current = requirePeriod(project, periodId);
      const before = mapPeriod(current);
      const allowed = {
        open: new Set(['open', 'closing', 'closed']),
        closing: new Set(['open', 'closing', 'closed']),
        closed: new Set(['closed', 'open']),
      };
      if (!allowed[current.status].has(next)) {
        throw conflict('INVALID_STATUS_TRANSITION', 'تغییر وضعیت دوره مجاز نیست.');
      }
      if (next === 'closed') {
        const draft = db.prepare(`
          SELECT id FROM journal_entries
          WHERE fiscal_period_id=? AND status='draft'
          LIMIT 1
        `).get(periodId);
        if (draft) {
          throw conflict(
            'FISCAL_PERIOD_HAS_DRAFTS',
            'پیش از بستن دوره، اسناد پیش‌نویس را ثبت یا تعیین تکلیف کنید.',
          );
        }
      }
      const updatedAt = at();
      db.prepare(`
        UPDATE fiscal_periods
        SET status=?, closed_by_user_id=?, closed_at=?, updated_at=?
        WHERE id=?
      `).run(
        next,
        next === 'closed' ? actorUserId(actor) : null,
        next === 'closed' ? updatedAt : null,
        updatedAt,
        periodId,
      );
      result = mapPeriod(db.prepare('SELECT * FROM fiscal_periods WHERE id=?').get(periodId));
      auditEvent(
        project,
        'fiscal_period',
        periodId,
        next === 'closed' ? 'closed' : next === 'open' && before.status === 'closed' ? 'reopened' : 'status_changed',
        actor,
        before,
        result,
      );
    });
    return { fiscalPeriod: result };
  }

  function createJournalDraft(projectId, input, { actor, idempotencyKey } = {}) {
    const project = requireProject(projectId);
    const keyHash = idempotencyHash(idempotencyKey, true);
    const hash = requestHash(input);
    let result;
    let replay = false;
    withTransaction(db, () => {
      const existing = idempotentJournal(project, keyHash, hash);
      if (existing) {
        result = journalResult(existing);
        replay = true;
        return;
      }
      const row = createDraftInside(project, input, actor, keyHash, hash);
      result = journalResult(row);
      auditEvent(project, 'journal_entry', row.id, 'draft_created', actor, null, result);
    });
    return { journalEntry: result, idempotentReplay: replay };
  }

  function journals(projectId, { status, limit = 200 } = {}) {
    const project = requireProject(projectId);
    if (status !== undefined) enumValue(status, JOURNAL_STATUSES, 'status');
    const selectedLimit = safeInteger(limit, 'limit', { minimum: 1, maximum: 500 });
    const rows = db.prepare(`
      SELECT *
      FROM journal_entries
      WHERE project_id=?
        ${status ? 'AND status=?' : ''}
      ORDER BY occurred_on DESC, entry_no DESC
      LIMIT ?
    `).all(...(status ? [project.id, status, selectedLimit] : [project.id, selectedLimit]));
    return { journalEntries: rows.map(journalResult) };
  }

  function getJournal(projectId, entryId) {
    requireProject(projectId);
    return { journalEntry: journalResult(journalRow(projectId, entryId)) };
  }

  function addJournalLine(projectId, entryId, input, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    withTransaction(db, () => {
      const current = journalRow(project.id, entryId);
      if (current.status !== 'draft') {
        throw conflict('POSTED_JOURNAL_IMMUTABLE', 'سند ثبت‌شده تغییرپذیر نیست.');
      }
      const [line] = validateJournalLines(project, [
        {
          ...input,
          ...(Number(input.debit || 0) > 0
            ? { credit: 0 }
            : { debit: 0 }),
        },
        // Temporary balancing line only validates account/reference and numeric
        // shape. It is not persisted.
        Number(input.debit || 0) > 0
          ? { accountId: input.accountId, debit: 0, credit: input.debit }
          : { accountId: input.accountId, debit: input.credit, credit: 0 },
      ]);
      insertJournalLines(entryId, [line], at());
      result = journalResult(journalRow(project.id, entryId));
      auditEvent(project, 'journal_entry', entryId, 'line_added', actor, null, result);
    });
    return { journalEntry: result };
  }

  function postJournal(projectId, entryId, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    let replay = false;
    withTransaction(db, () => {
      const beforeRow = journalRow(project.id, entryId);
      const before = journalResult(beforeRow);
      if (beforeRow.status !== 'draft') replay = true;
      const posted = postJournalInside(project, entryId, actor);
      result = journalResult(posted);
      if (!replay) {
        auditEvent(project, 'journal_entry', entryId, 'posted', actor, before, result);
      }
    });
    return { journalEntry: result, idempotentReplay: replay };
  }

  function reverseJournal(projectId, entryId, input, { actor, idempotencyKey } = {}) {
    const project = requireProject(projectId);
    const keyHash = idempotencyHash(idempotencyKey, true);
    const occurredOn = isoDate(input.occurredOn, 'occurredOn');
    const hash = requestHash({
      entryId,
      occurredOn,
      fiscalPeriodId: input.fiscalPeriodId || null,
      description: input.description || '',
    });
    let result;
    let replay = false;
    withTransaction(db, () => {
      const prior = idempotentJournal(project, keyHash, hash);
      if (prior) {
        result = journalResult(prior);
        replay = true;
        return;
      }
      const original = journalRow(project.id, entryId);
      if (original.status === 'draft') {
        throw conflict('JOURNAL_NOT_POSTED', 'سند پیش‌نویس قابل برگشت نیست.');
      }
      const existingReversal = db.prepare(`
        SELECT * FROM journal_entries
        WHERE reversal_of_id=? AND status IN ('posted','reversed')
      `).get(entryId);
      if (existingReversal) {
        throw conflict('JOURNAL_ALREADY_REVERSED', 'این سند قبلاً برگشت خورده است.');
      }
      const lines = db.prepare(`
        SELECT * FROM journal_lines
        WHERE journal_entry_id=?
        ORDER BY created_at, id
      `).all(entryId);
      const reversal = createDraftInside(project, {
        occurredOn,
        fiscalPeriodId: input.fiscalPeriodId,
        description: optionalText(input.description, 'description', 2_000)
          || `برگشت سند ${original.entry_no}`,
        currency: original.currency,
        sourceType: 'journal_reversal',
        sourceId: original.id,
        lines: lines.map((line) => ({
          accountId: line.account_id,
          stakeholderId: line.stakeholder_id,
          description: line.description,
          debit: Number(line.credit),
          credit: Number(line.debit),
        })),
      }, actor, keyHash, hash);
      db.prepare(
        'UPDATE journal_entries SET reversal_of_id=? WHERE id=?',
      ).run(original.id, reversal.id);
      const posted = postJournalInside(project, reversal.id, actor);
      const updatedAt = at();
      db.prepare(`
        UPDATE journal_entries
        SET status='reversed', updated_at=?
        WHERE id=? AND status='posted'
      `).run(updatedAt, original.id);
      result = journalResult(posted);
      auditEvent(
        project,
        'journal_entry',
        original.id,
        'reversed',
        actor,
        journalResult(original),
        { reversalEntryId: posted.id },
      );
    });
    return { journalEntry: result, idempotentReplay: replay };
  }

  function dateFilter(field, { from, to } = {}) {
    const values = [];
    let clause = '';
    if (from) {
      clause += ` AND ${field}>=?`;
      values.push(isoDate(from, 'from'));
    }
    if (to) {
      clause += ` AND ${field}<=?`;
      values.push(isoDate(to, 'to'));
    }
    return { clause, values };
  }

  function accountTotals(project, filters = {}) {
    const range = dateFilter('j.occurred_on', filters);
    const accounts = db.prepare(`
      SELECT
        a.id, a.code, a.name, a.account_type
      FROM accounting_accounts a
      WHERE a.organization_id=?
        AND (a.project_id=? OR a.project_id IS NULL)
      ORDER BY a.code, a.id
    `).all(project.organization_id, project.id);
    const totals = new Map(
      accounts.map((account) => [
        account.id,
        { debit: 0n, credit: 0n },
      ]),
    );
    const lines = db.prepare(`
      SELECT
        l.account_id,
        CAST(l.debit AS TEXT) AS debit_text,
        CAST(l.credit AS TEXT) AS credit_text
      FROM journal_entries j
      JOIN journal_lines l ON l.journal_entry_id=j.id
      JOIN accounting_accounts a ON a.id=l.account_id
      WHERE j.project_id=?
        AND j.status IN ('posted','reversed')
        ${range.clause}
        AND a.organization_id=?
        AND (a.project_id=? OR a.project_id IS NULL)
      ORDER BY j.occurred_on, j.entry_no, l.id
    `).all(project.id, ...range.values, project.organization_id, project.id);
    for (const line of lines) {
      const total = totals.get(line.account_id);
      if (!total) continue;
      total.debit += BigInt(line.debit_text);
      total.credit += BigInt(line.credit_text);
    }
    return accounts.map((row) => {
      const total = totals.get(row.id);
      return {
      accountId: row.id,
      code: row.code,
      name: row.name,
      accountType: row.account_type,
      debit: safeBigIntNumber(total.debit),
      credit: safeBigIntNumber(total.credit),
      balance: safeBigIntNumber(total.debit - total.credit),
      };
    });
  }

  function trialBalance(projectId, filters = {}) {
    const project = requireProject(projectId);
    const accountsList = accountTotals(project, filters);
    const debit = accountsList.reduce((sum, row) => sum + BigInt(row.debit), 0n);
    const credit = accountsList.reduce((sum, row) => sum + BigInt(row.credit), 0n);
    return {
      currency: project.currency,
      from: filters.from || null,
      to: filters.to || null,
      accounts: accountsList,
      totalDebit: safeBigIntNumber(debit),
      totalCredit: safeBigIntNumber(credit),
      balanced: debit === credit,
    };
  }

  function profitAndLoss(projectId, filters = {}) {
    const project = requireProject(projectId);
    const range = dateFilter('j.occurred_on', filters);
    const accounts = db.prepare(`
      SELECT id, code, name, account_type
      FROM accounting_accounts
      WHERE organization_id=?
        AND (project_id=? OR project_id IS NULL)
        AND account_type IN ('revenue','expense')
      ORDER BY code, id
    `).all(project.organization_id, project.id);
    const totals = new Map(accounts.map((account) => [account.id, 0n]));
    const lines = db.prepare(`
      SELECT
        l.account_id,
        a.account_type,
        CAST(l.debit AS TEXT) AS debit_text,
        CAST(l.credit AS TEXT) AS credit_text
      FROM journal_entries j
      JOIN journal_lines l ON l.journal_entry_id=j.id
      JOIN accounting_accounts a ON a.id=l.account_id
      WHERE j.project_id=?
        AND j.status IN ('posted','reversed')
        ${range.clause}
        AND a.organization_id=?
        AND (a.project_id=? OR a.project_id IS NULL)
        AND a.account_type IN ('revenue','expense')
      ORDER BY j.occurred_on, j.entry_no, l.id
    `).all(project.id, ...range.values, project.organization_id, project.id);
    for (const line of lines) {
      const debit = BigInt(line.debit_text);
      const credit = BigInt(line.credit_text);
      const signed = line.account_type === 'revenue'
        ? credit - debit
        : debit - credit;
      totals.set(line.account_id, (totals.get(line.account_id) || 0n) + signed);
    }
    const mapped = accounts.map((row) => ({
      accountId: row.id,
      code: row.code,
      name: row.name,
      accountType: row.account_type,
      amount: safeBigIntNumber(totals.get(row.id) || 0n),
    }));
    const revenueAccounts = mapped.filter(
      (row) => row.accountType === 'revenue',
    );
    const expenseAccounts = mapped.filter(
      (row) => row.accountType === 'expense',
    );
    const revenue = revenueAccounts.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    const expense = expenseAccounts.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    return {
      currency: project.currency,
      from: filters.from || null,
      to: filters.to || null,
      revenueAccounts,
      expenseAccounts,
      revenue: safeBigIntNumber(revenue),
      expense: safeBigIntNumber(expense),
      netIncome: safeBigIntNumber(revenue - expense),
    };
  }

  function balanceSheet(projectId, { to } = {}) {
    const project = requireProject(projectId);
    const rows = accountTotals(project, { to });
    const assets = rows.filter((row) => row.accountType === 'asset')
      .map((row) => ({ ...row, amount: row.debit - row.credit }));
    const liabilities = rows.filter((row) => row.accountType === 'liability')
      .map((row) => ({ ...row, amount: row.credit - row.debit }));
    const equity = rows.filter((row) => row.accountType === 'equity')
      .map((row) => ({ ...row, amount: row.credit - row.debit }));
    const total = (items) => items.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    const totalAssets = total(assets);
    const totalLiabilities = total(liabilities);
    const postedEquity = total(equity);
    const pnl = profitAndLoss(projectId, { to });
    const equityWithCurrentIncome = postedEquity + BigInt(pnl.netIncome);
    return {
      currency: project.currency,
      to: to || null,
      assets,
      liabilities,
      equity,
      totalAssets: safeBigIntNumber(totalAssets),
      totalLiabilities: safeBigIntNumber(totalLiabilities),
      postedEquity: safeBigIntNumber(postedEquity),
      currentNetIncome: pnl.netIncome,
      totalEquity: safeBigIntNumber(equityWithCurrentIncome),
      balanced: totalAssets === totalLiabilities + equityWithCurrentIncome,
    };
  }

  function valuationById(projectId, valuationId) {
    const row = db.prepare(`
      SELECT v.*, CAST(v.amount AS TEXT) AS amount_text
      FROM valuation_events v
      WHERE v.id=? AND v.project_id=?
    `).get(valuationId, projectId);
    if (!row) {
      throw notFound('VALUATION_NOT_FOUND', 'رویداد ارزش‌گذاری پیدا نشد.');
    }
    return mapValuation(row);
  }

  function valuations(projectId, { from, to, limit = 100 } = {}) {
    const project = requireProject(projectId);
    const selectedLimit = safeInteger(limit, 'limit', { minimum: 1, maximum: 500 });
    const range = dateFilter('v.valued_on', { from, to });
    return {
      valuations: db.prepare(`
        SELECT v.*, CAST(v.amount AS TEXT) AS amount_text
        FROM valuation_events v
        WHERE v.project_id=?
          ${range.clause}
        ORDER BY v.valued_on DESC, v.created_at DESC, v.id DESC
        LIMIT ?
      `).all(project.id, ...range.values, selectedLimit).map(mapValuation),
    };
  }

  function createValuation(
    projectId,
    input,
    { actor, idempotencyKey: selectedIdempotencyKey } = {},
  ) {
    const project = requireProject(projectId);
    const amount = safeInteger(input.amount, 'amount', {
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    const valuedOn = isoDate(input.valuedOn, 'valuedOn');
    if (valuedOn > at().slice(0, 10)) {
      throw badRequest('FUTURE_VALUATION_DATE', 'تاریخ ارزش‌گذاری نمی‌تواند در آینده باشد.', {
        valuedOn: 'یک تاریخ جاری یا گذشته وارد کنید.',
      });
    }
    const currency = currencyValue(input.currency, project.currency);
    if (currency !== project.currency) {
      throw conflict(
        'PROJECT_CURRENCY_MISMATCH',
        'ارزش‌گذاری باید با ارز پایه پروژه ثبت شود.',
      );
    }
    const sourceType = String(input.sourceType ?? 'manual').trim().toLowerCase();
    if (sourceType !== 'manual' || input.providerVerified === true) {
      throw badRequest(
        'VALUATION_SOURCE_NOT_SUPPORTED',
        'در این نسخه فقط ارزش‌گذاری دستی و صریح قابل ثبت است.',
      );
    }
    if (input.sourceId !== undefined) {
      throw badRequest(
        'VALUATION_SOURCE_ID_MANAGED',
        'شناسه منبع ارزش‌گذاری توسط سامانه مدیریت می‌شود.',
      );
    }
    const normalized = {
      amount,
      currency,
      valuedOn,
      description: optionalText(input.description, 'description', 4_000),
      methodology: optionalText(input.methodology, 'methodology', 8_000),
      documentId: input.documentId
        ? requiredText(input.documentId, 'documentId', 200)
        : null,
      sourceType: 'manual',
    };
    const keyHash = idempotencyHash(selectedIdempotencyKey, true);
    const hash = requestHash(normalized);
    const sourcePrefix = `idempotency:${keyHash}:`;
    const internalSourceId = `${sourcePrefix}${hash}`;
    let result;
    let replay = false;
    withTransaction(db, () => {
      const existing = db.prepare(`
        SELECT id, source_id
        FROM valuation_events
        WHERE project_id=? AND source_type='manual'
          AND substr(source_id,1,length(?))=?
        ORDER BY created_at, id
        LIMIT 1
      `).get(project.id, sourcePrefix, sourcePrefix);
      if (existing) {
        if (existing.source_id !== internalSourceId) {
          throw conflict(
            'IDEMPOTENCY_CONFLICT',
            'این کلید قبلاً برای یک ارزش‌گذاری متفاوت استفاده شده است.',
          );
        }
        result = valuationById(project.id, existing.id);
        replay = true;
        return;
      }

      if (normalized.documentId) {
        const document = db.prepare(`
          SELECT id
          FROM documents
          WHERE id=? AND organization_id=? AND archived_at IS NULL
            AND (project_id=? OR project_id IS NULL)
        `).get(
          normalized.documentId,
          project.organization_id,
          project.id,
        );
        if (!document) {
          throw badRequest(
            'INVALID_VALUATION_DOCUMENT',
            'سند ارزش‌گذاری باید به همین پروژه یا سازمان تعلق داشته باشد.',
          );
        }
      }

      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO valuation_events(
          id, project_id, amount, currency, valued_on, description,
          methodology, source_type, source_id, document_id,
          created_by_user_id, created_at
        ) VALUES(?,?,?,?,?,?,?,'manual',?,?,?,?)
      `).run(
        id,
        project.id,
        normalized.amount,
        normalized.currency,
        normalized.valuedOn,
        normalized.description,
        normalized.methodology,
        internalSourceId,
        normalized.documentId,
        actorUserId(actor),
        createdAt,
      );
      result = valuationById(project.id, id);
      auditEvent(
        project,
        'valuation_event',
        id,
        'created',
        actor,
        null,
        result,
        { sourceType: 'manual' },
      );
    });
    return { valuation: result, idempotentReplay: replay };
  }

  function documentedCapital(project, asOf) {
    const capitalAccountCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM accounting_accounts
      WHERE organization_id=? AND (project_id=? OR project_id IS NULL)
        AND account_type='equity' AND system_key='capital'
    `).get(project.organization_id, project.id).count);
    const lines = db.prepare(`
      SELECT
        j.occurred_on,
        l.stakeholder_id,
        CAST(l.debit AS TEXT) AS debit_text,
        CAST(l.credit AS TEXT) AS credit_text
      FROM journal_entries j
      JOIN journal_lines l ON l.journal_entry_id=j.id
      JOIN accounting_accounts a ON a.id=l.account_id
      WHERE j.project_id=?
        AND j.currency=?
        AND j.status IN ('posted','reversed')
        AND j.occurred_on<=?
        AND a.account_type='equity'
        AND a.system_key='capital'
      ORDER BY j.occurred_on, j.entry_no, l.id
    `).all(project.id, project.currency, asOf).map((row) => ({
      date: row.occurred_on,
      stakeholderId: row.stakeholder_id,
      debit: BigInt(row.debit_text),
      credit: BigInt(row.credit_text),
    }));
    const total = lines.reduce(
      (sum, line) => sum + line.credit - line.debit,
      0n,
    );
    return { capitalAccountCount, lines, total };
  }

  function returnDistributions(project, asOf) {
    return db.prepare(`
      SELECT
        d.id,
        d.status,
        d.record_date,
        d.payable_on,
        d.approved_at,
        d.currency,
        CAST(d.total_amount AS TEXT) AS amount_text
      FROM distributions d
      WHERE d.project_id=?
        AND d.status IN ('approved','processing','paid')
        AND substr(COALESCE(d.approved_at,d.updated_at,d.created_at),1,10)<=?
      ORDER BY d.record_date, d.created_at, d.id
    `).all(project.id, asOf).map((row) => {
      if (row.currency !== project.currency) {
        throw conflict(
          'DISTRIBUTION_CURRENCY_MISMATCH',
          'ارز سود توزیعی با ارز پایه پروژه یکسان نیست.',
        );
      }
      return {
        id: row.id,
        status: row.status,
        recordDate: row.record_date,
        cashFlowDate: String(
          row.approved_at ||
          row.payable_on ||
          row.record_date,
        ).slice(0, 10),
        amount: BigInt(row.amount_text),
      };
    });
  }

  function stakeholderReturnRows(
    project,
    asOf,
    latestValuation,
    capital,
    selectedDistributions,
  ) {
    const capitalByStakeholder = new Map();
    const capitalFlowsByStakeholder = new Map();
    for (const line of capital.lines) {
      if (!line.stakeholderId) continue;
      capitalByStakeholder.set(
        line.stakeholderId,
        (capitalByStakeholder.get(line.stakeholderId) || 0n) +
          line.credit -
          line.debit,
      );
      const flows = capitalFlowsByStakeholder.get(line.stakeholderId) || [];
      flows.push({ date: line.date, amount: line.debit - line.credit });
      capitalFlowsByStakeholder.set(line.stakeholderId, flows);
    }

    const distributionByStakeholder = new Map();
    const distributionFlowsByStakeholder = new Map();
    if (selectedDistributions.length) {
      const distributionDates = new Map(
        selectedDistributions.map((item) => [item.id, item.cashFlowDate]),
      );
      const placeholders = selectedDistributions.map(() => '?').join(',');
      const allocationRows = db.prepare(`
        SELECT
          a.distribution_id,
          a.stakeholder_id,
          CAST(a.amount AS TEXT) AS amount_text
        FROM distribution_allocations a
        WHERE a.distribution_id IN (${placeholders})
        ORDER BY a.distribution_id, a.stakeholder_id
      `).all(...selectedDistributions.map((item) => item.id));
      for (const row of allocationRows) {
        const amount = BigInt(row.amount_text);
        distributionByStakeholder.set(
          row.stakeholder_id,
          (distributionByStakeholder.get(row.stakeholder_id) || 0n) + amount,
        );
        const flows = distributionFlowsByStakeholder.get(row.stakeholder_id) || [];
        flows.push({
          date: distributionDates.get(row.distribution_id),
          amount,
        });
        distributionFlowsByStakeholder.set(row.stakeholder_id, flows);
      }
    }

    const valueByStakeholder = new Map();
    let valuationAllocationAvailable = false;
    if (latestValuation) {
      const holdings = holdingsAt(project.id, latestValuation.valuedOn);
      const weightsByStakeholder = new Map();
      for (const holding of holdings) {
        const current = BigInt(weightsByStakeholder.get(holding.stakeholderId) || 0);
        const next = current + BigInt(holding.units);
        if (next > MAX_SAFE_BIGINT) {
          throw conflict(
            'CAPITAL_AGGREGATE_INVALID',
            'مجموع واحدهای سهام از محدوده عددی امن خارج است.',
          );
        }
        weightsByStakeholder.set(holding.stakeholderId, Number(next));
      }
      if (weightsByStakeholder.size) {
        valuationAllocationAvailable = true;
        const allocations = largestRemainder(
          latestValuation.amount,
          [...weightsByStakeholder].map(([stakeholderId, weight]) => ({
            stakeholderId,
            weight,
            tieKey: stakeholderId,
          })),
        );
        for (const allocation of allocations) {
          valueByStakeholder.set(
            allocation.stakeholderId,
            BigInt(allocation.amount),
          );
        }
      }
    }

    const stakeholderIds = new Set([
      ...capitalByStakeholder.keys(),
      ...distributionByStakeholder.keys(),
      ...valueByStakeholder.keys(),
    ]);
    if (!stakeholderIds.size) return [];
    const placeholders = [...stakeholderIds].map(() => '?').join(',');
    const names = new Map(db.prepare(`
      SELECT id, name
      FROM project_stakeholders
      WHERE project_id=? AND id IN (${placeholders})
    `).all(project.id, ...stakeholderIds).map((row) => [row.id, row.name]));
    return [...stakeholderIds].sort().map((stakeholderId) => {
      const invested = capitalByStakeholder.get(stakeholderId) || 0n;
      const distributionsAmount =
        distributionByStakeholder.get(stakeholderId) || 0n;
      const currentValue = valueByStakeholder.get(stakeholderId);
      const totalMetric = latestValuation && valuationAllocationAvailable
        ? percentageMetric(
          (currentValue || 0n) + distributionsAmount - invested,
          invested,
          'stakeholder-linked capital journal lines, distribution allocations, and current share-holding valuation allocation',
        )
        : unavailableMetric(
          latestValuation
            ? 'NO_DOCUMENTED_SHARE_HOLDINGS'
            : 'NO_VALUATION',
          'stakeholder-linked capital journal lines, distribution allocations, and current share-holding valuation allocation',
        );
      const annualized = latestValuation && valuationAllocationAvailable
        ? annualizedReturnMetric(
          [
            ...(capitalFlowsByStakeholder.get(stakeholderId) || []),
            ...(distributionFlowsByStakeholder.get(stakeholderId) || []),
            {
              date: latestValuation.valuedOn,
              amount: currentValue || 0n,
            },
          ],
          'XIRR estimate from stakeholder-tagged capital, allocated distributions, and share-weighted terminal valuation',
        )
        : unavailableMetric(
          latestValuation
            ? 'NO_DOCUMENTED_SHARE_HOLDINGS'
            : 'NO_VALUATION',
          'XIRR estimate from stakeholder-tagged capital, allocated distributions, and share-weighted terminal valuation',
        );
      return {
        stakeholderId,
        stakeholderName: names.get(stakeholderId) || '',
        currency: project.currency,
        investedCapital: safeBigIntNumber(invested),
        distributions: safeBigIntNumber(distributionsAmount),
        estimatedCurrentValue: currentValue === undefined
          ? null
          : safeBigIntNumber(currentValue),
        totalReturnRoi: { ...totalMetric, estimate: true },
        annualizedReturn: { ...annualized, estimate: true },
        estimate: true,
        basis: {
          investedCapital: 'posted capital-account journal lines explicitly tagged with this stakeholder',
          distributions: 'approved, processing, or paid distribution allocations for this stakeholder',
          currentValue: 'latest project valuation allocated by share-ledger holdings on the valuation date',
        },
      };
    });
  }

  function returnsReport(projectId, filters = {}) {
    const project = requireProject(projectId);
    const asOf = isoDate(filters.asOf || filters.to || at().slice(0, 10), 'asOf');
    const capital = documentedCapital(project, asOf);
    const selectedDistributions = returnDistributions(project, asOf);
    const distributionTotals = {
      approved: 0n,
      processing: 0n,
      paid: 0n,
    };
    for (const distribution of selectedDistributions) {
      distributionTotals[distribution.status] += distribution.amount;
    }
    const totalDistributions = Object.values(distributionTotals)
      .reduce((sum, amount) => sum + amount, 0n);
    const latestRow = db.prepare(`
      SELECT v.*, CAST(v.amount AS TEXT) AS amount_text
      FROM valuation_events v
      WHERE v.project_id=? AND v.valued_on<=?
      ORDER BY v.valued_on DESC, v.created_at DESC, v.id DESC
      LIMIT 1
    `).get(project.id, asOf);
    const latestValuation = latestRow ? mapValuation(latestRow) : null;
    const pnl = profitAndLoss(project.id, { to: asOf });
    const capitalBasis =
      'net credits less debits in posted/reversed journal lines on equity accounts with systemKey=capital';
    const profitRoi = percentageMetric(
      BigInt(pnl.netIncome),
      capital.total,
      capitalBasis,
    );

    let totalReturnRoi;
    if (!latestValuation) {
      totalReturnRoi = unavailableMetric(
        'NO_VALUATION',
        `${capitalBasis}; latest manual or migrated valuation; approved/processing/paid distributions`,
      );
    } else if (latestValuation.currency !== project.currency) {
      totalReturnRoi = unavailableMetric(
        'VALUATION_CURRENCY_MISMATCH',
        `${capitalBasis}; latest valuation; approved/processing/paid distributions`,
      );
    } else {
      totalReturnRoi = percentageMetric(
        BigInt(latestValuation.amount) +
          totalDistributions -
          capital.total,
        capital.total,
        `${capitalBasis}; latest valuation; approved/processing/paid distributions`,
      );
    }

    let annualizedReturn;
    if (!latestValuation) {
      annualizedReturn = unavailableMetric(
        'NO_VALUATION',
        'XIRR estimate from documented capital cash flows, distributions, and terminal valuation',
      );
    } else if (latestValuation.currency !== project.currency) {
      annualizedReturn = unavailableMetric(
        'VALUATION_CURRENCY_MISMATCH',
        'XIRR estimate from documented capital cash flows, distributions, and terminal valuation',
      );
    } else {
      annualizedReturn = annualizedReturnMetric(
        [
          ...capital.lines.map((line) => ({
            date: line.date,
            amount: line.debit - line.credit,
          })),
          ...selectedDistributions.map((distribution) => ({
            date: distribution.cashFlowDate,
            amount: distribution.amount,
          })),
          {
            date: latestValuation.valuedOn,
            amount: BigInt(latestValuation.amount),
          },
        ],
        'XIRR estimate from documented capital cash flows, distributions, and terminal valuation',
      );
    }

    const investedCapital = safeBigIntNumber(capital.total);
    const distributionsResult = {
      approved: safeBigIntNumber(distributionTotals.approved),
      processing: safeBigIntNumber(distributionTotals.processing),
      paid: safeBigIntNumber(distributionTotals.paid),
      total: safeBigIntNumber(totalDistributions),
    };
    return {
      projectId: project.id,
      currency: project.currency,
      asOf,
      latestValuation,
      investedCapital,
      investedCapitalAvailability: {
        available: capital.capitalAccountCount > 0,
        reason: capital.capitalAccountCount > 0
          ? null
          : 'CAPITAL_ACCOUNT_NOT_CONFIGURED',
        basis: capitalBasis,
      },
      distributions: distributionsResult,
      netIncome: pnl.netIncome,
      profitRoi,
      totalReturnRoi,
      annualizedReturn,
      stakeholderReturns: stakeholderReturnRows(
        project,
        asOf,
        latestValuation,
        capital,
        selectedDistributions,
      ),
      notes: [
        'Only posted double-entry records are used for invested capital and net income.',
        'Approved and processing distributions are entitlements, not proof of cash settlement.',
        'Annualized and stakeholder current-value figures are estimates with their basis explicitly stated.',
      ],
    };
  }

  function invoices(projectId, { kind, status, limit = 200 } = {}) {
    const project = requireProject(projectId);
    if (kind !== undefined) enumValue(kind, INVOICE_KINDS, 'kind');
    const allowedStatuses = new Set([
      'draft',
      'issued',
      'partially_paid',
      'paid',
      'overdue',
      'void',
    ]);
    if (status !== undefined) enumValue(status, allowedStatuses, 'status');
    const selectedLimit = safeInteger(limit, 'limit', { minimum: 1, maximum: 500 });
    const where = ['project_id=?'];
    const params = [project.id];
    if (kind) {
      where.push('kind=?');
      params.push(kind);
    }
    if (status) {
      where.push('status=?');
      params.push(status);
    }
    params.push(selectedLimit);
    return {
      invoices: db.prepare(`
        SELECT *
        FROM invoices
        WHERE ${where.join(' AND ')}
        ORDER BY issued_on DESC, created_at DESC, id
        LIMIT ?
      `).all(...params).map(mapInvoice),
    };
  }

  function requireInvoice(projectId, invoiceId) {
    const row = db.prepare(`
      SELECT *
      FROM invoices
      WHERE id=? AND project_id=?
    `).get(invoiceId, projectId);
    if (!row) throw notFound('INVOICE_NOT_FOUND', 'صورتحساب پیدا نشد.');
    return row;
  }

  function issueInvoice(projectId, input, { actor, idempotencyKey } = {}) {
    const project = requireProject(projectId);
    const keyHash = idempotencyHash(idempotencyKey, true);
    const kind = enumValue(input.kind, INVOICE_KINDS, 'kind');
    const issuedOn = isoDate(input.issuedOn, 'issuedOn');
    const subtotal = safeInteger(input.subtotal, 'subtotal');
    const taxAmount = safeInteger(input.taxAmount ?? 0, 'taxAmount');
    const discountAmount = safeInteger(input.discountAmount ?? 0, 'discountAmount');
    const totalExact = BigInt(subtotal) + BigInt(taxAmount) - BigInt(discountAmount);
    if (totalExact < 0n || totalExact > MAX_SAFE_BIGINT) {
      throw badRequest(
        'VALIDATION_FAILED',
        'مبلغ کل صورتحساب معتبر نیست.',
        { totalAmount: 'جمع جزء، مالیات و تخفیف باید در محدوده معتبر باشد.' },
      );
    }
    const totalAmount = Number(totalExact);
    if (
      input.totalAmount !== undefined &&
      safeInteger(input.totalAmount, 'totalAmount') !== totalAmount
    ) {
      throw conflict(
        'INVOICE_TOTAL_MISMATCH',
        'مبلغ کل با جمع اجزای صورتحساب برابر نیست.',
      );
    }
    if (totalAmount <= 0) {
      throw badRequest('VALIDATION_FAILED', 'مبلغ صورتحساب باید بیشتر از صفر باشد.');
    }
    const currency = currencyValue(input.currency, project.currency);
    if (currency !== project.currency) {
      throw conflict('PROJECT_CURRENCY_MISMATCH', 'ارز صورتحساب باید با ارز پروژه یکسان باشد.');
    }
    const debitAccount = requireAccount(project, input.debitAccountId);
    const creditAccount = requireAccount(project, input.creditAccountId);
    const invoiceNo = requiredText(input.invoiceNo, 'invoiceNo', 100);
    const normalized = {
      kind,
      invoiceNo,
      counterpartyType: optionalText(input.counterpartyType, 'counterpartyType', 50) || 'external',
      counterpartyId: input.counterpartyId ? String(input.counterpartyId) : null,
      counterpartyName: requiredText(input.counterpartyName, 'counterpartyName', 300),
      issuedOn,
      dueOn: optionalIsoDate(input.dueOn, 'dueOn'),
      currency,
      subtotal,
      taxAmount,
      discountAmount,
      totalAmount,
      debitAccountId: debitAccount.id,
      creditAccountId: creditAccount.id,
      documentId: input.documentId || null,
      notes: optionalText(input.notes, 'notes', 5_000),
    };
    const hash = requestHash(normalized);
    let invoice;
    let replay = false;
    withTransaction(db, () => {
      const existingJournal = idempotentJournal(project, keyHash, hash);
      if (existingJournal) {
        const existingInvoice = db.prepare(
          'SELECT * FROM invoices WHERE journal_entry_id=? AND project_id=?',
        ).get(existingJournal.id, project.id);
        if (!existingInvoice) {
          throw conflict(
            'IDEMPOTENCY_STATE_INVALID',
            'رسید تکرارپذیری به صورتحساب متصل نیست.',
          );
        }
        invoice = mapInvoice(existingInvoice);
        replay = true;
        return;
      }
      if (normalized.documentId) {
        const document = db.prepare(`
          SELECT id FROM documents
          WHERE id=? AND organization_id=?
            AND (project_id=? OR project_id IS NULL)
        `).get(normalized.documentId, project.organization_id, project.id);
        if (!document) throw badRequest('INVALID_DOCUMENT', 'سند پیوست معتبر نیست.');
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO invoices(
          id, organization_id, project_id, kind, counterparty_type,
          counterparty_id, counterparty_name, invoice_no, issued_on, due_on,
          currency, subtotal, tax_amount, discount_amount, total_amount,
          paid_amount, status, journal_entry_id, document_id, notes,
          created_by_user_id, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'draft',NULL,?,?,?,?,?)
      `).run(
        id,
        project.organization_id,
        project.id,
        kind,
        normalized.counterpartyType,
        normalized.counterpartyId,
        normalized.counterpartyName,
        invoiceNo,
        issuedOn,
        normalized.dueOn,
        currency,
        subtotal,
        taxAmount,
        discountAmount,
        totalAmount,
        normalized.documentId,
        normalized.notes,
        actorUserId(actor),
        createdAt,
        createdAt,
      );
      const draft = createDraftInside(project, {
        occurredOn: issuedOn,
        fiscalPeriodId: input.fiscalPeriodId,
        description: `صورتحساب ${invoiceNo} — ${normalized.counterpartyName}`,
        currency,
        sourceType: `invoice_${kind}`,
        sourceId: id,
        lines: [
          {
            accountId: debitAccount.id,
            stakeholderId: normalized.counterpartyType === 'stakeholder'
              ? normalized.counterpartyId
              : null,
            description: normalized.notes,
            debit: totalAmount,
            credit: 0,
          },
          {
            accountId: creditAccount.id,
            stakeholderId: normalized.counterpartyType === 'stakeholder'
              ? normalized.counterpartyId
              : null,
            description: normalized.notes,
            debit: 0,
            credit: totalAmount,
          },
        ],
      }, actor, keyHash, hash);
      const posted = postJournalInside(project, draft.id, actor);
      db.prepare(`
        UPDATE invoices
        SET status='issued', journal_entry_id=?, updated_at=?
        WHERE id=?
      `).run(posted.id, at(), id);
      invoice = mapInvoice(requireInvoice(project.id, id));
      auditEvent(project, 'invoice', id, 'issued', actor, null, invoice, {
        journalEntryId: posted.id,
      });
    });
    return { invoice, idempotentReplay: replay };
  }

  function voidInvoice(projectId, invoiceId, input, { actor, idempotencyKey } = {}) {
    const project = requireProject(projectId);
    let invoice;
    let reversal = null;
    let replay = false;
    withTransaction(db, () => {
      const current = requireInvoice(project.id, invoiceId);
      if (current.status === 'void') {
        invoice = mapInvoice(current);
        replay = true;
        return;
      }
      if (Number(current.paid_amount) > 0) {
        throw conflict(
          'INVOICE_HAS_PAYMENTS',
          'صورتحساب دارای پرداخت است و ابتدا باید پرداخت‌ها برگشت داده شوند.',
        );
      }
      if (!current.journal_entry_id) {
        throw conflict('INVOICE_NOT_ISSUED', 'صورتحساب سند حسابداری ندارد.');
      }
      const keyHash = idempotencyHash(idempotencyKey, true);
      const occurredOn = isoDate(input.occurredOn, 'occurredOn');
      const hash = requestHash({ invoiceId, occurredOn, fiscalPeriodId: input.fiscalPeriodId || null });
      const existing = idempotentJournal(project, keyHash, hash);
      if (existing) {
        reversal = journalResult(existing);
      } else {
        const original = journalRow(project.id, current.journal_entry_id);
        if (original.status === 'draft') {
          throw conflict('INVOICE_JOURNAL_NOT_POSTED', 'سند صورتحساب ثبت نشده است.');
        }
        const lines = db.prepare(
          'SELECT * FROM journal_lines WHERE journal_entry_id=? ORDER BY created_at,id',
        ).all(original.id);
        const draft = createDraftInside(project, {
          occurredOn,
          fiscalPeriodId: input.fiscalPeriodId,
          description: optionalText(input.description, 'description', 2_000)
            || `ابطال صورتحساب ${current.invoice_no}`,
          currency: current.currency,
          sourceType: 'invoice_void',
          sourceId: current.id,
          lines: lines.map((line) => ({
            accountId: line.account_id,
            stakeholderId: line.stakeholder_id,
            description: line.description,
            debit: Number(line.credit),
            credit: Number(line.debit),
          })),
        }, actor, keyHash, hash);
        db.prepare('UPDATE journal_entries SET reversal_of_id=? WHERE id=?')
          .run(original.id, draft.id);
        reversal = journalResult(postJournalInside(project, draft.id, actor));
        db.prepare(`
          UPDATE journal_entries SET status='reversed', updated_at=?
          WHERE id=? AND status='posted'
        `).run(at(), original.id);
      }
      db.prepare(`
        UPDATE invoices SET status='void', updated_at=? WHERE id=?
      `).run(at(), current.id);
      invoice = mapInvoice(requireInvoice(project.id, current.id));
      auditEvent(project, 'invoice', current.id, 'voided', actor, mapInvoice(current), invoice, {
        reversalJournalEntryId: reversal.id,
      });
    });
    return { invoice, reversalJournalEntry: reversal, idempotentReplay: replay };
  }

  function payments(projectId, { status, limit = 200 } = {}) {
    const project = requireProject(projectId);
    const selectedLimit = safeInteger(limit, 'limit', { minimum: 1, maximum: 500 });
    const params = status ? [project.id, String(status), selectedLimit] : [project.id, selectedLimit];
    return {
      paymentIntents: db.prepare(`
        SELECT *
        FROM payment_intents
        WHERE project_id=? ${status ? 'AND status=?' : ''}
        ORDER BY created_at DESC, id
        LIMIT ?
      `).all(...params).map(mapPayment),
    };
  }

  function requirePayment(projectId, paymentId) {
    const row = db.prepare(`
      SELECT *
      FROM payment_intents
      WHERE id=? AND project_id=?
    `).get(paymentId, projectId);
    if (!row) throw notFound('PAYMENT_NOT_FOUND', 'درخواست پرداخت پیدا نشد.');
    return row;
  }

  function createPaymentIntent(projectId, input, { actor, idempotencyKey } = {}) {
    const project = requireProject(projectId);
    const keyHash = idempotencyHash(idempotencyKey, true);
    const provider = paymentProvider(input.provider);
    if (input.providerVerified || input.providerReference) {
      throw badRequest(
        'PROVIDER_VERIFICATION_NOT_ACCEPTED',
        'وضعیت تأیید ارائه‌دهنده از ورودی کاربر پذیرفته نمی‌شود.',
      );
    }
    let invoice = null;
    if (input.invoiceId) invoice = requireInvoice(project.id, input.invoiceId);
    const direction = enumValue(
      input.direction,
      PAYMENT_DIRECTIONS,
      'direction',
      invoice?.kind === 'payable' ? 'outgoing' : 'incoming',
    );
    if (
      invoice &&
      (
        (invoice.kind === 'receivable' && direction !== 'incoming') ||
        (invoice.kind === 'payable' && direction !== 'outgoing')
      )
    ) {
      throw conflict('PAYMENT_DIRECTION_MISMATCH', 'جهت پرداخت با نوع صورتحساب سازگار نیست.');
    }
    const amount = safeInteger(input.amount, 'amount', { minimum: 1 });
    const currency = currencyValue(input.currency, project.currency);
    if (currency !== project.currency || (invoice && currency !== invoice.currency)) {
      throw conflict('PAYMENT_CURRENCY_MISMATCH', 'ارز پرداخت معتبر نیست.');
    }
    if (invoice) {
      if (['void', 'paid'].includes(invoice.status)) {
        throw conflict('INVOICE_NOT_PAYABLE', 'صورتحساب قابل پرداخت نیست.');
      }
      const outstanding = Number(invoice.total_amount) - Number(invoice.paid_amount);
      if (amount > outstanding) {
        throw conflict('PAYMENT_EXCEEDS_OUTSTANDING', 'مبلغ از مانده صورتحساب بیشتر است.');
      }
    }
    let purposeType = null;
    let purposeId = null;
    if (invoice) {
      if (
        (input.purposeType && input.purposeType !== 'invoice') ||
        (input.purposeId && String(input.purposeId) !== invoice.id)
      ) {
        throw conflict(
          'PAYMENT_PURPOSE_MISMATCH',
          'An invoice payment cannot be linked to another purpose.',
        );
      }
      purposeType = 'invoice';
      purposeId = invoice.id;
    } else if (input.purposeType !== undefined) {
      purposeType = enumValue(
        input.purposeType,
        PAYMENT_PURPOSE_TYPES,
        'purposeType',
      );
      if (purposeType === 'invoice') {
        throw badRequest(
          'PAYMENT_INVOICE_REQUIRED',
          'invoiceId is required for an invoice payment purpose.',
        );
      }
      purposeId = input.purposeId
        ? requiredText(input.purposeId, 'purposeId', 200)
        : null;
      if (purposeType !== 'general' && !purposeId) {
        throw badRequest(
          'PAYMENT_PURPOSE_ID_REQUIRED',
          'purposeId is required for a restricted payment purpose.',
          { purposeId: 'Enter the referenced operation identifier.' },
        );
      }
      if (purposeType === 'share_transfer') {
        const transfer = db.prepare(`
          SELECT id, price_amount
          FROM share_transfers
          WHERE id=? AND project_id=? AND status='draft'
          LIMIT 1
        `).get(purposeId, project.id);
        if (
          !transfer ||
          Number(transfer.price_amount || 0) !== amount ||
          direction !== 'incoming'
        ) {
          throw conflict(
            'SHARE_TRANSFER_PAYMENT_PURPOSE_INVALID',
            'The payment must reference a draft transfer in the same project with the exact amount.',
          );
        }
      }
    } else if (input.purposeId !== undefined) {
      throw badRequest(
        'PAYMENT_PURPOSE_TYPE_REQUIRED',
        'purposeType is required when purposeId is provided.',
      );
    }
    const purposeHash = purposeType
      ? sha256(JSON.stringify({
        purposeType,
        purposeId,
        projectId: project.id,
        amount,
        currency,
        direction,
      }))
      : null;
    const hash = requestHash({
      invoiceId: invoice?.id || null,
      purposeType,
      purposeId,
      purposeHash,
      direction,
      provider,
      amount,
      currency,
    });
    let payment;
    let replay = false;
    withTransaction(db, () => {
      const existing = db.prepare(`
        SELECT *
        FROM payment_intents
        WHERE organization_id=? AND idempotency_key_hash=?
      `).get(project.organization_id, keyHash);
      if (existing) {
        const event = db.prepare(`
          SELECT payload_json FROM payment_events
          WHERE payment_intent_id=? AND event_type='intent_created'
        `).get(existing.id);
        if (parseJson(event?.payload_json).requestHash !== hash) {
          throw conflict(
            'IDEMPOTENCY_CONFLICT',
            'این کلید قبلاً برای پرداخت متفاوتی استفاده شده است.',
          );
        }
        payment = mapPayment(existing);
        replay = true;
        return;
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO payment_intents(
          id, organization_id, project_id, invoice_id,
          purpose_type, purpose_id, purpose_hash, direction, provider,
          provider_reference, idempotency_key_hash, amount, currency, status,
          failure_reason, initiated_by_user_id, completed_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?, '', ?,?,?, 'pending','',?,NULL,?,?)
      `).run(
        id,
        project.organization_id,
        project.id,
        invoice?.id || null,
        purposeType,
        purposeId,
        purposeHash,
        direction,
        provider,
        keyHash,
        amount,
        currency,
        actorUserId(actor),
        createdAt,
        createdAt,
      );
      db.prepare(`
        INSERT INTO payment_events(
          id, payment_intent_id, provider_event_id, event_type,
          payload_json, received_at
        ) VALUES(?,?,?,'intent_created',?,?)
      `).run(
        randomUUID(),
        id,
        `intent:${id}`,
        JSON.stringify({ requestHash: hash }),
        createdAt,
      );
      payment = mapPayment(requirePayment(project.id, id));
      auditEvent(project, 'payment_intent', id, 'created', actor, null, payment);
    });
    return { paymentIntent: payment, idempotentReplay: replay };
  }

  function invoiceSettlementAccount(project, invoice) {
    const line = db.prepare(`
      SELECT l.account_id, a.account_type, l.debit, l.credit
      FROM journal_lines l
      JOIN accounting_accounts a ON a.id=l.account_id
      WHERE l.journal_entry_id=?
      ORDER BY l.created_at, l.id
    `).all(invoice.journal_entry_id).find((candidate) => (
      invoice.kind === 'receivable'
        ? candidate.account_type === 'asset' && Number(candidate.debit) > 0
        : candidate.account_type === 'liability' && Number(candidate.credit) > 0
    ));
    if (!line) {
      throw conflict(
        'INVOICE_SETTLEMENT_ACCOUNT_MISSING',
        'حساب دریافتنی یا پرداختنی صورتحساب قابل تشخیص نیست.',
      );
    }
    return requireAccount(project, line.account_id);
  }

  function confirmPayment(projectId, paymentId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const providerEventId = requiredText(input.providerEventId, 'providerEventId', 200);
    const manualReference = optionalText(input.manualReference, 'manualReference', 200);
    let payment;
    let invoice = null;
    let journal = null;
    let replay = false;
    withTransaction(db, () => {
      const current = requirePayment(project.id, paymentId);
      if (current.provider !== configuredPaymentProvider) {
        throw conflict(
          'PROVIDER_ADAPTER_REQUIRED',
          'تأیید این پرداخت فقط از adapter رسمی ارائه‌دهنده ممکن است.',
        );
      }
      if (current.provider === 'manual' && !manualReference) {
        throw badRequest(
          'MANUAL_REFERENCE_REQUIRED',
          'برای تأیید دستی، شماره پیگیری یا مرجع بانکی الزامی است.',
        );
      }
      if (input.providerVerified) {
        throw badRequest(
          'PROVIDER_VERIFICATION_NOT_ACCEPTED',
          'پرچم تأیید ارائه‌دهنده از ورودی کاربر پذیرفته نمی‌شود.',
        );
      }
      const priorEvent = db.prepare(`
        SELECT * FROM payment_events
        WHERE payment_intent_id=? AND provider_event_id=?
      `).get(paymentId, providerEventId);
      if (priorEvent) {
        payment = mapPayment(requirePayment(project.id, paymentId));
        invoice = current.invoice_id
          ? mapInvoice(requireInvoice(project.id, current.invoice_id))
          : null;
        replay = true;
        return;
      }
      if (current.status === 'succeeded') {
        throw conflict(
          'PAYMENT_ALREADY_COMPLETED',
          'پرداخت با رویداد دیگری قبلاً تکمیل شده است.',
        );
      }
      if (!['pending', 'requires_action', 'processing'].includes(current.status)) {
        throw conflict('PAYMENT_NOT_CONFIRMABLE', 'پرداخت در وضعیت قابل تأیید نیست.');
      }
      const cashAccount = requireAccount(project, input.cashAccountId);
      let settlementAccount = null;
      if (current.invoice_id) {
        const invoiceRow = requireInvoice(project.id, current.invoice_id);
        const outstanding = Number(invoiceRow.total_amount) - Number(invoiceRow.paid_amount);
        if (Number(current.amount) > outstanding) {
          throw conflict('PAYMENT_EXCEEDS_OUTSTANDING', 'مبلغ از مانده صورتحساب بیشتر است.');
        }
        settlementAccount = invoiceSettlementAccount(project, invoiceRow);
        invoice = mapInvoice(invoiceRow);
      } else {
        settlementAccount = requireAccount(project, input.counterAccountId);
      }
      const amount = Number(current.amount);
      const lines = current.direction === 'incoming'
        ? [
          { accountId: cashAccount.id, debit: amount, credit: 0 },
          { accountId: settlementAccount.id, debit: 0, credit: amount },
        ]
        : [
          { accountId: settlementAccount.id, debit: amount, credit: 0 },
          { accountId: cashAccount.id, debit: 0, credit: amount },
        ];
      const internalKey = sha256(`payment-confirm:${current.id}`);
      const hash = requestHash({
        paymentId: current.id,
        amount,
        cashAccountId: cashAccount.id,
        counterAccountId: settlementAccount.id,
      });
      let draft = idempotentJournal(project, internalKey, hash);
      if (!draft) {
        draft = createDraftInside(project, {
          occurredOn: input.occurredOn || at().slice(0, 10),
          fiscalPeriodId: input.fiscalPeriodId,
          description: `تسویه پرداخت ${current.id}`,
          currency: current.currency,
          sourceType: 'payment',
          sourceId: current.id,
          lines,
        }, actor, internalKey, hash);
        draft = postJournalInside(project, draft.id, actor);
      }
      journal = journalResult(draft);
      const completedAt = at();
      db.prepare(`
        INSERT INTO payment_events(
          id, payment_intent_id, provider_event_id, event_type,
          payload_json, received_at
        ) VALUES(?,?,?,'payment_confirmed',?,?)
      `).run(
        randomUUID(),
        current.id,
        providerEventId,
        JSON.stringify({
          provider: current.provider,
          manual: current.provider === 'manual',
          referenceHash: manualReference ? sha256(manualReference) : '',
        }),
        completedAt,
      );
      db.prepare(`
        UPDATE payment_intents
        SET status='succeeded', provider_reference=?, completed_at=?, updated_at=?
        WHERE id=?
      `).run(
        current.provider === 'manual' ? manualReference : providerEventId,
        completedAt,
        completedAt,
        current.id,
      );
      if (current.invoice_id) {
        const invoiceRow = requireInvoice(project.id, current.invoice_id);
        const paidAmount = Number(invoiceRow.paid_amount) + amount;
        const status = paidAmount === Number(invoiceRow.total_amount)
          ? 'paid'
          : 'partially_paid';
        db.prepare(`
          UPDATE invoices
          SET paid_amount=?, status=?, updated_at=?
          WHERE id=?
        `).run(paidAmount, status, completedAt, invoiceRow.id);
        invoice = mapInvoice(requireInvoice(project.id, invoiceRow.id));
      }
      payment = mapPayment(requirePayment(project.id, current.id));
      auditEvent(project, 'payment_intent', current.id, 'confirmed', actor, mapPayment(current), payment, {
        provider: current.provider,
        providerEventId,
        journalEntryId: journal.id,
      });
    });
    return {
      paymentIntent: payment,
      invoice,
      journalEntry: journal,
      idempotentReplay: replay,
    };
  }

  function holdingsAt(projectId, recordDate, shareClassId = null) {
    const date = isoDate(recordDate, 'recordDate');
    const params = [projectId, date];
    const classFilter = shareClassId ? 'AND l.share_class_id=?' : '';
    if (shareClassId) params.push(shareClassId);
    const rows = db.prepare(`
      SELECT
        l.stakeholder_id,
        l.share_class_id,
        SUM(l.units) AS units
      FROM share_ledger l
      WHERE l.project_id=?
        AND substr(l.created_at,1,10)<=?
        ${classFilter}
      GROUP BY l.stakeholder_id, l.share_class_id
      HAVING SUM(l.units)>0
      ORDER BY l.stakeholder_id, l.share_class_id
    `).all(...params);
    return rows.map((row) => {
      const units = Number(row.units);
      if (!Number.isSafeInteger(units) || units <= 0) {
        throw conflict('CAPITAL_AGGREGATE_INVALID', 'موجودی سهام معتبر نیست.');
      }
      return {
        stakeholderId: row.stakeholder_id,
        shareClassId: row.share_class_id,
        units,
      };
    });
  }

  function largestRemainder(totalAmount, weights) {
    const total = BigInt(totalAmount);
    const totalWeight = weights.reduce((sum, item) => sum + BigInt(item.weight), 0n);
    if (totalWeight <= 0n) {
      throw conflict('NO_ELIGIBLE_HOLDINGS', 'در تاریخ مبنا دارنده واجد شرایطی وجود ندارد.');
    }
    const allocations = weights.map((item) => {
      const numerator = total * BigInt(item.weight);
      return {
        ...item,
        amount: numerator / totalWeight,
        remainder: numerator % totalWeight,
      };
    });
    let allocated = allocations.reduce((sum, item) => sum + item.amount, 0n);
    const ranked = [...allocations].sort((left, right) => {
      if (left.remainder !== right.remainder) {
        return left.remainder > right.remainder ? -1 : 1;
      }
      return String(left.tieKey).localeCompare(String(right.tieKey));
    });
    let index = 0;
    while (allocated < total) {
      ranked[index % ranked.length].amount += 1n;
      allocated += 1n;
      index += 1;
    }
    return allocations.map((item) => ({
      ...item,
      amount: safeBigIntNumber(item.amount),
      remainder: undefined,
    }));
  }

  function distributionResult(projectId, distributionId) {
    const row = db.prepare(`
      SELECT * FROM distributions WHERE id=? AND project_id=?
    `).get(distributionId, projectId);
    if (!row) throw notFound('DISTRIBUTION_NOT_FOUND', 'توزیع پیدا نشد.');
    const allocations = db.prepare(`
      SELECT a.*, s.name AS stakeholder_name
      FROM distribution_allocations a
      JOIN project_stakeholders s ON s.id=a.stakeholder_id
      WHERE a.distribution_id=?
      ORDER BY a.amount DESC, a.stakeholder_id
    `).all(distributionId).map((allocation) => ({
      id: allocation.id,
      stakeholderId: allocation.stakeholder_id,
      stakeholderName: allocation.stakeholder_name,
      eligibleUnits: Number(allocation.eligible_units),
      amount: Number(allocation.amount),
      status: allocation.status,
      paymentIntentId: allocation.payment_intent_id,
      paidAt: allocation.paid_at,
      createdAt: allocation.created_at,
      updatedAt: allocation.updated_at,
    }));
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      recordDate: row.record_date,
      payableOn: row.payable_on,
      currency: row.currency,
      totalAmount: Number(row.total_amount),
      status: row.status,
      resolutionId: row.resolution_id,
      journalEntryId: row.journal_entry_id,
      approvedByUserId: row.approved_by_user_id,
      approvedAt: row.approved_at,
      allocations,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function distributions(projectId, { status, limit = 100 } = {}) {
    const project = requireProject(projectId);
    const selectedLimit = safeInteger(limit, 'limit', { minimum: 1, maximum: 500 });
    const rows = db.prepare(`
      SELECT id
      FROM distributions
      WHERE project_id=? ${status ? 'AND status=?' : ''}
      ORDER BY record_date DESC, created_at DESC, id
      LIMIT ?
    `).all(...(status
      ? [project.id, String(status), selectedLimit]
      : [project.id, selectedLimit]));
    return { distributions: rows.map((row) => distributionResult(project.id, row.id)) };
  }

  function createDistributionPreview(projectId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const recordDate = isoDate(input.recordDate, 'recordDate');
    const totalAmount = safeInteger(input.totalAmount, 'totalAmount', { minimum: 1 });
    const currency = currencyValue(input.currency, project.currency);
    if (currency !== project.currency) {
      throw conflict('PROJECT_CURRENCY_MISMATCH', 'ارز توزیع باید با ارز پروژه یکسان باشد.');
    }
    const holdings = holdingsAt(project.id, recordDate, input.shareClassId || null);
    const byStakeholder = new Map();
    for (const holding of holdings) {
      byStakeholder.set(
        holding.stakeholderId,
        (byStakeholder.get(holding.stakeholderId) || 0n) + BigInt(holding.units),
      );
    }
    const weights = [...byStakeholder].map(([stakeholderId, units]) => ({
      stakeholderId,
      weight: safeBigIntNumber(units),
      tieKey: stakeholderId,
    }));
    const allocations = largestRemainder(totalAmount, weights);
    let result;
    withTransaction(db, () => {
      if (input.resolutionId) {
        const resolution = db.prepare(`
          SELECT r.id
          FROM meeting_resolutions r
          JOIN project_meetings m ON m.id=r.meeting_id
          WHERE r.id=? AND m.project_id=? AND r.status='closed'
        `).get(input.resolutionId, project.id);
        if (!resolution) {
          throw badRequest(
            'INVALID_RESOLUTION',
            'مصوبه بسته‌شده و متعلق به پروژه لازم است.',
          );
        }
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO distributions(
          id, project_id, title, record_date, payable_on, currency,
          total_amount, status, resolution_id, journal_entry_id,
          approved_by_user_id, approved_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,'draft',?,NULL,NULL,NULL,?,?)
      `).run(
        id,
        project.id,
        requiredText(input.title, 'title', 300),
        recordDate,
        optionalIsoDate(input.payableOn, 'payableOn'),
        currency,
        totalAmount,
        input.resolutionId || null,
        createdAt,
        createdAt,
      );
      const insert = db.prepare(`
        INSERT INTO distribution_allocations(
          id, distribution_id, stakeholder_id, eligible_units, amount,
          status, payment_intent_id, paid_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,'pending',NULL,NULL,?,?)
      `);
      for (const allocation of allocations) {
        insert.run(
          randomUUID(),
          id,
          allocation.stakeholderId,
          allocation.weight,
          allocation.amount,
          createdAt,
          createdAt,
        );
      }
      result = distributionResult(project.id, id);
      auditEvent(project, 'distribution', id, 'preview_created', actor, null, result, {
        allocationMethod: 'largest-remainder-v1',
        shareClassId: input.shareClassId || null,
      });
    });
    return { distribution: result };
  }

  function approveDistribution(projectId, distributionId, input, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    let journal;
    let replay = false;
    withTransaction(db, () => {
      const current = distributionResult(project.id, distributionId);
      if (current.status === 'approved') {
        result = current;
        journal = current.journalEntryId
          ? journalResult(journalRow(project.id, current.journalEntryId))
          : null;
        replay = true;
        return;
      }
      if (current.status !== 'draft') {
        throw conflict('DISTRIBUTION_NOT_DRAFT', 'فقط پیش‌نویس توزیع قابل تصویب است.');
      }
      const sum = current.allocations.reduce(
        (total, allocation) => total + BigInt(allocation.amount),
        0n,
      );
      if (sum !== BigInt(current.totalAmount)) {
        throw conflict('DISTRIBUTION_ALLOCATION_INVALID', 'جمع تخصیص‌ها با مبلغ توزیع برابر نیست.');
      }
      const debitAccount = requireAccount(project, input.retainedEarningsAccountId);
      const creditAccount = requireAccount(project, input.payableAccountId);
      if (debitAccount.account_type !== 'equity') {
        throw badRequest('INVALID_ACCOUNT_TYPE', 'حساب بدهکار توزیع باید از نوع حقوق مالکانه باشد.');
      }
      if (creditAccount.account_type !== 'liability') {
        throw badRequest('INVALID_ACCOUNT_TYPE', 'حساب بستانکار توزیع باید از نوع بدهی باشد.');
      }
      const internalKey = sha256(`distribution-approval:${distributionId}`);
      const hash = requestHash({
        distributionId,
        retainedEarningsAccountId: debitAccount.id,
        payableAccountId: creditAccount.id,
      });
      let draft = idempotentJournal(project, internalKey, hash);
      if (!draft) {
        draft = createDraftInside(project, {
          occurredOn: input.occurredOn || current.recordDate,
          fiscalPeriodId: input.fiscalPeriodId,
          description: `تصویب توزیع: ${current.title}`,
          currency: current.currency,
          sourceType: 'distribution_declaration',
          sourceId: current.id,
          lines: [
            {
              accountId: debitAccount.id,
              debit: current.totalAmount,
              credit: 0,
            },
            {
              accountId: creditAccount.id,
              debit: 0,
              credit: current.totalAmount,
            },
          ],
        }, actor, internalKey, hash);
        draft = postJournalInside(project, draft.id, actor);
      }
      journal = journalResult(draft);
      const approvedAt = at();
      db.prepare(`
        UPDATE distributions
        SET status='approved', journal_entry_id=?, approved_by_user_id=?,
            approved_at=?, updated_at=?
        WHERE id=? AND status='draft'
      `).run(
        journal.id,
        actorUserId(actor),
        approvedAt,
        approvedAt,
        distributionId,
      );
      result = distributionResult(project.id, distributionId);
      auditEvent(project, 'distribution', distributionId, 'approved', actor, current, result, {
        journalEntryId: journal.id,
      });
    });
    return { distribution: result, journalEntry: journal, idempotentReplay: replay };
  }

  function stakeholderHasCurrentKyc(project, stakeholderId, onDate) {
    return Boolean(db.prepare(`
      SELECT 1
      FROM kyc_cases
      WHERE organization_id=? AND project_id=?
        AND subject_type='stakeholder' AND subject_id=?
        AND status='verified'
        AND (expires_at IS NULL OR substr(expires_at,1,10)>=?)
      ORDER BY reviewed_at DESC, id
      LIMIT 1
    `).get(project.organization_id, project.id, stakeholderId, onDate));
  }

  function payDistribution(projectId, distributionId, input, { actor } = {}) {
    const project = requireProject(projectId);
    if (Object.hasOwn(input, 'requireVerifiedKyc')) {
      throw badRequest(
        'PAYMENT_POLICY_MANAGED',
        'سیاست احراز هویت پرداخت فقط در تنظیمات امن سرور تعیین می‌شود.',
      );
    }
    const provider = paymentProvider(input.provider);
    const manualReference = optionalText(input.manualReference, 'manualReference', 200);
    if (provider === 'manual' && !manualReference) {
      throw badRequest('MANUAL_REFERENCE_REQUIRED', 'مرجع پرداخت دستی الزامی است.');
    }
    let result;
    let journal = null;
    let replay = false;
    withTransaction(db, () => {
      const current = distributionResult(project.id, distributionId);
      if (current.status === 'paid') {
        result = current;
        replay = true;
        return;
      }
      if (!['approved', 'processing'].includes(current.status)) {
        throw conflict('DISTRIBUTION_NOT_APPROVED', 'توزیع هنوز تصویب نشده است.');
      }
      const payableAccount = requireAccount(project, input.payableAccountId);
      const cashAccount = requireAccount(project, input.cashAccountId);
      if (payableAccount.account_type !== 'liability' || cashAccount.account_type !== 'asset') {
        throw badRequest(
          'INVALID_ACCOUNT_TYPE',
          'برای پرداخت توزیع، حساب بدهی و حساب دارایی لازم است.',
        );
      }
      const paidOn = isoDate(input.paidOn || at().slice(0, 10), 'paidOn');
      const payableAllocations = current.allocations.filter(
        (allocation) => !['paid', 'withheld'].includes(allocation.status),
      );
      let paidTotal = 0n;
      const updatedAt = at();
      for (const allocation of payableAllocations) {
        if (
          distributionKycRequired &&
          !stakeholderHasCurrentKyc(project, allocation.stakeholderId, paidOn)
        ) {
          db.prepare(`
            UPDATE distribution_allocations
            SET status='withheld', updated_at=?
            WHERE id=?
          `).run(updatedAt, allocation.id);
          continue;
        }
        if (allocation.amount === 0) {
          db.prepare(`
            UPDATE distribution_allocations
            SET status='paid', paid_at=?, updated_at=?
            WHERE id=?
          `).run(updatedAt, updatedAt, allocation.id);
          continue;
        }
        const paymentId = randomUUID();
        const paymentKey = sha256(`distribution:${distributionId}:${allocation.stakeholderId}`);
        db.prepare(`
          INSERT OR IGNORE INTO payment_intents(
            id, organization_id, project_id, invoice_id, direction, provider,
            provider_reference, idempotency_key_hash, amount, currency, status,
            failure_reason, initiated_by_user_id, completed_at, created_at, updated_at
          ) VALUES(?,?,?,NULL,'outgoing',?,?,?,?,?,'succeeded','',?,?,?,?)
        `).run(
          paymentId,
          project.organization_id,
          project.id,
          provider,
          provider === 'manual'
            ? `${manualReference}:${allocation.stakeholderId}`
            : `sandbox:${distributionId}:${allocation.stakeholderId}`,
          paymentKey,
          allocation.amount,
          current.currency,
          actorUserId(actor),
          updatedAt,
          updatedAt,
          updatedAt,
        );
        const storedPayment = db.prepare(`
          SELECT * FROM payment_intents
          WHERE organization_id=? AND idempotency_key_hash=?
        `).get(project.organization_id, paymentKey);
        db.prepare(`
          INSERT OR IGNORE INTO payment_events(
            id, payment_intent_id, provider_event_id, event_type,
            payload_json, received_at
          ) VALUES(?,?,?,'distribution_paid',?,?)
        `).run(
          randomUUID(),
          storedPayment.id,
          `distribution:${distributionId}:${allocation.stakeholderId}`,
          JSON.stringify({ manual: provider === 'manual' }),
          updatedAt,
        );
        db.prepare(`
          UPDATE distribution_allocations
          SET status='paid', payment_intent_id=?, paid_at=?, updated_at=?
          WHERE id=?
        `).run(storedPayment.id, updatedAt, updatedAt, allocation.id);
        paidTotal += BigInt(allocation.amount);
      }
      if (paidTotal > 0n) {
        const amount = safeBigIntNumber(paidTotal);
        const internalKey = sha256(`distribution-payment:${distributionId}`);
        const hash = requestHash({
          distributionId,
          payableAccountId: payableAccount.id,
          cashAccountId: cashAccount.id,
          amount,
        });
        let draft = idempotentJournal(project, internalKey, hash);
        if (!draft) {
          draft = createDraftInside(project, {
            occurredOn: paidOn,
            fiscalPeriodId: input.fiscalPeriodId,
            description: `پرداخت توزیع: ${current.title}`,
            currency: current.currency,
            sourceType: 'distribution_payment',
            sourceId: current.id,
            lines: [
              { accountId: payableAccount.id, debit: amount, credit: 0 },
              { accountId: cashAccount.id, debit: 0, credit: amount },
            ],
          }, actor, internalKey, hash);
          draft = postJournalInside(project, draft.id, actor);
        }
        journal = journalResult(draft);
      }
      const remaining = db.prepare(`
        SELECT COUNT(*) AS count
        FROM distribution_allocations
        WHERE distribution_id=? AND status<>'paid'
      `).get(distributionId);
      db.prepare(`
        UPDATE distributions
        SET status=?, updated_at=?
        WHERE id=?
      `).run(Number(remaining.count) === 0 ? 'paid' : 'processing', updatedAt, distributionId);
      result = distributionResult(project.id, distributionId);
      auditEvent(project, 'distribution', distributionId, 'payment_processed', actor, current, result, {
        provider,
        paidAmount: safeBigIntNumber(paidTotal),
        journalEntryId: journal?.id || null,
      });
    });
    return { distribution: result, journalEntry: journal, idempotentReplay: replay };
  }

  function validateKycSubject(project, subjectType, subjectId) {
    if (subjectType === 'stakeholder') {
      const row = db.prepare(`
        SELECT id FROM project_stakeholders WHERE id=? AND project_id=?
      `).get(subjectId, project.id);
      if (!row) throw badRequest('INVALID_KYC_SUBJECT', 'ذی‌نفع KYC معتبر نیست.');
      return;
    }
    if (subjectType === 'organization') {
      if (subjectId !== project.organization_id) {
        throw badRequest('INVALID_KYC_SUBJECT', 'سازمان KYC معتبر نیست.');
      }
      return;
    }
    const user = db.prepare('SELECT id FROM users WHERE id=?').get(subjectId);
    if (!user) throw badRequest('INVALID_KYC_SUBJECT', 'کاربر KYC معتبر نیست.');
  }

  function kycCaseResult(projectId, caseId) {
    const row = db.prepare(`
      SELECT * FROM kyc_cases WHERE id=? AND project_id=?
    `).get(caseId, projectId);
    if (!row) throw notFound('KYC_CASE_NOT_FOUND', 'پرونده KYC پیدا نشد.');
    const checks = db.prepare(`
      SELECT * FROM kyc_checks WHERE case_id=? ORDER BY created_at, id
    `).all(caseId).map((check) => ({
      id: check.id,
      caseId: check.case_id,
      checkType: check.check_type,
      provider: check.provider,
      status: check.status,
      result: parseJson(check.result_json),
      evidenceDocumentId: check.evidence_document_id,
      checkedAt: check.checked_at,
      createdAt: check.created_at,
    }));
    return { ...mapKycCase(row), checks };
  }

  function kycCases(projectId, { subjectType, subjectId, status } = {}) {
    const project = requireProject(projectId);
    const where = ['project_id=?'];
    const values = [project.id];
    for (const [column, value] of [
      ['subject_type', subjectType],
      ['subject_id', subjectId],
      ['status', status],
    ]) {
      if (value) {
        where.push(`${column}=?`);
        values.push(String(value));
      }
    }
    const rows = db.prepare(`
      SELECT id FROM kyc_cases
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id
    `).all(...values);
    return { kycCases: rows.map((row) => kycCaseResult(project.id, row.id)) };
  }

  function createKycCase(projectId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const subjectType = enumValue(input.subjectType, KYC_SUBJECT_TYPES, 'subjectType');
    const subjectId = requiredText(input.subjectId, 'subjectId', 200);
    validateKycSubject(project, subjectType, subjectId);
    const provider = String(input.provider || 'manual');
    if (provider !== 'manual' || input.providerReference || input.providerVerified) {
      throw badRequest(
        'PROVIDER_VERIFICATION_NOT_ACCEPTED',
        'این نسخه فقط پرونده KYC دستی ایجاد می‌کند و تأیید provider قابل جعل نیست.',
      );
    }
    const level = enumValue(input.level, KYC_LEVELS, 'level', 'basic');
    let result;
    withTransaction(db, () => {
      const existing = db.prepare(`
        SELECT id FROM kyc_cases
        WHERE organization_id=? AND project_id=?
          AND subject_type=? AND subject_id=?
          AND status IN ('pending','in_review','verified')
        ORDER BY created_at DESC LIMIT 1
      `).get(project.organization_id, project.id, subjectType, subjectId);
      if (existing) {
        throw conflict('ACTIVE_KYC_CASE_EXISTS', 'برای این شخص یک پرونده فعال وجود دارد.');
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO kyc_cases(
          id, organization_id, project_id, subject_type, subject_id,
          level, provider, provider_reference, status, risk_rating,
          decision_reason, requested_at, reviewed_by_user_id, reviewed_at,
          expires_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,'manual','','pending','unknown','',?,NULL,NULL,NULL,?,?)
      `).run(
        id,
        project.organization_id,
        project.id,
        subjectType,
        subjectId,
        level,
        createdAt,
        createdAt,
        createdAt,
      );
      result = kycCaseResult(project.id, id);
      auditEvent(project, 'kyc_case', id, 'created', actor, null, result);
    });
    return { kycCase: result };
  }

  function addKycCheck(projectId, caseId, input, { actor } = {}) {
    const project = requireProject(projectId);
    if (input.provider && input.provider !== 'manual') {
      throw badRequest(
        'PROVIDER_VERIFICATION_NOT_ACCEPTED',
        'نتیجه provider فقط از adapter امضاشده پذیرفته می‌شود.',
      );
    }
    const status = enumValue(input.status, KYC_CHECK_STATUSES, 'status', 'pending');
    let result;
    withTransaction(db, () => {
      const current = kycCaseResult(project.id, caseId);
      if (!['pending', 'in_review'].includes(current.status)) {
        throw conflict('KYC_CASE_FINAL', 'پرونده نهایی‌شده قابل تغییر نیست.');
      }
      if (input.evidenceDocumentId) {
        const evidence = db.prepare(`
          SELECT id FROM documents
          WHERE id=? AND organization_id=?
            AND (project_id=? OR project_id IS NULL)
        `).get(input.evidenceDocumentId, project.organization_id, project.id);
        if (!evidence) throw badRequest('INVALID_DOCUMENT', 'مدرک KYC معتبر نیست.');
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO kyc_checks(
          id, case_id, check_type, provider, status, result_json,
          evidence_document_id, checked_at, created_at
        ) VALUES(?,?,?,'manual',?,?,?,?,?)
      `).run(
        id,
        caseId,
        requiredText(input.checkType, 'checkType', 100),
        status,
        JSON.stringify(stableValue(input.result || {})),
        input.evidenceDocumentId || null,
        status === 'pending' ? null : createdAt,
        createdAt,
      );
      db.prepare(`
        UPDATE kyc_cases SET status='in_review', updated_at=? WHERE id=?
      `).run(createdAt, caseId);
      result = kycCaseResult(project.id, caseId);
      auditEvent(project, 'kyc_check', id, 'recorded', actor, null, result, {
        manual: true,
        checkStatus: status,
      });
    });
    return { kycCase: result };
  }

  function reviewKycCase(projectId, caseId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const decision = enumValue(input.status, KYC_CASE_DECISIONS, 'status');
    if (input.providerVerified || input.providerReference) {
      throw badRequest(
        'PROVIDER_VERIFICATION_NOT_ACCEPTED',
        'تأیید provider از ورودی کاربر پذیرفته نمی‌شود.',
      );
    }
    let result;
    withTransaction(db, () => {
      const current = kycCaseResult(project.id, caseId);
      if (['verified', 'rejected', 'expired'].includes(current.status)) {
        if (current.status === decision) {
          result = current;
          return;
        }
        throw conflict('KYC_CASE_FINAL', 'پرونده KYC قبلاً نهایی شده است.');
      }
      if (!current.checks.length) {
        throw conflict('KYC_CHECKS_REQUIRED', 'حداقل یک بررسی دستی لازم است.');
      }
      if (
        decision === 'verified' &&
        current.checks.some((check) => check.status !== 'passed')
      ) {
        throw conflict(
          'KYC_CHECKS_INCOMPLETE',
          'برای تأیید، تمام بررسی‌ها باید passed باشند.',
        );
      }
      const reviewedAt = at();
      db.prepare(`
        UPDATE kyc_cases
        SET status=?, risk_rating=?, decision_reason=?,
            reviewed_by_user_id=?, reviewed_at=?, expires_at=?, updated_at=?
        WHERE id=?
      `).run(
        decision,
        enumValue(
          input.riskRating,
          new Set(['unknown', 'low', 'medium', 'high']),
          'riskRating',
          decision === 'verified' ? 'low' : 'unknown',
        ),
        optionalText(input.decisionReason, 'decisionReason', 2_000),
        actorUserId(actor),
        reviewedAt,
        optionalIsoDate(input.expiresAt, 'expiresAt'),
        reviewedAt,
        caseId,
      );
      result = kycCaseResult(project.id, caseId);
      auditEvent(project, 'kyc_case', caseId, 'reviewed', actor, current, result, {
        manual: true,
      });
    });
    return { kycCase: result };
  }

  function contractResult(projectId, contractId) {
    const row = db.prepare(`
      SELECT * FROM contracts WHERE id=? AND project_id=?
    `).get(contractId, projectId);
    if (!row) throw notFound('CONTRACT_NOT_FOUND', 'قرارداد پیدا نشد.');
    const parties = db.prepare(`
      SELECT *
      FROM contract_parties
      WHERE contract_id=?
      ORDER BY signing_order, created_at, id
    `).all(contractId).map((party) => ({
      id: party.id,
      contractId: party.contract_id,
      partyType: party.party_type,
      partyId: party.party_id,
      displayName: party.display_name,
      email: party.email,
      role: party.role,
      signingOrder: Number(party.signing_order),
      createdAt: party.created_at,
    }));
    const signatures = db.prepare(`
      SELECT *
      FROM contract_signatures
      WHERE contract_id=?
      ORDER BY created_at, id
    `).all(contractId).map((signature) => ({
      id: signature.id,
      contractId: signature.contract_id,
      partyId: signature.party_id,
      provider: signature.provider,
      providerReference: signature.provider_reference,
      status: signature.status,
      signatureHash: signature.signature_hash,
      signedDocumentId: signature.signed_document_id,
      signedAt: signature.signed_at,
      ipHash: signature.ip_hash,
      createdAt: signature.created_at,
      updatedAt: signature.updated_at,
    }));
    return { ...mapContract(row), parties, signatures };
  }

  function contracts(projectId, { status, limit = 100 } = {}) {
    const project = requireProject(projectId);
    const selectedLimit = safeInteger(limit, 'limit', { minimum: 1, maximum: 500 });
    const rows = db.prepare(`
      SELECT id FROM contracts
      WHERE project_id=? ${status ? 'AND status=?' : ''}
      ORDER BY updated_at DESC, id
      LIMIT ?
    `).all(...(status
      ? [project.id, String(status), selectedLimit]
      : [project.id, selectedLimit]));
    return { contracts: rows.map((row) => contractResult(project.id, row.id)) };
  }

  function createContract(projectId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const currency = currencyValue(input.currency, project.currency);
    if (currency !== project.currency) {
      throw conflict('PROJECT_CURRENCY_MISMATCH', 'ارز قرارداد باید با ارز پروژه یکسان باشد.');
    }
    let result;
    withTransaction(db, () => {
      if (input.documentId) {
        const document = db.prepare(`
          SELECT id FROM documents
          WHERE id=? AND organization_id=?
            AND (project_id=? OR project_id IS NULL)
        `).get(input.documentId, project.organization_id, project.id);
        if (!document) throw badRequest('INVALID_DOCUMENT', 'سند قرارداد معتبر نیست.');
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO contracts(
          id, organization_id, project_id, title, contract_type, status,
          document_id, effective_on, expires_on, value_amount, currency,
          owner_user_id, created_by_user_id, created_at, updated_at
        ) VALUES(?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        project.organization_id,
        project.id,
        requiredText(input.title, 'title', 300),
        optionalText(input.contractType, 'contractType', 100) || 'other',
        input.documentId || null,
        optionalIsoDate(input.effectiveOn, 'effectiveOn'),
        optionalIsoDate(input.expiresOn, 'expiresOn'),
        safeInteger(input.valueAmount, 'valueAmount', { allowNull: true }),
        currency,
        input.ownerUserId || actorUserId(actor),
        actorUserId(actor),
        createdAt,
        createdAt,
      );
      result = contractResult(project.id, id);
      auditEvent(project, 'contract', id, 'created', actor, null, result);
    });
    return { contract: result };
  }

  function validateContractParty(project, partyType, partyId) {
    if (partyType === 'external') return null;
    if (!partyId) {
      throw badRequest('VALIDATION_FAILED', 'شناسه طرف قرارداد الزامی است.');
    }
    const queries = {
      organization: [
        'SELECT id FROM organizations WHERE id=?',
        [partyId],
      ],
      user: [
        'SELECT id FROM users WHERE id=?',
        [partyId],
      ],
      stakeholder: [
        'SELECT id FROM project_stakeholders WHERE id=? AND project_id=?',
        [partyId, project.id],
      ],
    };
    const [sql, values] = queries[partyType];
    if (!db.prepare(sql).get(...values)) {
      throw badRequest('INVALID_CONTRACT_PARTY', 'طرف قرارداد معتبر نیست.');
    }
    return String(partyId);
  }

  function addContractParty(projectId, contractId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const partyType = enumValue(input.partyType, PARTY_TYPES, 'partyType');
    let result;
    withTransaction(db, () => {
      const current = contractResult(project.id, contractId);
      if (!['draft', 'review'].includes(current.status)) {
        throw conflict(
          'CONTRACT_PARTIES_LOCKED',
          'پس از ارسال برای امضا، طرف‌های قرارداد قابل تغییر نیستند.',
        );
      }
      const partyId = validateContractParty(project, partyType, input.partyId);
      if (
        partyId &&
        current.parties.some((party) => (
          party.partyType === partyType && party.partyId === partyId
        ))
      ) {
        throw conflict('CONTRACT_PARTY_EXISTS', 'این طرف قبلاً اضافه شده است.');
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO contract_parties(
          id, contract_id, party_type, party_id, display_name,
          email, role, signing_order, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        contractId,
        partyType,
        partyId,
        requiredText(input.displayName, 'displayName', 300),
        optionalText(input.email, 'email', 320),
        optionalText(input.role, 'role', 100) || 'party',
        safeInteger(input.signingOrder ?? current.parties.length, 'signingOrder'),
        at(),
      );
      result = contractResult(project.id, contractId);
      auditEvent(project, 'contract_party', id, 'created', actor, null, result);
    });
    return { contract: result };
  }

  function requestContractSignatures(projectId, contractId, input = {}, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    let replay = false;
    withTransaction(db, () => {
      const current = contractResult(project.id, contractId);
      if (['awaiting_signatures', 'active'].includes(current.status)) {
        result = current;
        replay = true;
        return;
      }
      if (!['draft', 'review'].includes(current.status)) {
        throw conflict('CONTRACT_NOT_SENDABLE', 'قرارداد در وضعیت قابل ارسال نیست.');
      }
      if (!current.documentId) {
        throw conflict('CONTRACT_DOCUMENT_REQUIRED', 'نسخه سند قرارداد الزامی است.');
      }
      if (!current.parties.length) {
        throw conflict('CONTRACT_PARTIES_REQUIRED', 'حداقل یک طرف قرارداد لازم است.');
      }
      if (input.provider && input.provider !== 'manual') {
        throw badRequest(
          'PROVIDER_ADAPTER_REQUIRED',
          'درخواست امضای provider فقط از adapter رسمی ممکن است.',
        );
      }
      const createdAt = at();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO contract_signatures(
          id, contract_id, party_id, provider, provider_reference, status,
          signature_hash, signed_document_id, signed_at, ip_hash,
          created_at, updated_at
        ) VALUES(?,?,?,'manual','','pending','',NULL,NULL,'',?,?)
      `);
      for (const party of current.parties) {
        insert.run(randomUUID(), contractId, party.id, createdAt, createdAt);
      }
      db.prepare(`
        UPDATE contracts
        SET status='awaiting_signatures', updated_at=?
        WHERE id=?
      `).run(createdAt, contractId);
      result = contractResult(project.id, contractId);
      auditEvent(project, 'contract', contractId, 'signature_requests_created', actor, current, result, {
        manual: true,
      });
    });
    return { contract: result, idempotentReplay: replay };
  }

  function deriveContractStatus(contractId) {
    const signatures = db.prepare(`
      SELECT status FROM contract_signatures WHERE contract_id=?
    `).all(contractId);
    if (!signatures.length) return 'draft';
    if (signatures.some((item) => ['declined', 'revoked', 'expired'].includes(item.status))) {
      return 'cancelled';
    }
    if (signatures.every((item) => item.status === 'signed')) return 'active';
    return 'awaiting_signatures';
  }

  function recordManualSignature(projectId, contractId, partyId, input, { actor } = {}) {
    const project = requireProject(projectId);
    if (input.providerVerified || input.providerReference || (input.provider && input.provider !== 'manual')) {
      throw badRequest(
        'PROVIDER_VERIFICATION_NOT_ACCEPTED',
        'تأیید provider از مسیر امضای دستی پذیرفته نمی‌شود.',
      );
    }
    const signatureHash = requiredText(input.signatureHash, 'signatureHash', 128).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(signatureHash)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'هش امضا معتبر نیست.',
        { signatureHash: 'SHA-256 شصت‌وچهار کاراکتری وارد کنید.' },
      );
    }
    let result;
    let replay = false;
    withTransaction(db, () => {
      const current = contractResult(project.id, contractId);
      if (current.status !== 'awaiting_signatures') {
        throw conflict('CONTRACT_NOT_AWAITING_SIGNATURES', 'قرارداد در انتظار امضا نیست.');
      }
      const signature = db.prepare(`
        SELECT *
        FROM contract_signatures
        WHERE contract_id=? AND party_id=?
      `).get(contractId, partyId);
      if (!signature) throw notFound('SIGNATURE_REQUEST_NOT_FOUND', 'درخواست امضا پیدا نشد.');
      if (signature.status === 'signed') {
        if (signature.signature_hash !== signatureHash) {
          throw conflict('SIGNATURE_ALREADY_RECORDED', 'امضای دیگری قبلاً ثبت شده است.');
        }
        result = current;
        replay = true;
        return;
      }
      if (input.signedDocumentId) {
        const document = db.prepare(`
          SELECT id FROM documents
          WHERE id=? AND organization_id=?
            AND (project_id=? OR project_id IS NULL)
        `).get(input.signedDocumentId, project.organization_id, project.id);
        if (!document) throw badRequest('INVALID_DOCUMENT', 'نسخه امضاشده معتبر نیست.');
      }
      const signedAt = at();
      db.prepare(`
        UPDATE contract_signatures
        SET status='signed', signature_hash=?, signed_document_id=?,
            signed_at=?, ip_hash=?, updated_at=?
        WHERE id=?
      `).run(
        signatureHash,
        input.signedDocumentId || current.documentId,
        signedAt,
        optionalText(input.ipHash, 'ipHash', 200),
        signedAt,
        signature.id,
      );
      const status = deriveContractStatus(contractId);
      db.prepare(`
        UPDATE contracts SET status=?, updated_at=? WHERE id=?
      `).run(status, signedAt, contractId);
      result = contractResult(project.id, contractId);
      auditEvent(project, 'contract_signature', signature.id, 'manual_signature_recorded', actor, {
        status: signature.status,
      }, {
        status: 'signed',
        signatureHash,
      }, {
        manual: true,
        contractStatus: status,
      });
    });
    return { contract: result, idempotentReplay: replay };
  }

  function requireShareClass(projectId, shareClassId) {
    const row = db.prepare(`
      SELECT * FROM share_classes WHERE id=? AND project_id=?
    `).get(shareClassId, projectId);
    if (!row) throw badRequest('INVALID_SHARE_CLASS', 'طبقه سهم معتبر نیست.');
    return row;
  }

  function requireStakeholder(projectId, stakeholderId, { active = true } = {}) {
    const row = db.prepare(`
      SELECT * FROM project_stakeholders
      WHERE id=? AND project_id=? ${active ? 'AND archived_at IS NULL' : ''}
    `).get(stakeholderId, projectId);
    if (!row) throw badRequest('INVALID_STAKEHOLDER', 'ذی‌نفع معتبر نیست.');
    return row;
  }

  function currentClassState(projectId, shareClassId) {
    const shareClass = requireShareClass(projectId, shareClassId);
    const rows = db.prepare(`
      SELECT stakeholder_id, SUM(units) AS units
      FROM share_ledger
      WHERE project_id=? AND share_class_id=?
      GROUP BY stakeholder_id
      HAVING SUM(units)<>0
      ORDER BY stakeholder_id
    `).all(projectId, shareClassId);
    let issued = 0n;
    const holdings = rows.map((row) => {
      const units = Number(row.units);
      if (!Number.isSafeInteger(units) || units < 0) {
        throw conflict('CAPITAL_AGGREGATE_INVALID', 'موجودی سهام معتبر نیست.');
      }
      issued += BigInt(units);
      return { stakeholderId: row.stakeholder_id, units };
    });
    const issuedUnits = safeBigIntNumber(issued);
    if (issuedUnits > Number(shareClass.authorized_units)) {
      throw conflict('AUTHORIZED_UNITS_EXCEEDED', 'سهام منتشرشده از سقف مجاز بیشتر است.');
    }
    return {
      shareClass,
      holdings,
      issuedUnits,
      authorizedUnits: Number(shareClass.authorized_units),
    };
  }

  function corporateActions(projectId, { status, limit = 100 } = {}) {
    const project = requireProject(projectId);
    const selectedLimit = safeInteger(limit, 'limit', { minimum: 1, maximum: 500 });
    const rows = db.prepare(`
      SELECT * FROM corporate_actions
      WHERE project_id=? ${status ? 'AND status=?' : ''}
      ORDER BY created_at DESC, id
      LIMIT ?
    `).all(...(status
      ? [project.id, String(status), selectedLimit]
      : [project.id, selectedLimit]));
    return { corporateActions: rows.map(mapCorporateAction) };
  }

  function requireCorporateAction(projectId, actionId) {
    const row = db.prepare(`
      SELECT * FROM corporate_actions WHERE id=? AND project_id=?
    `).get(actionId, projectId);
    if (!row) throw notFound('CORPORATE_ACTION_NOT_FOUND', 'رویداد سرمایه پیدا نشد.');
    return row;
  }

  function createCorporateAction(projectId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const actionType = enumValue(
      input.actionType,
      CORPORATE_ACTION_TYPES,
      'actionType',
    );
    if (!['issuance', 'capital_increase', 'split', 'reverse_split', 'rights_issue'].includes(actionType)) {
      throw badRequest(
        'CORPORATE_ACTION_NOT_SUPPORTED',
        'این نوع رویداد در نسخه تک‌سرور هنوز قابل اجرا نیست.',
      );
    }
    const shareClass = requireShareClass(project.id, input.shareClassId);
    const details = {
      note: optionalText(input.notes, 'notes', 2_000),
      stakeholderId: input.stakeholderId || null,
      destinationShareClassId: input.destinationShareClassId || null,
    };
    if (actionType === 'issuance') {
      requireStakeholder(project.id, details.stakeholderId);
    }
    const ratioRequired = ['split', 'reverse_split'].includes(actionType);
    const numerator = ratioRequired
      ? positiveRatio(input.ratioNumerator, 'ratioNumerator')
      : input.ratioNumerator
        ? positiveRatio(input.ratioNumerator, 'ratioNumerator')
        : null;
    const denominator = ratioRequired
      ? positiveRatio(input.ratioDenominator, 'ratioDenominator')
      : input.ratioDenominator
        ? positiveRatio(input.ratioDenominator, 'ratioDenominator')
        : null;
    if (actionType === 'split' && numerator <= denominator) {
      throw badRequest('INVALID_SPLIT_RATIO', 'نسبت split باید تعداد سهام را افزایش دهد.');
    }
    if (actionType === 'reverse_split' && numerator >= denominator) {
      throw badRequest('INVALID_SPLIT_RATIO', 'نسبت reverse split باید تعداد سهام را کاهش دهد.');
    }
    const units = ['issuance', 'capital_increase', 'rights_issue'].includes(actionType)
      ? safeInteger(input.units, 'units', { minimum: 1 })
      : null;
    const resolutionId = input.resolutionId
      ? requiredText(input.resolutionId, 'resolutionId', 200)
      : null;
    let result;
    withTransaction(db, () => {
      const policyActive = corporateGovernancePolicyActive(project);
      const createdByUserId = policyActive
        ? requireCorporateGovernanceActor(project, actor)
        : actorUserId(actor);
      if (!policyActive && resolutionId) {
        const resolution = db.prepare(`
          SELECT r.id
          FROM meeting_resolutions r
          JOIN project_meetings m ON m.id=r.meeting_id
          WHERE r.id=? AND m.project_id=? AND r.status='closed'
        `).get(resolutionId, project.id);
        if (!resolution) throw badRequest('INVALID_RESOLUTION', 'مصوبه معتبر نیست.');
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO corporate_actions(
          id, project_id, share_class_id, action_type, title, status,
          record_date, effective_date, ratio_numerator, ratio_denominator,
          units, unit_price, resolution_id, notes, executed_at,
          created_by_user_id, created_at, updated_at
        ) VALUES(?,?,?,?,?,'draft',?,?,?,?,?,?,?, ?,NULL,?,?,?)
      `).run(
        id,
        project.id,
        shareClass.id,
        actionType,
        requiredText(input.title, 'title', 300),
        optionalIsoDate(input.recordDate, 'recordDate'),
        optionalIsoDate(input.effectiveDate, 'effectiveDate'),
        numerator,
        denominator,
        units,
        input.unitPrice === undefined
          ? null
          : safeInteger(input.unitPrice, 'unitPrice'),
        resolutionId,
        JSON.stringify(details),
        createdByUserId,
        createdAt,
        createdAt,
      );
      result = mapCorporateAction(requireCorporateAction(project.id, id));
      if (policyActive) {
        requireApprovedCorporateResolution(
          project,
          result,
          { bind: true },
        );
      }
      auditEvent(project, 'corporate_action', id, 'created', actor, null, result);
    });
    return { corporateAction: result };
  }

  function previewCorporateAction(projectId, actionId) {
    const project = requireProject(projectId);
    const actionRow = requireCorporateAction(project.id, actionId);
    const action = mapCorporateAction(actionRow);
    const state = currentClassState(project.id, action.shareClassId);
    const before = state.holdings.map((holding) => ({
      ...holding,
      ownershipPercent: state.issuedUnits
        ? (holding.units / state.issuedUnits) * 100
        : 0,
    }));
    let after = before.map((holding) => ({ ...holding }));
    let authorizedUnitsAfter = state.authorizedUnits;
    let issuedUnitsAfter = state.issuedUnits;
    let entitlements = [];
    if (['split', 'reverse_split'].includes(action.actionType)) {
      const numerator = BigInt(action.ratioNumerator);
      const denominator = BigInt(action.ratioDenominator);
      const authorizedNumerator = BigInt(state.authorizedUnits) * numerator;
      if (authorizedNumerator % denominator !== 0n) {
        throw conflict(
          'FRACTIONAL_SHARES_NOT_SUPPORTED',
          'نسبت رویداد برای سقف مجاز سهم اعشاری ایجاد می‌کند.',
        );
      }
      authorizedUnitsAfter = safeBigIntNumber(authorizedNumerator / denominator);
      after = state.holdings.map((holding) => {
        const scaled = BigInt(holding.units) * numerator;
        if (scaled % denominator !== 0n) {
          throw conflict(
            'FRACTIONAL_SHARES_NOT_SUPPORTED',
            'برای یک یا چند سهام‌دار سهم اعشاری ایجاد می‌شود.',
            { stakeholderId: holding.stakeholderId },
          );
        }
        return {
          stakeholderId: holding.stakeholderId,
          units: safeBigIntNumber(scaled / denominator),
        };
      });
      issuedUnitsAfter = after.reduce((sum, holding) => sum + holding.units, 0);
    } else if (action.actionType === 'issuance') {
      issuedUnitsAfter = safeBigIntNumber(
        BigInt(state.issuedUnits) + BigInt(action.units),
      );
      if (issuedUnitsAfter > state.authorizedUnits) {
        throw conflict('AUTHORIZED_UNITS_EXCEEDED', 'سقف مجاز برای صدور کافی نیست.');
      }
      const target = after.find((holding) => holding.stakeholderId === action.stakeholderId);
      if (target) target.units += action.units;
      else after.push({ stakeholderId: action.stakeholderId, units: action.units });
    } else if (action.actionType === 'capital_increase') {
      authorizedUnitsAfter = safeBigIntNumber(
        BigInt(state.authorizedUnits) + BigInt(action.units),
      );
    } else if (action.actionType === 'rights_issue') {
      if (!state.issuedUnits) {
        throw conflict('NO_ELIGIBLE_HOLDINGS', 'برای حق‌تقدم سهام منتشرشده‌ای وجود ندارد.');
      }
      entitlements = largestRemainder(
        action.units,
        state.holdings.map((holding) => ({
          stakeholderId: holding.stakeholderId,
          weight: holding.units,
          tieKey: holding.stakeholderId,
        })),
      ).map((item) => ({
        stakeholderId: item.stakeholderId,
        entitledUnits: item.amount,
      }));
    }
    after = after.map((holding) => ({
      ...holding,
      ownershipPercent: issuedUnitsAfter
        ? (holding.units / issuedUnitsAfter) * 100
        : 0,
    })).sort((left, right) => left.stakeholderId.localeCompare(right.stakeholderId));
    return {
      corporateAction: action,
      shareClass: {
        id: state.shareClass.id,
        symbol: state.shareClass.symbol,
        authorizedUnitsBefore: state.authorizedUnits,
        authorizedUnitsAfter,
        issuedUnitsBefore: state.issuedUnits,
        issuedUnitsAfter,
      },
      before,
      after,
      entitlements,
      dilution: after.map((holding) => {
        const previous = before.find((item) => item.stakeholderId === holding.stakeholderId);
        return {
          stakeholderId: holding.stakeholderId,
          beforePercent: previous?.ownershipPercent || 0,
          afterPercent: holding.ownershipPercent,
          changePercent: holding.ownershipPercent - (previous?.ownershipPercent || 0),
        };
      }),
    };
  }

  function approveCorporateAction(projectId, actionId, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    let replay = false;
    withTransaction(db, () => {
      const current = requireCorporateAction(project.id, actionId);
      if (current.status === 'approved') {
        result = mapCorporateAction(current);
        replay = true;
        return;
      }
      if (current.status !== 'draft') {
        throw conflict('CORPORATE_ACTION_NOT_DRAFT', 'رویداد در وضعیت قابل تصویب نیست.');
      }
      const policyActive = corporateGovernancePolicyActive(project);
      const approverUserId = policyActive
        ? requireCorporateGovernanceActor(project, actor)
        : actorUserId(actor);
      if (
        policyActive
        && current.created_by_user_id
        && current.created_by_user_id === approverUserId
      ) {
        throw forbidden(
          'CORPORATE_ACTION_FOUR_EYES_REQUIRED',
          'سازنده رویداد سرمایه نمی‌تواند همان رویداد را تصویب کند.',
        );
      }
      const resolutionEvidence = policyActive
        ? requireApprovedCorporateResolution(project, mapCorporateAction(current))
        : null;
      const preview = previewCorporateAction(project.id, actionId);
      const previewHash = requestHash(
        corporateActionApprovalSnapshot(preview, resolutionEvidence),
      );
      const updatedAt = at();
      db.prepare(`
        UPDATE corporate_actions
        SET status='approved',
            approved_by_user_id=?,
            approved_at=?,
            approved_preview_hash=?,
            updated_at=?
        WHERE id=?
      `).run(approverUserId, updatedAt, previewHash, updatedAt, actionId);
      result = mapCorporateAction(requireCorporateAction(project.id, actionId));
      auditEvent(project, 'corporate_action', actionId, 'approved', actor, mapCorporateAction(current), result, {
        previewHash,
      });
    });
    return { corporateAction: result, idempotentReplay: replay };
  }

  function executeCorporateAction(projectId, actionId, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    let replay = false;
    withTransaction(db, () => {
      const current = requireCorporateAction(project.id, actionId);
      if (current.status === 'completed') {
        result = mapCorporateAction(current);
        replay = true;
        return;
      }
      if (current.status !== 'approved') {
        throw conflict('CORPORATE_ACTION_NOT_APPROVED', 'رویداد سرمایه تصویب نشده است.');
      }
      const policyActive = corporateGovernancePolicyActive(project);
      const executorUserId = policyActive
        ? requireCorporateGovernanceActor(project, actor)
        : actorUserId(actor);
      if (
        policyActive
        && current.created_by_user_id
        && current.created_by_user_id === executorUserId
      ) {
        throw forbidden(
          'CORPORATE_ACTION_EXECUTOR_SEPARATION_REQUIRED',
          'سازنده رویداد سرمایه نمی‌تواند همان رویداد را اجرا کند.',
        );
      }
      const action = mapCorporateAction(current);
      const resolutionEvidence = policyActive
        ? requireApprovedCorporateResolution(
          project,
          action,
          { consume: true },
        )
        : null;
      const preview = previewCorporateAction(project.id, actionId);
      const previewHash = requestHash(
        corporateActionApprovalSnapshot(preview, resolutionEvidence),
      );
      if (
        (policyActive || current.approved_preview_hash)
        && current.approved_preview_hash !== previewHash
      ) {
        throw conflict(
          'CORPORATE_ACTION_PREVIEW_STALE',
          'وضعیت جدول سرمایه یا شرایط رویداد پس از تصویب تغییر کرده است؛ رویداد باید دوباره بررسی و تصویب شود.',
        );
      }
      if (
        action.recordDate &&
        db.prepare(`
          SELECT 1 FROM share_ledger
          WHERE project_id=? AND share_class_id=?
            AND substr(created_at,1,10)>?
          LIMIT 1
        `).get(project.id, action.shareClassId, action.recordDate)
      ) {
        throw conflict(
          'CAP_TABLE_CHANGED_SINCE_RECORD_DATE',
          'پس از تاریخ مبنا گردش سهم ثبت شده است؛ preview را با رویداد تازه بازسازی کنید.',
        );
      }
      const executedAt = at();
      if (['split', 'reverse_split'].includes(action.actionType)) {
        const beforeByHolder = new Map(
          preview.before.map((holding) => [holding.stakeholderId, holding.units]),
        );
        const insert = db.prepare(`
          INSERT INTO share_ledger(
            id, project_id, share_class_id, stakeholder_id, entry_type,
            units, related_transfer_id, note, created_at
          ) VALUES(?,?,?,?, 'adjustment', ?,NULL,?,?)
        `);
        for (const holding of preview.after) {
          const delta = holding.units - (beforeByHolder.get(holding.stakeholderId) || 0);
          if (!delta) continue;
          insert.run(
            randomUUID(),
            project.id,
            action.shareClassId,
            holding.stakeholderId,
            delta,
            JSON.stringify({ corporateActionId: action.id, type: action.actionType }),
            executedAt,
          );
        }
        db.prepare(`
          UPDATE share_classes SET authorized_units=? WHERE id=? AND project_id=?
        `).run(preview.shareClass.authorizedUnitsAfter, action.shareClassId, project.id);
        db.prepare(`
          UPDATE share_certificates
          SET status='cancelled', updated_at=?
          WHERE project_id=? AND share_class_id=? AND status='active'
        `).run(executedAt, project.id, action.shareClassId);
      } else if (action.actionType === 'issuance') {
        requireStakeholder(project.id, action.stakeholderId);
        db.prepare(`
          INSERT INTO share_ledger(
            id, project_id, share_class_id, stakeholder_id, entry_type,
            units, related_transfer_id, note, created_at
          ) VALUES(?,?,?,?, 'issuance', ?,NULL,?,?)
        `).run(
          randomUUID(),
          project.id,
          action.shareClassId,
          action.stakeholderId,
          action.units,
          JSON.stringify({ corporateActionId: action.id }),
          executedAt,
        );
      } else if (action.actionType === 'capital_increase') {
        db.prepare(`
          UPDATE share_classes SET authorized_units=? WHERE id=? AND project_id=?
        `).run(preview.shareClass.authorizedUnitsAfter, action.shareClassId, project.id);
      } else if (action.actionType === 'rights_issue') {
        const insertRight = db.prepare(`
          INSERT INTO preemptive_rights(
            id, corporate_action_id, stakeholder_id, entitled_units,
            exercised_units, transferred_units, expires_on, status,
            created_at, updated_at
          ) VALUES(?,?,?,?,0,0,?,'available',?,?)
        `);
        for (const entitlement of preview.entitlements) {
          insertRight.run(
            randomUUID(),
            action.id,
            entitlement.stakeholderId,
            entitlement.entitledUnits,
            action.effectiveDate,
            executedAt,
            executedAt,
          );
        }
      }
      db.prepare(`
        UPDATE corporate_actions
        SET status='completed',
            executed_at=?,
            executed_by_user_id=?,
            updated_at=?
        WHERE id=? AND status='approved'
      `).run(executedAt, executorUserId, executedAt, action.id);
      result = mapCorporateAction(requireCorporateAction(project.id, action.id));
      auditEvent(project, 'corporate_action', action.id, 'executed', actor, action, result, {
        previewHash,
      });
    });
    return { corporateAction: result, idempotentReplay: replay };
  }

  function preemptiveRights(projectId, { actionId } = {}) {
    const project = requireProject(projectId);
    const rows = db.prepare(`
      SELECT r.*, a.project_id, a.share_class_id, a.unit_price
      FROM preemptive_rights r
      JOIN corporate_actions a ON a.id=r.corporate_action_id
      WHERE a.project_id=? ${actionId ? 'AND a.id=?' : ''}
      ORDER BY r.created_at, r.id
    `).all(...(actionId ? [project.id, actionId] : [project.id]));
    return {
      preemptiveRights: rows.map((row) => ({
        id: row.id,
        corporateActionId: row.corporate_action_id,
        stakeholderId: row.stakeholder_id,
        shareClassId: row.share_class_id,
        entitledUnits: Number(row.entitled_units),
        exercisedUnits: Number(row.exercised_units),
        transferredUnits: Number(row.transferred_units),
        remainingUnits:
          Number(row.entitled_units) -
          Number(row.exercised_units) -
          Number(row.transferred_units),
        unitPrice: row.unit_price === null ? null : Number(row.unit_price),
        expiresOn: row.expires_on,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  function exercisePreemptiveRight(projectId, rightId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const units = safeInteger(input.units, 'units', { minimum: 1 });
    let result;
    withTransaction(db, () => {
      const right = db.prepare(`
        SELECT r.*, a.project_id, a.share_class_id, a.unit_price
        FROM preemptive_rights r
        JOIN corporate_actions a ON a.id=r.corporate_action_id
        WHERE r.id=? AND a.project_id=?
      `).get(rightId, project.id);
      if (!right) throw notFound('PREEMPTIVE_RIGHT_NOT_FOUND', 'حق‌تقدم پیدا نشد.');
      if (!['available', 'partially_exercised'].includes(right.status)) {
        throw conflict('PREEMPTIVE_RIGHT_NOT_AVAILABLE', 'حق‌تقدم قابل اعمال نیست.');
      }
      const today = at().slice(0, 10);
      if (right.expires_on && right.expires_on < today) {
        db.prepare(`
          UPDATE preemptive_rights SET status='expired', updated_at=? WHERE id=?
        `).run(at(), right.id);
        throw conflict('PREEMPTIVE_RIGHT_EXPIRED', 'مهلت حق‌تقدم پایان یافته است.');
      }
      const remaining =
        Number(right.entitled_units) -
        Number(right.exercised_units) -
        Number(right.transferred_units);
      if (units > remaining) {
        throw conflict('PREEMPTIVE_RIGHT_EXCEEDED', 'تعداد از مانده حق‌تقدم بیشتر است.');
      }
      if (!stakeholderHasCurrentKyc(project, right.stakeholder_id, today)) {
        throw conflict('KYC_REQUIRED', 'KYC معتبر برای اعمال حق‌تقدم الزامی است.');
      }
      const signedContract = db.prepare(`
        SELECT 1
        FROM contracts c
        JOIN contract_parties p ON p.contract_id=c.id
        WHERE c.project_id=? AND c.status='active'
          AND p.party_type='stakeholder' AND p.party_id=?
        LIMIT 1
      `).get(project.id, right.stakeholder_id);
      if (!signedContract) {
        throw conflict('SIGNED_CONTRACT_REQUIRED', 'قرارداد فعال سهام‌دار الزامی است.');
      }
      if (Number(right.unit_price || 0) > 0) {
        const payment = input.paymentIntentId
          ? requirePayment(project.id, input.paymentIntentId)
          : null;
        const expected = Number(right.unit_price) * units;
        if (
          !Number.isSafeInteger(expected) ||
          !payment ||
          payment.status !== 'succeeded' ||
          payment.direction !== 'incoming' ||
          Number(payment.amount) < expected
        ) {
          throw conflict('SETTLED_PAYMENT_REQUIRED', 'پرداخت تسویه‌شده کافی الزامی است.');
        }
      }
      const state = currentClassState(project.id, right.share_class_id);
      if (state.issuedUnits + units > state.authorizedUnits) {
        throw conflict('AUTHORIZED_UNITS_EXCEEDED', 'سقف مجاز سهم کافی نیست.');
      }
      const createdAt = at();
      db.prepare(`
        INSERT INTO share_ledger(
          id, project_id, share_class_id, stakeholder_id, entry_type,
          units, related_transfer_id, note, created_at
        ) VALUES(?,?,?,?, 'issuance', ?,NULL,?,?)
      `).run(
        randomUUID(),
        project.id,
        right.share_class_id,
        right.stakeholder_id,
        units,
        JSON.stringify({ preemptiveRightId: right.id }),
        createdAt,
      );
      const exercised = Number(right.exercised_units) + units;
      const nextStatus = exercised + Number(right.transferred_units) === Number(right.entitled_units)
        ? 'exercised'
        : 'partially_exercised';
      db.prepare(`
        UPDATE preemptive_rights
        SET exercised_units=?, status=?, updated_at=?
        WHERE id=?
      `).run(exercised, nextStatus, createdAt, right.id);
      result = preemptiveRights(project.id).preemptiveRights
        .find((item) => item.id === right.id);
      auditEvent(project, 'preemptive_right', right.id, 'exercised', actor, null, result, {
        units,
        paymentIntentId: input.paymentIntentId || null,
      });
    });
    return { preemptiveRight: result };
  }

  function waivePreemptiveRight(projectId, rightId, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    withTransaction(db, () => {
      const right = db.prepare(`
        SELECT r.*
        FROM preemptive_rights r
        JOIN corporate_actions a ON a.id=r.corporate_action_id
        WHERE r.id=? AND a.project_id=?
      `).get(rightId, project.id);
      if (!right) throw notFound('PREEMPTIVE_RIGHT_NOT_FOUND', 'حق‌تقدم پیدا نشد.');
      if (!['available', 'partially_exercised'].includes(right.status)) {
        throw conflict('PREEMPTIVE_RIGHT_NOT_AVAILABLE', 'حق‌تقدم قابل صرف‌نظر نیست.');
      }
      db.prepare(`
        UPDATE preemptive_rights SET status='waived', updated_at=? WHERE id=?
      `).run(at(), right.id);
      result = preemptiveRights(project.id).preemptiveRights
        .find((item) => item.id === right.id);
      auditEvent(project, 'preemptive_right', right.id, 'waived', actor, null, result);
    });
    return { preemptiveRight: result };
  }

  function certificates(projectId, { stakeholderId, shareClassId, status } = {}) {
    const project = requireProject(projectId);
    const where = ['project_id=?'];
    const values = [project.id];
    for (const [column, value] of [
      ['stakeholder_id', stakeholderId],
      ['share_class_id', shareClassId],
      ['status', status],
    ]) {
      if (value) {
        where.push(`${column}=?`);
        values.push(String(value));
      }
    }
    return {
      shareCertificates: db.prepare(`
        SELECT *
        FROM share_certificates
        WHERE ${where.join(' AND ')}
        ORDER BY issued_on DESC, certificate_no, id
      `).all(...values).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        shareClassId: row.share_class_id,
        stakeholderId: row.stakeholder_id,
        certificateNo: row.certificate_no,
        units: Number(row.units),
        issuedOn: row.issued_on,
        status: row.status,
        documentId: row.document_id,
        replacedById: row.replaced_by_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  function nextCertificateNo(project, shareClass) {
    const prefix = `${project.code || project.id}-${shareClass.symbol}`;
    const count = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM share_certificates
      WHERE project_id=? AND share_class_id=?
    `).get(project.id, shareClass.id).count);
    return `${prefix}-${String(count + 1).padStart(6, '0')}`;
  }

  function issueCertificate(projectId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const shareClass = requireShareClass(project.id, input.shareClassId);
    requireStakeholder(project.id, input.stakeholderId, { active: false });
    const units = safeInteger(input.units, 'units', { minimum: 1 });
    let result;
    withTransaction(db, () => {
      const state = currentClassState(project.id, shareClass.id);
      const holding = state.holdings.find(
        (item) => item.stakeholderId === input.stakeholderId,
      )?.units || 0;
      const certified = Number(db.prepare(`
        SELECT COALESCE(SUM(units),0) AS units
        FROM share_certificates
        WHERE project_id=? AND share_class_id=? AND stakeholder_id=?
          AND status='active'
      `).get(project.id, shareClass.id, input.stakeholderId).units);
      if (certified + units > holding) {
        throw conflict(
          'CERTIFICATE_EXCEEDS_HOLDING',
          'مجموع گواهی‌های فعال از موجودی سهام بیشتر می‌شود.',
        );
      }
      if (input.documentId) {
        const document = db.prepare(`
          SELECT id FROM documents
          WHERE id=? AND organization_id=?
            AND (project_id=? OR project_id IS NULL)
        `).get(input.documentId, project.organization_id, project.id);
        if (!document) throw badRequest('INVALID_DOCUMENT', 'سند گواهی معتبر نیست.');
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO share_certificates(
          id, project_id, share_class_id, stakeholder_id, certificate_no,
          units, issued_on, status, document_id, replaced_by_id,
          created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,'active',?,NULL,?,?)
      `).run(
        id,
        project.id,
        shareClass.id,
        input.stakeholderId,
        input.certificateNo
          ? requiredText(input.certificateNo, 'certificateNo', 100)
          : nextCertificateNo(project, shareClass),
        units,
        isoDate(input.issuedOn || at().slice(0, 10), 'issuedOn'),
        input.documentId || null,
        createdAt,
        createdAt,
      );
      result = certificates(project.id).shareCertificates.find((item) => item.id === id);
      auditEvent(project, 'share_certificate', id, 'issued', actor, null, result);
    });
    return { shareCertificate: result };
  }

  function cancelCertificate(projectId, certificateId, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    let replay = false;
    withTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM share_certificates WHERE id=? AND project_id=?
      `).get(certificateId, project.id);
      if (!current) throw notFound('CERTIFICATE_NOT_FOUND', 'گواهی سهم پیدا نشد.');
      if (current.status === 'cancelled') {
        result = certificates(project.id).shareCertificates.find(
          (item) => item.id === certificateId,
        );
        replay = true;
        return;
      }
      if (current.status !== 'active') {
        throw conflict('CERTIFICATE_NOT_ACTIVE', 'گواهی فعال نیست.');
      }
      db.prepare(`
        UPDATE share_certificates SET status='cancelled', updated_at=? WHERE id=?
      `).run(at(), current.id);
      result = certificates(project.id).shareCertificates.find(
        (item) => item.id === certificateId,
      );
      auditEvent(project, 'share_certificate', certificateId, 'cancelled', actor, {
        status: current.status,
      }, result);
    });
    return { shareCertificate: result, idempotentReplay: replay };
  }

  function replaceCertificate(projectId, certificateId, input, { actor } = {}) {
    const project = requireProject(projectId);
    let oldCertificate;
    let newCertificate;
    withTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM share_certificates WHERE id=? AND project_id=?
      `).get(certificateId, project.id);
      if (!current) throw notFound('CERTIFICATE_NOT_FOUND', 'گواهی سهم پیدا نشد.');
      if (current.status !== 'active') {
        throw conflict('CERTIFICATE_NOT_ACTIVE', 'فقط گواهی فعال قابل جایگزینی است.');
      }
      const shareClass = requireShareClass(project.id, current.share_class_id);
      const replacementId = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO share_certificates(
          id, project_id, share_class_id, stakeholder_id, certificate_no,
          units, issued_on, status, document_id, replaced_by_id,
          created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,'active',?,NULL,?,?)
      `).run(
        replacementId,
        project.id,
        current.share_class_id,
        current.stakeholder_id,
        input.certificateNo
          ? requiredText(input.certificateNo, 'certificateNo', 100)
          : nextCertificateNo(project, shareClass),
        Number(current.units),
        isoDate(input.issuedOn || at().slice(0, 10), 'issuedOn'),
        input.documentId || current.document_id,
        createdAt,
        createdAt,
      );
      db.prepare(`
        UPDATE share_certificates
        SET status='replaced', replaced_by_id=?, updated_at=?
        WHERE id=?
      `).run(replacementId, createdAt, current.id);
      const all = certificates(project.id).shareCertificates;
      oldCertificate = all.find((item) => item.id === current.id);
      newCertificate = all.find((item) => item.id === replacementId);
      auditEvent(project, 'share_certificate', current.id, 'replaced', actor, {
        status: current.status,
      }, oldCertificate, { replacementId });
    });
    return { replacedCertificate: oldCertificate, shareCertificate: newCertificate };
  }

  function meetingRow(projectId, meetingId) {
    const row = db.prepare(`
      SELECT * FROM project_meetings WHERE id=? AND project_id=?
    `).get(meetingId, projectId);
    if (!row) throw notFound('MEETING_NOT_FOUND', 'جلسه پیدا نشد.');
    return row;
  }

  function resolutionRow(projectId, meetingId, resolutionId) {
    const row = db.prepare(`
      SELECT r.*
      FROM meeting_resolutions r
      JOIN project_meetings m ON m.id=r.meeting_id
      WHERE r.id=? AND r.meeting_id=? AND m.project_id=?
    `).get(resolutionId, meetingId, projectId);
    if (!row) throw notFound('RESOLUTION_NOT_FOUND', 'مصوبه پیدا نشد.');
    return row;
  }

  function votingPowerAt(projectId, recordDate) {
    const holdings = holdingsAt(projectId, recordDate);
    const classes = new Map(db.prepare(`
      SELECT id, voting_weight FROM share_classes WHERE project_id=?
    `).all(projectId).map((row) => [row.id, Number(row.voting_weight)]));
    const power = new Map();
    for (const holding of holdings) {
      const weighted = holding.units * (classes.get(holding.shareClassId) || 0);
      if (!Number.isSafeInteger(weighted) || weighted < 0) {
        throw conflict(
          'VOTING_POWER_NOT_INTEGER',
          'قدرت رأی برای ثبت proxy باید عدد صحیح امن باشد.',
        );
      }
      power.set(
        holding.stakeholderId,
        (power.get(holding.stakeholderId) || 0) + weighted,
      );
    }
    const boardRows = db.prepare(`
      SELECT id FROM project_stakeholders
      WHERE project_id=? AND role='board' AND archived_at IS NULL
    `).all(projectId);
    for (const board of boardRows) {
      if ((power.get(board.id) || 0) <= 0) power.set(board.id, 1);
    }
    return power;
  }

  function governanceProxies(projectId, { meetingId, resolutionId, status } = {}) {
    const project = requireProject(projectId);
    const where = ['project_id=?'];
    const values = [project.id];
    for (const [column, value] of [
      ['meeting_id', meetingId],
      ['resolution_id', resolutionId],
      ['status', status],
    ]) {
      if (value) {
        where.push(`${column}=?`);
        values.push(String(value));
      }
    }
    return {
      governanceProxies: db.prepare(`
        SELECT * FROM governance_proxies
        WHERE ${where.join(' AND ')}
        ORDER BY granted_at, id
      `).all(...values).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        meetingId: row.meeting_id,
        grantorStakeholderId: row.grantor_stakeholder_id,
        proxyStakeholderId: row.proxy_stakeholder_id,
        scope: row.scope,
        resolutionId: row.resolution_id,
        votingPower: Number(row.voting_power),
        status: row.status,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  function requireGovernanceProxyGrantor(project, grantor, actor) {
    const userId = actorUserId(actor);
    if (actor?.actorType === 'api_key' || actor?.apiKey || !userId) {
      throw forbidden(
        'GOVERNANCE_PROXY_INTERACTIVE_USER_REQUIRED',
        'Creating or revoking a voting proxy requires an interactive user session.',
      );
    }
    const linkedGrantor = db.prepare(`
      SELECT stakeholder.id
      FROM project_stakeholders stakeholder
      JOIN users user
        ON user.id=stakeholder.user_id
       AND user.status='active'
      JOIN organization_memberships membership
        ON membership.user_id=user.id
       AND membership.organization_id=?
       AND membership.status='active'
      WHERE stakeholder.id=?
        AND stakeholder.project_id=?
        AND stakeholder.archived_at IS NULL
        AND stakeholder.user_id=?
      LIMIT 1
    `).get(
      project.organization_id,
      grantor.id,
      project.id,
      userId,
    );
    if (!linkedGrantor) {
      throw forbidden(
        'GOVERNANCE_PROXY_GRANTOR_IDENTITY_REQUIRED',
        'Only the interactive user linked to the grantor stakeholder can create or revoke this voting proxy.',
      );
    }
    return userId;
  }

  function createGovernanceProxy(projectId, input, { actor } = {}) {
    const project = requireProject(projectId);
    const meeting = meetingRow(project.id, input.meetingId);
    const scope = enumValue(input.scope, new Set(['meeting', 'resolution']), 'scope', 'meeting');
    const resolutionId = scope === 'resolution'
      ? requiredText(input.resolutionId, 'resolutionId', 200)
      : null;
    if (resolutionId) resolutionRow(project.id, meeting.id, resolutionId);
    const grantor = requireStakeholder(
      project.id,
      input.grantorStakeholderId,
    );
    requireStakeholder(project.id, input.proxyStakeholderId);
    requireGovernanceProxyGrantor(project, grantor, actor);
    if (input.grantorStakeholderId === input.proxyStakeholderId) {
      throw badRequest('SELF_PROXY_NOT_ALLOWED', 'اعطاکننده و نماینده نمی‌توانند یکسان باشند.');
    }
    const recordDate = meeting.record_date
      ? isoDate(String(meeting.record_date).slice(0, 10), 'recordDate')
      : isoDate(String(meeting.scheduled_at).slice(0, 10), 'recordDate');
    const power = votingPowerAt(project.id, recordDate);
    const availablePower = power.get(input.grantorStakeholderId) || 0;
    const votingPower = input.votingPower === undefined
      ? availablePower
      : safeInteger(input.votingPower, 'votingPower', { minimum: 1 });
    if (!availablePower || votingPower > availablePower) {
      throw conflict('PROXY_POWER_EXCEEDED', 'قدرت واگذارشده از قدرت رأی اعطاکننده بیشتر است.');
    }
    if (votingPower !== availablePower) {
      throw conflict(
        'PARTIAL_PROXY_NOT_SUPPORTED',
        'A voting proxy must delegate the grantor stakeholder full voting power because split voting is not supported.',
      );
    }
    let result;
    withTransaction(db, () => {
      const duplicate = db.prepare(`
        SELECT id
        FROM governance_proxies
        WHERE meeting_id=? AND grantor_stakeholder_id=?
          AND scope=? AND COALESCE(resolution_id,'')=COALESCE(?, '')
          AND status='active'
        LIMIT 1
      `).get(meeting.id, input.grantorStakeholderId, scope, resolutionId);
      if (duplicate) {
        throw conflict('ACTIVE_PROXY_EXISTS', 'نمایندگی فعال برای این دامنه وجود دارد.');
      }
      const graphRows = db.prepare(`
        SELECT grantor_stakeholder_id, proxy_stakeholder_id
        FROM governance_proxies
        WHERE meeting_id=? AND status='active'
          AND (
            scope='meeting' OR
            (scope=? AND COALESCE(resolution_id,'')=COALESCE(?, ''))
          )
      `).all(meeting.id, scope, resolutionId);
      const graph = new Map(graphRows.map((row) => [
        row.grantor_stakeholder_id,
        row.proxy_stakeholder_id,
      ]));
      graph.set(input.grantorStakeholderId, input.proxyStakeholderId);
      let cursor = input.proxyStakeholderId;
      const visited = new Set([input.grantorStakeholderId]);
      while (cursor) {
        if (visited.has(cursor)) {
          throw conflict('PROXY_CYCLE', 'زنجیره نمایندگی دور ایجاد می‌کند.');
        }
        visited.add(cursor);
        cursor = graph.get(cursor);
      }
      const id = randomUUID();
      const createdAt = at();
      db.prepare(`
        INSERT INTO governance_proxies(
          id, project_id, meeting_id, grantor_stakeholder_id,
          proxy_stakeholder_id, scope, resolution_id, voting_power,
          status, granted_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?, 'active', ?,?,NULL,?,?)
      `).run(
        id,
        project.id,
        meeting.id,
        input.grantorStakeholderId,
        input.proxyStakeholderId,
        scope,
        resolutionId,
        votingPower,
        createdAt,
        input.expiresAt ? String(input.expiresAt) : null,
        createdAt,
        createdAt,
      );
      result = governanceProxies(project.id).governanceProxies
        .find((item) => item.id === id);
      auditEvent(project, 'governance_proxy', id, 'created', actor, null, result);
    });
    return { governanceProxy: result };
  }

  function revokeGovernanceProxy(projectId, proxyId, { actor } = {}) {
    const project = requireProject(projectId);
    let result;
    let replay = false;
    withTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM governance_proxies WHERE id=? AND project_id=?
      `).get(proxyId, project.id);
      if (!current) throw notFound('PROXY_NOT_FOUND', 'نمایندگی پیدا نشد.');
      const grantor = requireStakeholder(
        project.id,
        current.grantor_stakeholder_id,
      );
      requireGovernanceProxyGrantor(project, grantor, actor);
      if (current.status === 'revoked') {
        result = governanceProxies(project.id).governanceProxies
          .find((item) => item.id === proxyId);
        replay = true;
        return;
      }
      if (current.status !== 'active') {
        throw conflict('PROXY_NOT_ACTIVE', 'نمایندگی فعال نیست.');
      }
      const revokedAt = at();
      db.prepare(`
        UPDATE governance_proxies
        SET status='revoked', revoked_at=?, updated_at=?
        WHERE id=?
      `).run(revokedAt, revokedAt, proxyId);
      result = governanceProxies(project.id).governanceProxies
        .find((item) => item.id === proxyId);
      auditEvent(project, 'governance_proxy', proxyId, 'revoked', actor, null, result);
    });
    return { governanceProxy: result, idempotentReplay: replay };
  }

  function calculateQuorum(projectId, meetingId, { resolutionId } = {}) {
    const project = requireProject(projectId);
    const meeting = meetingRow(project.id, meetingId);
    let resolution = null;
    if (resolutionId) resolution = resolutionRow(project.id, meetingId, resolutionId);
    const recordDate = meeting.record_date
      ? String(meeting.record_date).slice(0, 10)
      : String(meeting.scheduled_at).slice(0, 10);
    const power = votingPowerAt(project.id, recordDate);
    const totalEligible = [...power.values()].reduce((sum, value) => sum + BigInt(value), 0n);
    const presentRows = db.prepare(`
      SELECT stakeholder_id
      FROM meeting_attendees
      WHERE meeting_id=? AND attendance='present'
    `).all(meetingId);
    const present = new Set(presentRows.map((row) => row.stakeholder_id));
    let represented = 0n;
    for (const stakeholderId of present) {
      represented += BigInt(power.get(stakeholderId) || 0);
    }
    const now = at();
    const proxies = db.prepare(`
      SELECT *
      FROM governance_proxies
      WHERE meeting_id=? AND status='active'
        AND (expires_at IS NULL OR expires_at>=?)
        AND (
          scope='meeting' OR
          (scope='resolution' AND resolution_id=?)
        )
    `).all(meetingId, now, resolutionId || '');
    const representedGrantors = new Set();
    for (const proxy of proxies) {
      if (
        present.has(proxy.proxy_stakeholder_id) &&
        !present.has(proxy.grantor_stakeholder_id) &&
        !representedGrantors.has(proxy.grantor_stakeholder_id)
      ) {
        represented += BigInt(
          Math.min(
            Number(proxy.voting_power),
            power.get(proxy.grantor_stakeholder_id) || 0,
          ),
        );
        representedGrantors.add(proxy.grantor_stakeholder_id);
      }
    }
    const total = safeBigIntNumber(totalEligible);
    const representedPower = safeBigIntNumber(represented);
    const requiredPercent = resolution
      ? Number(resolution.quorum_required_percent || meeting.quorum_percent || 0)
      : Number(meeting.quorum_percent || 0);
    const percent = total ? (representedPower / total) * 100 : 0;
    return {
      projectId: project.id,
      meetingId,
      resolutionId: resolutionId || null,
      recordDate,
      eligibleVotingPower: total,
      representedVotingPower: representedPower,
      presentStakeholders: present.size,
      representedByProxy: representedGrantors.size,
      quorumRequiredPercent: requiredPercent,
      quorumPercent: percent,
      quorumMet: total > 0 && percent >= requiredPercent,
    };
  }

  function calculateResolutionOutcome(projectId, meetingId, resolutionId) {
    const project = requireProject(projectId);
    const resolution = resolutionRow(project.id, meetingId, resolutionId);
    const quorum = calculateQuorum(project.id, meetingId, { resolutionId });
    const rows = db.prepare(`
      SELECT choice, voting_power
      FROM resolution_votes
      WHERE resolution_id=?
    `).all(resolutionId);
    const tally = { yes: 0, no: 0, abstain: 0 };
    for (const row of rows) {
      const amount = Number(row.voting_power);
      if (!Number.isSafeInteger(amount) || amount < 0 || !(row.choice in tally)) {
        throw conflict('VOTING_AGGREGATE_INVALID', 'جمع آرا معتبر نیست.');
      }
      tally[row.choice] += amount;
      if (!Number.isSafeInteger(tally[row.choice])) {
        throw conflict('VOTING_AGGREGATE_INVALID', 'جمع آرا از محدوده امن خارج است.');
      }
    }
    const castDecisive = tally.yes + tally.no;
    const threshold = Number(resolution.approval_threshold || 50);
    const denominator = resolution.approval_rule === 'absolute_majority'
      ? quorum.eligibleVotingPower
      : castDecisive;
    const approvalPercent = denominator ? (tally.yes / denominator) * 100 : 0;
    let outcome = 'rejected';
    if (!quorum.quorumMet) outcome = 'no_quorum';
    else if (castDecisive > 0 && approvalPercent > threshold) outcome = 'approved';
    else if (tally.yes === tally.no && castDecisive > 0) outcome = 'tied';
    return {
      resolutionId,
      approvalRule: resolution.approval_rule,
      approvalThreshold: threshold,
      approvalPercent,
      tally,
      quorum,
      outcome,
    };
  }

  function finalizeResolutionOutcome(
    projectId,
    meetingId,
    resolutionId,
    { actor, decision } = {},
  ) {
    const project = requireProject(projectId);
    let result;
    withTransaction(db, () => {
      const resolution = resolutionRow(project.id, meetingId, resolutionId);
      if (!['open', 'closed'].includes(resolution.status)) {
        throw conflict(
          'RESOLUTION_NOT_OPEN',
          'A resolution must be open before its outcome can be finalized.',
        );
      }
      const outcome = calculateResolutionOutcome(project.id, meetingId, resolutionId);
      const finalizedAt = at();
      const finalDecision = decision === undefined
        ? resolution.decision
        : optionalText(decision, 'decision', 5_000) || null;
      db.prepare(`
        UPDATE meeting_resolutions
        SET status='closed',
            eligible_voting_power=?,
            result_json=?,
            decision=?,
            decided_at=COALESCE(decided_at,?),
            updated_at=?
        WHERE id=?
      `).run(
        outcome.quorum.eligibleVotingPower,
        JSON.stringify(outcome),
        finalDecision,
        finalizedAt,
        finalizedAt,
        resolutionId,
      );
      db.prepare(`
        UPDATE project_meetings
        SET quorum_met=?, updated_at=?
        WHERE id=?
      `).run(
        outcome.quorum.quorumMet ? 1 : 0,
        finalizedAt,
        meetingId,
      );
      result = outcome;
      auditEvent(project, 'meeting_resolution', resolutionId, 'outcome_finalized', actor, {
        status: resolution.status,
        result: parseJson(resolution.result_json),
      }, {
        status: 'closed',
        result,
      });
    });
    return { outcome: result };
  }

  return Object.freeze({
    createAccount,
    accounts,
    patchAccount,
    createFiscalPeriod,
    fiscalPeriods,
    setFiscalPeriodStatus,
    createJournalDraft,
    journals,
    getJournal,
    addJournalLine,
    postJournal,
    reverseJournal,
    trialBalance,
    profitAndLoss,
    balanceSheet,
    valuations,
    createValuation,
    returnsReport,
    invoices,
    issueInvoice,
    voidInvoice,
    payments,
    createPaymentIntent,
    confirmPayment,
    distributions,
    createDistributionPreview,
    approveDistribution,
    payDistribution,
    kycCases,
    createKycCase,
    addKycCheck,
    reviewKycCase,
    contracts,
    createContract,
    addContractParty,
    requestContractSignatures,
    recordManualSignature,
    corporateActions,
    createCorporateAction,
    previewCorporateAction,
    approveCorporateAction,
    executeCorporateAction,
    preemptiveRights,
    exercisePreemptiveRight,
    waivePreemptiveRight,
    certificates,
    issueCertificate,
    cancelCertificate,
    replaceCertificate,
    governanceProxies,
    createGovernanceProxy,
    revokeGovernanceProxy,
    calculateQuorum,
    calculateResolutionOutcome,
    finalizeResolutionOutcome,
  });
}

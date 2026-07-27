const DEFAULT_PROJECT_SLUG = 'greenhouse-20ha';
const TRACKING_STORAGE_KEY = 'hamsakht_tracking_v1';
const PROJECT_REFRESH_INTERVAL = 30_000;

const main = document.querySelector('#main-content');
const projectNavLink = document.querySelector('#project-nav-link');
const liveIndicator = document.querySelector('#live-indicator');
const offlineIndicator = document.querySelector('#offline-indicator');
const trackingCount = document.querySelector('#tracking-count');
const toastRegion = document.querySelector('#toast-region');

const state = {
  route: null,
  projectData: null,
  portfolioData: null,
  projectCache: new Map(),
  requestController: null,
  eventSource: null,
  pollTimer: null,
  realtimeRefreshTimer: null,
  routeRunId: 0,
  viewerRequests: new Set(),
};

const needStatuses = {
  open: { label: 'فرصت باز', description: 'هنوز پیشنهاد فعالی برای این نیاز ثبت نشده است.' },
  under_review: { label: 'در حال بررسی', description: 'پیشنهادهای رسیده در حال بررسی اولیه هستند.' },
  negotiating: { label: 'در حال مذاکره', description: 'گفت‌وگو برای رسیدن به تعهد روشن ادامه دارد.' },
  committed: { label: 'تعهد نهایی', description: 'یک پیشنهاد برای این نیاز رسماً پذیرفته شده است.' },
};

const proposalStatuses = {
  new: { label: 'در انتظار بررسی', description: 'پیشنهاد شما دریافت شده و در صف بررسی است.' },
  contacted: { label: 'تماس برقرار شده', description: 'تیم پروژه برای ادامهٔ بررسی با شما تماس گرفته است.' },
  negotiating: { label: 'در حال مذاکره', description: 'جزئیات همکاری در حال نهایی‌شدن است.' },
  accepted: { label: 'پذیرفته‌شده', description: 'پیشنهاد شما رسماً پذیرفته شده است.' },
  rejected: { label: 'پذیرفته نشد', description: 'این پیشنهاد در وضعیت فعلی پذیرفته نشده است.' },
};

const projectTabs = {
  overview: 'نمای کلی',
  needs: 'مشارکت‌ها',
  capital: 'سرمایه و مالکیت',
  performance: 'عملکرد و اهداف',
  governance: 'حاکمیت و مصوبات',
};
const projectStageLabels = {
  idea: 'ایده',
  feasibility: 'امکان‌سنجی',
  fundraising: 'جذب سرمایه',
  pilot: 'پایلوت',
  execution: 'اجرا',
  construction: 'ساخت',
  operating: 'بهره‌برداری',
  on_hold: 'متوقف',
  completed: 'تکمیل‌شده',
};
const publicGoalStatusLabels = {
  planned: 'برنامه‌ریزی‌شده',
  active: 'فعال',
  completed: 'تکمیل‌شده',
  cancelled: 'لغوشده',
};
const publicMeetingStatusLabels = {
  scheduled: 'برنامه‌ریزی‌شده',
  held: 'برگزارشده',
  cancelled: 'لغوشده',
};
const publicResolutionStatusLabels = {
  draft: 'پیش‌نویس',
  open: 'رأی‌گیری باز',
  closed: 'بسته',
};
const publicOfferStatusLabels = {
  open: 'باز',
  partially_filled: 'بخشی انجام‌شده',
  filled: 'تکمیل‌شده',
  cancelled: 'لغوشده',
};

class ApiError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED', fields = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function element(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.id) node.id = options.id;
  if (options.attrs) {
    Object.entries(options.attrs).forEach(([name, value]) => {
      if (value === false || value === null || value === undefined) return;
      if (value === true) node.setAttribute(name, '');
      else node.setAttribute(name, String(value));
    });
  }
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([name, value]) => {
      if (value !== null && value !== undefined) node.dataset[name] = String(value);
    });
  }
  children.flat(Infinity).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function appLink(href, text, className = '') {
  return element('a', {
    className,
    text,
    attrs: { href },
    dataset: { appLink: '' },
  });
}

function replaceMain(...nodes) {
  main.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
}

function toEnglishDigits(value = '') {
  return String(value)
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

function asNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(toEnglishDigits(value));
  return Number.isFinite(number) ? number : fallback;
}

function faNumber(value) {
  return new Intl.NumberFormat('fa-IR').format(asNumber(value));
}

function formatPercent(value) {
  return `${faNumber(Math.max(0, Math.min(100, Math.round(asNumber(value)))))}٪`;
}

function formatFinancialPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${faNumber(Math.round(Number(value)))}٪`;
}

function formatDate(value, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('fa-IR', withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(date);
}

function formatMoney(value, unit = 'ریال', exact = '') {
  if (value === null) {
    try {
      return exact ? `${new Intl.NumberFormat('fa-IR').format(BigInt(exact))} ${unit}` : '—';
    } catch {
      return '—';
    }
  }
  const amount = asNumber(value);
  if (!amount) return `۰ ${unit}`;
  return `${new Intl.NumberFormat('fa-IR', {
    notation: Math.abs(amount) >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(amount)} ${unit}`;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, asNumber(value)));
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function optionalNumber(object, ...keys) {
  const key = keys.find((item) => Object.hasOwn(object, item));
  return key && object[key] === null
    ? null
    : asNumber(firstValue(...keys.map((item) => object[item])));
}

function safeStatus(value, statuses, fallback) {
  const key = String(value || '').toLowerCase();
  return Object.hasOwn(statuses, key) ? key : fallback;
}

function viewerStateForNeed(rootViewerState, need) {
  const direct = need.viewerState || need.viewer_state;
  if (direct) return direct;
  if (!rootViewerState) return {};
  if (Array.isArray(rootViewerState)) {
    return rootViewerState.find((item) => String(item.needId || item.need_id || item.id) === String(need.id)) || {};
  }
  return rootViewerState[need.id]
    || rootViewerState.needs?.[need.id]
    || rootViewerState.needs?.find?.((item) => String(item.needId || item.id) === String(need.id))
    || {};
}

function normalizeNeed(rawNeed, rootViewerState) {
  const statusKey = safeStatus(
    firstValue(rawNeed.statusKey, rawNeed.status_key, rawNeed.status),
    needStatuses,
    'open',
  );
  const rawStats = rawNeed.stats || {};
  const rawViewerState = viewerStateForNeed(rootViewerState, rawNeed);
  return {
    ...rawNeed,
    id: String(firstValue(rawNeed.id, rawNeed.needId, rawNeed.need_id, '')),
    title: firstValue(rawNeed.title, rawNeed.name, 'نیاز همکاری'),
    description: firstValue(rawNeed.description, rawNeed.summary, ''),
    category: firstValue(rawNeed.category, rawNeed.type, 'همکاری'),
    targetValue: firstValue(rawNeed.targetValue, rawNeed.target_value, rawNeed.target, ''),
    statusKey,
    stats: {
      followers: asNumber(firstValue(rawStats.followers, rawStats.following, rawNeed.followersCount, rawNeed.followers_count)),
      interests: asNumber(firstValue(rawStats.interests, rawNeed.interestsCount, rawNeed.interests_count)),
      proposals: asNumber(firstValue(rawStats.proposals, rawNeed.proposalsCount, rawNeed.proposal_count)),
      views: asNumber(firstValue(rawStats.views, rawNeed.viewsCount, rawNeed.views_count)),
    },
    viewerState: {
      following: Boolean(firstValue(rawViewerState.following, rawViewerState.isFollowing, false)),
      interested: Boolean(firstValue(rawViewerState.interested, rawViewerState.isInterested, false)),
    },
  };
}

function listValue(...values) {
  return values.find(Array.isArray) || [];
}

function normalizeCapitalSummary(payload, rawProject) {
  const projectMetrics = rawProject.metrics || payload.metrics || {};
  const raw = firstValue(
    payload.capital,
    payload.capitalSummary,
    payload.capital_summary,
    payload.capTable,
    payload.cap_table,
    rawProject.capital,
    projectMetrics.capital,
    {},
  ) || {};
  const classes = listValue(
    raw.shareClasses,
    raw.share_classes,
    raw.classes,
    payload.shareClasses,
    payload.share_classes,
  ).map((item, index) => ({
    id: String(firstValue(item.id, item.key, `class-${index + 1}`)),
    title: firstValue(item.title, item.name, item.label, 'طبقهٔ سرمایه'),
    type: firstValue(item.type, item.kind, ''),
    units: asNumber(firstValue(item.units, item.unitCount, item.unit_count, item.issuedUnits, item.issued_units)),
    ownershipPercent: clampPercent(firstValue(
      item.ownershipPercent,
      item.ownership_percent,
      item.percentage,
      item.percent,
    )),
    unitPrice: asNumber(firstValue(item.unitPrice, item.unit_price, item.price)),
    capital: asNumber(firstValue(item.capital, item.amount, item.raisedCapital, item.raised_capital)),
    description: firstValue(item.publicDescription, item.public_description, item.description, ''),
  }));
  const offers = listValue(
    raw.offers,
    raw.shareOffers,
    raw.share_offers,
    payload.shareOffers,
    payload.share_offers,
  ).map((item, index) => ({
    id: String(firstValue(item.id, `offer-${index + 1}`)),
    title: firstValue(item.title, item.name, 'عرضهٔ سرمایه'),
    status: String(firstValue(item.status, 'open')),
    classTitle: firstValue(
      item.classTitle,
      item.class_title,
      item.shareClassTitle,
      item.share_class_title,
      item.className,
      item.symbol,
      '',
    ),
    units: asNumber(firstValue(item.remainingUnits, item.remaining_units, item.units, item.unitCount, item.unit_count)),
    unitPrice: asNumber(firstValue(item.unitPrice, item.unit_price, item.price)),
    targetAmount: asNumber(firstValue(item.targetAmount, item.target_amount, item.amount)),
    subscribedAmount: asNumber(firstValue(item.subscribedAmount, item.subscribed_amount, item.committedAmount, item.committed_amount)),
    closesAt: firstValue(item.closesAt, item.closes_at, item.availableUntil, item.available_until, item.deadline, ''),
  }));
  return {
    totalCapital: asNumber(firstValue(
      raw.totalCapital,
      raw.total_capital,
      raw.registeredCapital,
      raw.registered_capital,
      payload.totalCapital,
      payload.total_capital,
    )),
    raisedCapital: asNumber(firstValue(
      raw.raisedCapital,
      raw.raised_capital,
      raw.paidCapital,
      raw.paid_capital,
      payload.raisedCapital,
      payload.raised_capital,
      projectMetrics.financial?.investedCapital,
      projectMetrics.financial?.investment,
    )),
    targetCapital: asNumber(firstValue(
      raw.targetCapital,
      raw.target_capital,
      raw.fundingTarget,
      raw.funding_target,
      payload.targetCapital,
      payload.target_capital,
      rawProject.budgetAmount,
      rawProject.budget_amount,
    )),
    valuation: asNumber(firstValue(
      raw.valuation,
      raw.projectValuation,
      raw.project_valuation,
      rawProject.valuationAmount,
      rawProject.valuation_amount,
    )),
    totalUnits: asNumber(firstValue(
      raw.totalUnits,
      raw.total_units,
      raw.totalIssuedUnits,
      raw.total_issued_units,
    ), classes.reduce((sum, item) => sum + item.units, 0)),
    holderCount: asNumber(firstValue(
      raw.holderCount,
      raw.holder_count,
      raw.stakeholderCount,
      raw.stakeholder_count,
    )),
    unit: firstValue(
      raw.currencyLabel,
      raw.currency_label,
      raw.unit,
      rawProject.currency === 'IRR' ? 'ریال' : rawProject.currency,
      'ریال',
    ),
    classes,
    offers,
  };
}

function normalizeFinancialSummary(payload, rawProject) {
  const projectMetrics = rawProject.metrics || payload.metrics || {};
  const raw = firstValue(
    payload.financial,
    payload.financialSummary,
    payload.financial_summary,
    rawProject.financial,
    projectMetrics.financial,
    {},
  ) || {};
  const periods = listValue(raw.periods, raw.trend, raw.series, payload.financialPeriods)
    .map((item, index) => ({
      id: String(firstValue(item.id, item.period, `period-${index + 1}`)),
      label: firstValue(item.label, item.periodLabel, item.period_label, item.period, ''),
      revenue: optionalNumber(item, 'revenue', 'income'),
      expenses: optionalNumber(item, 'expenses', 'expense', 'costs'),
      net: optionalNumber(item, 'net', 'netProfit', 'net_profit', 'profit'),
      overflow: Boolean(item.overflow),
      exact: item.exact || {},
    }));
  const roiKey = ['roiPercent', 'roi_percent', 'roi'].find((key) =>
    Object.hasOwn(raw, key));
  const roiValue = roiKey ? raw[roiKey] : null;
  let roiPercent = roiValue === null || roiValue === '' ? null : asNumber(roiValue);
  if (roiKey === 'roi' && roiPercent >= -1 && roiPercent <= 1) roiPercent *= 100;
  return {
    periodLabel: firstValue(raw.periodLabel, raw.period_label, raw.period, 'دورهٔ جاری'),
    revenue: optionalNumber(raw, 'revenue', 'totalRevenue', 'total_revenue', 'income'),
    expenses: optionalNumber(raw, 'expenses', 'expense', 'totalExpenses', 'total_expenses', 'costs'),
    netProfit: optionalNumber(raw, 'netProfit', 'net_profit', 'profit'),
    roiPercent,
    investedCapital: optionalNumber(raw, 'investedCapital', 'invested_capital', 'investment'),
    distribution: optionalNumber(raw, 'distribution', 'distributions'),
    cashBalance: optionalNumber(raw, 'cashBalance', 'cash_balance', 'netCash', 'net_cash', 'balance'),
    unit: firstValue(
      raw.currencyLabel,
      raw.currency_label,
      raw.unit,
      rawProject.currency === 'IRR' ? 'ریال' : rawProject.currency,
      'ریال',
    ),
    periods,
  };
}

function normalizeGoals(payload, rawProject) {
  const raw = firstValue(
    payload.goals,
    payload.milestones,
    rawProject.goals,
    rawProject.metrics?.goals,
    payload.metrics?.goals,
    [],
  ) || [];
  const list = Array.isArray(raw) ? raw : listValue(raw.items, raw.goals, raw.milestones);
  return list.map((item, index) => ({
    id: String(firstValue(item.id, `goal-${index + 1}`)),
    title: firstValue(item.title, item.name, 'هدف پروژه'),
    description: firstValue(item.publicDescription, item.public_description, item.description, ''),
    status: String(firstValue(item.status, 'planned')),
    progressPercent: clampPercent(firstValue(item.progressPercent, item.progress_percent, item.progress)),
    weight: asNumber(firstValue(item.weight, item.weightPercent, item.weight_percent), 1),
    targetValue: firstValue(item.targetValue, item.target_value, item.target, ''),
    dueDate: firstValue(item.dueDate, item.due_date, item.deadline, ''),
  }));
}

function normalizeGovernance(payload, rawProject) {
  const projectMetrics = rawProject.metrics || payload.metrics || {};
  const raw = firstValue(
    payload.governance,
    payload.governanceSummary,
    payload.governance_summary,
    rawProject.governance,
    projectMetrics.governance,
    {},
  ) || {};
  const meetings = listValue(raw.meetings, payload.meetings).map((item, index) => ({
    id: String(firstValue(item.id, `meeting-${index + 1}`)),
    title: firstValue(item.title, item.subject, 'جلسهٔ پروژه'),
    status: String(firstValue(item.status, 'scheduled')),
    scheduledAt: firstValue(item.scheduledAt, item.scheduled_at, item.date, ''),
    quorumPercent: clampPercent(firstValue(item.quorumPercent, item.quorum_percent, item.quorum)),
    summary: firstValue(item.publicSummary, item.public_summary, item.summary, item.minutes, ''),
    resolutions: listValue(item.resolutions, item.decisions).map((resolution, resolutionIndex) => ({
      id: String(firstValue(resolution.id, `resolution-${resolutionIndex + 1}`)),
      title: firstValue(resolution.title, resolution.subject, resolution.text, 'مصوبه'),
      result: firstValue(resolution.result, resolution.decision, resolution.status, ''),
      votesFor: asNumber(firstValue(
        resolution.votesFor,
        resolution.votes_for,
        resolution.for,
        resolution.tally?.yes?.votingPower,
        resolution.tally?.yes?.voters,
      )),
      votesAgainst: asNumber(firstValue(
        resolution.votesAgainst,
        resolution.votes_against,
        resolution.against,
        resolution.tally?.no?.votingPower,
        resolution.tally?.no?.voters,
      )),
      abstentions: asNumber(firstValue(
        resolution.abstentions,
        resolution.abstain,
        resolution.tally?.abstain?.votingPower,
        resolution.tally?.abstain?.voters,
      )),
    })),
  }));
  return {
    meetings,
    meetingCount: asNumber(firstValue(
      raw.meetingCount,
      raw.meeting_count,
      typeof raw.meetings === 'number' ? raw.meetings : undefined,
    ), meetings.length),
    resolutionCount: asNumber(firstValue(
      raw.resolutionCount,
      raw.resolution_count,
      typeof raw.resolutions === 'number' ? raw.resolutions : undefined,
    ), meetings.reduce((sum, item) => sum + item.resolutions.length, 0)),
    lastMeetingAt: firstValue(raw.lastMeetingAt, raw.last_meeting_at, meetings[0]?.scheduledAt, ''),
  };
}

function normalizeProjectPayload(rawPayload, requestedSlug) {
  const payload = rawPayload || {};
  const rawProject = payload.project || {};
  const needs = (payload.needs || rawProject.needs || payload.pieces || [])
    .map((need) => normalizeNeed(need, payload.viewerState || payload.viewer_state))
    .filter((need) => need.id);
  const committedNeeds = needs.filter((need) => need.statusKey === 'committed').length;
  const openNeeds = needs.filter((need) => need.statusKey === 'open').length;
  const underReviewNeeds = needs.filter((need) => need.statusKey === 'under_review').length;
  const negotiatingNeeds = needs.filter((need) => need.statusKey === 'negotiating').length;
  const totalProposals = needs.reduce((sum, need) => sum + need.stats.proposals, 0);
  const totalFollowers = needs.reduce((sum, need) => sum + need.stats.followers, 0);
  const totalInterests = needs.reduce((sum, need) => sum + need.stats.interests, 0);
  const projectMetrics = rawProject.metrics || payload.metrics || {};
  const rawSummary = payload.summary || projectMetrics.participation || rawProject.stats || {};
  const totalNeeds = asNumber(
    firstValue(rawSummary.totalNeeds, rawSummary.total_needs, rawSummary.activeNeeds, rawSummary.active_needs),
    needs.length,
  );
  const computedCompletion = totalNeeds ? Math.round((committedNeeds / totalNeeds) * 100) : 0;
  const projectSlug = String(firstValue(rawProject.slug, rawProject.id, requestedSlug, DEFAULT_PROJECT_SLUG));
  const capital = normalizeCapitalSummary(payload, rawProject);
  const financial = normalizeFinancialSummary(payload, rawProject);
  const goals = normalizeGoals(payload, rawProject);
  const governance = normalizeGovernance(payload, rawProject);
  const rawGoalSummary = projectMetrics.goals || {};
  const totalGoalWeight = goals.reduce((sum, goal) => sum + Math.max(0, goal.weight), 0);
  const weightedGoalProgress = totalGoalWeight
    ? goals.reduce((sum, goal) => sum + (goal.progressPercent * Math.max(0, goal.weight)), 0) / totalGoalWeight
    : 0;

  return {
    raw: payload,
    project: {
      ...rawProject,
      id: String(firstValue(rawProject.id, projectSlug)),
      slug: projectSlug,
      title: firstValue(rawProject.title, 'پروژهٔ مشارکتی'),
      subtitle: firstValue(rawProject.subtitle, rawProject.summary, ''),
      description: firstValue(rawProject.description, rawProject.summary, rawProject.subtitle, ''),
      location: firstValue(rawProject.location, ''),
      industry: firstValue(rawProject.industry, rawProject.sector, rawProject.category, 'سایر'),
      stage: firstValue(rawProject.stage, rawProject.phase, rawProject.lifecycleStage, rawProject.lifecycle_stage, 'در حال اجرا'),
      leaderName: firstValue(
        rawProject.leaderName,
        rawProject.leader_name,
        rawProject.ownerName,
        rawProject.owner_name,
        rawProject.leader?.name,
        rawProject.facilitator,
        '',
      ),
      leaderDescription: firstValue(
        rawProject.leaderDescription,
        rawProject.leader_description,
        rawProject.leader?.description,
        '',
      ),
      timeline: firstValue(rawProject.timeline, rawProject.schedule, rawProject.duration, ''),
      deadline: firstValue(rawProject.deadline, rawProject.endDate, rawProject.end_date, ''),
      processDescription: firstValue(rawProject.processDescription, rawProject.process_description, ''),
      status: String(firstValue(rawProject.status, 'published')),
      active: !rawProject.archivedAt && !rawProject.archived_at && ![false, 0, '0'].includes(firstValue(
        rawProject.active,
        rawProject.isActive,
        rawProject.is_active,
        true,
      )),
    },
    needs,
    capital,
    financial,
    goals,
    goalSummary: {
      count: asNumber(firstValue(rawGoalSummary.count, goals.length), goals.length),
      completedCount: asNumber(firstValue(
        rawGoalSummary.completedCount,
        rawGoalSummary.completed_count,
      ), goals.filter((goal) => goal.progressPercent === 100).length),
    },
    governance,
    summary: {
      totalNeeds,
      committedNeeds: asNumber(firstValue(rawSummary.committedNeeds, rawSummary.committed_needs), committedNeeds),
      openNeeds: asNumber(firstValue(rawSummary.openNeeds, rawSummary.open_needs), openNeeds),
      underReviewNeeds: asNumber(firstValue(rawSummary.underReviewNeeds, rawSummary.under_review_needs), underReviewNeeds),
      negotiatingNeeds: asNumber(firstValue(rawSummary.negotiatingNeeds, rawSummary.negotiating_needs), negotiatingNeeds),
      totalProposals: asNumber(
        firstValue(rawSummary.totalProposals, rawSummary.total_proposals, rawSummary.proposals),
        totalProposals,
      ),
      totalFollowers: asNumber(
        firstValue(rawSummary.totalFollowers, rawSummary.total_followers, rawSummary.followers),
        totalFollowers,
      ),
      totalInterests: asNumber(
        firstValue(rawSummary.totalInterests, rawSummary.total_interests, rawSummary.interests),
        totalInterests,
      ),
      completionPercent: asNumber(
        firstValue(
          rawSummary.completionPercent,
          rawSummary.completion_percent,
          rawSummary.participationCompletionPercent,
          rawSummary.participation_completion_percent,
          projectMetrics.participationCompletionPercent,
          projectMetrics.participation_completion_percent,
          rawSummary.progress,
        ),
        computedCompletion,
      ),
      operationalProgress: asNumber(
        firstValue(
          rawSummary.operationalProgress,
          rawSummary.operational_progress,
          rawSummary.weightedGoalProgress,
          rawSummary.weighted_goal_progress,
          projectMetrics.goalProgressPercent,
          projectMetrics.goal_progress_percent,
          projectMetrics.goals?.goalProgressPercent,
          projectMetrics.goals?.goal_progress_percent,
        ),
        weightedGoalProgress,
      ),
      participationCompletionPercent: asNumber(firstValue(
        projectMetrics.participationCompletionPercent,
        projectMetrics.participation_completion_percent,
        rawSummary.participationCompletionPercent,
        rawSummary.participation_completion_percent,
      ), computedCompletion),
    },
    updatedAt: firstValue(payload.updatedAt, payload.updated_at, rawProject.updatedAt, rawProject.updated_at, ''),
  };
}

function normalizePortfolioPayload(rawPayload) {
  const payload = rawPayload || {};
  const rawProjects = Array.isArray(payload)
    ? payload
    : listValue(payload.projects, payload.items, payload.data?.projects, payload.data?.items, payload.data);
  const projects = rawProjects.map((rawProject) => {
    const detail = normalizeProjectPayload({
      project: rawProject,
      summary: rawProject.summaryStats || rawProject.summary_stats || rawProject.summary || rawProject.stats,
      capital: rawProject.capital || rawProject.capitalSummary || rawProject.capital_summary,
      financial: rawProject.financial || rawProject.financialSummary || rawProject.financial_summary,
      goals: rawProject.goals,
      governance: rawProject.governance,
      needs: rawProject.needs || [],
    }, rawProject.slug || rawProject.id);
    return detail;
  }).filter((item) => item.project.slug);

  const rawSummary = payload.summary || payload.portfolioSummary || payload.portfolio_summary || {};
  return {
    projects,
    summary: {
      projectCount: asNumber(
        firstValue(rawSummary.projectCount, rawSummary.project_count, rawSummary.totalProjects),
        projects.length,
      ),
      activeNeeds: asNumber(
        firstValue(rawSummary.activeNeeds, rawSummary.active_needs),
        projects.reduce((sum, item) => sum + item.summary.totalNeeds, 0),
      ),
      committedNeeds: asNumber(
        firstValue(rawSummary.committedNeeds, rawSummary.committed_needs),
        projects.reduce((sum, item) => sum + item.summary.committedNeeds, 0),
      ),
      raisedCapital: asNumber(
        firstValue(rawSummary.raisedCapital, rawSummary.raised_capital),
        projects.reduce((sum, item) => sum + item.capital.raisedCapital, 0),
      ),
      capitalUnit: firstValue(rawSummary.capitalUnit, rawSummary.capital_unit, 'ریال'),
    },
    updatedAt: firstValue(payload.updatedAt, payload.updated_at, ''),
  };
}

function projectFingerprint(data) {
  return JSON.stringify({
    updatedAt: data.updatedAt,
    title: data.project.title,
    project: [
      data.project.status,
      data.project.active,
      data.project.stage,
      data.project.industry,
    ],
    summary: data.summary,
    capital: [
      data.capital.totalCapital,
      data.capital.raisedCapital,
      data.capital.targetCapital,
      data.capital.totalUnits,
      data.capital.classes,
      data.capital.offers,
    ],
    financial: data.financial,
    goals: [data.goalSummary, data.goals],
    governance: data.governance,
    needs: data.needs.map((need) => [
      need.id,
      need.statusKey,
      need.stats.followers,
      need.stats.interests,
      need.stats.proposals,
      need.viewerState.following,
      need.viewerState.interested,
    ]),
  });
}

async function apiRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.');
  }

  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (response.status !== 204) {
    try {
      data = contentType.includes('json') ? await response.json() : await response.text();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const apiError = data?.error;
    const message = typeof apiError === 'string'
      ? apiError
      : firstValue(apiError?.message, data?.message, 'درخواست انجام نشد. لطفاً دوباره تلاش کنید.');
    throw new ApiError(message, {
      status: response.status,
      code: firstValue(apiError?.code, 'REQUEST_FAILED'),
      fields: apiError?.fields || data?.fields || null,
    });
  }
  return data;
}

function parseRoute(pathname = window.location.pathname, search = window.location.search) {
  const cleanPath = pathname.replace(/\/+$/, '') || '/';
  if (cleanPath === '/' || cleanPath === '/projects') return { type: 'portfolio' };
  if (cleanPath === '/my-proposals') return { type: 'tracking' };

  const needMatch = cleanPath.match(/^\/projects\/([^/]+)\/needs\/([^/]+)$/);
  if (needMatch) {
    return {
      type: 'need',
      slug: decodeURIComponent(needMatch[1]),
      needId: decodeURIComponent(needMatch[2]),
    };
  }

  const projectMatch = cleanPath.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    const selectedTab = new URLSearchParams(search).get('tab') || 'overview';
    return {
      type: 'project',
      slug: decodeURIComponent(projectMatch[1]),
      tab: Object.hasOwn(projectTabs, selectedTab) ? selectedTab : 'overview',
    };
  }
  return { type: 'not-found' };
}

function navigate(href, { replace = false } = {}) {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  window.history[replace ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}${url.hash}`);
  renderCurrentRoute({ focusMain: true });
}

function setActiveNavigation(route) {
  document.querySelectorAll('.main-nav a').forEach((link) => link.removeAttribute('aria-current'));
  if (route.type === 'tracking') {
    document.querySelector('.main-nav a[href="/my-proposals"]')?.setAttribute('aria-current', 'page');
  } else if (route.type === 'portfolio' || route.type === 'project' || route.type === 'need') {
    projectNavLink.setAttribute('aria-current', 'page');
  }
}

function renderLoading(type) {
  const wrapper = element('div', {
    className: `container route-loader route-loader-${type}`,
    attrs: { 'aria-busy': 'true', 'aria-label': 'در حال بارگذاری محتوا' },
  });
  wrapper.append(
    element('div', { className: 'skeleton skeleton-line skeleton-short' }),
    element('div', { className: 'skeleton skeleton-title' }),
    element('div', { className: 'skeleton skeleton-line' }),
  );
  const grid = element('div', { className: type === 'need' ? 'skeleton-need-layout' : 'skeleton-grid' });
  grid.append(
    element('div', { className: 'skeleton skeleton-card skeleton-card-tall' }),
    element('div', { className: 'skeleton skeleton-card skeleton-card-tall' }),
    ...(type === 'project' ? [element('div', { className: 'skeleton skeleton-card skeleton-card-tall' })] : []),
  );
  wrapper.append(grid);
  replaceMain(wrapper);
}

function renderRouteError(error, retryAction = 'retry-route') {
  const isOffline = !navigator.onLine || error.status === 0;
  const panel = element('section', {
    className: 'container state-page',
    attrs: { 'aria-labelledby': 'route-error-title' },
  });
  panel.append(
    element('div', { className: `state-illustration ${isOffline ? 'offline' : 'error'}`, attrs: { 'aria-hidden': 'true' } }),
    element('p', { className: 'eyebrow', text: isOffline ? 'اتصال برقرار نیست' : 'خطا در دریافت اطلاعات' }),
    element('h1', {
      id: 'route-error-title',
      text: isOffline ? 'این صفحه فعلاً در دسترس نیست' : 'بارگذاری صفحه کامل نشد',
    }),
    element('p', {
      text: isOffline
        ? 'بعد از وصل‌شدن اینترنت، دوباره تلاش کنید.'
        : error.message || 'چند لحظه دیگر دوباره تلاش کنید.',
    }),
    element('button', {
      className: 'button button-primary',
      text: 'تلاش دوباره',
      attrs: { type: 'button' },
      dataset: { action: retryAction },
    }),
  );
  replaceMain(panel);
}

function renderNotFound() {
  document.title = 'صفحه پیدا نشد | هم‌ساخت';
  const panel = element('section', {
    className: 'container state-page',
    attrs: { 'aria-labelledby': 'not-found-title' },
  });
  panel.append(
    element('p', { className: 'eyebrow', text: 'خطای ۴۰۴' }),
    element('h1', { id: 'not-found-title', text: 'این مسیر را پیدا نکردیم' }),
    element('p', { text: 'ممکن است آدرس تغییر کرده باشد یا لینک کامل نباشد.' }),
    appLink('/', 'بازگشت به پروژه', 'button button-primary'),
  );
  replaceMain(panel);
}

function metaItem(label, value) {
  if (!value) return null;
  return element('li', { className: 'project-meta-item' },
    element('span', { text: label }),
    element('strong', { text: value }),
  );
}

function statusBadge(statusKey, needId = '') {
  const status = needStatuses[statusKey] || needStatuses.open;
  return element('span', {
    className: `status-badge status-${statusKey}`,
    text: status.label,
    dataset: { needStatusId: needId },
  });
}

function statItem(label, value, statKey, needId, compact = false) {
  return element('div', { className: compact ? 'need-stat compact' : 'need-stat' },
    element('strong', {
      text: faNumber(value),
      dataset: { needStatId: needId, statKey },
    }),
    element('span', { text: label }),
  );
}

function viewerButton(need, action, compact = false) {
  const pressed = action === 'following' ? need.viewerState.following : need.viewerState.interested;
  const text = action === 'following'
    ? (pressed ? 'دنبال می‌کنم' : 'دنبال کردن')
    : (pressed ? 'آمادگی ثبت شد' : 'اعلام آمادگی');
  return element('button', {
    className: `viewer-button ${pressed ? 'is-active' : ''} ${compact ? 'is-compact' : ''}`,
    text,
    attrs: {
      type: 'button',
      'aria-pressed': String(pressed),
      'aria-label': `${text} برای «${need.title}»`,
    },
    dataset: {
      viewerAction: action,
      needId: need.id,
    },
  });
}

function renderNeedCard(need, projectSlug) {
  const href = `/projects/${encodeURIComponent(projectSlug)}/needs/${encodeURIComponent(need.id)}`;
  const card = element('article', {
    className: `need-card need-card-${need.statusKey}`,
    dataset: { needCardId: need.id },
  });
  const header = element('div', { className: 'need-card-header' },
    element('span', { className: 'need-category', text: need.category }),
    statusBadge(need.statusKey, need.id),
  );
  const title = element('h3', {}, appLink(href, need.title));
  const description = element('p', { className: 'need-description', text: need.description || 'جزئیات این نیاز را ببینید و پیشنهاد مشخص خود را ثبت کنید.' });
  const target = need.targetValue
    ? element('div', { className: 'need-target' },
      element('span', { text: 'نیاز مشخص' }),
      element('strong', { text: need.targetValue }),
    )
    : null;
  const stats = element('div', { className: 'need-stats', attrs: { 'aria-label': 'آمار تعامل' } },
    statItem('دنبال‌کننده', need.stats.followers, 'followers', need.id, true),
    statItem('اعلام آمادگی', need.stats.interests, 'interests', need.id, true),
    statItem('پیشنهاد', need.stats.proposals, 'proposals', need.id, true),
  );
  const actions = element('div', { className: 'need-card-actions' },
    viewerButton(need, 'following', true),
    viewerButton(need, 'interested', true),
    appLink(href, 'مشاهده و ارسال پیشنهاد', 'need-detail-link'),
  );
  card.append(header, title, description, target, stats, actions);
  return card;
}

function metricCard(label, value, key, hint = '') {
  const card = element('div', { className: 'metric-card' });
  card.append(
    element('strong', { text: faNumber(value), dataset: { summaryValue: key } }),
    element('span', { text: label }),
  );
  if (hint) card.append(element('small', { text: hint }));
  return card;
}

function displayMetric(label, value, hint = '', tone = '') {
  const card = element('div', { className: `metric-card display-metric ${tone ? `tone-${tone}` : ''}` });
  card.append(
    element('strong', { text: value }),
    element('span', { text: label }),
  );
  if (hint) card.append(element('small', { text: hint }));
  return card;
}

function projectFooter(projectSlug) {
  const footer = element('footer', { className: 'site-footer' });
  const inner = element('div', { className: 'container footer-inner' });
  const footerNavigation = element('nav', {
    className: 'footer-links',
    attrs: { 'aria-label': 'پیوندهای پایانی' },
  });
  footerNavigation.append(appLink('/projects', 'پروژه‌ها'));
  if (projectSlug) {
    footerNavigation.append(appLink(`/projects/${encodeURIComponent(projectSlug)}`, 'نمای پروژه'));
  }
  footerNavigation.append(
    appLink('/my-proposals', 'پیگیری‌های من'),
    element('a', { text: 'ورود به فضای کاری', attrs: { href: '/workspace' } }),
  );
  inner.append(
    element('div', { className: 'footer-brand' },
      element('strong', { text: 'هم‌ساخت' }),
      element('p', { text: 'پیشنهاد روشن، تصمیم قابل پیگیری، همکاری واقعی.' }),
    ),
    footerNavigation,
  );
  footer.append(inner);
  return footer;
}

function renderLegacyProjectPage(data) {
  const { project, needs, summary } = data;
  document.title = `${project.title} | هم‌ساخت`;
  projectNavLink.href = `/projects/${encodeURIComponent(project.slug)}`;

  const hero = element('section', {
    className: 'project-hero',
    attrs: { 'aria-labelledby': 'project-title' },
  });
  const heroInner = element('div', { className: 'container hero-grid' });
  const intro = element('div', { className: 'hero-copy' },
    element('span', { className: 'eyebrow', text: 'اتاق مشارکت پروژه' }),
    element('h1', { id: 'project-title', text: project.title }),
    element('p', { className: 'hero-lead', text: project.subtitle || project.description }),
  );

  const meta = element('ul', { className: 'project-meta', attrs: { 'aria-label': 'مشخصات پروژه' } });
  [
    metaItem('راهبر پروژه', project.leaderName),
    metaItem('موقعیت', project.location),
    metaItem('زمان‌بندی', project.timeline),
    metaItem('مهلت', formatDate(project.deadline)),
  ].filter(Boolean).forEach((item) => meta.append(item));
  if (meta.childElementCount) intro.append(meta);
  if (project.leaderDescription) {
    intro.append(element('p', {
      className: 'leader-description',
      text: project.leaderDescription,
    }));
  }
  intro.append(
    element('div', { className: 'hero-actions' },
      element('a', { className: 'button button-primary', text: 'دیدن نیازهای همکاری', attrs: { href: '#needs' } }),
      appLink('/my-proposals', 'پیگیری پیشنهادهای من', 'button button-secondary'),
    ),
  );

  const progressCard = element('aside', {
    className: 'progress-card',
    attrs: { 'aria-label': 'پیشرفت واقعی پروژه' },
  });
  progressCard.append(
    element('div', { className: 'motif-grid', attrs: { 'aria-hidden': 'true' } }),
    element('span', { className: 'progress-label', text: 'تعهدهای قطعی' }),
    element('strong', {
      className: 'progress-value',
      text: formatPercent(summary.completionPercent),
      dataset: { summaryPercent: '' },
    }),
    element('p', {
      text: `${faNumber(summary.committedNeeds)} نیاز از ${faNumber(summary.totalNeeds)} نیاز فعال، همکار قطعی دارد.`,
      dataset: { summarySentence: '' },
    }),
    element('progress', {
      className: 'project-progress',
      attrs: {
        max: '100',
        value: String(Math.max(0, Math.min(100, summary.completionPercent))),
        'aria-label': `پیشرفت پروژه ${formatPercent(summary.completionPercent)}`,
      },
      dataset: { summaryProgress: '' },
    }),
    element('small', { text: 'این عدد فقط با پذیرش رسمی پیشنهادها تغییر می‌کند؛ بازدید و علاقه در آن اثری ندارد.' }),
  );
  heroInner.append(intro, progressCard);
  hero.append(heroInner);

  const metrics = element('section', {
    className: 'metrics-section',
    attrs: { 'aria-label': 'خلاصه وضعیت پروژه' },
  });
  metrics.append(element('div', { className: 'container metrics-grid' },
    metricCard('نیاز فعال', summary.totalNeeds, 'totalNeeds'),
    metricCard('همکاری قطعی', summary.committedNeeds, 'committedNeeds'),
    metricCard('در حال بررسی و مذاکره', summary.underReviewNeeds + summary.negotiatingNeeds, 'activeDiscussions'),
    metricCard('پیشنهاد دریافت‌شده', summary.totalProposals, 'totalProposals'),
  ));

  const process = element('section', {
    className: 'content-section process-section',
    attrs: { 'aria-labelledby': 'process-title' },
  });
  const processInner = element('div', { className: 'container' });
  processInner.append(
    element('div', { className: 'section-heading' },
      element('div', {},
        element('span', { className: 'eyebrow', text: 'مسیر همکاری' }),
        element('h2', { id: 'process-title', text: 'از یک پیشنهاد روشن تا تعهد واقعی' }),
      ),
    element('p', {
      text: project.processDescription || 'هر مرحله وضعیت مشخص دارد؛ بعد از ثبت هم می‌توانید نتیجه را با لینک امن خود دنبال کنید.',
    }),
    ),
  );
  const steps = element('ol', { className: 'process-list' });
  [
    ['۱', 'نیاز مناسب را انتخاب کنید', 'جزئیات، هدف و وضعیت فعلی هر نیاز را ببینید.'],
    ['۲', 'پیشنهاد مشخص بفرستید', 'ظرفیت، زمان آمادگی و راه تماس را شفاف ثبت کنید.'],
    ['۳', 'نتیجه را پیگیری کنید', 'بررسی، مذاکره و تصمیم نهایی در لینک شخصی شما به‌روز می‌شود.'],
  ].forEach(([number, title, description]) => {
    steps.append(element('li', {},
      element('span', { className: 'step-number', text: number, attrs: { 'aria-hidden': 'true' } }),
      element('div', {},
        element('h3', { text: title }),
        element('p', { text: description }),
      ),
    ));
  });
  processInner.append(steps);
  process.append(processInner);

  const needsSection = element('section', {
    className: 'content-section needs-section',
    id: 'needs',
    attrs: { 'aria-labelledby': 'needs-title' },
  });
  const needsInner = element('div', { className: 'container' });
  const updatedText = data.updatedAt ? `آخرین به‌روزرسانی: ${formatDate(data.updatedAt, true)}` : '';
  needsInner.append(
    element('div', { className: 'section-heading needs-heading' },
      element('div', {},
        element('span', { className: 'eyebrow', text: 'فرصت‌های مشارکت' }),
        element('h2', { id: 'needs-title', text: 'نیازهای این پروژه' }),
      ),
      updatedText ? element('p', { className: 'updated-at', text: updatedText }) : null,
    ),
  );
  if (needs.length) {
    const grid = element('div', { className: 'needs-grid' });
    needs.forEach((need) => grid.append(renderNeedCard(need, project.slug)));
    needsInner.append(grid);
  } else {
    needsInner.append(element('div', { className: 'empty-panel' },
      element('h3', { text: 'فعلاً نیاز فعالی منتشر نشده است' }),
      element('p', { text: 'با انتشار نیاز جدید، جزئیات آن در همین صفحه نمایش داده می‌شود.' }),
    ));
  }
  needsSection.append(needsInner);

  replaceMain(hero, metrics, process, needsSection, projectFooter(project.slug));
}

function moduleEmpty(title, description) {
  return element('div', { className: 'module-empty' },
    element('span', { className: 'module-empty-mark', text: '—', attrs: { 'aria-hidden': 'true' } }),
    element('h3', { text: title }),
    element('p', { text: description }),
  );
}

function moduleHeading(eyebrow, title, description, id) {
  const heading = element('div', { className: 'module-heading' },
    element('div', {},
      element('span', { className: 'eyebrow', text: eyebrow }),
      element('h2', { id, text: title }),
    ),
  );
  if (description) heading.append(element('p', { text: description }));
  return heading;
}

function progressSignal(label, value, hint, tone = '') {
  const percent = clampPercent(value);
  const valueNode = element('strong', {
    text: formatPercent(percent),
    dataset: tone === 'participation' ? { summaryPercent: '' } : {},
  });
  const progressNode = element('progress', {
    attrs: {
      max: '100',
      value: String(percent),
      'aria-label': `${label}: ${formatPercent(percent)}`,
    },
    dataset: tone === 'participation' ? { summaryProgress: '' } : {},
  });
  return element('div', {
    className: `progress-signal ${tone ? `tone-${tone}` : ''}`,
    dataset: tone ? { signal: tone } : {},
  },
    element('div', { className: 'progress-signal-head' },
      element('span', { text: label }),
      valueNode,
    ),
    progressNode,
    element('small', { text: hint }),
  );
}

function renderProjectCard(data) {
  const {
    project,
    summary,
    capital,
    financial,
    goals,
  } = data;
  const href = `/projects/${encodeURIComponent(project.slug)}`;
  const activeNeeds = Math.max(0, summary.totalNeeds - summary.committedNeeds);
  const nextGoal = goals.find((goal) => !['done', 'completed', 'achieved'].includes(goal.status.toLowerCase()));
  const article = element('article', {
    className: 'portfolio-card',
    dataset: {
      portfolioCard: '',
      searchText: [
        project.title,
        project.subtitle,
        project.description,
        project.location,
        project.industry,
        project.stage,
        projectStageLabels[project.stage],
      ].filter(Boolean).join(' ').toLocaleLowerCase('fa-IR'),
      industry: project.industry,
      stage: project.stage,
      status: project.active ? 'active' : 'archived',
    },
  });
  const header = element('div', { className: 'portfolio-card-header' },
    element('span', {
      className: `project-state ${project.active ? 'is-active' : 'is-inactive'}`,
      text: project.active ? 'فعال' : 'آرشیو',
    }),
    project.location ? element('span', { className: 'portfolio-location', text: project.location }) : null,
  );
  const title = element('h2', {}, appLink(href, project.title));
  const description = element('p', {
    className: 'portfolio-card-description',
    text: project.subtitle || project.description || 'جزئیات این پروژه را در نمای شفاف پروژه ببینید.',
  });
  const meta = element('div', { className: 'portfolio-card-meta', attrs: { 'aria-label': 'دسته‌بندی پروژه' } },
    element('span', { text: project.industry }),
    element('span', { text: projectStageLabels[project.stage] || project.stage }),
    project.location ? element('span', { text: project.location }) : null,
  );
  const signals = element('div', {
    className: 'portfolio-card-signals',
    attrs: { 'aria-label': 'شاخص‌های مستقل پروژه' },
  },
  progressSignal(
    'پیشرفت عملیاتی',
    summary.operationalProgress,
    'بر پایهٔ اهداف وزن‌دار پروژه',
    'operation',
  ),
  progressSignal(
    'تکمیل مشارکت',
    summary.completionPercent,
    `${faNumber(summary.committedNeeds)} نیاز پذیرفته‌شده از ${faNumber(summary.totalNeeds)}`,
    'participation',
  ));
  const facts = element('dl', { className: 'portfolio-facts' },
    element('div', {},
      element('dt', { text: 'سرمایه جذب‌شده' }),
      element('dd', { text: formatMoney(capital.raisedCapital, capital.unit) }),
    ),
    element('div', {},
      element('dt', { text: 'بازده مالی' }),
      element('dd', { text: formatFinancialPercent(financial.roiPercent) }),
    ),
    element('div', {},
      element('dt', { text: 'نیاز باز' }),
      element('dd', { text: faNumber(activeNeeds) }),
    ),
  );
  if (nextGoal) {
    article.append(
      header,
      title,
      description,
      meta,
      signals,
      facts,
      element('p', { className: 'next-goal', text: `هدف پیش‌رو: ${nextGoal.title}` }),
      appLink(href, 'مشاهدهٔ پروندهٔ پروژه', 'button button-secondary portfolio-card-link'),
    );
  } else {
    article.append(
      header,
      title,
      description,
      meta,
      signals,
      facts,
      appLink(href, 'مشاهدهٔ پروندهٔ پروژه', 'button button-secondary portfolio-card-link'),
    );
  }
  return article;
}

function filterOption(value, label = value) {
  return element('option', { text: label, attrs: { value } });
}

function applyPortfolioFilters() {
  const search = toEnglishDigits(document.querySelector('#portfolio-search')?.value || '')
    .trim()
    .toLocaleLowerCase('fa-IR');
  const industry = document.querySelector('#portfolio-industry')?.value || '';
  const stage = document.querySelector('#portfolio-stage')?.value || '';
  const status = document.querySelector('#portfolio-status')?.value || '';
  const cards = [...document.querySelectorAll('[data-portfolio-card]')];
  let visibleCount = 0;
  cards.forEach((card) => {
    const matchesSearch = !search || toEnglishDigits(card.dataset.searchText || '').includes(search);
    const matchesIndustry = !industry || card.dataset.industry === industry;
    const matchesStage = !stage || card.dataset.stage === stage;
    const matchesStatus = !status || card.dataset.status === status;
    const visible = matchesSearch && matchesIndustry && matchesStage && matchesStatus;
    card.hidden = !visible;
    if (visible) visibleCount += 1;
  });
  const count = document.querySelector('#portfolio-results-count');
  if (count) count.textContent = `${faNumber(visibleCount)} پروژه`;
  const empty = document.querySelector('#portfolio-filter-empty');
  if (empty) empty.hidden = visibleCount !== 0;
}

function portfolioFilters(projects) {
  const industries = [...new Set(projects.map((item) => item.project.industry).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'fa'));
  const stages = [...new Set(projects.map((item) => item.project.stage).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'fa'));
  const industrySelect = element('select', {
    id: 'portfolio-industry',
    attrs: { 'aria-label': 'فیلتر صنعت' },
    dataset: { portfolioFilter: '' },
  }, filterOption('', 'همهٔ صنعت‌ها'));
  industries.forEach((industry) => industrySelect.append(filterOption(industry)));
  const stageSelect = element('select', {
    id: 'portfolio-stage',
    attrs: { 'aria-label': 'فیلتر مرحله' },
    dataset: { portfolioFilter: '' },
  }, filterOption('', 'همهٔ مرحله‌ها'));
  stages.forEach((stage) => stageSelect.append(filterOption(stage, projectStageLabels[stage] || stage)));
  return element('div', { className: 'portfolio-toolbar' },
    element('label', { className: 'portfolio-search' },
      element('span', { text: 'جست‌وجوی پروژه' }),
      element('input', {
        id: 'portfolio-search',
        attrs: {
          type: 'search',
          placeholder: 'نام، صنعت یا موقعیت…',
          autocomplete: 'off',
        },
        dataset: { portfolioFilter: '' },
      }),
    ),
    element('div', { className: 'portfolio-selects' },
      element('label', {},
        element('span', { text: 'صنعت' }),
        industrySelect,
      ),
      element('label', {},
        element('span', { text: 'مرحله' }),
        stageSelect,
      ),
      element('label', {},
        element('span', { text: 'وضعیت' }),
        element('select', {
          id: 'portfolio-status',
          attrs: { 'aria-label': 'فیلتر وضعیت' },
          dataset: { portfolioFilter: '' },
        },
        filterOption('', 'همهٔ وضعیت‌ها'),
        filterOption('active', 'فعال'),
        filterOption('archived', 'آرشیو')),
      ),
    ),
    element('output', {
      id: 'portfolio-results-count',
      className: 'portfolio-results-count',
      text: `${faNumber(projects.length)} پروژه`,
      attrs: { 'aria-live': 'polite' },
    }),
  );
}

function renderPortfolioPage(data) {
  state.portfolioData = data;
  document.title = 'پروژه‌ها | هم‌ساخت';
  projectNavLink.href = '/projects';

  const hero = element('section', {
    className: 'portfolio-hero',
    attrs: { 'aria-labelledby': 'portfolio-title' },
  });
  const heroInner = element('div', { className: 'container portfolio-hero-grid' },
    element('div', { className: 'portfolio-hero-copy' },
      element('span', { className: 'eyebrow', text: 'پرتفوی شفاف هم‌ساخت' }),
      element('h1', { id: 'portfolio-title', text: 'هر پروژه، یک پروندهٔ روشن و قابل پیگیری' }),
      element('p', {
        text: 'فرصت‌های مشارکت، سرمایهٔ تجمیعی، عملکرد مالی و تصمیم‌های عمومی پروژه‌ها را در یک قاب مشترک ببینید.',
      }),
    ),
    element('aside', { className: 'portfolio-summary', attrs: { 'aria-label': 'خلاصهٔ پرتفوی' } },
      displayMetric('پروژهٔ منتشرشده', faNumber(data.summary.projectCount), 'پروژه‌های قابل مشاهده'),
      displayMetric('نیاز مشارکت', faNumber(data.summary.activeNeeds), 'فرصت‌های تعریف‌شده'),
      displayMetric(
        'سرمایهٔ جذب‌شده',
        formatMoney(data.summary.raisedCapital, data.summary.capitalUnit),
        'عدد تجمیعی، بدون نمایش هویت سهام‌داران',
      ),
    ),
  );
  hero.append(heroInner);

  const projectsSection = element('section', {
    className: 'content-section portfolio-section',
    attrs: { 'aria-labelledby': 'projects-title' },
  });
  const projectsInner = element('div', { className: 'container' },
    moduleHeading(
      'پروژه‌ها',
      'مسیر هر پروژه را مستقل دنبال کنید',
      'سه شاخص پیشرفت عملیاتی، تکمیل مشارکت و عملکرد مالی عمداً با هم ترکیب نمی‌شوند.',
      'projects-title',
    ),
  );
  if (data.projects.length) {
    projectsInner.append(portfolioFilters(data.projects));
    const grid = element('div', { className: 'portfolio-grid' });
    data.projects.forEach((projectData) => grid.append(renderProjectCard(projectData)));
    projectsInner.append(
      grid,
      element('div', {
        className: 'module-empty portfolio-filter-empty',
        id: 'portfolio-filter-empty',
        attrs: { hidden: true, role: 'status' },
      },
      element('span', { className: 'module-empty-mark', text: '⌕', attrs: { 'aria-hidden': 'true' } }),
      element('h3', { text: 'پروژه‌ای با این فیلتر پیدا نشد' }),
      element('p', { text: 'عبارت جست‌وجو یا یکی از فیلترها را تغییر دهید.' })),
    );
  } else {
    projectsInner.append(moduleEmpty(
      'هنوز پروژه‌ای منتشر نشده است',
      'به محض انتشار نخستین پروژه، پروندهٔ شفاف آن در این صفحه نمایش داده می‌شود.',
    ));
  }
  projectsSection.append(projectsInner);

  const principles = element('section', {
    className: 'content-section portfolio-principles',
    attrs: { 'aria-labelledby': 'principles-title' },
  });
  principles.append(element('div', { className: 'container' },
    moduleHeading(
      'روش خواندن داده‌ها',
      'سه سیگنال، سه معنای متفاوت',
      'برای جلوگیری از برداشت اشتباه، هیچ عددی جای عدد دیگر نمی‌نشیند.',
      'principles-title',
    ),
    element('div', { className: 'principles-grid' },
      element('article', {},
        element('span', { className: 'principle-index', text: '۰۱' }),
        element('h3', { text: 'پیشرفت عملیاتی' }),
        element('p', { text: 'میانگین وزن‌دار تحقق اهداف و نقاط عطف اجرایی پروژه است.' }),
      ),
      element('article', {},
        element('span', { className: 'principle-index', text: '۰۲' }),
        element('h3', { text: 'تکمیل مشارکت' }),
        element('p', { text: 'فقط از نسبت نیازهای دارای پیشنهاد پذیرفته‌شده به کل نیازها محاسبه می‌شود.' }),
      ),
      element('article', {},
        element('span', { className: 'principle-index', text: '۰۳' }),
        element('h3', { text: 'عملکرد مالی' }),
        element('p', { text: 'درآمد، هزینه، سود خالص و بازده دوره را مستقل گزارش می‌کند.' }),
      ),
    ),
    element('p', {
      className: 'public-privacy-note',
      text: 'اطلاعات عمومی سرمایه فقط به‌صورت تجمیعی نمایش داده می‌شود؛ هویت و راه ارتباطی ذی‌نفعان عمومی نیست.',
    }),
  ));

  replaceMain(hero, projectsSection, principles, projectFooter());
}

function projectTabNavigation(project, selectedTab) {
  const nav = element('nav', {
    className: 'project-tabs',
    attrs: { 'aria-label': 'بخش‌های پروندهٔ پروژه' },
  });
  Object.entries(projectTabs).forEach(([key, label]) => {
    const href = `/projects/${encodeURIComponent(project.slug)}${key === 'overview' ? '' : `?tab=${key}`}`;
    const link = appLink(href, label);
    if (key === selectedTab) link.setAttribute('aria-current', 'page');
    nav.append(link);
  });
  return nav;
}

function renderNeedsCollection(data, { preview = false } = {}) {
  const { project, needs } = data;
  const visibleNeeds = preview ? needs.slice(0, 3) : needs;
  const section = element('section', {
    className: 'project-module needs-module',
    id: 'needs',
    attrs: { 'aria-labelledby': preview ? 'overview-needs-title' : 'needs-title' },
  });
  section.append(moduleHeading(
    preview ? 'فرصت‌های جاری' : 'مشارکت و نیازها',
    preview ? 'نیازهای باز برای همکاری' : 'از اعلام آمادگی تا تعهد پذیرفته‌شده',
    preview
      ? 'برای دیدن همهٔ فرصت‌ها و ثبت پیشنهاد، وارد بخش مشارکت‌ها شوید.'
      : 'بازدید و علاقه‌مندی، شاخص تعامل‌اند؛ فقط پیشنهاد پذیرفته‌شده در تکمیل مشارکت محاسبه می‌شود.',
    preview ? 'overview-needs-title' : 'needs-title',
  ));
  if (visibleNeeds.length) {
    const grid = element('div', { className: 'needs-grid' });
    visibleNeeds.forEach((need) => grid.append(renderNeedCard(need, project.slug)));
    section.append(grid);
    if (preview && needs.length > visibleNeeds.length) {
      section.append(appLink(
        `/projects/${encodeURIComponent(project.slug)}?tab=needs`,
        `مشاهدهٔ همهٔ ${faNumber(needs.length)} نیاز`,
        'button button-secondary module-more-link',
      ));
    }
  } else {
    section.append(moduleEmpty(
      'فعلاً نیاز فعالی منتشر نشده است',
      'با انتشار فرصت تازه، امکان ثبت پیشنهاد همکاری در همین بخش فعال می‌شود.',
    ));
  }
  return section;
}

function renderOverviewModule(data) {
  const {
    project,
    summary,
    financial,
    capital,
  } = data;
  const section = element('section', {
    className: 'project-module overview-module',
    attrs: { 'aria-labelledby': 'overview-title' },
  });
  section.append(
    moduleHeading(
      'نمای کلی',
      'وضعیت پروژه در یک نگاه',
      'هر کارت یک بُعد مستقل را نشان می‌دهد و با دو شاخص دیگر جمع یا جایگزین نمی‌شود.',
      'overview-title',
    ),
    element('div', { className: 'signal-grid' },
      element('article', { className: 'signal-card signal-operation' },
        element('span', { className: 'signal-kicker', text: 'اجرای پروژه' }),
        element('strong', { text: formatPercent(summary.operationalProgress) }),
        element('h3', { text: 'پیشرفت عملیاتی' }),
        element('p', { text: 'بر پایهٔ اهداف وزن‌دار و نقاط عطف ثبت‌شده.' }),
        element('progress', {
          attrs: {
            max: '100',
            value: String(clampPercent(summary.operationalProgress)),
            'aria-label': `پیشرفت عملیاتی ${formatPercent(summary.operationalProgress)}`,
          },
        }),
      ),
      element('article', { className: 'signal-card signal-participation' },
        element('span', { className: 'signal-kicker', text: 'همکاری' }),
        element('strong', { text: formatPercent(summary.completionPercent) }),
        element('h3', { text: 'تکمیل مشارکت' }),
        element('p', {
          text: `${faNumber(summary.committedNeeds)} نیاز پذیرفته‌شده از ${faNumber(summary.totalNeeds)} نیاز.`,
        }),
        element('progress', {
          attrs: {
            max: '100',
            value: String(clampPercent(summary.completionPercent)),
            'aria-label': `تکمیل مشارکت ${formatPercent(summary.completionPercent)}`,
          },
        }),
      ),
      element('article', { className: 'signal-card signal-financial' },
        element('span', { className: 'signal-kicker', text: financial.periodLabel }),
        element('strong', { text: formatFinancialPercent(financial.roiPercent) }),
        element('h3', { text: 'بازده مالی' }),
        element('p', { text: `سود خالص: ${formatMoney(financial.netProfit, financial.unit)}` }),
        appLink(
          `/projects/${encodeURIComponent(project.slug)}?tab=performance`,
          'جزئیات عملکرد',
          'signal-link',
        ),
      ),
    ),
  );

  const narrative = element('div', { className: 'overview-grid' });
  narrative.append(
    element('article', { className: 'project-story' },
      element('span', { className: 'eyebrow', text: 'دربارهٔ پروژه' }),
      element('h3', { text: project.subtitle || project.title }),
      element('p', { text: project.description || 'شرح عمومی پروژه به‌زودی تکمیل می‌شود.' }),
    ),
    element('aside', { className: 'project-snapshot' },
      element('h3', { text: 'خلاصهٔ ثبت‌شده' }),
      element('dl', {},
        element('div', {},
          element('dt', { text: 'سرمایهٔ جذب‌شده' }),
          element('dd', { text: formatMoney(capital.raisedCapital, capital.unit) }),
        ),
        element('div', {},
          element('dt', { text: 'پیشنهاد همکاری' }),
          element('dd', { text: faNumber(summary.totalProposals) }),
        ),
        element('div', {},
          element('dt', { text: 'موقعیت' }),
          element('dd', { text: project.location || 'ثبت نشده' }),
        ),
        element('div', {},
          element('dt', { text: 'آخرین به‌روزرسانی' }),
          element('dd', { text: data.updatedAt ? formatDate(data.updatedAt, true) : 'ثبت نشده' }),
        ),
      ),
    ),
  );
  section.append(narrative, renderNeedsCollection(data, { preview: true }));
  return section;
}

function renderNeedsModule(data) {
  const wrapper = element('div', { className: 'module-stack' });
  wrapper.append(
    element('section', {
      className: 'project-module participation-explainer',
      attrs: { 'aria-labelledby': 'participation-path-title' },
    },
    moduleHeading(
      'مسیر مشارکت',
      'پیشنهاد روشن، تصمیم قابل پیگیری',
      data.project.processDescription
        || 'نیاز را انتخاب کنید، ظرفیت و زمان آمادگی را بنویسید و نتیجه را با لینک شخصی خود دنبال کنید.',
      'participation-path-title',
    ),
    element('ol', { className: 'compact-process' },
      element('li', {},
        element('span', { text: '۱' }),
        element('div', {}, element('strong', { text: 'انتخاب نیاز' }), element('p', { text: 'دامنه و هدف را بررسی کنید.' })),
      ),
      element('li', {},
        element('span', { text: '۲' }),
        element('div', {}, element('strong', { text: 'ثبت پیشنهاد' }), element('p', { text: 'ظرفیت، زمان و راه تماس را مشخص کنید.' })),
      ),
      element('li', {},
        element('span', { text: '۳' }),
        element('div', {}, element('strong', { text: 'پیگیری نتیجه' }), element('p', { text: 'مذاکره و تصمیم نهایی را ببینید.' })),
      ),
    )),
    renderNeedsCollection(data),
  );
  return wrapper;
}

function renderCapitalModule(data) {
  const { capital } = data;
  const section = element('section', {
    className: 'project-module capital-module',
    attrs: { 'aria-labelledby': 'capital-title' },
  });
  section.append(
    moduleHeading(
      'سرمایه و مالکیت',
      'تصویر تجمیعی دفتر سرمایه',
      'برای حفظ حریم خصوصی، فقط جمع سرمایه، طبقات سهم و عرضه‌های عمومی نمایش داده می‌شوند.',
      'capital-title',
    ),
    element('div', { className: 'module-metrics' },
      displayMetric('ارزش‌گذاری ثبت‌شده', formatMoney(capital.valuation, capital.unit)),
      displayMetric('سرمایهٔ جذب‌شده', formatMoney(capital.raisedCapital, capital.unit)),
      displayMetric('هدف تأمین مالی', formatMoney(capital.targetCapital, capital.unit)),
      displayMetric('واحد منتشرشده', faNumber(capital.totalUnits), 'جمع همهٔ طبقات سرمایه'),
    ),
    element('div', { className: 'ledger-notice', attrs: { role: 'note' } },
      element('strong', { text: 'یادآوری حقوقی و تسویه' }),
      element('p', { text: 'دفتر ثبت داخلی؛ تسویه بانکی و اعتبار حقوقی انتقال خارج از سامانه انجام می‌شود' }),
    ),
  );

  const classesBlock = element('div', { className: 'capital-block' },
    element('div', { className: 'subsection-heading' },
      element('h3', { text: 'طبقات سرمایه' }),
      element('p', { text: 'ترکیب کلی سرمایه، بدون نمایش نام یا اطلاعات تماس اشخاص.' }),
    ),
  );
  if (capital.classes.length) {
    const grid = element('div', { className: 'share-class-grid' });
    capital.classes.forEach((shareClass) => {
      const classSharePercent = shareClass.ownershipPercent
        || (capital.totalUnits ? (shareClass.units / capital.totalUnits) * 100 : 0);
      const ownershipText = classSharePercent
        ? formatPercent(classSharePercent)
        : 'درصد ثبت نشده';
      grid.append(element('article', { className: 'share-class-card' },
        element('div', { className: 'share-class-head' },
          element('h4', { text: shareClass.title }),
          shareClass.type ? element('span', { text: shareClass.type }) : null,
        ),
        element('strong', { text: ownershipText }),
        element('dl', {},
          element('div', {},
            element('dt', { text: 'واحد منتشرشده' }),
            element('dd', { text: faNumber(shareClass.units) }),
          ),
          element('div', {},
            element('dt', { text: 'ارزش هر واحد' }),
            element('dd', { text: formatMoney(shareClass.unitPrice, capital.unit) }),
          ),
          element('div', {},
            element('dt', { text: 'سرمایهٔ طبقه' }),
            element('dd', { text: formatMoney(shareClass.capital, capital.unit) }),
          ),
        ),
        shareClass.description ? element('p', { text: shareClass.description }) : null,
      ));
    });
    classesBlock.append(grid);
  } else {
    classesBlock.append(moduleEmpty('طبقهٔ سرمایه‌ای ثبت نشده است', 'پس از انتشار اطلاعات تجمیعی، این بخش تکمیل می‌شود.'));
  }

  const offersBlock = element('div', { className: 'capital-block' },
    element('div', { className: 'subsection-heading' },
      element('h3', { text: 'عرضه‌های عمومی سرمایه' }),
      element('p', { text: 'وضعیت عرضه و میزان تعهد تجمیعی را بررسی کنید.' }),
    ),
  );
  if (capital.offers.length) {
    const list = element('div', { className: 'offer-list' });
    capital.offers.forEach((offer) => {
      const progress = offer.targetAmount
        ? (offer.subscribedAmount / offer.targetAmount) * 100
        : 0;
      list.append(element('article', { className: 'offer-card' },
        element('div', { className: 'offer-head' },
          element('div', {},
            element('span', {
              className: `offer-status status-${offer.status}`,
              text: publicOfferStatusLabels[offer.status] || offer.status,
            }),
            element('h4', { text: offer.title }),
          ),
          offer.classTitle ? element('span', { className: 'offer-class', text: offer.classTitle }) : null,
        ),
        progressSignal(
          'تعهد سرمایه',
          progress,
          `${formatMoney(offer.subscribedAmount, capital.unit)} از ${formatMoney(offer.targetAmount, capital.unit)}`,
          'capital',
        ),
        element('dl', { className: 'offer-facts' },
          element('div', {}, element('dt', { text: 'تعداد واحد' }), element('dd', { text: faNumber(offer.units) })),
          element('div', {}, element('dt', { text: 'قیمت واحد' }), element('dd', { text: formatMoney(offer.unitPrice, capital.unit) })),
          element('div', {}, element('dt', { text: 'پایان عرضه' }), element('dd', { text: formatDate(offer.closesAt) || 'باز' })),
        ),
      ));
    });
    offersBlock.append(list);
  } else {
    offersBlock.append(moduleEmpty('عرضهٔ بازی وجود ندارد', 'عرضه‌های منتشرشده و میزان تعهد تجمیعی در این بخش قرار می‌گیرند.'));
  }
  section.append(classesBlock, offersBlock);
  return section;
}

function renderPerformanceModule(data) {
  const {
    financial,
    goals,
    goalSummary,
    summary,
  } = data;
  const section = element('section', {
    className: 'project-module performance-module',
    attrs: { 'aria-labelledby': 'performance-title' },
  });
  section.append(
    moduleHeading(
      'عملکرد و اهداف',
      'مالی و عملیاتی، کنار هم اما مستقل',
      'شاخص مالی از دفتر درآمد و هزینه می‌آید؛ درصد عملیاتی از اهداف وزن‌دار محاسبه می‌شود.',
      'performance-title',
    ),
    element('div', { className: 'performance-summary' },
      displayMetric('درآمد', formatMoney(financial.revenue, financial.unit), financial.periodLabel, 'revenue'),
      displayMetric('هزینه', formatMoney(financial.expenses, financial.unit), financial.periodLabel, 'expense'),
      displayMetric('سود خالص', formatMoney(financial.netProfit, financial.unit), financial.periodLabel, 'profit'),
      displayMetric('بازده سرمایه', formatFinancialPercent(financial.roiPercent), financial.periodLabel, 'roi'),
    ),
  );

  const trend = element('div', { className: 'performance-block' },
    element('div', { className: 'subsection-heading' },
      element('h3', { text: 'روند دوره‌ای' }),
      element('p', { text: 'درآمد، هزینه و نتیجهٔ خالص هر دوره.' }),
    ),
  );
  if (financial.periods.length) {
    const maxAmount = Math.max(
      1,
      ...financial.periods.flatMap((period) => [
        Math.abs(period.revenue),
        Math.abs(period.expenses),
        Math.abs(period.net),
      ]),
    );
    const chart = element('div', { className: 'finance-trend', attrs: { role: 'list' } });
    financial.periods.forEach((period) => {
      const row = element('article', { className: 'finance-period', attrs: { role: 'listitem' } },
        element('div', { className: 'finance-period-head' },
          element('h4', { text: period.label || 'دوره' }),
          element('strong', {
            className: period.net < 0 ? 'is-negative' : 'is-positive',
            text: formatMoney(period.net, financial.unit, period.exact.netProfit),
          }),
        ),
      );
      [
        ['درآمد', period.revenue, 'revenue', period.exact.revenue],
        ['هزینه', period.expenses, 'expense', period.exact.expense],
        ['خالص', period.net === null ? null : Math.abs(period.net), period.net < 0 ? 'negative' : 'net', period.exact.netProfit],
      ].forEach(([label, amount, tone, exact]) => {
        const relativeAmount = amount === null ? 0 : Math.max(
          2,
          (Math.abs(amount) / maxAmount) * 100,
        );
        row.append(element('div', { className: 'finance-bar-row' },
          element('span', { text: label }),
          element('div', { className: 'finance-bar-track' },
            element('progress', {
              className: `finance-bar tone-${tone}`,
              attrs: {
                max: '100',
                value: String(relativeAmount),
                'aria-hidden': 'true',
                tabindex: '-1',
              },
            }),
          ),
          element('small', { text: formatMoney(amount, financial.unit, exact) }),
        ));
      });
      chart.append(row);
    });
    trend.append(chart);
  } else if (goalSummary.count) {
    trend.append(element('article', { className: 'goal-card goal-summary-card' },
      element('div', { className: 'goal-head' },
        element('div', {},
          element('span', { className: 'goal-status', text: 'خلاصهٔ عمومی' }),
          element('h4', { text: `${faNumber(goalSummary.count)} هدف فعال` }),
        ),
        element('strong', { text: formatPercent(summary.operationalProgress) }),
      ),
      element('p', {
        text: `${faNumber(goalSummary.completedCount)} هدف تکمیل شده است؛ جزئیات هدف‌ها هنوز برای انتشار عمومی فعال نشده.`,
      }),
      element('progress', {
        attrs: {
          max: '100',
          value: String(clampPercent(summary.operationalProgress)),
          'aria-label': `پیشرفت عملیاتی اهداف ${formatPercent(summary.operationalProgress)}`,
        },
      }),
    ));
  } else {
    trend.append(moduleEmpty('دادهٔ دوره‌ای هنوز منتشر نشده است', 'خلاصهٔ دوره پس از ثبت گزارش مالی در اینجا نمایش داده می‌شود.'));
  }

  const goalsBlock = element('div', { className: 'performance-block goals-block' },
    element('div', { className: 'subsection-heading' },
      element('div', {},
        element('h3', { text: 'اهداف و نقاط عطف' }),
        element('p', { text: 'درصد بالای بخش، میانگین وزن‌دار همین هدف‌هاست.' }),
      ),
      element('strong', { className: 'operational-total', text: formatPercent(summary.operationalProgress) }),
    ),
  );
  if (goals.length) {
    const list = element('div', { className: 'goal-list' });
    goals.forEach((goal) => {
      list.append(element('article', { className: 'goal-card' },
        element('div', { className: 'goal-head' },
          element('div', {},
            element('span', {
              className: `goal-status status-${goal.status}`,
              text: publicGoalStatusLabels[goal.status] || goal.status,
            }),
            element('h4', { text: goal.title }),
          ),
          element('strong', { text: formatPercent(goal.progressPercent) }),
        ),
        goal.description ? element('p', { text: goal.description }) : null,
        element('progress', {
          attrs: {
            max: '100',
            value: String(clampPercent(goal.progressPercent)),
            'aria-label': `${goal.title}: ${formatPercent(goal.progressPercent)}`,
          },
        }),
        element('div', { className: 'goal-meta' },
          element('span', { text: `وزن: ${faNumber(goal.weight)}` }),
          goal.targetValue ? element('span', { text: `هدف: ${goal.targetValue}` }) : null,
          goal.dueDate ? element('span', { text: `موعد: ${formatDate(goal.dueDate)}` }) : null,
        ),
      ));
    });
    goalsBlock.append(list);
  } else {
    goalsBlock.append(moduleEmpty('هدفی برای انتشار ثبت نشده است', 'پس از تعریف نقاط عطف، پیشرفت وزن‌دار پروژه در این بخش قابل بررسی است.'));
  }
  section.append(trend, goalsBlock);
  return section;
}

function renderGovernanceModule(data) {
  const { governance } = data;
  const section = element('section', {
    className: 'project-module governance-module',
    attrs: { 'aria-labelledby': 'governance-title' },
  });
  section.append(
    moduleHeading(
      'حاکمیت پروژه',
      'جلسه‌ها و مصوبات عمومی',
      'نتیجهٔ تصمیم‌ها و آرای تجمیعی نمایش داده می‌شود؛ هویت رأی‌دهندگان عمومی نیست.',
      'governance-title',
    ),
    element('div', { className: 'module-metrics governance-metrics' },
      displayMetric('جلسه', faNumber(governance.meetingCount)),
      displayMetric('مصوبه', faNumber(governance.resolutionCount)),
      displayMetric('آخرین جلسه', formatDate(governance.lastMeetingAt) || 'ثبت نشده'),
    ),
  );
  if (governance.meetings.length) {
    const timeline = element('div', { className: 'meeting-timeline' });
    governance.meetings.forEach((meeting) => {
      const card = element('article', { className: 'meeting-card' },
        element('header', { className: 'meeting-head' },
          element('div', {},
            element('span', {
              className: `meeting-status status-${meeting.status}`,
              text: publicMeetingStatusLabels[meeting.status] || meeting.status,
            }),
            element('h3', { text: meeting.title }),
          ),
          element('time', {
            text: formatDate(meeting.scheduledAt, true) || 'زمان ثبت نشده',
            attrs: meeting.scheduledAt ? { datetime: meeting.scheduledAt } : {},
          }),
        ),
      );
      if (meeting.summary) card.append(element('p', { className: 'meeting-summary', text: meeting.summary }));
      if (meeting.quorumPercent) {
        card.append(progressSignal('حد نصاب حضور', meeting.quorumPercent, 'درصد تجمیعی مشارکت در جلسه', 'governance'));
      }
      if (meeting.resolutions.length) {
        const resolutions = element('div', { className: 'resolution-list' });
        meeting.resolutions.forEach((resolution) => {
          resolutions.append(element('section', { className: 'resolution-card' },
            element('div', { className: 'resolution-head' },
              element('h4', { text: resolution.title }),
              resolution.result ? element('span', {
                text: publicResolutionStatusLabels[resolution.result] || resolution.result,
              }) : null,
            ),
            element('dl', { className: 'vote-summary', attrs: { 'aria-label': 'وزن آرای تجمیعی' } },
              element('div', {}, element('dt', { text: 'وزن رأی موافق' }), element('dd', { text: faNumber(resolution.votesFor) })),
              element('div', {}, element('dt', { text: 'وزن رأی مخالف' }), element('dd', { text: faNumber(resolution.votesAgainst) })),
              element('div', {}, element('dt', { text: 'وزن رأی ممتنع' }), element('dd', { text: faNumber(resolution.abstentions) })),
            ),
          ));
        });
        card.append(resolutions);
      } else {
        card.append(element('p', { className: 'no-resolution', text: 'مصوبهٔ عمومی برای این جلسه ثبت نشده است.' }));
      }
      timeline.append(card);
    });
    section.append(timeline);
  } else {
    section.append(moduleEmpty('جلسهٔ عمومی ثبت نشده است', 'زمان‌بندی جلسه‌ها و نتیجهٔ مصوبات پس از انتشار در این بخش قرار می‌گیرد.'));
  }
  return section;
}

function renderProjectPage(data, selectedTab = state.route?.tab || 'overview') {
  const {
    project,
    summary,
    financial,
  } = data;
  const activeTab = Object.hasOwn(projectTabs, selectedTab) ? selectedTab : 'overview';
  document.title = `${project.title} | هم‌ساخت`;
  projectNavLink.href = '/projects';

  const hero = element('section', {
    className: 'project-hero project-record-hero',
    attrs: { 'aria-labelledby': 'project-title' },
  });
  const heroInner = element('div', { className: 'container hero-grid' });
  const intro = element('div', { className: 'hero-copy' },
    appLink('/projects', 'بازگشت به همهٔ پروژه‌ها', 'portfolio-back-link'),
    element('div', { className: 'project-title-row' },
      element('span', {
        className: `project-state ${project.active ? 'is-active' : 'is-inactive'}`,
        text: project.active ? 'پروژهٔ فعال' : 'پروژهٔ آرشیوی',
      }),
      element('span', { className: 'eyebrow', text: 'پروندهٔ عمومی پروژه' }),
    ),
    element('h1', { id: 'project-title', text: project.title }),
    element('p', { className: 'hero-lead', text: project.subtitle || project.description }),
  );
  const meta = element('ul', { className: 'project-meta', attrs: { 'aria-label': 'مشخصات پروژه' } });
  [
    metaItem('راهبر پروژه', project.leaderName),
    metaItem('موقعیت', project.location),
    metaItem('زمان‌بندی', project.timeline),
    metaItem('مهلت', formatDate(project.deadline)),
  ].filter(Boolean).forEach((item) => meta.append(item));
  if (meta.childElementCount) intro.append(meta);

  const statusPanel = element('aside', {
    className: 'project-signal-panel',
    attrs: { 'aria-label': 'شاخص‌های مستقل پروژه' },
  },
  element('div', { className: 'signal-panel-heading' },
    element('span', { text: 'وضعیت ثبت‌شده' }),
    data.updatedAt ? element('small', { text: formatDate(data.updatedAt, true) }) : null,
  ),
  progressSignal(
    'پیشرفت عملیاتی',
    summary.operationalProgress,
    'تحقق اهداف وزن‌دار',
    'operation',
  ),
  progressSignal(
    'تکمیل مشارکت',
    summary.completionPercent,
    `${faNumber(summary.committedNeeds)} نیاز پذیرفته‌شده از ${faNumber(summary.totalNeeds)}`,
    'participation',
  ),
  element('div', { className: 'financial-signal' },
    element('span', { text: 'عملکرد مالی' }),
    element('strong', { text: formatFinancialPercent(financial.roiPercent) }),
    element('small', { text: `بازده ${financial.periodLabel}؛ مستقل از دو شاخص بالا` }),
  ));

  heroInner.append(intro, statusPanel);
  hero.append(heroInner);

  const navigation = element('div', { className: 'project-tabs-shell' },
    element('div', { className: 'container' }, projectTabNavigation(project, activeTab)),
  );
  const content = element('div', { className: 'container project-tab-content' });
  const renderers = {
    overview: renderOverviewModule,
    needs: renderNeedsModule,
    capital: renderCapitalModule,
    performance: renderPerformanceModule,
    governance: renderGovernanceModule,
  };
  content.append(renderers[activeTab](data));
  replaceMain(hero, navigation, content, projectFooter(project.slug));
}

function breadcrumb(project, need) {
  const nav = element('nav', { className: 'breadcrumb', attrs: { 'aria-label': 'مسیر صفحه' } });
  nav.append(
    appLink(`/projects/${encodeURIComponent(project.slug)}`, project.title),
    element('span', { text: '←', attrs: { 'aria-hidden': 'true' } }),
    element('span', { text: need.title, attrs: { 'aria-current': 'page' } }),
  );
  return nav;
}

function formControl({ id, label, required = false, hint = '', control }) {
  const labelNode = element('label', { className: 'field-label', attrs: { for: id } },
    label,
    required ? element('span', { className: 'required-mark', text: ' (الزامی)' }) : null,
  );
  const wrapper = element('div', { className: 'form-field', dataset: { field: id } }, labelNode);
  if (hint) wrapper.append(element('p', { className: 'field-hint', text: hint, id: `${id}-hint` }));
  wrapper.append(control);
  wrapper.append(element('p', {
    className: 'field-error',
    id: `${id}-error`,
    attrs: { 'aria-live': 'polite' },
  }));
  return wrapper;
}

function proposalForm(need, project) {
  const form = element('form', {
    className: 'proposal-form',
    id: 'proposal-form',
    attrs: { novalidate: true },
    dataset: {
      needId: need.id,
      projectSlug: project.slug,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  form.append(
    element('div', { className: 'form-heading' },
      element('span', { className: 'eyebrow', text: 'پیشنهاد همکاری' }),
      element('h2', { text: 'ظرفیت خود را روشن ثبت کنید' }),
      element('p', { text: 'اطلاعات تماس و متن پیشنهاد عمومی نمی‌شود و فقط مدیر پروژه به آن دسترسی دارد.' }),
    ),
    element('div', {
      className: 'form-error-summary',
      id: 'form-error-summary',
      attrs: { role: 'alert', tabindex: '-1', hidden: true },
    }),
  );

  const applicantName = element('input', {
    id: 'applicantName',
    attrs: {
      name: 'applicantName',
      type: 'text',
      autocomplete: 'name',
      minlength: '2',
      maxlength: '120',
      required: true,
      'aria-describedby': 'applicantName-error',
    },
  });
  const mobile = element('input', {
    id: 'mobile',
    attrs: {
      name: 'mobile',
      type: 'tel',
      inputmode: 'tel',
      autocomplete: 'tel',
      dir: 'ltr',
      placeholder: '09123456789',
      maxlength: '20',
      required: true,
      'aria-describedby': 'mobile-hint mobile-error',
    },
  });
  const email = element('input', {
    id: 'email',
    attrs: {
      name: 'email',
      type: 'email',
      inputmode: 'email',
      autocomplete: 'email',
      dir: 'ltr',
      maxlength: '254',
      placeholder: 'name@example.com',
      'aria-describedby': 'email-error',
    },
  });
  const contribution = element('textarea', {
    id: 'contribution',
    attrs: {
      name: 'contribution',
      rows: '5',
      minlength: '20',
      maxlength: '1000',
      required: true,
      placeholder: 'چه ظرفیت، تخصص، کالا یا سرمایه‌ای فراهم می‌کنید؟',
      'aria-describedby': 'contribution-hint contribution-error',
    },
  });
  const availability = element('select', {
    id: 'availability',
    attrs: {
      name: 'availability',
      'aria-describedby': 'availability-error',
    },
  });
  [
    ['', 'هنوز مشخص نیست'],
    ['immediate', 'همین حالا'],
    ['within_2_weeks', 'تا دو هفتهٔ آینده'],
    ['within_1_month', 'تا یک ماه آینده'],
    ['planned', 'نیازمند هماهنگی بیشتر'],
  ].forEach(([value, label], index) => {
    availability.append(element('option', {
      text: label,
      attrs: { value, selected: index === 0 },
    }));
  });
  const notes = element('textarea', {
    id: 'notes',
    attrs: {
      name: 'notes',
      rows: '3',
      maxlength: '1000',
      placeholder: 'شرایط، محدودیت یا نکتهٔ تکمیلی (اختیاری)',
      'aria-describedby': 'notes-error',
    },
  });
  const website = element('input', {
    id: 'website',
    attrs: {
      name: 'website',
      type: 'text',
      tabindex: '-1',
      autocomplete: 'off',
      'aria-hidden': 'true',
    },
  });

  form.append(
    formControl({ id: 'applicantName', label: 'نام فرد یا مجموعه', required: true, control: applicantName }),
    formControl({
      id: 'mobile',
      label: 'شماره موبایل',
      required: true,
      hint: 'برای هماهنگی مدیر پروژه؛ نمونه: ۰۹۱۲۳۴۵۶۷۸۹',
      control: mobile,
    }),
    formControl({ id: 'email', label: 'ایمیل', control: email }),
    formControl({
      id: 'contribution',
      label: 'شرح دقیق آورده یا ظرفیت',
      required: true,
      hint: 'مقدار، محدوده مسئولیت و شرایط پیشنهادی را بنویسید.',
      control: contribution,
    }),
    formControl({ id: 'availability', label: 'زمان آمادگی', control: availability }),
    formControl({ id: 'notes', label: 'توضیحات تکمیلی', control: notes }),
    element('div', { className: 'honeypot', attrs: { 'aria-hidden': 'true' } }, website),
  );

  const consent = element('input', {
    id: 'consent',
    attrs: {
      name: 'consent',
      type: 'checkbox',
      required: true,
      'aria-describedby': 'consent-error',
    },
  });
  form.append(
    element('div', { className: 'form-field consent-field', dataset: { field: 'consent' } },
      element('label', { attrs: { for: 'consent' } },
        consent,
        element('span', { text: 'با تماس تیم پروژه برای بررسی این پیشنهاد موافقم.' }),
      ),
      element('p', { className: 'field-error', id: 'consent-error', attrs: { 'aria-live': 'polite' } }),
    ),
    element('button', {
      className: 'button button-primary submit-button',
      text: 'ثبت پیشنهاد برای بررسی',
      attrs: { type: 'submit' },
    }),
    element('p', { className: 'form-footnote', text: 'پس از ثبت، کد و لینک امن پیگیری را دریافت می‌کنید.' }),
  );
  return form;
}

function renderNeedDetail(data, need) {
  const { project } = data;
  document.title = `${need.title} | ${project.title}`;
  projectNavLink.href = `/projects/${encodeURIComponent(project.slug)}`;

  const page = element('div', { className: 'need-page' });
  const inner = element('div', { className: 'container' });
  inner.append(breadcrumb(project, need));

  const layout = element('div', { className: 'need-layout' });
  const content = element('article', {
    className: 'need-detail',
    attrs: { 'aria-labelledby': 'need-title' },
  });
  content.append(
    element('header', { className: 'need-detail-header' },
      element('div', { className: 'need-detail-kicker' },
        element('span', { className: 'need-category', text: need.category }),
        statusBadge(need.statusKey, need.id),
      ),
      element('h1', { id: 'need-title', text: need.title }),
      element('p', { className: 'need-detail-lead', text: need.description }),
    ),
  );
  if (need.targetValue) {
    content.append(element('section', { className: 'detail-block', attrs: { 'aria-labelledby': 'need-target-title' } },
      element('span', { className: 'detail-block-label', text: 'هدف این نیاز', id: 'need-target-title' }),
      element('strong', { className: 'need-target-value', text: need.targetValue }),
    ));
  }
  if (need.expectations) {
    content.append(element('section', {
      className: 'detail-block',
      attrs: { 'aria-labelledby': 'need-expectations-title' },
    },
    element('span', {
      className: 'detail-block-label',
      text: 'انتظار پروژه از همکار',
      id: 'need-expectations-title',
    }),
    element('p', { className: 'preserve-lines', text: need.expectations })));
  }
  content.append(
    element('section', { className: 'detail-block', attrs: { 'aria-labelledby': 'need-status-title' } },
      element('span', { className: 'detail-block-label', text: 'وضعیت فعلی', id: 'need-status-title' }),
      element('p', {
        text: needStatuses[need.statusKey].description,
        dataset: { needStatusDescription: need.id },
      }),
    ),
    element('section', { className: 'detail-block', attrs: { 'aria-labelledby': 'engagement-title' } },
      element('div', { className: 'detail-block-heading' },
        element('span', { className: 'detail-block-label', text: 'تعامل‌های ثبت‌شده', id: 'engagement-title' }),
        element('small', { text: 'این اعداد روی درصد پیشرفت اثر ندارند.' }),
      ),
      element('div', { className: 'detail-stats' },
        statItem('دنبال‌کننده', need.stats.followers, 'followers', need.id),
        statItem('اعلام آمادگی', need.stats.interests, 'interests', need.id),
        statItem('پیشنهاد رسیده', need.stats.proposals, 'proposals', need.id),
      ),
      element('div', { className: 'detail-viewer-actions' },
        viewerButton(need, 'following'),
        viewerButton(need, 'interested'),
      ),
    ),
    element('section', { className: 'detail-guidance', attrs: { 'aria-labelledby': 'proposal-guidance-title' } },
      element('h2', { id: 'proposal-guidance-title', text: 'چه پیشنهادی بررسی سریع‌تری دارد؟' }),
      element('ul', {},
        element('li', { text: 'ظرفیت یا آوردهٔ دقیق و قابل اندازه‌گیری' }),
        element('li', { text: 'زمان آمادگی و محدودیت‌های اجرایی روشن' }),
        element('li', { text: 'راه تماس درست برای هماهنگی بعدی' }),
      ),
    ),
  );

  const aside = element('aside', { className: 'proposal-aside', id: 'proposal-panel' }, proposalForm(need, project));
  layout.append(content, aside);
  inner.append(layout);
  page.append(inner);
  replaceMain(page, projectFooter(project.slug));
}

function normalizeMobile(value) {
  let mobile = toEnglishDigits(value).replace(/[\s\-()]/g, '');
  if (mobile.startsWith('0098')) mobile = `0${mobile.slice(4)}`;
  else if (mobile.startsWith('+98')) mobile = `0${mobile.slice(3)}`;
  else if (mobile.startsWith('98')) mobile = `0${mobile.slice(2)}`;
  else if (mobile.startsWith('9')) mobile = `0${mobile}`;
  return mobile;
}

function validateProposalForm(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const errors = {};
  const applicantName = String(values.applicantName || '').trim();
  const mobile = normalizeMobile(values.mobile || '');
  const email = String(values.email || '').trim();
  const contribution = String(values.contribution || '').trim();
  const availability = String(values.availability || '');
  const notes = String(values.notes || '').trim();
  const website = String(values.website || '');
  const consent = form.elements.consent.checked;

  if (applicantName.length < 2) errors.applicantName = 'نام فرد یا مجموعه را وارد کنید.';
  if (!/^09\d{9}$/.test(mobile)) errors.mobile = 'شماره موبایل معتبر ایران وارد کنید؛ مانند ۰۹۱۲۳۴۵۶۷۸۹.';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'ساختار ایمیل درست نیست.';
  if (contribution.length < 20) errors.contribution = 'پیشنهاد را کمی دقیق‌تر و حداقل در ۲۰ نویسه توضیح دهید.';
  if (contribution.length > 1000) errors.contribution = 'شرح پیشنهاد نباید بیشتر از ۱۰۰۰ نویسه باشد.';
  if (notes.length > 1000) errors.notes = 'توضیحات تکمیلی نباید بیشتر از ۱۰۰۰ نویسه باشد.';
  if (!consent) errors.consent = 'برای ادامه، رضایت تماس را تأیید کنید.';

  return {
    values: { applicantName, mobile, email, contribution, availability, notes, consent, website },
    errors,
  };
}

function clearFormErrors(form) {
  form.querySelectorAll('.form-field').forEach((field) => field.classList.remove('has-error'));
  form.querySelectorAll('.field-error').forEach((error) => error.replaceChildren());
  form.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute('aria-invalid'));
  const summary = form.querySelector('#form-error-summary');
  summary.hidden = true;
  summary.replaceChildren();
}

function showFormErrors(form, errors, message = 'لطفاً موارد مشخص‌شده را اصلاح کنید.') {
  clearFormErrors(form);
  Object.entries(errors || {}).forEach(([fieldName, errorMessage]) => {
    const normalizedName = fieldName === 'applicant_name' ? 'applicantName' : fieldName;
    const control = form.elements[normalizedName];
    const wrapper = form.querySelector(`[data-field="${normalizedName}"]`);
    const error = form.querySelector(`#${normalizedName}-error`);
    if (control) control.setAttribute('aria-invalid', 'true');
    wrapper?.classList.add('has-error');
    if (error) error.textContent = String(errorMessage);
  });
  const summary = form.querySelector('#form-error-summary');
  summary.append(
    element('strong', { text: 'ثبت پیشنهاد کامل نشد' }),
    element('p', { text: message }),
  );
  summary.hidden = false;
  summary.focus();
}

function trackingRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRACKING_STORAGE_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((record) => record && record.token && record.id)
      : [];
  } catch {
    return [];
  }
}

function saveTrackingRecords(records) {
  localStorage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(records.slice(0, 50)));
  updateTrackingCount();
}

function importTrackingTokenFromLocation() {
  if (window.location.pathname.replace(/\/+$/, '') !== '/my-proposals') return;
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = firstValue(hashParams.get('token'), '');
  if (!token) {
    if (new URLSearchParams(window.location.search).has('token')) {
      window.history.replaceState({}, '', '/my-proposals');
    }
    return;
  }

  if (/^[A-Za-z0-9_-]{16,512}$/.test(token)) {
    const records = trackingRecords();
    if (!records.some((record) => record.token === token)) {
      records.unshift({
        id: crypto.randomUUID(),
        token,
        referenceCode: '',
        trackingUrl: `${window.location.origin}/my-proposals#token=${encodeURIComponent(token)}`,
        projectSlug: '',
        projectTitle: '',
        needId: '',
        needTitle: '',
        createdAt: new Date().toISOString(),
      });
      saveTrackingRecords(records);
    }
  }

  window.history.replaceState({}, '', '/my-proposals');
}

function extractTrackingToken(trackingUrl) {
  if (!trackingUrl) return '';
  try {
    const url = new URL(trackingUrl, window.location.origin);
    return new URLSearchParams(url.hash.replace(/^#/, '')).get('token') || '';
  } catch {
    return '';
  }
}

function storeTrackingResult(result, context) {
  const proposal = result?.proposal || {};
  const tracking = result?.tracking || {};
  const trackingUrl = firstValue(
    result?.trackingUrl,
    result?.tracking_url,
    tracking.url,
    proposal.trackingUrl,
    proposal.tracking_url,
    '',
  );
  const token = firstValue(
    result?.trackingToken,
    result?.tracking_token,
    result?.token,
    tracking.token,
    proposal.trackingToken,
    proposal.tracking_token,
    extractTrackingToken(trackingUrl),
    '',
  );
  const referenceCode = firstValue(
    result?.referenceCode,
    result?.reference_code,
    proposal.referenceCode,
    proposal.reference_code,
    proposal.id,
    '',
  );
  const finalTrackingUrl = trackingUrl || (token
    ? `${window.location.origin}/my-proposals#token=${encodeURIComponent(token)}`
    : '');

  if (token) {
    const records = trackingRecords();
    const existingIndex = records.findIndex((record) => record.token === token);
    const record = {
      id: existingIndex >= 0 ? records[existingIndex].id : crypto.randomUUID(),
      token,
      referenceCode,
      trackingUrl: finalTrackingUrl,
      projectSlug: context.projectSlug,
      projectTitle: context.projectTitle,
      needId: context.needId,
      needTitle: context.needTitle,
      createdAt: new Date().toISOString(),
    };
    if (existingIndex >= 0) records.splice(existingIndex, 1);
    records.unshift(record);
    saveTrackingRecords(records);
  }
  return { token, referenceCode, trackingUrl: finalTrackingUrl };
}

function renderProposalSuccess(result, context) {
  const { token, referenceCode, trackingUrl } = storeTrackingResult(result, context);
  const panel = element('div', {
    className: 'proposal-success',
    attrs: { role: 'status', tabindex: '-1' },
  });
  panel.append(
    element('div', { className: 'success-mark', text: '✓', attrs: { 'aria-hidden': 'true' } }),
    element('span', { className: 'eyebrow', text: 'پیشنهاد ثبت شد' }),
    element('h2', { text: 'از اینجا به بعد قابل پیگیری است' }),
    element('p', { text: 'مدیر پروژه پیشنهاد را بررسی می‌کند و هر تغییر وضعیت در بخش پیگیری‌های من نمایش داده می‌شود.' }),
  );
  if (referenceCode) {
    panel.append(element('div', { className: 'reference-code' },
      element('span', { text: 'کد پیگیری' }),
      element('strong', { text: referenceCode, attrs: { dir: 'ltr' } }),
    ));
  }
  if (trackingUrl) {
    panel.append(element('div', { className: 'tracking-link-box' },
      element('span', { text: 'لینک امن پیگیری' }),
      element('code', { text: trackingUrl, attrs: { dir: 'ltr' } }),
      element('button', {
        className: 'button button-tertiary',
        text: 'کپی لینک',
        attrs: { type: 'button' },
        dataset: { action: 'copy-link', copyValue: trackingUrl },
      }),
    ));
  }
  panel.append(
    appLink('/my-proposals', 'مشاهده پیگیری‌های من', 'button button-primary'),
    element('p', {
      className: 'security-note',
      text: token
        ? 'این لینک در همین مرورگر ذخیره شد. آن را در اختیار افراد ناشناس نگذارید.'
        : 'کد پیگیری را نزد خود نگه دارید؛ سرور لینک جداگانه‌ای برنگرداند.',
    }),
  );
  document.querySelector('#proposal-panel')?.replaceChildren(panel);
  panel.focus();
}

async function submitProposal(form) {
  if (form.dataset.submitting === 'true') return;
  const { values, errors } = validateProposalForm(form);
  if (Object.keys(errors).length) {
    showFormErrors(form, errors);
    return;
  }
  clearFormErrors(form);

  const submitButton = form.querySelector('[type="submit"]');
  const originalText = submitButton.textContent;
  form.dataset.submitting = 'true';
  form.setAttribute('aria-busy', 'true');
  submitButton.disabled = true;
  submitButton.textContent = 'در حال ثبت…';

  try {
    const result = await apiRequest(`/api/v1/needs/${encodeURIComponent(form.dataset.needId)}/proposals`, {
      method: 'POST',
      headers: { 'Idempotency-Key': form.dataset.idempotencyKey },
      body: JSON.stringify(values),
    });
    const project = state.projectData?.project || {};
    const need = state.projectData?.needs.find((item) => item.id === form.dataset.needId) || {};
    renderProposalSuccess(result, {
      projectSlug: project.slug || form.dataset.projectSlug,
      projectTitle: project.title || '',
      needId: need.id || form.dataset.needId,
      needTitle: need.title || '',
    });
    showToast('پیشنهاد شما با موفقیت ثبت شد.');
  } catch (error) {
    const serverFields = error.fields && typeof error.fields === 'object' ? error.fields : {};
    showFormErrors(form, serverFields, error.message);
    if (error.status > 0 && error.status < 500) form.dataset.idempotencyKey = crypto.randomUUID();
  } finally {
    form.dataset.submitting = 'false';
    form.removeAttribute('aria-busy');
    submitButton.disabled = false;
    submitButton.textContent = originalText;
  }
}

function normalizeTrackedProposal(raw, record) {
  const proposal = raw?.proposal || raw || {};
  const need = raw?.need || proposal.need || {};
  const project = raw?.project || proposal.project || {};
  const statusKey = safeStatus(
    firstValue(proposal.statusKey, proposal.status_key, proposal.status),
    proposalStatuses,
    'new',
  );
  return {
    statusKey,
    referenceCode: firstValue(proposal.referenceCode, proposal.reference_code, record.referenceCode, ''),
    needTitle: firstValue(need.title, proposal.needTitle, proposal.need_title, record.needTitle, 'پیشنهاد همکاری'),
    projectTitle: firstValue(project.title, proposal.projectTitle, proposal.project_title, record.projectTitle, ''),
    updatedAt: firstValue(proposal.updatedAt, proposal.updated_at, raw?.updatedAt, raw?.updated_at, ''),
    decisionMessage: firstValue(
      proposal.decisionMessage,
      proposal.decision_message,
      proposal.publicMessage,
      proposal.public_message,
      raw?.decisionMessage,
      raw?.decision_message,
      '',
    ),
  };
}

function trackingStatusBadge(statusKey) {
  return element('span', {
    className: `status-badge proposal-status status-${statusKey}`,
    text: proposalStatuses[statusKey]?.label || proposalStatuses.new.label,
  });
}

function trackingCardSkeleton(record) {
  return element('article', {
    className: 'tracking-card is-loading',
    attrs: { 'aria-busy': 'true', 'aria-label': `در حال دریافت وضعیت ${record.needTitle || 'پیشنهاد'}` },
    dataset: { trackingId: record.id },
  },
  element('div', { className: 'skeleton skeleton-line skeleton-short' }),
  element('div', { className: 'skeleton skeleton-line' }),
  element('div', { className: 'skeleton skeleton-line' }));
}

function renderTrackingCard(card, record, data) {
  const proposal = normalizeTrackedProposal(data, record);
  card.className = `tracking-card tracking-${proposal.statusKey}`;
  card.removeAttribute('aria-busy');
  card.removeAttribute('aria-label');
  const header = element('div', { className: 'tracking-card-header' },
    trackingStatusBadge(proposal.statusKey),
    proposal.referenceCode
      ? element('span', { className: 'tracking-reference', text: `کد ${proposal.referenceCode}`, attrs: { dir: 'ltr' } })
      : null,
  );
  card.replaceChildren(
    header,
    element('div', { className: 'tracking-card-body' },
      element('span', { className: 'tracking-project', text: proposal.projectTitle }),
      element('h2', { text: proposal.needTitle }),
      element('p', { text: proposalStatuses[proposal.statusKey]?.description }),
      proposal.decisionMessage
        ? element('div', { className: 'decision-message' },
          element('strong', { text: 'پیام مدیر پروژه' }),
          element('p', { text: proposal.decisionMessage }),
        )
        : null,
    ),
    element('footer', { className: 'tracking-card-footer' },
      element('span', {
        text: proposal.updatedAt ? `آخرین تغییر: ${formatDate(proposal.updatedAt, true)}` : 'در انتظار به‌روزرسانی',
      }),
      element('button', {
        className: 'text-button danger-text',
        text: 'حذف لینک از این مرورگر',
        attrs: { type: 'button' },
        dataset: { action: 'remove-tracking', trackingId: record.id },
      }),
    ),
  );
}

function renderTrackingCardError(card, record, error) {
  card.className = 'tracking-card has-error';
  card.removeAttribute('aria-busy');
  card.removeAttribute('aria-label');
  card.replaceChildren(
    element('span', { className: 'eyebrow error-text', text: 'دریافت وضعیت ناموفق بود' }),
    element('h2', { text: record.needTitle || 'پیشنهاد ذخیره‌شده' }),
    element('p', { text: error.status === 404 ? 'این لینک معتبر نیست یا منقضی شده است.' : error.message }),
    element('div', { className: 'tracking-error-actions' },
      element('button', {
        className: 'button button-secondary',
        text: 'تلاش دوباره',
        attrs: { type: 'button' },
        dataset: { action: 'retry-tracking', trackingId: record.id },
      }),
      element('button', {
        className: 'text-button danger-text',
        text: 'حذف از مرورگر',
        attrs: { type: 'button' },
        dataset: { action: 'remove-tracking', trackingId: record.id },
      }),
    ),
  );
}

async function loadTrackingCard(record, card, runId) {
  card.classList.add('is-loading');
  try {
    const data = await apiRequest('/api/v1/proposals/track', {
      headers: { Authorization: `Bearer ${record.token}` },
    });
    if (state.routeRunId !== runId || !card.isConnected) return;
    renderTrackingCard(card, record, data);
  } catch (error) {
    if (state.routeRunId !== runId || !card.isConnected) return;
    renderTrackingCardError(card, record, error);
  }
}

function renderTrackingPage() {
  document.title = 'پیگیری‌های من | هم‌ساخت';
  const runId = state.routeRunId;
  importTrackingTokenFromLocation();
  const records = trackingRecords();
  const page = element('div', { className: 'tracking-page' });
  const inner = element('div', { className: 'container' });
  inner.append(
    element('header', { className: 'page-heading' },
      element('span', { className: 'eyebrow', text: 'پیگیری امن' }),
      element('h1', { text: 'پیشنهادهای من' }),
      element('p', { text: 'وضعیت پیشنهادهایی که در این مرورگر ثبت کرده‌اید، بدون نمایش عمومی اطلاعات تماس.' }),
    ),
  );

  if (!records.length) {
    inner.append(element('section', { className: 'empty-panel tracking-empty' },
      element('div', { className: 'empty-mark', attrs: { 'aria-hidden': 'true' } }),
      element('h2', { text: 'هنوز پیشنهادی در این مرورگر ندارید' }),
      element('p', { text: 'بعد از ثبت پیشنهاد، لینک امن پیگیری به‌صورت خودکار اینجا ذخیره می‌شود.' }),
      appLink(projectNavLink.getAttribute('href') || '/', 'مشاهده نیازهای پروژه', 'button button-primary'),
    ));
  } else {
    inner.append(
      element('div', { className: 'tracking-toolbar' },
        element('p', { text: `${faNumber(records.length)} لینک پیگیری در این مرورگر ذخیره شده است.` }),
        element('button', {
          className: 'button button-secondary',
          text: 'به‌روزرسانی همه',
          attrs: { type: 'button' },
          dataset: { action: 'retry-all-tracking' },
        }),
      ),
    );
    const grid = element('div', { className: 'tracking-grid', id: 'tracking-grid' });
    records.forEach((record) => {
      const card = trackingCardSkeleton(record);
      grid.append(card);
      loadTrackingCard(record, card, runId);
    });
    inner.append(grid);
  }
  page.append(inner);
  replaceMain(
    page,
    projectFooter(state.projectData?.project.slug || records[0]?.projectSlug || ''),
  );
}

function updateTrackingCount() {
  const count = trackingRecords().length;
  trackingCount.hidden = count === 0;
  trackingCount.textContent = count ? faNumber(count) : '';
  trackingCount.setAttribute('aria-label', `${faNumber(count)} پیشنهاد ذخیره‌شده`);
}

function findNeed(needId) {
  return state.projectData?.needs.find((need) => String(need.id) === String(needId));
}

function setViewerButtonState(button, need, action) {
  const pressed = Boolean(need.viewerState[action]);
  const text = action === 'following'
    ? (pressed ? 'دنبال می‌کنم' : 'دنبال کردن')
    : (pressed ? 'آمادگی ثبت شد' : 'اعلام آمادگی');
  button.textContent = text;
  button.classList.toggle('is-active', pressed);
  button.setAttribute('aria-pressed', String(pressed));
  button.setAttribute('aria-label', `${text} برای «${need.title}»`);
  button.disabled = state.viewerRequests.has(need.id);
}

function patchNeedState(need) {
  document.querySelectorAll(`[data-need-status-id="${CSS.escape(need.id)}"]`).forEach((badge) => {
    badge.className = `status-badge status-${need.statusKey}`;
    badge.textContent = needStatuses[need.statusKey].label;
  });
  document.querySelectorAll(`[data-need-status-description="${CSS.escape(need.id)}"]`).forEach((description) => {
    description.textContent = needStatuses[need.statusKey].description;
  });
  document.querySelectorAll(`[data-need-stat-id="${CSS.escape(need.id)}"]`).forEach((stat) => {
    stat.textContent = faNumber(need.stats[stat.dataset.statKey]);
  });
  document.querySelectorAll(`[data-viewer-action][data-need-id="${CSS.escape(need.id)}"]`).forEach((button) => {
    setViewerButtonState(button, need, button.dataset.viewerAction);
  });
}

function patchSummary(summary) {
  const values = {
    totalNeeds: summary.totalNeeds,
    committedNeeds: summary.committedNeeds,
    activeDiscussions: summary.underReviewNeeds + summary.negotiatingNeeds,
    totalProposals: summary.totalProposals,
  };
  Object.entries(values).forEach(([key, value]) => {
    document.querySelectorAll(`[data-summary-value="${key}"]`).forEach((node) => {
      node.textContent = faNumber(value);
    });
  });
  document.querySelectorAll('[data-summary-percent]').forEach((node) => {
    node.textContent = formatPercent(summary.completionPercent);
  });
  document.querySelectorAll('[data-summary-sentence]').forEach((node) => {
    node.textContent = `${faNumber(summary.committedNeeds)} نیاز از ${faNumber(summary.totalNeeds)} نیاز فعال، همکار قطعی دارد.`;
  });
  document.querySelectorAll('[data-summary-progress]').forEach((progress) => {
    progress.value = Math.max(0, Math.min(100, summary.completionPercent));
    progress.setAttribute('aria-label', `پیشرفت پروژه ${formatPercent(summary.completionPercent)}`);
  });
}

function mergeNeedFromResponse(currentNeed, response) {
  const rawNeed = response?.need || response;
  const normalized = rawNeed?.id
    ? normalizeNeed(rawNeed, response?.viewerState)
    : null;
  if (normalized) {
    return {
      ...currentNeed,
      ...normalized,
      viewerState: {
        ...currentNeed.viewerState,
        ...normalized.viewerState,
        ...(response?.viewerState || {}),
      },
    };
  }
  return {
    ...currentNeed,
    viewerState: {
      ...currentNeed.viewerState,
      ...(response?.viewerState || response?.viewer_state || {}),
    },
  };
}

async function toggleViewerState(needId, action) {
  const need = findNeed(needId);
  if (!need || state.viewerRequests.has(need.id)) return;
  const previous = structuredClone(need);
  const nextPressed = !need.viewerState[action];
  need.viewerState[action] = nextPressed;
  const statKey = action === 'following' ? 'followers' : 'interests';
  need.stats[statKey] = Math.max(0, need.stats[statKey] + (nextPressed ? 1 : -1));
  state.viewerRequests.add(need.id);
  patchNeedState(need);

  try {
    const response = await apiRequest(`/api/v1/needs/${encodeURIComponent(need.id)}/viewer-state`, {
      method: 'PUT',
      body: JSON.stringify({
        following: need.viewerState.following,
        interested: need.viewerState.interested,
      }),
    });
    const merged = mergeNeedFromResponse(need, response);
    const index = state.projectData.needs.findIndex((item) => item.id === need.id);
    state.projectData.needs[index] = merged;
    patchNeedState(merged);
    showToast(action === 'following'
      ? (nextPressed ? 'این نیاز به فهرست دنبال‌شده‌ها اضافه شد.' : 'این نیاز دیگر دنبال نمی‌شود.')
      : (nextPressed ? 'آمادگی شما ثبت شد.' : 'اعلام آمادگی برداشته شد.'));
  } catch (error) {
    const index = state.projectData.needs.findIndex((item) => item.id === need.id);
    state.projectData.needs[index] = previous;
    patchNeedState(previous);
    showToast(error.message, true);
  } finally {
    state.viewerRequests.delete(need.id);
    patchNeedState(findNeed(need.id));
  }
}

function showToast(message, isError = false) {
  const toast = element('div', {
    className: `toast ${isError ? 'toast-error' : ''}`,
    text: message,
    attrs: { role: isError ? 'alert' : 'status' },
  });
  toastRegion.append(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  window.setTimeout(() => {
    toast.classList.remove('is-visible');
    window.setTimeout(() => toast.remove(), 200);
  }, 4_000);
}

function stopRealtime() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.realtimeRefreshTimer) {
    window.clearTimeout(state.realtimeRefreshTimer);
    state.realtimeRefreshTimer = null;
  }
  liveIndicator.hidden = true;
}

function startPolling(slug) {
  if (state.pollTimer) return;
  state.pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) refreshProject(slug);
  }, PROJECT_REFRESH_INTERVAL);
}

function scheduleRealtimeRefresh(slug) {
  if (state.realtimeRefreshTimer) return;
  state.realtimeRefreshTimer = window.setTimeout(() => {
    state.realtimeRefreshTimer = null;
    refreshProject(slug);
  }, 300);
}

function leaveUnavailableProject(slug, movedTo = '') {
  if (state.route?.slug !== slug) return;
  state.projectCache.delete(slug);
  state.projectData = null;
  stopRealtime();
  navigate(movedTo ? `/projects/${encodeURIComponent(movedTo)}` : '/', { replace: true });
  showToast(movedTo ? 'آدرس پروژه به‌روز شد.' : 'این پروژه دیگر در صفحهٔ عمومی منتشر نیست.');
}

function connectRealtime(slug) {
  stopRealtime();
  if (!('EventSource' in window) || !navigator.onLine) {
    startPolling(slug);
    return;
  }
  const source = new EventSource(`/api/v1/projects/${encodeURIComponent(slug)}/events`, { withCredentials: true });
  state.eventSource = source;
  source.addEventListener('open', () => {
    if (state.eventSource !== source) return;
    liveIndicator.hidden = false;
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  });
  source.addEventListener('error', () => {
    if (state.eventSource !== source) return;
    liveIndicator.hidden = true;
    startPolling(slug);
  });
  const onUpdate = (event) => {
    if (state.eventSource !== source) return;
    try {
      const payload = JSON.parse(event.data);
      if (payload?.movedTo || payload?.unavailable) {
        leaveUnavailableProject(slug, payload.movedTo);
        return;
      }
      if (payload?.project && Array.isArray(payload?.needs)) {
        applyProjectUpdate(normalizeProjectPayload(payload, slug));
        return;
      }
    } catch {
    }
    scheduleRealtimeRefresh(slug);
  };
  source.addEventListener('message', onUpdate);
  ['project', 'need', 'proposal', 'update'].forEach((eventName) => source.addEventListener(eventName, onUpdate));
}

function applyProjectUpdate(nextData) {
  if (!state.projectData || projectFingerprint(nextData) === projectFingerprint(state.projectData)) return;
  state.projectData = nextData;
  state.projectCache.set(nextData.project.slug, nextData);
  if (state.route.type === 'project') {
    renderProjectPage(nextData, state.route.tab);
  } else if (state.route.type === 'need') {
    const need = nextData.needs.find((item) => item.id === state.route.needId);
    if (need) {
      patchNeedState(need);
      patchSummary(nextData.summary);
    }
  }
}

async function refreshProject(slug) {
  if (!slug || state.route?.slug !== slug) return;
  try {
    const payload = await apiRequest(`/api/v1/projects/${encodeURIComponent(slug)}`);
    if (state.route?.slug !== slug) return;
    applyProjectUpdate(normalizeProjectPayload(payload, slug));
  } catch (error) {
    if (error.status === 404) {
      leaveUnavailableProject(slug);
      return;
    }
  }
}

async function loadProjectRoute(route, runId, focusMain) {
  const cached = state.projectCache.get(route.slug)
    || (state.projectData?.project.slug === route.slug ? state.projectData : null);
  if (cached) {
    state.projectData = cached;
    if (route.type === 'need') {
      const cachedNeed = cached.needs.find((need) => need.id === route.needId);
      if (cachedNeed) renderNeedDetail(cached, cachedNeed);
      else renderNotFound();
    } else {
      renderProjectPage(cached, route.tab);
    }
    if (focusMain) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      main.focus({ preventScroll: true });
    }
    connectRealtime(route.slug);
    refreshProject(route.slug);
    return;
  }

  renderLoading(route.type);
  state.requestController = new AbortController();
  try {
    const payload = await apiRequest(`/api/v1/projects/${encodeURIComponent(route.slug)}`, {
      signal: state.requestController.signal,
    });
    if (state.routeRunId !== runId) return;
    const data = normalizeProjectPayload(payload, route.slug || DEFAULT_PROJECT_SLUG);
    route.slug = data.project.slug;
    state.projectData = data;
    state.projectCache.set(data.project.slug, data);
    projectNavLink.href = '/projects';

    if (route.type === 'need') {
      const need = data.needs.find((item) => item.id === route.needId);
      if (need) renderNeedDetail(data, need);
      else renderNotFound();
    } else {
      renderProjectPage(data, route.tab);
    }
    connectRealtime(data.project.slug);
  } catch (error) {
    if (error.name === 'AbortError' || state.routeRunId !== runId) return;
    renderRouteError(error);
  }
  if (focusMain) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    main.focus({ preventScroll: true });
  }
}

function portfolioFromProject(data) {
  return {
    projects: [data],
    summary: {
      projectCount: 1,
      activeNeeds: data.summary.totalNeeds,
      committedNeeds: data.summary.committedNeeds,
      raisedCapital: data.capital.raisedCapital,
      capitalUnit: data.capital.unit,
    },
    updatedAt: data.updatedAt,
  };
}

async function loadPortfolioRoute(runId, focusMain) {
  renderLoading('portfolio');
  state.requestController = new AbortController();
  try {
    let data;
    try {
      const payload = await apiRequest('/api/v1/projects', {
        signal: state.requestController.signal,
      });
      data = normalizePortfolioPayload(payload);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.status !== 404) throw error;
      const compatibilityPayload = await apiRequest('/api/v1/projects/current', {
        signal: state.requestController.signal,
      });
      data = portfolioFromProject(normalizeProjectPayload(
        compatibilityPayload,
        DEFAULT_PROJECT_SLUG,
      ));
    }
    if (state.routeRunId !== runId) return;
    state.portfolioData = data;
    data.projects.forEach((projectData) => {
      state.projectCache.set(projectData.project.slug, projectData);
    });
    renderPortfolioPage(data);
  } catch (error) {
    if (error.name === 'AbortError' || state.routeRunId !== runId) return;
    renderRouteError(error);
  }
  if (focusMain) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    main.focus({ preventScroll: true });
  }
}

function renderCurrentRoute({ focusMain = false } = {}) {
  const route = parseRoute();
  state.route = route;
  state.routeRunId += 1;
  const runId = state.routeRunId;
  state.requestController?.abort();
  state.requestController = null;
  stopRealtime();
  setActiveNavigation(route);

  if (route.type === 'not-found') {
    renderNotFound();
  } else if (route.type === 'tracking') {
    renderTrackingPage();
  } else if (route.type === 'portfolio') {
    loadPortfolioRoute(runId, focusMain);
    return;
  } else {
    loadProjectRoute(route, runId, focusMain);
    return;
  }
  if (focusMain) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    main.focus({ preventScroll: true });
  }
}

async function retryTrackingCard(button) {
  const record = trackingRecords().find((item) => item.id === button.dataset.trackingId);
  const card = button.closest('.tracking-card');
  if (!record || !card) return;
  card.replaceWith(trackingCardSkeleton(record));
  const replacement = document.querySelector(`[data-tracking-id="${CSS.escape(record.id)}"]`);
  if (replacement) loadTrackingCard(record, replacement, state.routeRunId);
}

function removeTrackingRecord(id) {
  const record = trackingRecords().find((item) => item.id === id);
  if (!record) return;
  const confirmed = window.confirm('فقط لینک پیگیری از این مرورگر حذف می‌شود و پیشنهاد ثبت‌شده پاک نخواهد شد. ادامه می‌دهید؟');
  if (!confirmed) return;
  saveTrackingRecords(trackingRecords().filter((item) => item.id !== id));
  renderTrackingPage();
  showToast('لینک پیگیری از این مرورگر حذف شد.');
}

document.addEventListener('click', async (event) => {
  const link = event.target.closest('a[data-app-link]');
  if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    const url = new URL(link.href, window.location.href);
    if (url.origin === window.location.origin) {
      event.preventDefault();
      navigate(`${url.pathname}${url.search}${url.hash}`);
      return;
    }
  }

  const viewerButtonNode = event.target.closest('[data-viewer-action]');
  if (viewerButtonNode) {
    toggleViewerState(viewerButtonNode.dataset.needId, viewerButtonNode.dataset.viewerAction);
    return;
  }

  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === 'retry-route') renderCurrentRoute();
  if (action === 'retry-tracking') retryTrackingCard(actionButton);
  if (action === 'remove-tracking') removeTrackingRecord(actionButton.dataset.trackingId);
  if (action === 'retry-all-tracking') renderTrackingPage();
  if (action === 'copy-link') {
    try {
      await navigator.clipboard.writeText(actionButton.dataset.copyValue);
      showToast('لینک پیگیری کپی شد.');
    } catch {
      showToast('کپی خودکار ممکن نبود؛ لینک را به‌صورت دستی کپی کنید.', true);
    }
  }
});

main.addEventListener('submit', (event) => {
  if (event.target.matches('#proposal-form')) {
    event.preventDefault();
    submitProposal(event.target);
  }
});

main.addEventListener('input', (event) => {
  if (event.target.matches('[data-portfolio-filter]')) {
    applyPortfolioFilters();
  }
  const form = event.target.closest('#proposal-form');
  if (!form) return;
  const wrapper = event.target.closest('.form-field');
  if (!wrapper?.classList.contains('has-error')) return;
  wrapper.classList.remove('has-error');
  event.target.removeAttribute('aria-invalid');
  wrapper.querySelector('.field-error')?.replaceChildren();
});

main.addEventListener('change', (event) => {
  if (event.target.matches('[data-portfolio-filter]')) applyPortfolioFilters();
});

window.addEventListener('popstate', () => renderCurrentRoute({ focusMain: true }));
window.addEventListener('offline', () => {
  offlineIndicator.hidden = false;
  liveIndicator.hidden = true;
  document.body.classList.add('is-offline');
});
window.addEventListener('online', () => {
  offlineIndicator.hidden = true;
  document.body.classList.remove('is-offline');
  if (state.route?.slug) {
    refreshProject(state.route.slug);
    connectRealtime(state.route.slug);
  }
});

offlineIndicator.hidden = navigator.onLine;
document.body.classList.toggle('is-offline', !navigator.onLine);
updateTrackingCount();
renderCurrentRoute();

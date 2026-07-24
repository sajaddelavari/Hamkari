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
  const number = Number(toEnglishDigits(value));
  return Number.isFinite(number) ? number : fallback;
}

function faNumber(value) {
  return new Intl.NumberFormat('fa-IR').format(asNumber(value));
}

function formatPercent(value) {
  return `${faNumber(Math.max(0, Math.min(100, Math.round(asNumber(value)))))}٪`;
}

function formatDate(value, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('fa-IR', withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(date);
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
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
  const rawSummary = payload.summary || rawProject.stats || {};
  const totalNeeds = asNumber(
    firstValue(rawSummary.totalNeeds, rawSummary.total_needs, rawSummary.activeNeeds, rawSummary.active_needs),
    needs.length,
  );
  const computedCompletion = totalNeeds ? Math.round((committedNeeds / totalNeeds) * 100) : 0;
  const projectSlug = String(firstValue(rawProject.slug, rawProject.id, requestedSlug, DEFAULT_PROJECT_SLUG));

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
    },
    needs,
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
        firstValue(rawSummary.completionPercent, rawSummary.completion_percent, rawSummary.progress),
        computedCompletion,
      ),
    },
    updatedAt: firstValue(payload.updatedAt, payload.updated_at, rawProject.updatedAt, rawProject.updated_at, ''),
  };
}

function projectFingerprint(data) {
  return JSON.stringify({
    updatedAt: data.updatedAt,
    title: data.project.title,
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

function parseRoute(pathname = window.location.pathname) {
  const cleanPath = pathname.replace(/\/+$/, '') || '/';
  if (cleanPath === '/') return { type: 'project', slug: '', isRoot: true };
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
  if (projectMatch) return { type: 'project', slug: decodeURIComponent(projectMatch[1]) };
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
  } else if (route.type === 'project' || route.type === 'need') {
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

function projectFooter(projectSlug) {
  const projectHref = projectSlug
    ? `/projects/${encodeURIComponent(projectSlug)}`
    : '/';
  const footer = element('footer', { className: 'site-footer' });
  const inner = element('div', { className: 'container footer-inner' });
  inner.append(
    element('div', { className: 'footer-brand' },
      element('strong', { text: 'هم‌ساخت' }),
      element('p', { text: 'پیشنهاد روشن، تصمیم قابل پیگیری، همکاری واقعی.' }),
    ),
    element('nav', { className: 'footer-links', attrs: { 'aria-label': 'پیوندهای پایانی' } },
      appLink(projectHref, 'پروژه'),
      appLink('/my-proposals', 'پیگیری‌های من'),
      element('a', { text: 'ورود مدیر', attrs: { href: '/admin' } }),
    ),
  );
  footer.append(inner);
  return footer;
}

function renderProjectPage(data) {
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

  // Remove the secret from the address bar and browser history after local import.
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
      if (payload?.project && Array.isArray(payload?.needs)) {
        applyProjectUpdate(normalizeProjectPayload(payload, slug));
        return;
      }
    } catch {
      // A signal-only event is valid; the fresh state is fetched below.
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
    renderProjectPage(nextData);
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
    const endpoint = state.route.isRoot
      ? '/api/v1/projects/current'
      : `/api/v1/projects/${encodeURIComponent(slug)}`;
    const payload = await apiRequest(endpoint);
    if (state.route?.slug !== slug) return;
    applyProjectUpdate(normalizeProjectPayload(payload, slug));
    const currentSlug = state.projectData?.project.slug;
    if (state.route.isRoot && currentSlug && currentSlug !== slug) {
      state.route.slug = currentSlug;
      projectNavLink.href = `/projects/${encodeURIComponent(currentSlug)}`;
      connectRealtime(currentSlug);
    }
  } catch {
    // The last known state remains usable; polling or SSE will retry.
  }
}

async function loadProjectRoute(route, runId, focusMain) {
  const cached = route.isRoot
    ? null
    : (
      state.projectCache.get(route.slug)
      || (state.projectData?.project.slug === route.slug ? state.projectData : null)
    );
  if (cached) {
    state.projectData = cached;
    if (route.type === 'need') {
      const cachedNeed = cached.needs.find((need) => need.id === route.needId);
      if (cachedNeed) renderNeedDetail(cached, cachedNeed);
      else renderNotFound();
    } else {
      renderProjectPage(cached);
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
    const projectEndpoint = route.isRoot
      ? '/api/v1/projects/current'
      : `/api/v1/projects/${encodeURIComponent(route.slug)}`;
    const payload = await apiRequest(projectEndpoint, {
      signal: state.requestController.signal,
    });
    if (state.routeRunId !== runId) return;
    const data = normalizeProjectPayload(payload, route.slug || DEFAULT_PROJECT_SLUG);
    route.slug = data.project.slug;
    state.projectData = data;
    state.projectCache.set(data.project.slug, data);
    projectNavLink.href = `/projects/${encodeURIComponent(data.project.slug)}`;

    if (route.type === 'need') {
      const need = data.needs.find((item) => item.id === route.needId);
      if (need) renderNeedDetail(data, need);
      else renderNotFound();
    } else {
      renderProjectPage(data);
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
  const form = event.target.closest('#proposal-form');
  if (!form) return;
  const wrapper = event.target.closest('.form-field');
  if (!wrapper?.classList.contains('has-error')) return;
  wrapper.classList.remove('has-error');
  event.target.removeAttribute('aria-invalid');
  wrapper.querySelector('.field-error')?.replaceChildren();
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

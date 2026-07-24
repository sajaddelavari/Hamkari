const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  csrfToken: "",
  sessionProjectSlug: "",
  projectSlug: "",
  projectId: "",
  projects: [],
  project: null,
  needs: [],
  proposals: [],
  summary: {},
  dashboard: {},
  resources: {
    stakeholders: [],
    shareClasses: [],
    shareOffers: [],
    shareTransfers: [],
    financialEntries: [],
    goals: [],
    meetings: [],
    capTable: { classes: [], holdings: [], totalUnits: 0 }
  },
  resourceErrors: {},
  entitySubmit: null,
  proposalStatus: "",
  proposalSearch: "",
  currentProposalId: null,
  activeView: "overview",
  events: null,
  pollTimer: null,
  refreshTimer: null
};

const proposalStatusLabels = {
  new: "جدید",
  contacted: "تماس گرفته‌شده",
  negotiating: "در مذاکره",
  accepted: "پذیرفته‌شده",
  rejected: "ردشده"
};

const needStatusLabels = {
  open: "باز",
  under_review: "در حال بررسی",
  negotiating: "در مذاکره",
  committed: "متعهد",
  archived: "آرشیوشده"
};

const availabilityLabels = {
  immediate: "همین حالا",
  within_2_weeks: "تا دو هفتهٔ آینده",
  within_1_month: "تا یک ماه آینده",
  planned: "نیازمند هماهنگی بیشتر"
};

const faNumber = value => new Intl.NumberFormat("fa-IR").format(Number(value || 0));
const faDate = value => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const faMoney = (value, currency = "ریال") => {
  const amount = Number(value || 0);
  const label = currency === "IRR" ? "ریال" : currency || "ریال";
  return `${new Intl.NumberFormat("fa-IR", {
    notation: Math.abs(amount) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(amount)} ${label}`;
};
const faPercent = value => `${new Intl.NumberFormat("fa-IR", {
  maximumFractionDigits: 1
}).format(Number(value || 0))}٪`;
const faOptionalPercent = value => value == null ? "—" : faPercent(value);

const stakeholderRoleLabels = {
  owner: "مالک",
  board: "عضو هیئت‌مدیره",
  manager: "مدیر",
  investor: "سرمایه‌گذار",
  partner: "شریک"
};
const financialTypeLabels = {
  revenue: "درآمد",
  expense: "هزینه",
  investment: "سرمایه‌گذاری",
  distribution: "توزیع",
  valuation: "ارزش‌گذاری"
};
const transferStatusLabels = {
  draft: "پیش‌نویس",
  pending: "منتظر تصمیم",
  approved: "تأییدشده",
  rejected: "ردشده",
  cancelled: "لغوشده"
};
const offerStatusLabels = {
  open: "باز",
  partially_filled: "بخشی انجام‌شده",
  filled: "تکمیل‌شده",
  cancelled: "لغوشده"
};
const goalStatusLabels = {
  planned: "برنامه‌ریزی‌شده",
  active: "فعال",
  completed: "تکمیل‌شده",
  cancelled: "لغوشده"
};
const meetingStatusLabels = {
  scheduled: "برنامه‌ریزی‌شده",
  held: "برگزارشده",
  cancelled: "لغوشده"
};
const resolutionStatusLabels = {
  draft: "پیش‌نویس",
  open: "رأی‌گیری باز",
  closed: "بسته"
};
const attendanceLabels = {
  invited: "دعوت‌شده",
  present: "حاضر",
  absent: "غایب"
};
const projectStageLabels = {
  idea: "ایده",
  feasibility: "امکان‌سنجی",
  fundraising: "جذب سرمایه",
  pilot: "پایلوت",
  execution: "اجرا",
  construction: "ساخت",
  operating: "بهره‌برداری",
  on_hold: "متوقف",
  completed: "تکمیل‌شده"
};

function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value == null) continue;
    if (key === "className") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key === "attributes") {
      for (const [name, attributeValue] of Object.entries(value)) {
        element.setAttribute(name, String(attributeValue));
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      element[key] = value;
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function replaceChildren(target, children) {
  const element = typeof target === "string" ? $(target) : target;
  element.replaceChildren(...(Array.isArray(children) ? children : [children]));
}

function errorMessage(error) {
  return error?.payload?.error?.message || error?.message || "خطایی رخ داد. دوباره تلاش کنید.";
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body != null && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD"].includes(method) && state.csrfToken) headers["X-CSRF-Token"] = state.csrfToken;

  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    method,
    headers
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `خطای ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    if (response.status === 401 && path !== "/api/v1/admin/session") showLogin();
    throw error;
  }
  return payload || {};
}

let toastTimer;
function toast(message, kind = "success") {
  const target = $("#adminToast");
  clearTimeout(toastTimer);
  target.textContent = message;
  target.dataset.kind = kind;
  target.classList.add("is-visible");
  toastTimer = setTimeout(() => target.classList.remove("is-visible"), 3600);
}

function setLoading(button, loading) {
  if (!button) return;
  button.disabled = loading;
  button.dataset.loading = String(loading);
}

function setConnection(status, label) {
  const badge = $("#adminConnection");
  badge.dataset.state = status;
  badge.querySelector("span").textContent = label;
}

function showLogin(message = "") {
  stopLiveUpdates();
  state.csrfToken = "";
  $("#dashboardView").hidden = true;
  $("#loginView").hidden = false;
  $("#loginError").hidden = !message;
  $("#loginError").textContent = message;
  setTimeout(() => $("#adminPassword")?.focus(), 0);
}

async function showDashboard(session) {
  state.csrfToken = session.csrfToken || "";
  state.sessionProjectSlug = session.projectSlug || "";
  state.projectSlug = session.projectSlug || state.projectSlug;
  $("#loginView").hidden = true;
  $("#dashboardView").hidden = false;
  await loadWorkspace();
  startLiveUpdates();
}

async function boot() {
  try {
    const session = await api("/api/v1/admin/session");
    if (session.authenticated) await showDashboard(session);
    else showLogin();
  } catch (error) {
    if (error.status === 401) showLogin();
    else showLogin("ارتباط با سرور برقرار نشد. چند لحظه دیگر دوباره تلاش کنید.");
  }
}

async function loadAllProposals(base = "/api/v1/admin/proposals") {
  const proposals = [];
  let summary = {};
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const separator = base.includes("?") ? "&" : "?";
    const payload = await api(`${base}${separator}limit=200&offset=${offset}`);
    const batch = payload.proposals || [];
    proposals.push(...batch);
    summary = payload.summary || summary;
    if (!payload.pagination?.hasMore) return { proposals, summary };
    const nextOffset = Number(payload.pagination.nextOffset);
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
      throw new Error("صفحه‌بندی پیشنهادها پاسخ معتبر دریافت نکرد.");
    }
    offset = nextOffset;
  }
  throw new Error("تعداد پیشنهادها از ظرفیت نمای فعلی بیشتر است.");
}

async function loadAdminProjects() {
  try {
    const payload = await api("/api/v1/admin/projects?includeArchived=true");
    return {
      projects: Array.isArray(payload) ? payload : payload.projects || payload.items || [],
      compatibility: null
    };
  } catch (error) {
    if (error.status !== 404) throw error;
    const compatibility = await api("/api/v1/admin/project");
    const project = compatibility.project || compatibility;
    return { projects: project?.id ? [project] : [], compatibility };
  }
}

function settledValue(result, fallback = {}) {
  return result?.status === "fulfilled" ? result.value : fallback;
}

function resourceList(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function projectApiPath(resource = "") {
  const base = `/api/v1/admin/projects/${encodeURIComponent(state.projectId)}`;
  return resource ? `${base}/${resource}` : base;
}

async function loadWorkspace({ silent = false } = {}) {
  if (!silent) setConnection("idle", "در حال به‌روزرسانی");
  try {
    const previousSlug = state.projectSlug;
    const portfolio = await loadAdminProjects();
    state.projects = portfolio.projects;
    const selected = state.projects.find(project => String(project.id) === String(state.projectId))
      || state.projects.find(project => project.slug === state.projectSlug)
      || state.projects.find(project => project.slug === state.sessionProjectSlug)
      || state.projects[0]
      || null;

    if (!selected) {
      state.project = null;
      state.projectId = "";
      state.projectSlug = "";
      state.needs = [];
      state.proposals = [];
      state.summary = {};
      state.dashboard = {};
      state.resources = {
        stakeholders: [],
        shareClasses: [],
        shareOffers: [],
        shareTransfers: [],
        financialEntries: [],
        goals: [],
        meetings: [],
        capTable: { classes: [], holdings: [], totalUnits: 0 }
      };
      renderAll();
      setConnection("online", "پروژه‌ای ثبت نشده");
      return;
    }

    state.projectId = String(selected.id);
    state.projectSlug = selected.slug || "";
    const projectBase = `/api/v1/admin/projects/${encodeURIComponent(state.projectId)}`;
    const selectedArchived = Boolean(selected.archivedAt || selected.archived_at);
    const activeProjectRequest = (path, fallback) => selectedArchived
      ? Promise.resolve(fallback)
      : api(path);
    const requestEntries = [
      ["detail", api(projectBase)],
      ["dashboard", activeProjectRequest(`${projectBase}/dashboard`, {})],
      ["stakeholders", activeProjectRequest(`${projectBase}/stakeholders`, { stakeholders: [] })],
      ["shareClasses", activeProjectRequest(`${projectBase}/share-classes`, { shareClasses: [] })],
      ["shareOffers", activeProjectRequest(`${projectBase}/share-offers`, { shareOffers: [] })],
      ["shareTransfers", activeProjectRequest(`${projectBase}/share-transfers`, { shareTransfers: [] })],
      ["financialEntries", activeProjectRequest(`${projectBase}/financial-entries`, { financialEntries: [] })],
      ["goals", activeProjectRequest(`${projectBase}/goals`, { goals: [] })],
      ["meetings", activeProjectRequest(`${projectBase}/meetings`, { meetings: [] })],
      ["capTable", activeProjectRequest(`${projectBase}/cap-table`, { classes: [], holdings: [], totalUnits: 0 })],
      ["needs", activeProjectRequest(`${projectBase}/needs`, { needs: [] })],
      ["proposals", selectedArchived
        ? Promise.resolve({ proposals: [], summary: {} })
        : loadAllProposals(`${projectBase}/proposals`)]
    ];
    const settled = await Promise.allSettled(requestEntries.map(([, request]) => request));
    const results = Object.fromEntries(requestEntries.map(([key], index) => [key, settled[index]]));
    const detail = settledValue(results.detail, { project: selected });
    let needsPayload = settledValue(results.needs, {});
    let proposalPayload = settledValue(results.proposals, { proposals: [], summary: {} });
    if (results.needs?.status === "rejected" && results.needs.reason?.status === 404) {
      try {
        const compatibility = portfolio.compatibility || await api("/api/v1/admin/project");
        needsPayload = compatibility;
      } catch {
        needsPayload = {};
      }
    }
    if (results.proposals?.status === "rejected" && results.proposals.reason?.status === 404) {
      try {
        proposalPayload = await loadAllProposals();
      } catch {
        proposalPayload = { proposals: [], summary: {} };
      }
    }

    state.project = detail.project || selected;
    state.projectSlug = state.project?.slug || state.projectSlug;
    state.dashboard = settledValue(results.dashboard, {});
    state.needs = needsPayload.needs || needsPayload.project?.needs || [];
    state.proposals = proposalPayload.proposals || [];
    state.summary = proposalPayload.summary || {};
    state.resources = {
      stakeholders: resourceList(settledValue(results.stakeholders), "stakeholders"),
      shareClasses: resourceList(settledValue(results.shareClasses), "shareClasses", "share_classes"),
      shareOffers: resourceList(settledValue(results.shareOffers), "shareOffers", "share_offers"),
      shareTransfers: resourceList(settledValue(results.shareTransfers), "shareTransfers", "share_transfers"),
      financialEntries: resourceList(settledValue(results.financialEntries), "financialEntries", "financial_entries"),
      goals: resourceList(settledValue(results.goals), "goals"),
      meetings: resourceList(settledValue(results.meetings), "meetings"),
      capTable: settledValue(results.capTable, { classes: [], holdings: [], totalUnits: 0 })
    };
    state.resourceErrors = Object.fromEntries(Object.entries(results)
      .filter(([key, result]) => result.status === "rejected" && !["needs", "proposals"].includes(key))
      .map(([key, result]) => [key, errorMessage(result.reason)]));
    $("#publicProjectLink").href = state.projectSlug
      ? `/projects/${encodeURIComponent(state.projectSlug)}`
      : "/projects";
    renderAll();
    if (state.events && previousSlug !== state.projectSlug) startLiveUpdates();
    setConnection("online", "اطلاعات به‌روز است");
  } catch (error) {
    setConnection("error", "خطا در دریافت اطلاعات");
    if (!silent) toast(errorMessage(error), "error");
  }
}

function startLiveUpdates() {
  stopLiveUpdates();
  const archived = Boolean(state.project?.archivedAt || state.project?.archived_at);
  if (state.projectSlug && !archived && "EventSource" in window) {
    state.events = new EventSource(`/api/v1/projects/${encodeURIComponent(state.projectSlug)}/events`);
    state.events.addEventListener("open", () => setConnection("online", "به‌روزرسانی زنده"));
    state.events.addEventListener("message", scheduleRefresh);
    state.events.addEventListener("project.updated", scheduleRefresh);
    state.events.addEventListener("proposal.created", scheduleRefresh);
    state.events.addEventListener("proposal.updated", scheduleRefresh);
    state.events.onerror = () => setConnection("idle", "بازیابی اتصال");
  }
  state.pollTimer = setInterval(() => loadWorkspace({ silent: true }), 30_000);
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => loadWorkspace({ silent: true }), 450);
}

function stopLiveUpdates() {
  state.events?.close();
  state.events = null;
  clearInterval(state.pollTimer);
  clearTimeout(state.refreshTimer);
}

function proposalValue(proposal, ...keys) {
  for (const key of keys) {
    if (proposal?.[key] != null && proposal[key] !== "") return proposal[key];
  }
  return "";
}

function normalizedProposal(proposal) {
  return {
    ...proposal,
    id: proposalValue(proposal, "id"),
    referenceCode: proposalValue(proposal, "referenceCode", "reference_code"),
    applicantName: proposalValue(proposal, "applicantName", "applicant_name", "actorName", "actor_name"),
    mobile: proposalValue(proposal, "mobile"),
    email: proposalValue(proposal, "email"),
    contribution: proposalValue(proposal, "contribution", "note"),
    availability: proposalValue(proposal, "availability"),
    notes: proposalValue(proposal, "notes"),
    internalNote: proposalValue(proposal, "internalNote", "internal_note"),
    decisionMessage: proposalValue(proposal, "decisionMessage", "decision_message"),
    needTitle: proposalValue(proposal, "needTitle", "need_title") || proposal.need?.title || "نیاز پروژه",
    status: proposalValue(proposal, "status") || "new",
    createdAt: proposalValue(proposal, "createdAt", "created_at"),
    updatedAt: proposalValue(proposal, "updatedAt", "updated_at"),
    events: proposal.events || []
  };
}

function normalizedNeed(need) {
  return {
    ...need,
    id: need.id,
    title: need.title || "نیاز بدون عنوان",
    category: need.category || "سایر",
    description: need.description || "",
    requirements: need.requirements || "",
    targetValue: need.targetValue || need.target_value || "",
    orderNo: Number(need.orderNo || need.order_no || 0),
    statusKey: need.statusKey || need.status_key || (need.archived ? "archived" : "open"),
    archived: Boolean(need.archived || need.is_active === 0)
  };
}

function renderAll() {
  renderProjectSwitcher();
  renderKpis();
  renderRecentProposals();
  renderAttentionNeeds();
  renderProposals();
  renderNeeds();
  renderStakeholders();
  renderCapital();
  renderTransfers();
  renderFinance();
  renderGoals();
  renderGovernance();
  fillProjectForm();
  renderProjectArchiveAction();
}

function renderProjectSwitcher() {
  const select = $("#projectSwitcher");
  const options = state.projects.map(project => node("option", {
    value: String(project.id),
    text: `${project.title || "پروژه بدون عنوان"}${project.archivedAt ? " — آرشیو" : ""}`
  }));
  if (!options.length) options.push(node("option", { value: "", text: "هنوز پروژه‌ای ثبت نشده" }));
  replaceChildren(select, options);
  select.value = state.projectId;
  select.disabled = state.projects.length === 0;
}

function renderProjectArchiveAction() {
  const button = $("#archiveProjectButton");
  const archived = Boolean(state.project?.archivedAt || state.project?.archived_at);
  button.hidden = !state.project;
  button.textContent = archived ? "بازگردانی پروژه" : "بایگانی پروژه";
  button.classList.toggle("danger", !archived);
  button.classList.toggle("secondary", archived);
}

function adminKpi(label, value, hint = "") {
  return node("article", { className: "admin-kpi" }, [
    node("span", { text: label }),
    node("strong", { text: value }),
    hint ? node("small", { text: hint }) : null
  ]);
}

function resourceUnavailable(key, title = "اطلاعات این بخش دریافت نشد") {
  const message = state.resourceErrors[key];
  return message
    ? errorState(title, message, () => loadWorkspace())
    : null;
}

function managementTable(headers, rows) {
  return node("div", { className: `management-table columns-${headers.length}`, attributes: { role: "table" } }, [
    node("div", { className: "management-row management-head", attributes: { role: "row" } },
      headers.map(header => node("span", { text: header, attributes: { role: "columnheader" } }))),
    ...rows.map(cells => node("div", { className: "management-row", attributes: { role: "row" } },
      cells.map(cell => node("div", { className: "management-cell", attributes: { role: "cell" } },
        Array.isArray(cell) ? cell : [cell]))))
  ]);
}

function resourceActions(...buttons) {
  return node("div", { className: "resource-actions" }, buttons.filter(Boolean));
}

function miniButton(text, onclick, tone = "") {
  return node("button", {
    className: `mini-action${tone ? ` ${tone}` : ""}`,
    type: "button",
    text,
    onclick
  });
}

function stakeholderById(id) {
  return state.resources.stakeholders.find(item => String(item.id) === String(id));
}

function shareClassById(id) {
  return state.resources.shareClasses.find(item => String(item.id) === String(id))
    || state.resources.capTable.classes?.find(item => String(item.id) === String(id));
}

function renderStakeholders() {
  const target = $("#stakeholderList");
  const unavailable = resourceUnavailable("stakeholders");
  if (unavailable) {
    replaceChildren(target, unavailable);
    return;
  }
  const stakeholders = state.resources.stakeholders;
  if (!stakeholders.length) {
    replaceChildren(target, emptyState("ذی‌نفعی ثبت نشده است", "مالک، مدیر، سرمایه‌گذار یا شریک پروژه را اضافه کنید."));
    return;
  }
  replaceChildren(target, managementTable(
    ["نام و نوع", "نقش", "راه تماس خصوصی", "وضعیت", "اقدام"],
    stakeholders.map(item => [
      [
        node("strong", { text: item.name || "—" }),
        node("small", { text: item.kind === "organization" ? "سازمان" : "شخص" })
      ],
      stakeholderRoleLabels[item.role] || item.role || "—",
      [
        node("span", { text: item.mobile || "بدون موبایل", attributes: { dir: item.mobile ? "ltr" : "rtl" } }),
        node("small", { text: item.email || "بدون ایمیل", attributes: { dir: item.email ? "ltr" : "rtl" } })
      ],
      node("span", {
        className: `resource-status ${item.archivedAt ? "muted" : "success"}`,
        text: item.archivedAt ? "آرشیو" : "فعال"
      }),
      resourceActions(
        miniButton("ویرایش", () => openStakeholderForm(item)),
        !item.archivedAt
          ? miniButton("آرشیو", () => archiveStakeholder(item), "danger")
          : miniButton("بازگردانی", () => restoreStakeholder(item))
      )
    ])
  ));
}

function renderCapital() {
  const cap = state.resources.capTable || {};
  const classes = cap.classes?.length ? cap.classes : state.resources.shareClasses;
  const holdings = cap.holdings || [];
  const financial = state.dashboard.financial || {};
  replaceChildren("#capitalSummary", [
    adminKpi("واحد منتشرشده", faNumber(cap.totalUnits || classes.reduce((sum, item) => sum + Number(item.issuedUnits || 0), 0)), "جمع دفتر سرمایه"),
    adminKpi("طبقات سرمایه", faNumber(classes.length), "طبقات فعال"),
    adminKpi("دارندگان واحد", faNumber(new Set(holdings.map(item => item.stakeholderId)).size), "ذی‌نفع یکتا"),
    adminKpi("ارزش‌گذاری", faMoney(financial.valuation || state.project?.valuationAmount, state.project?.currency), "آخرین ثبت مدیریتی")
  ]);

  const unavailable = resourceUnavailable("capTable");
  if (unavailable) {
    replaceChildren("#shareClassList", unavailable);
    replaceChildren("#holdingsTable", emptyState("دفتر مالکیت در دسترس نیست", "پس از بازیابی ارتباط دوباره تلاش کنید."));
  } else {
    replaceChildren("#shareClassList", classes.length
      ? classes.map(item => node("article", { className: "resource-card" }, [
        node("div", { className: "resource-card-head" }, [
          node("div", {}, [
            node("strong", { text: item.name || "طبقهٔ سرمایه" }),
            node("span", { text: item.symbol || "بدون نماد", attributes: { dir: "ltr" } })
          ]),
          node("b", { text: faNumber(item.issuedUnits || 0) })
        ]),
        node("dl", { className: "resource-facts" }, [
          node("div", {}, [node("dt", { text: "سقف مجاز" }), node("dd", { text: faNumber(item.authorizedUnits) })]),
          node("div", {}, [node("dt", { text: "مانده" }), node("dd", { text: faNumber(item.availableUnits ?? Number(item.authorizedUnits || 0) - Number(item.issuedUnits || 0)) })]),
          node("div", {}, [node("dt", { text: "وزن رأی" }), node("dd", { text: faNumber(item.votingWeight) })])
        ]),
        resourceActions(
          miniButton("ویرایش", () => openShareClassForm(item)),
          miniButton("صدور واحد", () => openIssuanceForm(item.id))
        )
      ]))
      : emptyState("طبقهٔ سرمایه‌ای ثبت نشده است", "پیش از صدور یا انتقال، یک طبقهٔ سرمایه بسازید."));

    replaceChildren("#holdingsTable", holdings.length
      ? managementTable(
        ["ذی‌نفع", "طبقه", "واحد", "مالکیت در طبقه"],
        holdings.map(item => [
          item.stakeholderName || stakeholderById(item.stakeholderId)?.name || "—",
          `${item.className || shareClassById(item.shareClassId)?.name || "—"} ${item.symbol ? `(${item.symbol})` : ""}`,
          faNumber(item.units),
          faPercent(item.ownershipPercent)
        ])
      )
      : emptyState("مالکیتی در دفتر ثبت نشده است", "پس از صدور نخستین واحد، ترکیب مالکیت اینجا دیده می‌شود."));
  }
  renderStakeholderReturns();
}

function renderStakeholderReturns() {
  const panel = $("#stakeholderReturnsPanel");
  const returns = state.dashboard.stakeholderReturns
    || state.dashboard.stakeholder_returns
    || state.dashboard.returns?.stakeholders
    || [];
  panel.hidden = !Array.isArray(returns) || returns.length === 0;
  if (panel.hidden) {
    replaceChildren("#stakeholderReturns", []);
    return;
  }
  replaceChildren("#stakeholderReturns", managementTable(
    ["ذی‌نفع", "سرمایه واردشده", "توزیع", "ارزش برآوردی", "ROI برآوردی"],
    returns.map(item => [
      item.stakeholderName || item.name || stakeholderById(item.stakeholderId)?.name || "—",
      faMoney(item.investedCapital ?? item.investment, state.project?.currency),
      faMoney(item.distribution ?? item.distributions ?? item.distributedAmount, state.project?.currency),
      faMoney(item.estimatedValue ?? item.ownershipValue ?? item.valuation, state.project?.currency),
      faOptionalPercent(item.roiPercent ?? (item.roi == null ? null : Number(item.roi) * 100))
    ])
  ));
}

function renderTransfers() {
  const offers = state.resources.shareOffers;
  const transfers = state.resources.shareTransfers;
  const offerUnavailable = resourceUnavailable("shareOffers");
  const transferUnavailable = resourceUnavailable("shareTransfers");
  if (offerUnavailable) replaceChildren("#offerList", offerUnavailable);
  else if (!offers.length) replaceChildren("#offerList", emptyState("عرضه‌ای ثبت نشده است", "عرضهٔ خرید یا فروش تازه‌ای ایجاد کنید."));
  else {
    replaceChildren("#offerList", offers.map(offer => {
      const ownerId = offer.side === "sell" ? offer.sellerStakeholderId : offer.buyerStakeholderId;
      return node("article", { className: "resource-card" }, [
        node("div", { className: "resource-card-head" }, [
          node("div", {}, [
            node("span", { className: "resource-status", text: offer.side === "sell" ? "فروش" : "خرید" }),
            node("strong", { text: shareClassById(offer.shareClassId)?.name || "طبقهٔ سرمایه" })
          ]),
          node("b", { text: offerStatusLabels[offer.status] || offer.status })
        ]),
        node("p", {
          className: "resource-description",
          text: `${stakeholderById(ownerId)?.name || "ذی‌نفع"} · ${faNumber(offer.remainingUnits ?? offer.units)} از ${faNumber(offer.units)} واحد`
        }),
        node("dl", { className: "resource-facts" }, [
          node("div", {}, [node("dt", { text: "قیمت واحد" }), node("dd", { text: faMoney(offer.unitPrice, state.project?.currency) })]),
          node("div", {}, [node("dt", { text: "مهلت" }), node("dd", { text: faDate(offer.availableUntil) })])
        ]),
        ["open", "partially_filled"].includes(offer.status)
          ? resourceActions(miniButton("لغو عرضه", () => cancelOffer(offer), "danger"))
          : null
      ]);
    }));
  }

  if (transferUnavailable) replaceChildren("#transferList", transferUnavailable);
  else if (!transfers.length) replaceChildren("#transferList", emptyState("انتقالی ثبت نشده است", "درخواست انتقال واحدها را ثبت و مرحله‌به‌مرحله تصمیم‌گیری کنید."));
  else {
    replaceChildren("#transferList", transfers.map(transfer => {
      const actions = [];
      if (transfer.status === "draft") {
        actions.push(miniButton("ارسال برای تصمیم", () => transitionTransfer(transfer, "pending")));
        actions.push(miniButton("لغو", () => transitionTransfer(transfer, "cancelled"), "danger"));
      } else if (transfer.status === "pending") {
        actions.push(miniButton("تأیید انتقال", () => transitionTransfer(transfer, "approved"), "success"));
        actions.push(miniButton("رد", () => transitionTransfer(transfer, "rejected"), "danger"));
      }
      return node("article", { className: "resource-card" }, [
        node("div", { className: "resource-card-head" }, [
          node("strong", { text: `${faNumber(transfer.units)} واحد ${shareClassById(transfer.shareClassId)?.name || ""}` }),
          node("span", {
            className: `resource-status status-${transfer.status}`,
            text: transferStatusLabels[transfer.status] || transfer.status
          })
        ]),
        node("p", {
          className: "resource-description",
          text: `${stakeholderById(transfer.fromStakeholderId)?.name || "فروشنده"} ← ${stakeholderById(transfer.toStakeholderId)?.name || "خریدار"}`
        }),
        node("small", { text: `مبلغ: ${faMoney(transfer.priceAmount, state.project?.currency)} · ${faDate(transfer.createdAt)}` }),
        actions.length ? resourceActions(...actions) : null
      ]);
    }));
  }
}

function financialSnapshot() {
  const dashboard = state.dashboard.financial;
  if (dashboard) return dashboard;
  const activeEntries = state.resources.financialEntries;
  const sum = type => activeEntries
    .filter(item => item.type === type)
    .reduce((total, item) => total + (item.isReversal ? -1 : 1) * Number(item.amount || 0), 0);
  const revenue = sum("revenue");
  const expense = sum("expense");
  const investment = sum("investment");
  const distribution = sum("distribution");
  const netProfit = revenue - expense;
  return {
    revenue,
    expense,
    investedCapital: investment,
    distribution,
    netProfit,
    roiPercent: investment ? (netProfit / investment) * 100 : null,
    netCash: revenue + investment - expense - distribution
  };
}

function renderFinance() {
  const financial = financialSnapshot();
  replaceChildren("#financeSummary", [
    adminKpi("درآمد", faMoney(financial.revenue, state.project?.currency), "ثبت مؤثر"),
    adminKpi("هزینه", faMoney(financial.expense ?? financial.expenses, state.project?.currency), "ثبت مؤثر"),
    adminKpi("سود خالص", faMoney(financial.netProfit, state.project?.currency), "درآمد منهای هزینه"),
    adminKpi("ROI", faOptionalPercent(financial.roiPercent ?? (financial.roi == null ? null : Number(financial.roi) * 100)), "مستقل از پیشرفت عملیاتی"),
    adminKpi("جریان نقد", faMoney(financial.netCash, state.project?.currency), "با سرمایه و توزیع")
  ]);
  const unavailable = resourceUnavailable("financialEntries");
  if (unavailable) {
    replaceChildren("#financialEntries", unavailable);
    return;
  }
  const entries = state.resources.financialEntries;
  if (!entries.length) {
    replaceChildren("#financialEntries", emptyState("ثبت مالی وجود ندارد", "درآمد، هزینه، سرمایه‌گذاری، توزیع یا ارزش‌گذاری را ثبت کنید."));
    return;
  }
  const reversedIds = new Set(entries.filter(item => item.reversalOfEntryId).map(item => String(item.reversalOfEntryId)));
  replaceChildren("#financialEntries", managementTable(
    ["نوع و شرح", "مبلغ", "تاریخ وقوع", "ارتباط", "اقدام"],
    entries.map(entry => [
      [
        node("strong", { text: financialTypeLabels[entry.type] || entry.type }),
        node("small", { text: entry.description || (entry.isReversal ? "ثبت اصلاحی" : "بدون توضیح") })
      ],
      node("span", {
        className: entry.isReversal ? "amount-negative" : "",
        text: `${entry.isReversal ? "−" : ""}${faMoney(entry.amount, state.project?.currency)}`
      }),
      String(entry.occurredOn || "—"),
      entry.stakeholderId ? stakeholderById(entry.stakeholderId)?.name || "ذی‌نفع" : "عمومی پروژه",
      !entry.isReversal && !reversedIds.has(String(entry.id))
        ? miniButton("ثبت اصلاحی", () => openReversalForm(entry), "danger")
        : node("span", { className: "muted-copy", text: entry.isReversal ? "اصلاح" : "اصلاح‌شده" })
    ])
  ));
}

function renderGoals() {
  const goals = state.resources.goals;
  const totalWeight = goals.filter(goal => goal.status !== "cancelled")
    .reduce((sum, goal) => sum + Number(goal.weight || 0), 0);
  const progress = totalWeight
    ? goals.filter(goal => goal.status !== "cancelled")
      .reduce((sum, goal) => sum + Number(goal.weight || 0) * Number(goal.progressPercent || 0), 0) / totalWeight
    : Number(state.dashboard.goalProgressPercent || state.dashboard.goals?.goalProgressPercent || 0);
  replaceChildren("#goalsSummary", [
    adminKpi("پیشرفت عملیاتی", faPercent(progress), "میانگین وزن‌دار اهداف"),
    adminKpi("هدف فعال", faNumber(goals.filter(goal => goal.status === "active").length), "در حال اجرا"),
    adminKpi("هدف تکمیل‌شده", faNumber(goals.filter(goal => goal.status === "completed").length), "مستقل از مشارکت")
  ]);
  const unavailable = resourceUnavailable("goals");
  if (unavailable) {
    replaceChildren("#goalsBoard", unavailable);
    return;
  }
  if (!goals.length) {
    replaceChildren("#goalsBoard", emptyState("هدف عملیاتی ثبت نشده است", "هدف و نقاط عطف وزن‌دار را برای سنجش اجرای پروژه تعریف کنید."));
    return;
  }
  replaceChildren("#goalsBoard", goals.map(goal => {
    const milestoneList = (goal.milestones || []).map(milestone => node("li", {}, [
      node("button", {
        className: `milestone-toggle${milestone.completed ? " is-complete" : ""}`,
        type: "button",
        text: milestone.completed ? "✓" : "○",
        title: milestone.completed ? "بازکردن دوبارهٔ نقطه عطف" : "علامت‌گذاری به‌عنوان تکمیل‌شده",
        onclick: () => toggleMilestone(goal, milestone)
      }),
      node("span", { text: milestone.title }),
      node("small", { text: `وزن ${faNumber(milestone.weight)}` })
    ]));
    const actions = [
      miniButton("نقطهٔ عطف", () => openMilestoneForm(goal)),
      goal.status === "planned" ? miniButton("فعال‌سازی", () => patchGoalStatus(goal, "active")) : null,
      ["planned", "active"].includes(goal.status) ? miniButton("تکمیل هدف", () => patchGoalStatus(goal, "completed"), "success") : null,
      !["completed", "cancelled"].includes(goal.status) ? miniButton("لغو", () => patchGoalStatus(goal, "cancelled"), "danger") : null
    ];
    return node("article", { className: "admin-panel goal-panel" }, [
      node("div", { className: "resource-card-head" }, [
        node("div", {}, [
          node("span", { className: `resource-status status-${goal.status}`, text: goalStatusLabels[goal.status] || goal.status }),
          node("h3", { text: goal.title })
        ]),
        node("strong", { className: "goal-progress-value", text: faPercent(goal.progressPercent) })
      ]),
      goal.description ? node("p", { className: "resource-description", text: goal.description }) : null,
      node("progress", {
        value: Number(goal.progressPercent || 0),
        max: 100,
        attributes: { "aria-label": `${goal.title}: ${faPercent(goal.progressPercent)}` }
      }),
      node("div", { className: "goal-panel-meta" }, [
        node("span", { text: `وزن هدف: ${faNumber(goal.weight)}` }),
        node("span", { text: `موعد: ${goal.dueDate || "ثبت نشده"}` })
      ]),
      milestoneList.length
        ? node("ul", { className: "milestone-list" }, milestoneList)
        : emptyState("نقطهٔ عطفی ندارد", "برای محاسبهٔ قابل اتکا، حداقل یک نقطهٔ عطف بسازید."),
      resourceActions(...actions)
    ]);
  }));
}

function renderGovernance() {
  const meetings = state.resources.meetings;
  const resolutionCount = meetings.reduce((sum, meeting) => sum + (meeting.resolutions || []).length, 0);
  const openCount = meetings.reduce((sum, meeting) => sum
    + (meeting.resolutions || []).filter(item => item.status === "open").length, 0);
  replaceChildren("#governanceSummary", [
    adminKpi("جلسه", faNumber(meetings.length), "کل جلسات ثبت‌شده"),
    adminKpi("مصوبه", faNumber(resolutionCount), "کل تصمیم‌ها"),
    adminKpi("رأی‌گیری باز", faNumber(openCount), "نیازمند اقدام")
  ]);
  const unavailable = resourceUnavailable("meetings");
  if (unavailable) {
    replaceChildren("#meetingsBoard", unavailable);
    return;
  }
  if (!meetings.length) {
    replaceChildren("#meetingsBoard", emptyState("جلسه‌ای ثبت نشده است", "جلسه را برنامه‌ریزی کنید و مصوبات را زیر همان جلسه نگه دارید."));
    return;
  }
  replaceChildren("#meetingsBoard", meetings.map(meeting => {
    const resolutions = (meeting.resolutions || []).map(resolution => {
      const tally = resolution.tally || {};
      const actions = [];
      if (resolution.status === "draft") actions.push(miniButton("بازکردن رأی‌گیری", () => patchResolutionStatus(meeting, resolution, "open")));
      if (resolution.status === "open") {
        actions.push(miniButton("ثبت رأی", () => openVoteForm(meeting, resolution)));
        actions.push(miniButton("بستن و ثبت تصمیم", () => openCloseResolutionForm(meeting, resolution), "success"));
      }
      return node("article", { className: "resolution-admin-card" }, [
        node("div", { className: "resource-card-head" }, [
          node("strong", { text: resolution.title }),
          node("span", { className: `resource-status status-${resolution.status}`, text: resolutionStatusLabels[resolution.status] || resolution.status })
        ]),
        resolution.description ? node("p", { className: "resource-description", text: resolution.description }) : null,
        node("dl", { className: "vote-facts" }, [
          node("div", {}, [node("dt", { text: "موافق" }), node("dd", { text: `${faNumber(tally.yes?.voters)} نفر · وزن ${faNumber(tally.yes?.votingPower)}` })]),
          node("div", {}, [node("dt", { text: "مخالف" }), node("dd", { text: `${faNumber(tally.no?.voters)} نفر · وزن ${faNumber(tally.no?.votingPower)}` })]),
          node("div", {}, [node("dt", { text: "ممتنع" }), node("dd", { text: `${faNumber(tally.abstain?.voters)} نفر · وزن ${faNumber(tally.abstain?.votingPower)}` })])
        ]),
        resolution.decision ? node("p", { className: "decision-copy", text: `تصمیم: ${resolution.decision}` }) : null,
        actions.length ? resourceActions(...actions) : null
      ]);
    });
    const meetingActions = [
      miniButton("مدیریت حضور", () => openAttendanceForm(meeting)),
      miniButton("افزودن مصوبه", () => openResolutionForm(meeting)),
      meeting.status === "scheduled" ? miniButton("جلسه برگزار شد", () => patchMeetingStatus(meeting, "held"), "success") : null,
      meeting.status === "scheduled" ? miniButton("لغو جلسه", () => patchMeetingStatus(meeting, "cancelled"), "danger") : null
    ];
    return node("article", { className: "admin-panel meeting-panel" }, [
      node("div", { className: "resource-card-head" }, [
        node("div", {}, [
          node("span", { className: `resource-status status-${meeting.status}`, text: meetingStatusLabels[meeting.status] || meeting.status }),
          node("h3", { text: meeting.title })
        ]),
        node("div", { className: "meeting-meta" }, [
          node("time", { text: faDate(meeting.scheduledAt) }),
          node("span", { text: meeting.publicVisible ? "عمومی" : "خصوصی" })
        ])
      ]),
      meeting.location ? node("p", { className: "resource-description", text: meeting.location }) : null,
      meeting.minutes ? node("p", { className: "meeting-minutes", text: meeting.minutes }) : null,
      (meeting.attendees || []).length
        ? node("div", { className: "attendance-list", attributes: { "aria-label": "فهرست حضور" } },
          meeting.attendees.map(attendee => node("span", {}, [
            node("strong", { text: attendee.stakeholderName || stakeholderById(attendee.stakeholderId)?.name || "ذی‌نفع" }),
            node("small", { text: attendanceLabels[attendee.attendance] || attendee.attendance })
          ])))
        : node("p", { className: "attendance-empty", text: "حضور اعضا هنوز ثبت نشده است." }),
      resourceActions(...meetingActions),
      node("div", { className: "resolution-admin-list" },
        resolutions.length ? resolutions : [emptyState("مصوبه‌ای ندارد", "نخستین موضوع تصمیم‌گیری را برای این جلسه ثبت کنید.")])
    ]);
  }));
}

function proposalCounts() {
  const counts = { new: 0, contacted: 0, negotiating: 0, accepted: 0, rejected: 0 };
  let hasServerSummary = false;
  for (const status of Object.keys(counts)) {
    const count = Number(state.summary?.[status]);
    if (Number.isFinite(count)) {
      counts[status] = count;
      hasServerSummary = true;
    }
  }
  if (hasServerSummary) return counts;
  for (const raw of state.proposals) {
    const status = normalizedProposal(raw).status;
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function renderKpis() {
  const counts = proposalCounts();
  const needs = state.needs.map(normalizedNeed).filter(need => !need.archived);
  const committed = needs.filter(need => need.statusKey === "committed").length;
  const open = needs.filter(need => need.statusKey === "open").length;
  const totalProposals = Number.isFinite(Number(state.summary?.total))
    ? Number(state.summary.total)
    : state.proposals.length;
  const conversion = totalProposals ? Math.round((counts.accepted / totalProposals) * 100) : 0;
  const items = [
    ["منتظر بررسی", counts.new, "به اقدام اولیه نیاز دارد"],
    ["نیازهای باز", open, "هنوز پیشنهاد فعالی ندارد"],
    ["تعهد نهایی", committed, `از ${faNumber(needs.length)} نیاز فعال`],
    ["نرخ تبدیل", `${faNumber(conversion)}٪`, "پیشنهاد پذیرفته‌شده"]
  ];
  replaceChildren("#overviewKpis", items.map(([label, value, hint]) =>
    node("article", { className: "admin-kpi" }, [
      node("span", { text: label }),
      node("strong", { text: typeof value === "number" ? faNumber(value) : value }),
      node("small", { text: hint })
    ])
  ));
  $("#navPendingCount").textContent = faNumber(counts.new);
  $("#navPendingCount").hidden = counts.new === 0;
}

function proposalCompactRow(raw) {
  const proposal = normalizedProposal(raw);
  return node("article", { className: "proposal-row" }, [
    node("div", { className: "row-primary" }, [
      node("strong", { text: proposal.applicantName || "نام ثبت نشده" }),
      node("span", { text: proposal.referenceCode ? `کد ${proposal.referenceCode}` : "بدون کد" })
    ]),
    node("div", { className: "row-meta" }, [
      node("strong", { text: proposal.needTitle }),
      node("span", { text: faDate(proposal.createdAt) })
    ]),
    statusBadge(proposal.status),
    node("button", {
      className: "table-action",
      type: "button",
      text: "بررسی",
      onclick: () => openProposal(proposal.id)
    })
  ]);
}

function renderRecentProposals() {
  const proposals = state.proposals
    .map(normalizedProposal)
    .filter(item => ["new", "contacted", "negotiating"].includes(item.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
  if (!proposals.length) {
    replaceChildren("#recentProposals", emptyState("پیشنهاد منتظر اقدامی وجود ندارد", "با ثبت پیشنهاد جدید، این بخش خودکار به‌روز می‌شود."));
    return;
  }
  replaceChildren("#recentProposals", proposals.map(proposalCompactRow));
}

function renderAttentionNeeds() {
  const needs = state.needs
    .map(normalizedNeed)
    .filter(need => !need.archived && need.statusKey !== "committed")
    .sort((a, b) => {
      const priority = { negotiating: 0, under_review: 1, open: 2 };
      return (priority[a.statusKey] ?? 3) - (priority[b.statusKey] ?? 3) || a.orderNo - b.orderNo;
    })
    .slice(0, 6);
  if (!needs.length) {
    replaceChildren("#attentionNeeds", emptyState("همه نیازها متعهد شده‌اند", "پیشرفت پروژه کامل شده است."));
    return;
  }
  replaceChildren("#attentionNeeds", needs.map(need =>
    node("article", { className: "attention-item" }, [
      node("div", {}, [
        node("strong", { text: need.title }),
        node("p", { text: need.statusKey === "open" ? "هنوز پیشنهاد فعالی ندارد" : "پیشنهاد فعال نیاز به پیگیری دارد" })
      ]),
      statusBadge(need.statusKey, true)
    ])
  ));
}

function statusBadge(status, isNeed = false) {
  return node("span", {
    className: "status-badge",
    text: (isNeed ? needStatusLabels : proposalStatusLabels)[status] || status || "نامشخص",
    dataset: { status: status || "open" }
  });
}

function filteredProposals() {
  const search = state.proposalSearch.trim().toLocaleLowerCase("fa");
  return state.proposals
    .map(normalizedProposal)
    .filter(proposal => !state.proposalStatus || proposal.status === state.proposalStatus)
    .filter(proposal => {
      if (!search) return true;
      return [proposal.applicantName, proposal.needTitle, proposal.referenceCode, proposal.mobile]
        .some(value => String(value || "").toLocaleLowerCase("fa").includes(search));
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderProposals() {
  const proposals = filteredProposals();
  if (!proposals.length) {
    replaceChildren("#proposalTable", emptyState("پیشنهادی با این فیلتر پیدا نشد", "فیلتر یا عبارت جست‌وجو را تغییر دهید."));
    return;
  }
  const header = node("div", { className: "table-header", attributes: { role: "row" } }, [
    "متقاضی", "نیاز", "خلاصه آورده", "تاریخ", "وضعیت", "اقدام"
  ].map(text => node("span", { text, attributes: { role: "columnheader" } })));
  const rows = proposals.map(proposal =>
    node("article", { className: "table-row", attributes: { role: "row" } }, [
      node("div", { className: "table-cell" }, [
        node("strong", { text: proposal.applicantName || "—" }),
        node("span", { text: proposal.referenceCode || proposal.mobile || "—" })
      ]),
      node("div", { className: "table-cell" }, [node("span", { text: proposal.needTitle })]),
      node("div", { className: "table-cell" }, [node("span", { text: proposal.contribution || "شرحی ثبت نشده" })]),
      node("div", { className: "table-cell" }, [node("span", { text: faDate(proposal.createdAt) })]),
      node("div", { className: "table-cell" }, [statusBadge(proposal.status)]),
      node("button", {
        className: "table-action",
        type: "button",
        text: "بررسی",
        onclick: () => openProposal(proposal.id)
      })
    ])
  );
  replaceChildren("#proposalTable", [header, ...rows]);
}

function emptyState(title, description) {
  return node("div", { className: "empty-state" }, [
    node("strong", { text: title }),
    node("p", { text: description })
  ]);
}

function errorState(title, description, retry) {
  return node("div", { className: "error-state" }, [
    node("strong", { text: title }),
    node("p", { text: description }),
    retry ? node("button", { className: "admin-button secondary", type: "button", text: "تلاش دوباره", onclick: retry }) : null
  ]);
}

async function openProposal(id) {
  state.currentProposalId = id;
  $("#proposalDialogTitle").textContent = "در حال دریافت اطلاعات…";
  replaceChildren("#proposalDetail", node("div", { className: "loading-state", text: "در حال بارگذاری جزئیات پیشنهاد…" }));
  if (!$("#proposalDialog").open) $("#proposalDialog").showModal();
  try {
    const payload = await api(`${projectApiPath("proposals")}/${encodeURIComponent(id)}`);
    renderProposalDetail(normalizedProposal(payload.proposal || payload));
  } catch (error) {
    replaceChildren("#proposalDetail", errorState("جزئیات دریافت نشد", errorMessage(error), () => openProposal(id)));
  }
}

function detailCard(label, value, direction = "") {
  return node("div", { className: "detail-card" }, [
    node("span", { text: label }),
    node("strong", { text: value || "—", attributes: direction ? { dir: direction } : {} })
  ]);
}

function renderProposalDetail(proposal) {
  $("#proposalDialogTitle").textContent = proposal.applicantName || "جزئیات پیشنهاد";

  const contactSection = node("section", { className: "detail-section" }, [
    node("h3", { text: "اطلاعات تماس و پیشنهاد" }),
    node("div", { className: "detail-grid" }, [
      detailCard("کد پیگیری", proposal.referenceCode),
      detailCard("وضعیت", proposalStatusLabels[proposal.status] || proposal.status),
      detailCard("شماره تماس", proposal.mobile, "ltr"),
      detailCard("ایمیل", proposal.email, "ltr"),
      detailCard("نیاز مرتبط", proposal.needTitle),
      detailCard(
        "زمان آمادگی",
        availabilityLabels[proposal.availability] || proposal.availability || "ثبت نشده"
      )
    ])
  ]);

  const contributionSection = node("section", { className: "detail-section" }, [
    node("h3", { text: "آورده و ظرفیت" }),
    node("p", { className: "detail-text", text: proposal.contribution || "شرحی ثبت نشده است." })
  ]);
  if (proposal.notes) {
    contributionSection.append(
      node("h3", { text: "توضیحات تکمیلی" }),
      node("p", { className: "detail-text", text: proposal.notes })
    );
  }

  const timelineItems = (proposal.events || []).length
    ? proposal.events
    : [{ status: proposal.status, createdAt: proposal.updatedAt || proposal.createdAt, message: "آخرین وضعیت ثبت‌شده" }];
  const timelineSection = node("section", { className: "detail-section" }, [
    node("h3", { text: "تاریخچه پیگیری" }),
    node("div", { className: "timeline" }, timelineItems.map(event =>
      node("div", { className: "timeline-item" }, [
        node("i", { className: "timeline-dot", attributes: { "aria-hidden": "true" } }),
        node("div", { className: "timeline-copy" }, [
          node("strong", {
            text: event.message || proposalStatusLabels[event.toStatus || event.status] || "به‌روزرسانی پیشنهاد"
          }),
          node("span", { text: faDate(event.createdAt || event.created_at) })
        ])
      ])
    ))
  ]);

  const internalNote = node("textarea", {
    value: proposal.internalNote || "",
    rows: 3,
    maxLength: 1000,
    attributes: { id: "proposalInternalNote" }
  });
  const decisionMessage = node("textarea", {
    value: proposal.decisionMessage || "",
    rows: 3,
    maxLength: 500,
    attributes: { id: "proposalDecisionMessage" }
  });
  const actionError = node("div", { className: "form-alert", attributes: { role: "alert" } });
  actionError.hidden = true;

  const actionMap = {
    new: [["تماس گرفته شد", "contacted"], ["رد پیشنهاد", "rejected"]],
    contacted: [["شروع مذاکره", "negotiating"], ["رد پیشنهاد", "rejected"]],
    negotiating: [["پذیرش و تثبیت نیاز", "accepted"], ["رد پیشنهاد", "rejected"]],
    accepted: [["لغو پذیرش و بازگشت به مذاکره", "negotiating"]],
    rejected: [["بازگشایی پیشنهاد", "new"]]
  };

  const buttons = (actionMap[proposal.status] || []).map(([label, nextStatus]) =>
    node("button", {
      className: `status-action${nextStatus === "rejected" ? " danger" : ""}`,
      type: "button",
      text: label,
      onclick: () => updateProposal(proposal, nextStatus, internalNote, decisionMessage, actionError)
    })
  );
  const saveNote = node("button", {
    className: "admin-button secondary",
    type: "button",
    text: "ذخیره یادداشت",
    onclick: () => updateProposal(proposal, null, internalNote, decisionMessage, actionError)
  });

  const decisionForm = node("section", { className: "decision-form" }, [
    node("label", { className: "field" }, [
      node("span", { text: "یادداشت داخلی مدیر" }),
      internalNote
    ]),
    node("label", { className: "field" }, [
      node("span", { text: "پیام قابل مشاهده برای پیشنهاددهنده" }),
      decisionMessage,
      node("small", { className: "field-error", text: "برای رد پیشنهاد، درج یک توضیح کوتاه الزامی است." })
    ]),
    actionError,
    node("div", { className: "status-actions" }, [...buttons, saveNote])
  ]);

  replaceChildren("#proposalDetail", [contactSection, contributionSection, timelineSection, decisionForm]);
}

async function updateProposal(proposal, nextStatus, internalNote, decisionMessage, errorTarget) {
  errorTarget.hidden = true;
  const decision = decisionMessage.value.trim();
  if (nextStatus === "rejected" && decision.length < 5) {
    errorTarget.textContent = "برای رد پیشنهاد، دلیل کوتاهی بنویسید تا متقاضی قدم بعدی را بداند.";
    errorTarget.hidden = false;
    decisionMessage.focus();
    return;
  }
  let confirmUnaccept = false;
  if (nextStatus === "accepted" && !window.confirm("با پذیرش این پیشنهاد، نیاز مربوطه متعهد می‌شود. ادامه می‌دهید؟")) return;
  if (proposal.status === "accepted" && nextStatus === "negotiating") {
    if (!window.confirm("پذیرش قبلی لغو و پیشرفت پروژه اصلاح می‌شود. ادامه می‌دهید؟")) return;
    confirmUnaccept = true;
  }
  try {
    const body = {
      internalNote: internalNote.value.trim(),
      decisionMessage: decision,
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(confirmUnaccept ? { confirmUnaccept: true } : {})
    };
    const payload = await api(`${projectApiPath("proposals")}/${encodeURIComponent(proposal.id)}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    toast(nextStatus ? "وضعیت پیشنهاد به‌روزرسانی شد." : "یادداشت ذخیره شد.");
    await loadWorkspace({ silent: true });
    renderProposalDetail(normalizedProposal(payload.proposal || payload));
  } catch (error) {
    errorTarget.textContent = error.status === 409
      ? "برای این نیاز قبلاً پیشنهاد دیگری پذیرفته شده است. ابتدا پذیرش قبلی را لغو کنید."
      : errorMessage(error);
    errorTarget.hidden = false;
  }
}

function renderNeeds() {
  const needs = state.needs.map(normalizedNeed).sort((a, b) => a.orderNo - b.orderNo);
  if (!needs.length) {
    replaceChildren("#needsManager", emptyState("هنوز نیازی تعریف نشده است", "اولین نیاز پروژه را اضافه کنید."));
    return;
  }
  replaceChildren("#needsManager", needs.map((need, index) =>
    node("article", { className: "need-manager-card" }, [
      node("span", { className: "need-order", text: faNumber(need.orderNo || index + 1) }),
      node("div", { className: "need-copy" }, [
        node("strong", { text: need.title }),
        node("span", { text: need.category })
      ]),
      node("div", { className: "need-copy" }, [
        node("strong", { text: need.targetValue || "هدف ثبت نشده" }),
        node("span", { text: need.archived ? "این نیاز در صفحه عمومی نمایش داده نمی‌شود." : need.description })
      ]),
      statusBadge(need.archived ? "archived" : need.statusKey, true),
      node("div", { className: "need-actions" }, [
        node("div", { className: "order-actions" }, [
          node("button", {
            className: "order-button",
            type: "button",
            text: "↑",
            title: "انتقال به بالا",
            disabled: index === 0,
            onclick: () => moveNeed(index, -1)
          }),
          node("button", {
            className: "order-button",
            type: "button",
            text: "↓",
            title: "انتقال به پایین",
            disabled: index === needs.length - 1,
            onclick: () => moveNeed(index, 1)
          })
        ]),
        node("button", {
          className: "admin-button secondary",
          type: "button",
          text: "ویرایش",
          onclick: () => openNeedDialog(need)
        }),
        !need.archived ? node("button", {
          className: "admin-button danger",
          type: "button",
          text: "آرشیو",
          onclick: () => archiveNeed(need)
        }) : null
      ])
    ])
  ));
}

async function moveNeed(index, delta) {
  const ordered = state.needs.map(normalizedNeed).sort((a, b) => a.orderNo - b.orderNo);
  const target = index + delta;
  if (target < 0 || target >= ordered.length) return;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  try {
    await api(projectApiPath("needs/order"), {
      method: "PUT",
      body: JSON.stringify({ ids: ordered.map(need => need.id) })
    });
    await loadWorkspace({ silent: true });
    toast("ترتیب نیازها ذخیره شد.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function openNeedDialog(need = null) {
  const form = $("#needForm");
  form.reset();
  $("#needFormError").hidden = true;
  $("#needDialogTitle").textContent = need ? "ویرایش نیاز" : "افزودن نیاز";
  form.elements.id.value = need?.id || "";
  form.elements.title.value = need?.title || "";
  form.elements.category.value = need?.category || "";
  form.elements.targetValue.value = need?.targetValue || "";
  form.elements.description.value = need?.description || "";
  form.elements.requirements.value = need?.requirements || "";
  form.elements.orderNo.value = need?.orderNo || state.needs.length + 1;
  $("#needDialog").showModal();
  setTimeout(() => form.elements.title.focus(), 0);
}

async function saveNeed(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorTarget = $("#needFormError");
  errorTarget.hidden = true;
  if (!form.reportValidity()) return;
  const id = form.elements.id.value;
  const body = {
    title: form.elements.title.value.trim(),
    category: form.elements.category.value.trim(),
    targetValue: form.elements.targetValue.value.trim(),
    description: form.elements.description.value.trim(),
    requirements: form.elements.requirements.value.trim(),
    orderNo: Number(form.elements.orderNo.value)
  };
  setLoading($("#saveNeedButton"), true);
  try {
    await api(id
      ? `${projectApiPath("needs")}/${encodeURIComponent(id)}`
      : projectApiPath("needs"), {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(body)
    });
    $("#needDialog").close();
    await loadWorkspace({ silent: true });
    toast(id ? "نیاز به‌روزرسانی شد." : "نیاز جدید اضافه شد.");
  } catch (error) {
    errorTarget.textContent = errorMessage(error);
    errorTarget.hidden = false;
  } finally {
    setLoading($("#saveNeedButton"), false);
  }
}

async function archiveNeed(need) {
  if (!window.confirm(`نیاز «${need.title}» از صفحه عمومی آرشیو شود؟ پیشنهادهای قبلی حذف نمی‌شوند.`)) return;
  try {
    await api(`${projectApiPath("needs")}/${encodeURIComponent(need.id)}`, { method: "DELETE" });
    await loadWorkspace({ silent: true });
    toast("نیاز آرشیو شد.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function selectOptions(items, valueKey, labelBuilder, includeBlank = true) {
  const options = includeBlank ? [{ value: "", label: "انتخاب کنید" }] : [];
  return options.concat(items.map(item => ({
    value: String(item[valueKey]),
    label: labelBuilder(item)
  })));
}

function entityField(field) {
  const id = `entity-${field.name}`;
  if (field.type === "checkbox") {
    return node("label", { className: "entity-check", htmlFor: id }, [
      node("input", {
        id,
        name: field.name,
        type: "checkbox",
        checked: Boolean(field.value)
      }),
      node("span", {}, [
        node("strong", { text: field.label }),
        field.hint ? node("small", { text: field.hint }) : null
      ])
    ]);
  }
  let control;
  if (field.type === "select") {
    control = node("select", {
      id,
      name: field.name,
      required: Boolean(field.required)
    }, (field.options || []).map(option => node("option", {
      value: String(option.value),
      text: option.label,
      selected: String(option.value) === String(field.value ?? "")
    })));
  } else if (field.type === "textarea") {
    control = node("textarea", {
      id,
      name: field.name,
      value: field.value ?? "",
      rows: field.rows || 4,
      required: Boolean(field.required),
      maxLength: field.maxLength || 5000,
      placeholder: field.placeholder || ""
    });
  } else {
    control = node("input", {
      id,
      name: field.name,
      type: field.type || "text",
      value: field.value ?? "",
      required: Boolean(field.required),
      min: field.min,
      max: field.max,
      step: field.step,
      maxLength: field.maxLength,
      placeholder: field.placeholder || "",
      dir: field.dir || "auto"
    });
  }
  return node("label", { className: `field entity-field${field.wide ? " is-wide" : ""}`, htmlFor: id }, [
    node("span", { text: field.label }),
    control,
    field.hint ? node("small", { className: "field-hint", text: field.hint }) : null
  ]);
}

function openEntityDialog({
  eyebrow = "مرکز عملیات",
  title,
  description = "",
  submitLabel = "ذخیره",
  fields,
  onSubmit
}) {
  state.entityFields = fields;
  state.entitySubmit = onSubmit;
  $("#entityDialogEyebrow").textContent = eyebrow;
  $("#entityDialogTitle").textContent = title;
  $("#entityDialogDescription").textContent = description;
  $("#entityDialogDescription").hidden = !description;
  $("#saveEntityButton").textContent = submitLabel;
  $("#entityFormError").hidden = true;
  $("#entityFormError").textContent = "";
  replaceChildren("#entityFields", fields.map(entityField));
  if (!$("#entityDialog").open) $("#entityDialog").showModal();
  setTimeout(() => $("#entityFields input:not([type=hidden]), #entityFields select, #entityFields textarea")?.focus(), 0);
}

async function submitEntityForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity() || typeof state.entitySubmit !== "function") return;
  const values = {};
  for (const field of state.entityFields || []) {
    const control = form.elements[field.name];
    if (!control) continue;
    if (field.type === "checkbox") {
      values[field.name] = control.checked;
      continue;
    }
    const raw = String(control.value ?? "").trim();
    if (!raw && !field.required && field.omitEmpty !== false) continue;
    values[field.name] = field.type === "number" && raw !== "" ? Number(raw) : raw;
  }
  const errorTarget = $("#entityFormError");
  errorTarget.hidden = true;
  setLoading($("#saveEntityButton"), true);
  try {
    const result = await state.entitySubmit(values);
    $("#entityDialog").close();
    await loadWorkspace({ silent: true });
    toast(result?.message || "اطلاعات ذخیره شد.");
  } catch (error) {
    errorTarget.textContent = errorMessage(error);
    errorTarget.hidden = false;
  } finally {
    setLoading($("#saveEntityButton"), false);
  }
}

async function quickMutation(path, options, successMessage) {
  try {
    await api(path, options);
    await loadWorkspace({ silent: true });
    toast(successMessage);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function openNewProjectForm() {
  openEntityDialog({
    eyebrow: "پرتفوی",
    title: "ساخت پروژهٔ جدید",
    description: "پروژه ابتدا با هویت مستقل ساخته می‌شود و سپس منابع آن را تکمیل می‌کنید.",
    submitLabel: "ساخت پروژه",
    fields: [
      { name: "title", label: "عنوان پروژه", required: true, maxLength: 200 },
      { name: "slug", label: "نشانی کوتاه انگلیسی", required: true, maxLength: 80, dir: "ltr", placeholder: "new-project" },
      { name: "subtitle", label: "زیرعنوان", maxLength: 500, wide: true },
      { name: "summary", label: "معرفی کوتاه", type: "textarea", maxLength: 5000, wide: true },
      { name: "industry", label: "صنعت", maxLength: 120 },
      { name: "sector", label: "حوزه", maxLength: 120 },
      { name: "kind", label: "نوع پروژه", maxLength: 120 },
      {
        name: "stage",
        label: "مرحله",
        type: "select",
        value: "idea",
        options: Object.entries(projectStageLabels).map(([value, label]) => ({ value, label }))
      },
      { name: "currency", label: "واحد پول", value: "IRR", maxLength: 3, dir: "ltr" },
      { name: "budgetAmount", label: "بودجه", type: "number", min: 0 },
      { name: "valuationAmount", label: "ارزش‌گذاری", type: "number", min: 0 },
      { name: "location", label: "موقعیت", maxLength: 300 },
      { name: "leaderName", label: "راهبر پروژه", maxLength: 200 },
      { name: "targetDate", label: "موعد هدف", type: "date" },
      {
        name: "status",
        label: "وضعیت انتشار",
        type: "select",
        value: "draft",
        options: [{ value: "draft", label: "پیش‌نویس" }, { value: "published", label: "منتشرشده" }]
      }
    ],
    onSubmit: async values => {
      const payload = await api("/api/v1/admin/projects", {
        method: "POST",
        body: JSON.stringify(values)
      });
      const project = payload.project || payload;
      state.projectId = String(project.id || "");
      state.projectSlug = project.slug || "";
      return { message: "پروژهٔ جدید ساخته شد." };
    }
  });
}

async function toggleProjectArchive() {
  if (!state.project) return;
  const archived = Boolean(state.project.archivedAt || state.project.archived_at);
  if (archived) {
    await quickMutation(projectApiPath(), {
      method: "PATCH",
      body: JSON.stringify({ archived: false })
    }, "پروژه بازگردانی شد.");
    return;
  }
  const confirmed = window.confirm(
    `پروژهٔ «${state.project.title}» بایگانی شود؟ از پرتفوی عمومی خارج می‌شود اما سوابق آن باقی می‌ماند.`
  );
  if (!confirmed) return;
  try {
    const archivedId = state.projectId;
    await api(projectApiPath(), { method: "DELETE" });
    const nextProject = state.projects.find(project =>
      String(project.id) !== String(archivedId) && !project.archivedAt && !project.archived_at
    );
    state.projectId = nextProject ? String(nextProject.id) : "";
    state.projectSlug = nextProject?.slug || "";
    await loadWorkspace({ silent: true });
    startLiveUpdates();
    toast("پروژه بایگانی شد و سوابق آن در انتخاب‌گر باقی ماند.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function openStakeholderForm(item = null) {
  openEntityDialog({
    eyebrow: "ذی‌نفعان خصوصی",
    title: item ? "ویرایش ذی‌نفع" : "افزودن ذی‌نفع",
    submitLabel: item ? "ذخیره تغییرات" : "افزودن",
    fields: [
      { name: "name", label: "نام", required: true, value: item?.name, maxLength: 200 },
      {
        name: "kind",
        label: "نوع",
        type: "select",
        value: item?.kind || "person",
        options: [{ value: "person", label: "شخص" }, { value: "organization", label: "سازمان" }]
      },
      {
        name: "role",
        label: "نقش",
        type: "select",
        value: item?.role || "investor",
        options: Object.entries(stakeholderRoleLabels).map(([value, label]) => ({ value, label }))
      },
      { name: "mobile", label: "موبایل", value: item?.mobile, dir: "ltr" },
      { name: "email", label: "ایمیل", type: "email", value: item?.email, dir: "ltr", wide: true }
    ],
    onSubmit: async values => {
      await api(item
        ? `${projectApiPath("stakeholders")}/${encodeURIComponent(item.id)}`
        : projectApiPath("stakeholders"), {
        method: item ? "PATCH" : "POST",
        body: JSON.stringify(values)
      });
      return { message: item ? "ذی‌نفع به‌روزرسانی شد." : "ذی‌نفع اضافه شد." };
    }
  });
}

function archiveStakeholder(item) {
  if (!window.confirm(`ذی‌نفع «${item.name}» آرشیو شود؟ سوابق مالی و مالکیت حذف نمی‌شوند.`)) return;
  quickMutation(`${projectApiPath("stakeholders")}/${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true })
  }, "ذی‌نفع آرشیو شد.");
}

function restoreStakeholder(item) {
  quickMutation(`${projectApiPath("stakeholders")}/${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: false })
  }, "ذی‌نفع به فهرست فعال برگشت.");
}

function openShareClassForm(item = null) {
  openEntityDialog({
    eyebrow: "دفتر سرمایه",
    title: item ? "ویرایش طبقهٔ سرمایه" : "طبقهٔ سرمایهٔ جدید",
    fields: [
      { name: "name", label: "نام طبقه", required: true, value: item?.name, maxLength: 120 },
      { name: "symbol", label: "نماد", required: true, value: item?.symbol, maxLength: 20, dir: "ltr" },
      { name: "authorizedUnits", label: "سقف واحد مجاز", type: "number", min: 1, required: true, value: item?.authorizedUnits },
      { name: "votingWeight", label: "وزن رأی هر واحد", type: "number", min: 0, step: "0.01", required: true, value: item?.votingWeight ?? 1 }
    ],
    onSubmit: async values => {
      await api(item
        ? `${projectApiPath("share-classes")}/${encodeURIComponent(item.id)}`
        : projectApiPath("share-classes"), {
        method: item ? "PATCH" : "POST",
        body: JSON.stringify(values)
      });
      return { message: item ? "طبقهٔ سرمایه به‌روزرسانی شد." : "طبقهٔ سرمایه ساخته شد." };
    }
  });
}

function openIssuanceForm(classId = "") {
  const activeStakeholders = state.resources.stakeholders.filter(item => !item.archivedAt);
  if (!state.resources.shareClasses.length || !activeStakeholders.length) {
    toast("برای صدور واحد، طبقهٔ سرمایه و ذی‌نفع فعال لازم است.", "error");
    return;
  }
  const idempotencyKey = crypto.randomUUID();
  openEntityDialog({
    eyebrow: "صدور اولیه",
    title: "ثبت صدور واحد",
    description: "این ثبت به دفتر مالکیت افزوده می‌شود و حذف مستقیم ندارد.",
    submitLabel: "ثبت صدور",
    fields: [
      {
        name: "shareClassId",
        label: "طبقهٔ سرمایه",
        type: "select",
        value: classId,
        required: true,
        options: selectOptions(state.resources.shareClasses, "id", item => `${item.name} (${item.symbol})`)
      },
      {
        name: "stakeholderId",
        label: "دارنده",
        type: "select",
        required: true,
        options: selectOptions(activeStakeholders, "id", item => item.name)
      },
      { name: "units", label: "تعداد واحد", type: "number", min: 1, required: true },
      { name: "note", label: "یادداشت داخلی", type: "textarea", maxLength: 2000, wide: true }
    ],
    onSubmit: async values => {
      const shareClassId = values.shareClassId;
      delete values.shareClassId;
      await api(`${projectApiPath("share-classes")}/${encodeURIComponent(shareClassId)}/issuances`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(values)
      });
      return { message: "صدور واحد در دفتر ثبت شد." };
    }
  });
}

function openOfferForm() {
  const activeStakeholders = state.resources.stakeholders.filter(item => !item.archivedAt);
  if (!state.resources.shareClasses.length || !activeStakeholders.length) {
    toast("برای ثبت عرضه، طبقهٔ سرمایه و ذی‌نفع فعال لازم است.", "error");
    return;
  }
  const idempotencyKey = crypto.randomUUID();
  const people = selectOptions(activeStakeholders, "id", item => item.name);
  openEntityDialog({
    eyebrow: "بازار داخلی",
    title: "ثبت عرضهٔ خرید یا فروش",
    description: "برای فروش، فروشنده و برای خرید، خریدار را مشخص کنید.",
    fields: [
      {
        name: "shareClassId",
        label: "طبقهٔ سرمایه",
        type: "select",
        required: true,
        options: selectOptions(state.resources.shareClasses, "id", item => `${item.name} (${item.symbol})`)
      },
      {
        name: "side",
        label: "نوع عرضه",
        type: "select",
        value: "sell",
        options: [{ value: "sell", label: "فروش" }, { value: "buy", label: "خرید" }]
      },
      { name: "sellerStakeholderId", label: "فروشنده (برای فروش)", type: "select", options: people },
      { name: "buyerStakeholderId", label: "خریدار (برای خرید)", type: "select", options: people },
      { name: "units", label: "تعداد واحد", type: "number", min: 1, required: true },
      { name: "unitPrice", label: "قیمت هر واحد", type: "number", min: 0, required: true },
      { name: "availableUntil", label: "مهلت عرضه", type: "date" },
      { name: "note", label: "یادداشت", type: "textarea", maxLength: 2000, wide: true }
    ],
    onSubmit: async values => {
      await api(projectApiPath("share-offers"), {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(values)
      });
      return { message: "عرضهٔ سرمایه ثبت شد." };
    }
  });
}

function cancelOffer(offer) {
  if (!window.confirm("این عرضه لغو شود؟ عرضهٔ بسته‌شده دوباره باز نمی‌شود.")) return;
  quickMutation(`${projectApiPath("share-offers")}/${encodeURIComponent(offer.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" })
  }, "عرضه لغو شد.");
}

function openTransferForm() {
  const activeStakeholders = state.resources.stakeholders.filter(item => !item.archivedAt);
  if (!state.resources.shareClasses.length || activeStakeholders.length < 2) {
    toast("برای انتقال، یک طبقهٔ سرمایه و دست‌کم دو ذی‌نفع فعال لازم است.", "error");
    return;
  }
  const idempotencyKey = crypto.randomUUID();
  const people = selectOptions(activeStakeholders, "id", item => item.name);
  const openOffers = state.resources.shareOffers.filter(item => ["open", "partially_filled"].includes(item.status));
  openEntityDialog({
    eyebrow: "گردش مالکیت",
    title: "ثبت درخواست انتقال",
    description: "تأیید نهایی انتقال بعداً و با کنترل مانده انجام می‌شود.",
    fields: [
      {
        name: "shareClassId",
        label: "طبقهٔ سرمایه",
        type: "select",
        required: true,
        options: selectOptions(state.resources.shareClasses, "id", item => `${item.name} (${item.symbol})`)
      },
      {
        name: "offerId",
        label: "عرضهٔ مرتبط (اختیاری)",
        type: "select",
        options: selectOptions(openOffers, "id", item => `${item.side === "sell" ? "فروش" : "خرید"} · ${faNumber(item.remainingUnits)} واحد`)
      },
      { name: "fromStakeholderId", label: "انتقال‌دهنده", type: "select", required: true, options: people },
      { name: "toStakeholderId", label: "دریافت‌کننده", type: "select", required: true, options: people },
      { name: "units", label: "تعداد واحد", type: "number", min: 1, required: true },
      { name: "priceAmount", label: "مبلغ کل", type: "number", min: 0 },
      {
        name: "status",
        label: "وضعیت شروع",
        type: "select",
        value: "pending",
        options: [{ value: "draft", label: "پیش‌نویس" }, { value: "pending", label: "منتظر تصمیم" }]
      },
      { name: "note", label: "یادداشت داخلی", type: "textarea", maxLength: 2000, wide: true }
    ],
    onSubmit: async values => {
      await api(projectApiPath("share-transfers"), {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(values)
      });
      return { message: "درخواست انتقال ثبت شد." };
    }
  });
}

function transitionTransfer(transfer, status) {
  if (status === "pending") {
    quickMutation(`${projectApiPath("share-transfers")}/${encodeURIComponent(transfer.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    }, "انتقال برای تصمیم ارسال شد.");
    return;
  }
  const labels = { approved: "تأیید انتقال", rejected: "رد انتقال", cancelled: "لغو انتقال" };
  openEntityDialog({
    eyebrow: "تصمیم انتقال",
    title: labels[status],
    description: status === "approved"
      ? "با تأیید، دفتر مالکیت به‌صورت تراکنشی تغییر می‌کند. تسویه بانکی بیرون سامانه است."
      : "دلیل تصمیم در سابقهٔ داخلی نگهداری می‌شود.",
    submitLabel: labels[status],
    fields: [{ name: "decisionNote", label: "یادداشت تصمیم", type: "textarea", maxLength: 2000, wide: true }],
    onSubmit: async values => {
      await api(`${projectApiPath("share-transfers")}/${encodeURIComponent(transfer.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status, ...values })
      });
      return { message: `انتقال ${transferStatusLabels[status]} شد.` };
    }
  });
}

function openFinancialEntryForm() {
  const stakeholderOptions = selectOptions(
    state.resources.stakeholders.filter(item => !item.archivedAt),
    "id",
    item => item.name
  );
  const idempotencyKey = crypto.randomUUID();
  openEntityDialog({
    eyebrow: "دفتر مالی",
    title: "ثبت رویداد مالی",
    description: "برای اصلاح بعدی، رکورد معکوس ساخته می‌شود و اصل ثبت باقی می‌ماند.",
    fields: [
      {
        name: "type",
        label: "نوع ثبت",
        type: "select",
        value: "revenue",
        options: Object.entries(financialTypeLabels).map(([value, label]) => ({ value, label }))
      },
      { name: "amount", label: "مبلغ", type: "number", min: 0, required: true },
      { name: "occurredOn", label: "تاریخ وقوع", type: "date", required: true, value: new Date().toISOString().slice(0, 10) },
      { name: "stakeholderId", label: "ذی‌نفع مرتبط (اختیاری)", type: "select", options: stakeholderOptions },
      { name: "description", label: "شرح", type: "textarea", maxLength: 2000, wide: true }
    ],
    onSubmit: async values => {
      await api(projectApiPath("financial-entries"), {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(values)
      });
      return { message: "رویداد مالی ثبت شد." };
    }
  });
}

function openReversalForm(entry) {
  openEntityDialog({
    eyebrow: "رد حسابرسی",
    title: "ثبت اصلاحیهٔ مالی",
    description: `برای «${entry.description || financialTypeLabels[entry.type]}» یک ثبت معکوس ساخته می‌شود.`,
    submitLabel: "ثبت اصلاحیه",
    fields: [
      { name: "occurredOn", label: "تاریخ اصلاح", type: "date", required: true, value: new Date().toISOString().slice(0, 10) },
      { name: "description", label: "دلیل اصلاح", type: "textarea", value: `اصلاح ثبت ${entry.id}`, maxLength: 2000, wide: true }
    ],
    onSubmit: async values => {
      await api(`${projectApiPath("financial-entries")}/${encodeURIComponent(entry.id)}/reversal`, {
        method: "POST",
        body: JSON.stringify(values)
      });
      return { message: "اصلاحیهٔ مالی ثبت شد." };
    }
  });
}

function openGoalForm() {
  openEntityDialog({
    eyebrow: "عملکرد عملیاتی",
    title: "افزودن هدف وزن‌دار",
    fields: [
      { name: "title", label: "عنوان هدف", required: true, maxLength: 200 },
      { name: "weight", label: "وزن هدف", type: "number", min: 0.01, step: "0.01", required: true, value: 1 },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        value: "planned",
        options: [
          { value: "planned", label: "برنامه‌ریزی‌شده" },
          { value: "active", label: "فعال" },
          { value: "completed", label: "تکمیل‌شده" }
        ]
      },
      { name: "dueDate", label: "موعد", type: "date" },
      { name: "description", label: "شرح هدف", type: "textarea", maxLength: 2000, wide: true }
    ],
    onSubmit: async values => {
      await api(projectApiPath("goals"), { method: "POST", body: JSON.stringify(values) });
      return { message: "هدف عملیاتی ثبت شد." };
    }
  });
}

function patchGoalStatus(goal, status) {
  quickMutation(`${projectApiPath("goals")}/${encodeURIComponent(goal.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  }, "وضعیت هدف به‌روزرسانی شد.");
}

function openMilestoneForm(goal) {
  openEntityDialog({
    eyebrow: "هدف عملیاتی",
    title: `نقطهٔ عطف برای «${goal.title}»`,
    fields: [
      { name: "title", label: "عنوان نقطهٔ عطف", required: true, maxLength: 200 },
      { name: "weight", label: "وزن", type: "number", min: 0.01, step: "0.01", required: true, value: 1 },
      { name: "completed", label: "همین حالا تکمیل‌شده ثبت شود", type: "checkbox" }
    ],
    onSubmit: async values => {
      await api(`${projectApiPath("goals")}/${encodeURIComponent(goal.id)}/milestones`, {
        method: "POST",
        body: JSON.stringify(values)
      });
      return { message: "نقطهٔ عطف اضافه شد." };
    }
  });
}

function toggleMilestone(goal, milestone) {
  quickMutation(
    `${projectApiPath("goals")}/${encodeURIComponent(goal.id)}/milestones/${encodeURIComponent(milestone.id)}`,
    { method: "PATCH", body: JSON.stringify({ completed: !milestone.completed }) },
    milestone.completed ? "نقطهٔ عطف دوباره باز شد." : "نقطهٔ عطف تکمیل شد."
  );
}

function openMeetingForm() {
  openEntityDialog({
    eyebrow: "حاکمیت",
    title: "برنامه‌ریزی جلسه",
    fields: [
      { name: "title", label: "عنوان جلسه", required: true, maxLength: 200 },
      { name: "scheduledAt", label: "زمان جلسه", type: "datetime-local", required: true },
      { name: "location", label: "محل یا لینک جلسه", maxLength: 300 },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        value: "scheduled",
        options: [{ value: "scheduled", label: "برنامه‌ریزی‌شده" }, { value: "held", label: "برگزارشده" }]
      },
      { name: "publicVisible", label: "در صفحهٔ عمومی نمایش داده شود", type: "checkbox", hint: "صورت جلسه و مصوبات عمومی نیز باید جداگانه کنترل شوند." },
      { name: "minutes", label: "صورت جلسه / خلاصه", type: "textarea", maxLength: 20000, wide: true }
    ],
    onSubmit: async values => {
      const scheduledAt = new Date(values.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new Error("زمان جلسه معتبر نیست.");
      }
      await api(projectApiPath("meetings"), {
        method: "POST",
        body: JSON.stringify({ ...values, scheduledAt: scheduledAt.toISOString() })
      });
      return { message: "جلسه ثبت شد." };
    }
  });
}

function patchMeetingStatus(meeting, status) {
  quickMutation(`${projectApiPath("meetings")}/${encodeURIComponent(meeting.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  }, "وضعیت جلسه به‌روزرسانی شد.");
}

function openAttendanceForm(meeting) {
  const members = state.resources.stakeholders.filter(item => !item.archivedAt);
  if (!members.length) {
    toast("برای ثبت حضور، ذی‌نفع فعال لازم است.", "error");
    return;
  }
  openEntityDialog({
    eyebrow: "حضور جلسه",
    title: `مدیریت حضور «${meeting.title}»`,
    description: "ثبت دوبارهٔ یک عضو، وضعیت حضور قبلی او را به‌روزرسانی می‌کند.",
    submitLabel: "ثبت حضور",
    fields: [
      {
        name: "stakeholderId",
        label: "عضو جلسه",
        type: "select",
        required: true,
        options: selectOptions(members, "id", item => `${item.name} · ${stakeholderRoleLabels[item.role] || item.role}`)
      },
      {
        name: "attendance",
        label: "وضعیت حضور",
        type: "select",
        value: "present",
        options: Object.entries(attendanceLabels).map(([value, label]) => ({ value, label }))
      }
    ],
    onSubmit: async values => {
      const stakeholderId = values.stakeholderId;
      delete values.stakeholderId;
      await api(
        `${projectApiPath("meetings")}/${encodeURIComponent(meeting.id)}/attendees/${encodeURIComponent(stakeholderId)}`,
        { method: "PUT", body: JSON.stringify(values) }
      );
      return { message: "وضعیت حضور ثبت شد." };
    }
  });
}

function openResolutionForm(meeting) {
  openEntityDialog({
    eyebrow: "دستور جلسه",
    title: "افزودن مصوبه",
    fields: [
      { name: "title", label: "عنوان مصوبه", required: true, maxLength: 300 },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        value: "draft",
        options: [{ value: "draft", label: "پیش‌نویس" }, { value: "open", label: "رأی‌گیری باز" }, { value: "closed", label: "بسته" }]
      },
      { name: "publicVisible", label: "مصوبه عمومی باشد", type: "checkbox" },
      { name: "description", label: "شرح", type: "textarea", maxLength: 5000, wide: true },
      { name: "decision", label: "متن تصمیم (در صورت بسته‌بودن)", type: "textarea", maxLength: 5000, wide: true }
    ],
    onSubmit: async values => {
      await api(`${projectApiPath("meetings")}/${encodeURIComponent(meeting.id)}/resolutions`, {
        method: "POST",
        body: JSON.stringify(values)
      });
      return { message: "مصوبه ثبت شد." };
    }
  });
}

function patchResolutionStatus(meeting, resolution, status) {
  quickMutation(
    `${projectApiPath("meetings")}/${encodeURIComponent(meeting.id)}/resolutions/${encodeURIComponent(resolution.id)}`,
    { method: "PATCH", body: JSON.stringify({ status }) },
    "وضعیت مصوبه به‌روزرسانی شد."
  );
}

function openCloseResolutionForm(meeting, resolution) {
  openEntityDialog({
    eyebrow: "نتیجهٔ رأی‌گیری",
    title: "بستن مصوبه و ثبت تصمیم",
    submitLabel: "بستن مصوبه",
    fields: [{ name: "decision", label: "متن تصمیم نهایی", type: "textarea", required: true, maxLength: 5000, wide: true }],
    onSubmit: async values => {
      await api(
        `${projectApiPath("meetings")}/${encodeURIComponent(meeting.id)}/resolutions/${encodeURIComponent(resolution.id)}`,
        { method: "PATCH", body: JSON.stringify({ status: "closed", ...values }) }
      );
      return { message: "مصوبه بسته و تصمیم ثبت شد." };
    }
  });
}

function openVoteForm(meeting, resolution) {
  const voters = state.resources.stakeholders.filter(item => !item.archivedAt);
  if (!voters.length) {
    toast("برای ثبت رأی، ذی‌نفع فعال لازم است.", "error");
    return;
  }
  openEntityDialog({
    eyebrow: "رأی با وزن ثبت‌شده",
    title: `ثبت رأی برای «${resolution.title}»`,
    description: "وزن رأی در نخستین ثبت از دفتر مالکیت snapshot می‌شود و در ویرایش رأی ثابت می‌ماند.",
    submitLabel: "ثبت رأی",
    fields: [
      {
        name: "stakeholderId",
        label: "رأی‌دهنده",
        type: "select",
        required: true,
        options: selectOptions(voters, "id", item => `${item.name} · ${stakeholderRoleLabels[item.role] || item.role}`)
      },
      {
        name: "choice",
        label: "انتخاب",
        type: "select",
        value: "yes",
        options: [{ value: "yes", label: "موافق" }, { value: "no", label: "مخالف" }, { value: "abstain", label: "ممتنع" }]
      }
    ],
    onSubmit: async values => {
      await api(
        `${projectApiPath("meetings")}/${encodeURIComponent(meeting.id)}/resolutions/${encodeURIComponent(resolution.id)}/votes`,
        { method: "POST", body: JSON.stringify(values) }
      );
      return { message: "رأی ثبت شد." };
    }
  });
}

function projectFieldValue(project, camel, snake = "") {
  return project?.[camel] ?? (snake ? project?.[snake] : "") ?? "";
}

function fillProjectForm() {
  if (!state.project) return;
  const form = $("#projectForm");
  const values = {
    title: projectFieldValue(state.project, "title"),
    slug: projectFieldValue(state.project, "slug"),
    subtitle: projectFieldValue(state.project, "subtitle"),
    summary: projectFieldValue(state.project, "summary"),
    location: projectFieldValue(state.project, "location"),
    industry: projectFieldValue(state.project, "industry"),
    sector: projectFieldValue(state.project, "sector"),
    kind: projectFieldValue(state.project, "kind"),
    stage: projectFieldValue(state.project, "stage") || "idea",
    currency: projectFieldValue(state.project, "currency") || "IRR",
    budgetAmount: projectFieldValue(state.project, "budgetAmount", "budget_amount"),
    valuationAmount: projectFieldValue(state.project, "valuationAmount", "valuation_amount"),
    startDate: String(projectFieldValue(state.project, "startDate", "start_date")).slice(0, 10),
    timeline: projectFieldValue(state.project, "timeline"),
    targetDate: String(projectFieldValue(state.project, "targetDate", "target_date")).slice(0, 10),
    leaderName: projectFieldValue(state.project, "leaderName", "leader_name"),
    leaderDescription: projectFieldValue(state.project, "leaderDescription", "leader_description"),
    processDescription: projectFieldValue(state.project, "processDescription", "process_description"),
    status: projectFieldValue(state.project, "status") || "draft"
  };
  for (const [name, value] of Object.entries(values)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value;
  }
  if (form.elements.isDefault && document.activeElement !== form.elements.isDefault) {
    form.elements.isDefault.checked = Boolean(projectFieldValue(state.project, "isDefault", "is_default"));
  }
}

async function saveProject(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const body = Object.fromEntries(new FormData(form).entries());
  body.isDefault = form.elements.isDefault.checked;
  ["budgetAmount", "valuationAmount"].forEach(key => {
    if (body[key] === "") delete body[key];
    else body[key] = Number(body[key]);
  });
  setLoading($("#saveProjectButton"), true);
  $("#projectSaveState").textContent = "در حال ذخیره…";
  try {
    const previousSlug = state.projectSlug;
    let payload;
    try {
      payload = await api(projectApiPath(), { method: "PATCH", body: JSON.stringify(body) });
    } catch (error) {
      if (error.status !== 404) throw error;
      payload = await api("/api/v1/admin/project", { method: "PUT", body: JSON.stringify(body) });
    }
    state.project = payload.project || payload;
    state.projectSlug = state.project.slug || state.projectSlug;
    if (state.project.isDefault || body.isDefault) state.sessionProjectSlug = state.projectSlug;
    $("#projectSaveState").textContent = "تغییرات ذخیره شد.";
    $("#publicProjectLink").href = `/projects/${encodeURIComponent(state.projectSlug)}`;
    await loadWorkspace({ silent: true });
    if (previousSlug !== state.projectSlug) startLiveUpdates();
    toast("اطلاعات پروژه ذخیره شد.");
  } catch (error) {
    $("#projectSaveState").textContent = errorMessage(error);
    toast(errorMessage(error), "error");
  } finally {
    setLoading($("#saveProjectButton"), false);
  }
}

function setView(view) {
  state.activeView = view;
  const titles = {
    overview: ["امروز در پروژه", "نمای کلی"],
    proposals: ["مدیریت سرنخ‌ها", "پیشنهادها"],
    needs: ["ساختار مشارکت", "نیازهای پروژه"],
    stakeholders: ["اطلاعات خصوصی", "ذی‌نفعان"],
    capital: ["دفتر مالکیت", "سرمایه و دارایی"],
    transfers: ["گردش مالکیت", "عرضه و انتقال"],
    finance: ["دفتر مالی", "سود و زیان و ROI"],
    goals: ["عملکرد عملیاتی", "اهداف و نقاط عطف"],
    governance: ["حاکمیت", "جلسات و مصوبات"],
    project: ["پرتفوی و انتشار", "پروژه‌ها و تنظیمات"]
  };
  $$(".admin-view").forEach(section => { section.hidden = section.id !== `view-${view}`; });
  $$(".nav-item").forEach(button => button.classList.toggle("is-active", button.dataset.view === view));
  const title = titles[view] || titles.overview;
  $("#viewEyebrow").textContent = title[0];
  $("#viewTitle").textContent = title[1];
  closeSidebar();
  document.querySelector(".admin-content").scrollIntoView({ block: "start" });
}

function openSidebar() {
  $("#adminSidebar").classList.add("is-open");
  $("#sidebarBackdrop").hidden = false;
  $("#sidebarToggle").setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  $("#adminSidebar").classList.remove("is-open");
  $("#sidebarBackdrop").hidden = true;
  $("#sidebarToggle").setAttribute("aria-expanded", "false");
}

$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const password = $("#adminPassword").value;
  $("#loginError").hidden = true;
  $("#passwordError").textContent = "";
  if (password.length < 12) {
    $("#passwordError").textContent = "رمز مدیریت حداقل ۱۲ نویسه است.";
    $("#adminPassword").focus();
    return;
  }
  setLoading($("#loginButton"), true);
  try {
    const session = await api("/api/v1/admin/session", {
      method: "POST",
      body: JSON.stringify({ password })
    });
    $("#loginForm").reset();
    await showDashboard(session);
  } catch (error) {
    $("#loginError").textContent = error.status === 429
      ? "تعداد تلاش‌ها زیاد است. چند دقیقه بعد دوباره امتحان کنید."
      : errorMessage(error);
    $("#loginError").hidden = false;
  } finally {
    setLoading($("#loginButton"), false);
  }
});

$("#logoutButton").addEventListener("click", async () => {
  const button = $("#logoutButton");
  setLoading(button, true);
  try {
    await api("/api/v1/admin/session", { method: "DELETE" });
    window.location.replace("/admin");
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("/admin");
      return;
    }
    toast(
      navigator.onLine
        ? `خروج انجام نشد: ${errorMessage(error)}`
        : "خروج انجام نشد؛ اتصال شبکه را برقرار و دوباره تلاش کنید.",
      "error"
    );
  } finally {
    setLoading(button, false);
  }
});

$$(".nav-item").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
$$("[data-go-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.goView)));
$("#refreshButton").addEventListener("click", () => loadWorkspace());
$("#sidebarToggle").addEventListener("click", () => {
  if ($("#adminSidebar").classList.contains("is-open")) closeSidebar();
  else openSidebar();
});
$("#sidebarBackdrop").addEventListener("click", closeSidebar);
$("#projectSwitcher").addEventListener("change", async event => {
  if (!event.target.value || event.target.value === state.projectId) return;
  state.projectId = event.target.value;
  state.proposalStatus = "";
  state.proposalSearch = "";
  $("#proposalSearch").value = "";
  $$("#proposalFilters .filter-chip").forEach(item => {
    item.classList.toggle("is-active", item.dataset.status === "");
  });
  await loadWorkspace();
  startLiveUpdates();
});
$("#proposalSearch").addEventListener("input", event => {
  state.proposalSearch = event.target.value;
  renderProposals();
});
$("#proposalFilters").addEventListener("click", event => {
  const button = event.target.closest("[data-status]");
  if (!button) return;
  state.proposalStatus = button.dataset.status;
  $$("#proposalFilters .filter-chip").forEach(item => item.classList.toggle("is-active", item === button));
  renderProposals();
});
$("#closeProposalDialog").addEventListener("click", () => $("#proposalDialog").close());
$("#proposalDialog").addEventListener("click", event => {
  if (event.target === $("#proposalDialog")) $("#proposalDialog").close();
});
$("#newNeedButton").addEventListener("click", () => openNeedDialog());
$("#newProjectButton").addEventListener("click", openNewProjectForm);
$("#newProjectInlineButton").addEventListener("click", openNewProjectForm);
$("#archiveProjectButton").addEventListener("click", toggleProjectArchive);
$("#newStakeholderButton").addEventListener("click", () => openStakeholderForm());
$("#newShareClassButton").addEventListener("click", () => openShareClassForm());
$("#issueSharesButton").addEventListener("click", () => openIssuanceForm());
$("#newOfferButton").addEventListener("click", openOfferForm);
$("#newTransferButton").addEventListener("click", openTransferForm);
$("#newFinancialEntryButton").addEventListener("click", openFinancialEntryForm);
$("#newGoalButton").addEventListener("click", openGoalForm);
$("#newMeetingButton").addEventListener("click", openMeetingForm);
$("#closeNeedDialog").addEventListener("click", () => $("#needDialog").close());
$("#cancelNeedButton").addEventListener("click", () => $("#needDialog").close());
$("#needForm").addEventListener("submit", saveNeed);
$("#projectForm").addEventListener("submit", saveProject);
$("#closeEntityDialog").addEventListener("click", () => $("#entityDialog").close());
$("#cancelEntityButton").addEventListener("click", () => $("#entityDialog").close());
$("#entityForm").addEventListener("submit", submitEntityForm);
$("#entityDialog").addEventListener("click", event => {
  if (event.target === $("#entityDialog")) $("#entityDialog").close();
});
window.addEventListener("offline", () => setConnection("error", "اتصال اینترنت قطع است"));
window.addEventListener("online", () => loadWorkspace({ silent: true }));
window.addEventListener("beforeunload", stopLiveUpdates);

boot();

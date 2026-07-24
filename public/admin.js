const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  csrfToken: "",
  projectSlug: "",
  project: null,
  needs: [],
  proposals: [],
  summary: {},
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

async function loadAllProposals() {
  const proposals = [];
  let summary = {};
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const payload = await api(`/api/v1/admin/proposals?limit=200&offset=${offset}`);
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

async function loadWorkspace({ silent = false } = {}) {
  if (!silent) setConnection("idle", "در حال به‌روزرسانی");
  try {
    const previousSlug = state.projectSlug;
    const [projectPayload, proposalPayload] = await Promise.all([
      api("/api/v1/admin/project"),
      loadAllProposals()
    ]);
    state.project = projectPayload.project || projectPayload;
    state.needs = projectPayload.needs || state.project?.needs || [];
    state.projectSlug = state.project?.slug || state.projectSlug;
    state.proposals = proposalPayload.proposals || [];
    state.summary = proposalPayload.summary || {};
    $("#publicProjectLink").href = state.projectSlug ? `/projects/${encodeURIComponent(state.projectSlug)}` : "/";
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
  if (state.projectSlug && "EventSource" in window) {
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
  renderKpis();
  renderRecentProposals();
  renderAttentionNeeds();
  renderProposals();
  renderNeeds();
  fillProjectForm();
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
    const payload = await api(`/api/v1/admin/proposals/${encodeURIComponent(id)}`);
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
    const payload = await api(`/api/v1/admin/proposals/${encodeURIComponent(proposal.id)}`, {
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
    await api("/api/v1/admin/needs/order", {
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
    await api(id ? `/api/v1/admin/needs/${encodeURIComponent(id)}` : "/api/v1/admin/needs", {
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
    await api(`/api/v1/admin/needs/${encodeURIComponent(need.id)}`, { method: "DELETE" });
    await loadWorkspace({ silent: true });
    toast("نیاز آرشیو شد.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
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
}

async function saveProject(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const body = Object.fromEntries(new FormData(form).entries());
  setLoading($("#saveProjectButton"), true);
  $("#projectSaveState").textContent = "در حال ذخیره…";
  try {
    const previousSlug = state.projectSlug;
    const payload = await api("/api/v1/admin/project", { method: "PUT", body: JSON.stringify(body) });
    state.project = payload.project || payload;
    state.projectSlug = state.project.slug || state.projectSlug;
    $("#projectSaveState").textContent = "تغییرات ذخیره شد.";
    $("#publicProjectLink").href = `/projects/${encodeURIComponent(state.projectSlug)}`;
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
    project: ["اطلاعات عمومی", "تنظیمات پروژه"]
  };
  $$(".admin-view").forEach(section => { section.hidden = section.id !== `view-${view}`; });
  $$(".nav-item").forEach(button => button.classList.toggle("is-active", button.dataset.view === view));
  $("#viewEyebrow").textContent = titles[view][0];
  $("#viewTitle").textContent = titles[view][1];
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
  try {
    await api("/api/v1/admin/session", { method: "DELETE" });
  } catch {
    // Session is removed locally even if the request cannot be completed.
  }
  showLogin();
});

$$(".nav-item").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
$$("[data-go-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.goView)));
$("#refreshButton").addEventListener("click", () => loadWorkspace());
$("#sidebarToggle").addEventListener("click", () => {
  if ($("#adminSidebar").classList.contains("is-open")) closeSidebar();
  else openSidebar();
});
$("#sidebarBackdrop").addEventListener("click", closeSidebar);
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
$("#closeNeedDialog").addEventListener("click", () => $("#needDialog").close());
$("#cancelNeedButton").addEventListener("click", () => $("#needDialog").close());
$("#needForm").addEventListener("submit", saveNeed);
$("#projectForm").addEventListener("submit", saveProject);
window.addEventListener("offline", () => setConnection("error", "اتصال اینترنت قطع است"));
window.addEventListener("online", () => loadWorkspace({ silent: true }));
window.addEventListener("beforeunload", stopLiveUpdates);

boot();

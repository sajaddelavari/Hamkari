const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const dom = {
  authView: $("#authView"),
  workspaceView: $("#workspaceView"),
  accountStep: $("#accountLoginStep"),
  mfaStep: $("#mfaStep"),
  resetStep: $("#resetStep"),
  accountForm: $("#accountLoginForm"),
  accountError: $("#accountLoginError"),
  mfaForm: $("#mfaForm"),
  mfaError: $("#mfaError"),
  resetForm: $("#resetRequestForm"),
  resetMessage: $("#resetMessage"),
  legacyForm: $("#legacyLoginForm"),
  legacyError: $("#legacyLoginError"),
  bootstrapDialog: $("#bootstrapDialog"),
  bootstrapForm: $("#bootstrapForm"),
  bootstrapError: $("#bootstrapError"),
  organizationSelect: $("#organizationSelect"),
  projectSelect: $("#projectSelect"),
  workspaceNav: $("#workspaceNav"),
  sidebar: $("#workspaceSidebar"),
  sidebarBackdrop: $("#sidebarBackdrop"),
  pageBody: $("#pageBody"),
  pageTitle: $("#pageTitle"),
  pageDescription: $("#pageDescription"),
  pageBreadcrumb: $("#pageBreadcrumb"),
  pageActions: $("#pageActions"),
  pageAlert: $("#pageAlert"),
  content: $("#workspaceContent"),
  connectionStatus: $("#connectionStatus"),
  profileButton: $("#profileButton"),
  profileMenu: $("#profileMenu"),
  profileName: $("#profileName"),
  profileAvatar: $("#profileAvatar"),
  sidebarAvatar: $("#sidebarAvatar"),
  sidebarUserName: $("#sidebarUserName"),
  sidebarUserRole: $("#sidebarUserRole"),
  notificationButton: $("#notificationButton"),
  notificationDrawer: $("#notificationDrawer"),
  notificationList: $("#notificationList"),
  notificationBadge: $("#notificationBadge"),
  proposalBadge: $("#proposalBadge"),
  toastRegion: $("#toastRegion"),
  entityDialog: $("#entityDialog"),
  entityForm: $("#entityForm"),
  dialogKicker: $("#dialogKicker"),
  dialogTitle: $("#dialogTitle"),
  dialogFields: $("#dialogFields"),
  dialogError: $("#dialogError"),
  dialogSubmit: $("#dialogSubmitButton"),
};

const state = {
  authenticated: false,
  csrfToken: "",
  legacyCsrfToken: "",
  user: null,
  organizations: [],
  projects: [],
  organizationId: "",
  projectId: "",
  dashboard: null,
  activeView: "overview",
  organizationPermissions: new Set(),
  permissions: new Set(),
  projectRole: null,
  pendingLogin: null,
  dialogSubmit: null,
  renderSequence: 0,
  notificationTimer: null,
  notifications: [],
  online: navigator.onLine,
};

const labels = {
  roles: {
    owner: "مالک سازمان",
    admin: "مدیر سازمان",
    project_manager: "مدیر پروژه",
    contributor: "همکار پروژه",
    finance: "مدیر مالی",
    board: "عضو هیئت‌مدیره",
    auditor: "حسابرس",
    viewer: "مشاهده‌گر",
  },
  projectStatus: {
    draft: "پیش‌نویس",
    published: "منتشرشده",
    private: "خصوصی",
    archived: "آرشیوشده",
  },
  lifecycle: {
    idea: "ایده",
    feasibility: "امکان‌سنجی",
    fundraising: "جذب سرمایه",
    planning: "برنامه‌ریزی",
    executing: "در حال اجرا",
    operating: "بهره‌برداری",
    paused: "متوقف",
    on_hold: "متوقف",
    completed: "تکمیل‌شده",
    cancelled: "لغوشده",
  },
  status: {
    new: "جدید",
    contacted: "تماس گرفته‌شده",
    negotiating: "در مذاکره",
    accepted: "پذیرفته‌شده",
    rejected: "ردشده",
    open: "باز",
    closed: "بسته",
    active: "فعال",
    inactive: "غیرفعال",
    available: "آماده",
    allocated: "تخصیص‌یافته",
    unavailable: "غیردردسترس",
    retired: "بازنشسته",
    planned: "برنامه‌ریزی‌شده",
    completed: "تکمیل‌شده",
    blocked: "مسدود",
    cancelled: "لغوشده",
    backlog: "صف کار",
    todo: "آماده انجام",
    in_progress: "در حال انجام",
    review: "بازبینی",
    done: "انجام‌شده",
    mitigating: "در حال کنترل",
    resolved: "حل‌شده",
    draft: "پیش‌نویس",
    approved: "تأییدشده",
    posted: "ثبت قطعی",
    reversed: "برگشت‌خورده",
    pending: "در انتظار",
    failed: "ناموفق",
    paid: "پرداخت‌شده",
    issued: "صادرشده",
    void: "باطل",
    verified: "تأییدشده",
    needs_review: "نیازمند بازبینی",
    signed: "امضاشده",
    published: "منتشرشده",
    archived: "آرشیوشده",
    scheduled: "برنامه‌ریزی‌شده",
    held: "برگزارشده",
    partially_filled: "تکمیل جزئی",
    filled: "تکمیل‌شده",
    submitted: "در انتظار تأیید",
    ready: "آماده بهره‌برداری",
    operating: "در بهره‌برداری",
    attention_required: "نیازمند رسیدگی",
    suspended: "بهره‌برداری متوقف",
    waived: "صرف‌نظرشده",
    not_started: "شروع‌نشده",
  },
  taskPriority: {
    low: "کم",
    medium: "متوسط",
    high: "زیاد",
    critical: "بحرانی",
  },
  riskBand: {
    low: "کم",
    medium: "متوسط",
    high: "زیاد",
    critical: "بحرانی",
  },
};

const viewMeta = {
  overview: {
    title: "نمای کلی",
    description: "وضعیت امروز پروژه‌ها، سرمایه و تصمیم‌های در انتظار را ببینید.",
    scope: "organization",
    permission: "organization.read",
  },
  portfolio: {
    title: "سبد پروژه‌ها",
    description: "همهٔ پروژه‌ها و طرح‌های سازمان را از ایده تا بهره‌برداری مدیریت کنید.",
    scope: "organization",
    permission: "organization.read",
  },
  participation: {
    title: "مشارکت‌ها",
    description: "پیشنهادهای همکاری، نیازها و تعهدهای قطعی را پیگیری کنید.",
    permission: "proposals.read_sensitive",
  },
  execution: {
    title: "برنامه و وظایف",
    description: "مراحل، وظایف، وابستگی‌ها و شواهد پیشرفت را یک‌جا کنترل کنید.",
    permission: "project.read",
  },
  resources: {
    title: "منابع و ظرفیت",
    description: "نیروی انسانی، تجهیزات، تخصیص ظرفیت و زمان مصرف‌شده را پایش کنید.",
    permission: "project.read",
  },
  performance: {
    title: "ریسک و شاخص‌ها",
    description: "ریسک‌ها، مسائل، KPIها و تحقق اهداف پروژه را اندازه‌گیری کنید.",
    permission: "project.read",
  },
  readiness: {
    title: "آمادگی بهره‌برداری",
    description: "شرایط قطعی شروع بهره‌برداری را با فرایند، فرم، سند، وظیفه و مصوبه کنترل کنید.",
    permission: "project.read",
  },
  finance: {
    title: "مالی و بودجه",
    description: "دفتر مالی، بودجه، صورتحساب، پرداخت، سود و بازده را کنترل کنید.",
    permission: "finance.read",
  },
  capital: {
    title: "سهام و سرمایه",
    description: "جدول سرمایه، عرضه، انتقال، اقدام شرکتی و گواهی سهام را مدیریت کنید.",
    permission: "capital.read",
  },
  governance: {
    title: "جلسات و تصمیم‌ها",
    description: "جلسات، مصوبات، رأی‌گیری، حدنصاب و نمایندگی رأی را مستند کنید.",
    permission: "governance.read",
  },
  compliance: {
    title: "حقوقی و انطباق",
    description: "پرونده‌های احراز هویت، قراردادها و امضاهای مستند را پیگیری کنید.",
    permission: "compliance.read",
  },
  documents: {
    title: "اسناد و مدارک",
    description: "نسخه‌های قابل ممیزی اسناد پروژه را نگهداری و به رکوردها متصل کنید.",
    permission: "project.read",
  },
  marketplace: {
    title: "بازار فرصت‌ها",
    description: "فرصت‌های سرمایه‌گذاری، فروش سهام و همکاری را منتشر و دنبال کنید.",
    permission: "project.read",
  },
  reports: {
    title: "گزارش و خروجی",
    description: "گزارش‌های اجرایی، مالی، سرمایه و حاکمیت را با فرمت امن دریافت کنید.",
    permission: "project.read",
  },
  team: {
    title: "اعضا و دسترسی",
    description: "عضویت سازمان، دعوت‌ها و سطح دسترسی پروژه را مدیریت کنید.",
    scope: "organization",
    permission: "members.read",
  },
  settings: {
    title: "تنظیمات",
    description: "مشخصات سازمان، پروژه، نمایه عمومی و اتصال‌های بیرونی را پیکربندی کنید.",
    scope: "organization",
    permission: "organization.read",
  },
  security: {
    title: "امنیت حساب",
    description: "پروفایل، رمز عبور، ورود دومرحله‌ای و ترجیحات اعلان را مدیریت کنید.",
    scope: "account",
    permission: null,
  },
};

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `خطای ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload?.error?.code || "REQUEST_FAILED";
    this.fields = payload?.error?.fields || {};
    this.requestId = payload?.requestId || "";
  }
}

function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (key === "className") element.className = value;
    else if (key === "text") element.textContent = String(value);
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key === "attributes") {
      for (const [name, selected] of Object.entries(value)) {
        element.setAttribute(name, String(selected));
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in element) {
      element[key] = value;
    } else {
      element.setAttribute(key, String(value));
    }
  }
  const selectedChildren = Array.isArray(children) ? children : [children];
  for (const child of selectedChildren) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function setBusy(button, busy, label = "در حال انجام…") {
  if (!button) return;
  if (busy) {
    button.dataset.previousLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.previousLabel || button.textContent;
    button.disabled = false;
    delete button.dataset.previousLabel;
  }
}

function errorMessage(error) {
  if (error instanceof ApiError) {
    return `${error.message}${error.requestId ? ` — کد پیگیری: ${error.requestId}` : ""}`;
  }
  if (!navigator.onLine) return "اتصال اینترنت قطع است. پس از اتصال دوباره تلاش کنید.";
  return error?.message || "انجام درخواست ممکن نشد. دوباره تلاش کنید.";
}

function showInline(target, message, kind = "error") {
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("ws-alert--error", kind === "error");
  target.hidden = false;
}

function hideInline(target) {
  if (!target) return;
  target.textContent = "";
  target.hidden = true;
}

function toast(message, kind = "success") {
  const item = node("div", {
    className: `ws-toast${kind === "error" ? " ws-toast--error" : ""}`,
    text: message,
    attributes: { role: kind === "error" ? "alert" : "status" },
  });
  dom.toastRegion.append(item);
  window.setTimeout(() => item.remove(), 5200);
}

async function copyText(value, successMessage = "در کلیپ‌بورد کپی شد.") {
  const selected = String(value || "");
  if (!selected) throw new Error("مقداری برای کپی وجود ندارد.");
  if (!navigator.clipboard?.writeText) {
    window.prompt("این مقدار را کپی کنید:", selected);
    return;
  }
  await navigator.clipboard.writeText(selected);
  toast(successMessage);
}

function encodeHeaderValue(value, maximum) {
  let selected = String(value || "");
  if (selected.length > maximum) {
    selected = selected.slice(0, maximum);
    if (/[\uD800-\uDBFF]$/.test(selected)) selected = selected.slice(0, -1);
  }
  return encodeURIComponent(selected);
}

function updateConnection() {
  state.online = navigator.onLine;
  dom.connectionStatus.classList.toggle("is-offline", !state.online);
  dom.connectionStatus.lastChild.textContent = state.online ? "متصل" : "آفلاین";
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = new Headers(options.headers || {});
  headers.set("Accept", options.accept || "application/json");
  let body = options.body;
  if (body !== undefined && body !== null && options.raw !== true) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    body = JSON.stringify(body);
  }
  if (!["GET", "HEAD"].includes(method) && options.csrf !== false) {
    const token = options.csrfToken === undefined
      ? state.csrfToken
      : options.csrfToken;
    if (token) headers.set("X-CSRF-Token", token);
  }
  if (options.idempotent) {
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    updateConnection();
    throw error;
  }
  if (options.response === "blob" && response.ok) return response;
  const contentType = response.headers.get("content-type") || "";
  let payload = {};
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => ({}));
  } else {
    const text = await response.text().catch(() => "");
    payload = { error: { message: text || "پاسخ نامعتبر از سرور دریافت شد." } };
  }
  if (!response.ok) {
    if (response.status === 401 && state.authenticated && !options.keepSession) {
      endWorkspaceSession();
    }
    throw new ApiError(response.status, payload);
  }
  return payload;
}

function faNumber(value, maximumFractionDigits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits }).format(numeric);
}

function faPercent(value) {
  return value === null || value === undefined
    ? "—"
    : `${faNumber(value, 1)}٪`;
}

function faMoney(value, currency = "IRR") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  const label = currency === "IRR" ? "ریال" : currency || "ریال";
  return `${new Intl.NumberFormat("fa-IR", {
    notation: Math.abs(numeric) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(numeric)} ${label}`;
}

function faDate(value, withTime = false) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
  }).format(parsed);
}

function translatedStatus(value) {
  return labels.status[value] || labels.projectStatus[value] || value || "—";
}

function statusTone(value) {
  if (["accepted", "active", "completed", "done", "approved", "posted", "paid", "verified", "signed", "published", "resolved", "held", "filled", "on_track", "ready", "operating"].includes(value)) {
    return "success";
  }
  if (["rejected", "failed", "blocked", "cancelled", "void", "critical", "off_track", "attention_required"].includes(value)) {
    return "danger";
  }
  if (["pending", "negotiating", "review", "needs_review", "warning", "partially_filled", "mitigating", "submitted", "suspended"].includes(value)) {
    return "warning";
  }
  return "";
}

function statusChip(value, customLabel) {
  const tone = statusTone(value);
  return node("span", {
    className: `ws-status${tone ? ` ws-status--${tone}` : ""}`,
    text: customLabel || translatedStatus(value),
  });
}

function hasPermission(permission) {
  if (!permission) return true;
  return state.permissions.has("*") || state.permissions.has(permission);
}

function hasOrganizationPermission(permission) {
  if (!permission) return true;
  return state.organizationPermissions.has("*")
    || state.organizationPermissions.has(permission);
}

function currentOrganization() {
  return state.organizations.find((item) => item.id === state.organizationId) || null;
}

function currentProject() {
  return state.projects.find((item) => item.id === state.projectId) || null;
}

function projectPath(resource = "") {
  if (!state.projectId) return "";
  const base = `/api/v2/admin/projects/${encodeURIComponent(state.projectId)}`;
  return resource ? `${base}/${resource}` : base;
}

function button(label, options = {}) {
  const element = node("button", {
    type: options.type || "button",
    className: `ws-button ws-button--${options.variant || "secondary"}`,
    text: label,
    disabled: Boolean(options.disabled),
    title: options.title || "",
    onclick: options.onClick,
  });
  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) {
      element.setAttribute(name, String(value));
    }
  }
  return element;
}

function metricCard(title, value, note, icon = "◈") {
  return node("article", { className: "ws-metric" }, [
    node("div", { className: "ws-metric__head" }, [
      node("span", { text: title }),
      node("span", { className: "ws-metric__icon", text: icon, attributes: { "aria-hidden": "true" } }),
    ]),
    node("div", {}, [
      node("strong", { text: value }),
      node("small", { text: note || " " }),
    ]),
  ]);
}

function panel(title, subtitle, body, action = null) {
  return node("section", { className: "ws-panel" }, [
    node("div", { className: "ws-panel__head" }, [
      node("div", {}, [
        node("h2", { text: title }),
        subtitle ? node("p", { text: subtitle }) : null,
      ]),
      action,
    ]),
    node("div", { className: "ws-panel__body" }, body),
  ]);
}

function emptyState(title, description, options = {}) {
  return node("div", { className: "ws-empty" }, [
    node("div", { className: "ws-empty__copy" }, [
      node("span", {
        className: "ws-empty__icon",
        text: options.icon || "◇",
        attributes: { "aria-hidden": "true" },
      }),
      node("h2", { text: title }),
      node("p", { text: description }),
      options.action || null,
    ]),
  ]);
}

function progressItem(title, subtitle, percent) {
  const available = percent !== null && percent !== undefined && Number.isFinite(Number(percent));
  const safe = available ? Math.max(0, Math.min(100, Number(percent))) : null;
  return node("div", { className: "ws-progress-item" }, [
    node("div", { className: "ws-progress-item__name" }, [
      node("strong", { text: title }),
      node("small", { text: subtitle || " " }),
    ]),
    available
      ? node("progress", {
          className: "ws-progress-track",
          value: safe,
          max: 100,
          attributes: { "aria-label": `پیشرفت ${title}` },
        })
      : node("span", { className: "ws-form-note", text: "داده ثبت نشده" }),
    node("b", { text: available ? faPercent(safe) : "ناموجود" }),
  ]);
}

function dataTable(columns, rows, options = {}) {
  if (!rows.length) {
    return emptyState(
      options.emptyTitle || "هنوز داده‌ای ثبت نشده است",
      options.emptyDescription || "با ثبت نخستین مورد، اطلاعات این بخش نمایش داده می‌شود.",
      { icon: options.icon || "□", action: options.emptyAction || null },
    );
  }
  const head = node("thead", {}, node("tr", {}, columns.map((column) =>
    node("th", {
      text: column.label,
      className: column.title ? "ws-table__title" : "",
      scope: "col",
    }))));
  const body = node("tbody");
  for (const row of rows) {
    const tr = node("tr");
    for (const column of columns) {
      const value = typeof column.render === "function"
        ? column.render(row)
        : row[column.key];
      tr.append(node("td", {}, value instanceof Node ? value : String(value ?? "—")));
    }
    body.append(tr);
  }
  return node("div", { className: "ws-table-wrap" }, [
    node("table", { className: "ws-table" }, [head, body]),
  ]);
}

function titleCell(title, subtitle) {
  return node("div", {}, [
    node("strong", { text: title || "بدون عنوان" }),
    subtitle ? node("small", { text: subtitle }) : null,
  ]);
}

function tabs(items, selected, onChange) {
  return node("div", { className: "ws-tabs", attributes: { role: "tablist" } }, items.map((item) =>
    node("button", {
      type: "button",
      className: item.value === selected ? "is-active" : "",
      text: item.label,
      attributes: {
        role: "tab",
        "aria-selected": item.value === selected ? "true" : "false",
      },
      onclick: () => onChange(item.value),
    })));
}

function renderLoading() {
  dom.pageBody.setAttribute("aria-busy", "true");
  dom.pageBody.replaceChildren(node("div", { className: "ws-skeleton-grid" }, [
    node("span"), node("span"), node("span"), node("span"),
  ]));
}

function renderPageError(error, retry) {
  dom.pageBody.setAttribute("aria-busy", "false");
  dom.pageBody.replaceChildren(emptyState(
    navigator.onLine ? "بارگذاری این بخش کامل نشد" : "اتصال شبکه برقرار نیست",
    errorMessage(error),
    {
      icon: navigator.onLine ? "!" : "⌁",
      action: button("تلاش دوباره", { variant: "primary", onClick: retry }),
    },
  ));
}

function showPageAlert(message, kind = "info") {
  showInline(dom.pageAlert, message, kind);
}

function clearPageAlert() {
  hideInline(dom.pageAlert);
}

function setPageActions(actions = []) {
  dom.pageActions.replaceChildren(...actions.filter(Boolean));
}

function selectOptions(select, items, value, placeholder = "") {
  select.replaceChildren();
  if (placeholder) select.append(node("option", { value: "", text: placeholder }));
  for (const item of items) {
    select.append(node("option", {
      value: item.value,
      text: item.label,
      selected: item.value === value,
      disabled: Boolean(item.disabled),
    }));
  }
}

function fieldControl(field, initial) {
  const value = initial[field.name] ?? field.value ?? "";
  let control;
  if (field.type === "select") {
    control = node("select", {
      name: field.name,
      required: Boolean(field.required),
      disabled: Boolean(field.disabled),
    });
    for (const option of field.options || []) {
      control.append(node("option", {
        value: option.value,
        text: option.label,
        selected: String(option.value) === String(value),
        disabled: Boolean(option.disabled),
      }));
    }
  } else if (field.type === "textarea") {
    control = node("textarea", {
      name: field.name,
      value: String(value ?? ""),
      rows: field.rows || 4,
      required: Boolean(field.required),
      disabled: Boolean(field.disabled),
      maxLength: field.maxLength || 10_000,
      placeholder: field.placeholder || "",
      dir: field.dir || "auto",
    });
  } else {
    control = node("input", {
      name: field.name,
      type: field.type || "text",
      value: field.type === "checkbox" ? "" : String(value ?? ""),
      checked: field.type === "checkbox" ? Boolean(value) : false,
      required: Boolean(field.required),
      min: field.min,
      max: field.max,
      step: field.step,
      minLength: field.minLength,
      maxLength: field.maxLength,
      pattern: field.pattern,
      inputMode: field.inputMode,
      placeholder: field.placeholder || "",
      autocomplete: field.autocomplete || "off",
      dir: field.dir || (["email", "password", "number", "url"].includes(field.type) ? "ltr" : "auto"),
      disabled: Boolean(field.disabled),
    });
  }
  const label = node("label", {}, [
    node("span", { text: field.label }),
    control,
    node("small", {
      text: field.help || "",
      dataset: { fieldError: field.name },
    }),
  ]);
  return { label, control };
}

function openEntityDialog(config) {
  state.dialogSubmit = config.onSubmit;
  dom.dialogKicker.textContent = config.kicker || "ثبت اطلاعات";
  dom.dialogTitle.textContent = config.title || "مورد جدید";
  dom.dialogSubmit.textContent = config.submitLabel || "ذخیره";
  hideInline(dom.dialogError);
  dom.dialogFields.replaceChildren();
  for (const field of config.fields || []) {
    const { label } = fieldControl(field, config.initial || {});
    dom.dialogFields.append(label);
  }
  if (config.note) {
    dom.dialogFields.append(node("p", { className: "ws-form-note", text: config.note }));
  }
  dom.entityDialog.showModal();
  const first = $("input:not([disabled]),select:not([disabled]),textarea:not([disabled])", dom.dialogFields);
  first?.focus();
}

function closeEntityDialog() {
  if (dom.entityDialog.open) dom.entityDialog.close();
  state.dialogSubmit = null;
  hideInline(dom.dialogError);
}

function formValues(form) {
  const result = {};
  for (const element of $$("input[name],select[name],textarea[name]", form)) {
    if (element.disabled) continue;
    if (element.type === "checkbox") {
      result[element.name] = element.checked;
    } else if (element.type === "number") {
      result[element.name] = element.value === "" ? null : Number(element.value);
    } else if (element.dataset.array === "true") {
      result[element.name] = element.value.split(",").map((item) => item.trim()).filter(Boolean);
    } else {
      result[element.name] = element.value.trim();
    }
  }
  return result;
}

function displayDialogErrors(error) {
  for (const helper of $$("[data-field-error]", dom.dialogFields)) {
    helper.textContent = "";
  }
  if (error instanceof ApiError) {
    for (const [name, message] of Object.entries(error.fields)) {
      const helper = $(`[data-field-error="${CSS.escape(name)}"]`, dom.dialogFields);
      if (helper) helper.textContent = String(message);
    }
  }
  showInline(dom.dialogError, errorMessage(error));
}

async function handleDialogSubmit(event) {
  event.preventDefault();
  if (!state.dialogSubmit || !dom.entityForm.reportValidity()) return;
  hideInline(dom.dialogError);
  setBusy(dom.dialogSubmit, true);
  try {
    await state.dialogSubmit(formValues(dom.dialogFields));
    closeEntityDialog();
  } catch (error) {
    displayDialogErrors(error);
  } finally {
    setBusy(dom.dialogSubmit, false);
  }
}

function authStep(step) {
  dom.accountStep.hidden = step !== "account";
  dom.mfaStep.hidden = step !== "mfa";
  dom.resetStep.hidden = step !== "reset";
  const focus = step === "mfa"
    ? $("#mfaCode")
    : step === "reset" ? $("#resetEmail") : $("#loginEmail");
  window.setTimeout(() => focus?.focus(), 30);
}

function showAuth() {
  state.authenticated = false;
  stopNotificationPolling();
  dom.workspaceView.hidden = true;
  dom.authView.hidden = false;
  authStep("account");
}

function showWorkspace() {
  state.authenticated = true;
  dom.authView.hidden = true;
  dom.workspaceView.hidden = false;
}

function endWorkspaceSession() {
  state.authenticated = false;
  state.csrfToken = "";
  state.user = null;
  state.projects = [];
  state.organizations = [];
  state.organizationId = "";
  state.projectId = "";
  state.dashboard = null;
  state.organizationPermissions = new Set();
  state.permissions = new Set();
  state.projectRole = null;
  showAuth();
}

async function submitAccountLogin(event) {
  event.preventDefault();
  hideInline(dom.accountError);
  if (!dom.accountForm.reportValidity()) return;
  const submit = $("button[type=submit]", dom.accountForm);
  setBusy(submit, true, "در حال ورود…");
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  try {
    const result = await api("/api/v2/auth/session", {
      method: "POST",
      body: { email, password },
      csrf: false,
      keepSession: true,
    });
    if (result.mfaRequired) {
      state.pendingLogin = { email, password };
      authStep("mfa");
      return;
    }
    await acceptAuthentication(result);
  } catch (error) {
    showInline(dom.accountError, errorMessage(error));
  } finally {
    setBusy(submit, false);
  }
}

async function submitMfa(event) {
  event.preventDefault();
  hideInline(dom.mfaError);
  if (!state.pendingLogin || !dom.mfaForm.reportValidity()) return;
  const submit = $("button[type=submit]", dom.mfaForm);
  const code = $("#mfaCode").value.trim();
  setBusy(submit, true, "در حال تأیید…");
  try {
    const payload = {
      ...state.pendingLogin,
      ...(/^\d{6}$/.test(code) ? { totpCode: code } : { backupCode: code }),
    };
    const result = await api("/api/v2/auth/session", {
      method: "POST",
      body: payload,
      csrf: false,
      keepSession: true,
    });
    state.pendingLogin = null;
    $("#mfaCode").value = "";
    await acceptAuthentication(result);
  } catch (error) {
    showInline(dom.mfaError, errorMessage(error));
  } finally {
    setBusy(submit, false);
  }
}

async function submitResetRequest(event) {
  event.preventDefault();
  hideInline(dom.resetMessage);
  if (!dom.resetForm.reportValidity()) return;
  const submit = $("button[type=submit]", dom.resetForm);
  setBusy(submit, true);
  try {
    const result = await api("/api/v2/auth/password-reset/request", {
      method: "POST",
      body: { email: $("#resetEmail").value.trim() },
      csrf: false,
      keepSession: true,
    });
    showInline(dom.resetMessage, result.message, "info");
  } catch (error) {
    showInline(dom.resetMessage, errorMessage(error));
  } finally {
    setBusy(submit, false);
  }
}

async function submitLegacyLogin(event) {
  event.preventDefault();
  hideInline(dom.legacyError);
  if (!dom.legacyForm.reportValidity()) return;
  const submit = $("button[type=submit]", dom.legacyForm);
  setBusy(submit, true);
  try {
    const result = await api("/api/v1/admin/session", {
      method: "POST",
      body: { password: $("#legacyPassword").value },
      csrf: false,
      keepSession: true,
    });
    state.legacyCsrfToken = result.csrfToken;
    const bootstrap = await api("/api/v2/auth/bootstrap", {
      csrf: false,
      keepSession: true,
    });
    if (!bootstrap.bootstrapRequired) {
      throw new ApiError(409, {
        error: { message: "مالک سازمان قبلاً ساخته شده است؛ با حساب شخصی وارد شوید." },
      });
    }
    dom.bootstrapDialog.showModal();
  } catch (error) {
    showInline(dom.legacyError, errorMessage(error));
  } finally {
    setBusy(submit, false);
  }
}

async function submitBootstrap(event) {
  event.preventDefault();
  hideInline(dom.bootstrapError);
  if (!dom.bootstrapForm.reportValidity()) return;
  const submit = $("button[type=submit]", dom.bootstrapForm);
  const values = formValues(dom.bootstrapForm);
  setBusy(submit, true, "در حال ساخت…");
  try {
    await api("/api/v2/auth/bootstrap", {
      method: "POST",
      body: values,
      csrfToken: state.legacyCsrfToken,
      keepSession: true,
    });
    dom.bootstrapDialog.close();
    const result = await api("/api/v2/auth/session", {
      method: "POST",
      body: { email: values.email, password: values.password },
      csrf: false,
      keepSession: true,
    });
    await acceptAuthentication(result);
    toast("مالک سازمان و فضای کاری با موفقیت ساخته شد.");
  } catch (error) {
    showInline(dom.bootstrapError, errorMessage(error));
  } finally {
    setBusy(submit, false);
  }
}

async function acceptAuthentication(result) {
  state.csrfToken = result.csrfToken || "";
  state.user = result.user || null;
  showWorkspace();
  await loadWorkspace({
    organizationId: localStorage.getItem("hamkari.workspace.organization") || "",
    projectId: localStorage.getItem("hamkari.workspace.project") || "",
  });
  startNotificationPolling();
}

async function logout() {
  try {
    await api("/api/v2/auth/session", {
      method: "DELETE",
      body: {},
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      toast(errorMessage(error), "error");
    }
  } finally {
    endWorkspaceSession();
  }
}

function hydrateWorkspace(result) {
  state.csrfToken = result.csrfToken || state.csrfToken;
  state.user = result.user || state.user;
  state.organizations = result.organizations || [];
  state.projects = result.projects || [];
  state.organizationId = result.selectedOrganizationId || "";
  state.projectId = result.selectedProjectId || "";
  state.dashboard = result.dashboard || null;
  const organization = currentOrganization();
  state.organizationPermissions = new Set(organization?.permissions || []);
  const projectAuthorization = result.selectedProjectAuthorization
    || result.projectAuthorization
    || currentProject()?.authorization
    || null;
  const effectiveProjectPermissions = result.selectedProjectPermissions
    || projectAuthorization?.serializedPermissions
    || projectAuthorization?.permissions
    || currentProject()?.permissions
    || [];
  state.permissions = new Set(
    state.projectId && effectiveProjectPermissions.length
      ? effectiveProjectPermissions
      : state.organizationPermissions,
  );
  state.projectRole = projectAuthorization?.projectRole
    || result.selectedProjectRole
    || currentProject()?.roleKey
    || null;
  localStorage.setItem("hamkari.workspace.organization", state.organizationId);
  if (state.projectId) localStorage.setItem("hamkari.workspace.project", state.projectId);
  else localStorage.removeItem("hamkari.workspace.project");
  renderWorkspaceChrome();
}

function renderWorkspaceChrome() {
  const organizationItems = state.organizations.map((organization) => ({
    value: organization.id,
    label: organization.name,
  }));
  selectOptions(
    dom.organizationSelect,
    organizationItems,
    state.organizationId,
    "سازمانی در دسترس نیست",
  );
  const projectItems = state.projects.map((project) => ({
    value: project.id,
    label: `${project.title}${project.archivedAt ? " — آرشیو" : ""}`,
  }));
  selectOptions(
    dom.projectSelect,
    projectItems,
    state.projectId,
    projectItems.length ? "انتخاب پروژه" : "هنوز پروژه‌ای ندارید",
  );
  const name = state.user?.fullName || state.user?.email || "کاربر";
  const initial = [...name.trim()][0] || "ه";
  const role = state.projectRole || currentOrganization()?.membership?.roleKey || "viewer";
  dom.profileName.textContent = name;
  dom.sidebarUserName.textContent = name;
  dom.profileAvatar.textContent = initial;
  dom.sidebarAvatar.textContent = initial;
  dom.sidebarUserRole.textContent = labels.roles[role] || role;
  for (const navButton of $$("[data-view]", dom.workspaceNav)) {
    const meta = viewMeta[navButton.dataset.view];
    const needsProject = meta?.scope !== "organization" && meta?.scope !== "account";
    const allowed = meta && hasPermission(meta.permission) && (!needsProject || state.projectId);
    navButton.hidden = !allowed;
  }
}

async function loadWorkspace(options = {}) {
  const query = new URLSearchParams();
  if (options.organizationId) query.set("organizationId", options.organizationId);
  if (options.projectId) query.set("projectId", options.projectId);
  const path = `/api/v2/admin/workspace${query.size ? `?${query}` : ""}`;
  try {
    const result = await api(path, { keepSession: true });
    hydrateWorkspace(result);
    let preferred = viewFromLocation();
    if (!viewMeta[preferred]) preferred = "overview";
    const meta = viewMeta[preferred];
    const needsProject = meta.scope !== "organization" && meta.scope !== "account";
    if (!hasPermission(meta.permission) || (needsProject && !state.projectId)) {
      preferred = state.projectId ? "overview" : "portfolio";
    }
    await navigate(preferred, { replace: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      endWorkspaceSession();
      return;
    }
    showWorkspace();
    renderPageError(error, () => loadWorkspace(options));
  }
}

function viewFromLocation() {
  const selected = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return selected || localStorage.getItem("hamkari.workspace.view") || "overview";
}

async function navigate(view, options = {}) {
  const meta = viewMeta[view];
  if (!meta) return navigate("overview", { replace: true });
  const requiresProject = meta.scope !== "organization" && meta.scope !== "account";
  if (!hasPermission(meta.permission)) {
    showPageAlert("سطح دسترسی شما برای مشاهدهٔ این بخش کافی نیست.", "error");
    return;
  }
  if (requiresProject && !state.projectId) {
    view = "portfolio";
  }
  state.activeView = view;
  localStorage.setItem("hamkari.workspace.view", view);
  const method = options.replace ? "replaceState" : "pushState";
  if (viewFromLocation() !== view || options.replace) {
    history[method]({ view }, "", `#/${view}`);
  }
  for (const item of $$("[data-view]")) {
    item.classList.toggle("is-active", item.dataset.view === view);
  }
  const selectedMeta = viewMeta[view];
  dom.pageTitle.textContent = selectedMeta.title;
  dom.pageDescription.textContent = selectedMeta.description;
  dom.pageBreadcrumb.textContent = `فضای کاری / ${selectedMeta.title}`;
  setPageActions([]);
  clearPageAlert();
  closeSidebar();
  dom.profileMenu.hidden = true;
  dom.profileButton.setAttribute("aria-expanded", "false");
  renderLoading();
  const sequence = ++state.renderSequence;
  try {
    await viewRenderers[view](sequence);
    if (sequence === state.renderSequence) {
      dom.pageBody.setAttribute("aria-busy", "false");
      dom.content.focus({ preventScroll: true });
    }
  } catch (error) {
    if (sequence === state.renderSequence) {
      renderPageError(error, () => navigate(view, { replace: true }));
    }
  }
}

async function optionalApi(path, options = {}) {
  try {
    return await api(path, options);
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 405, 501].includes(error.status)) return null;
    throw error;
  }
}

function ensureSequence(sequence) {
  return sequence === state.renderSequence;
}

function openSidebar() {
  dom.sidebar.classList.add("is-open");
  dom.sidebarBackdrop.hidden = false;
  $("#closeSidebarButton")?.focus();
}

function closeSidebar() {
  dom.sidebar.classList.remove("is-open");
  dom.sidebarBackdrop.hidden = true;
}

function toggleProfileMenu() {
  const opening = dom.profileMenu.hidden;
  dom.profileMenu.hidden = !opening;
  dom.profileButton.setAttribute("aria-expanded", opening ? "true" : "false");
  if (opening) $("button", dom.profileMenu)?.focus();
}

async function refreshNotifications() {
  if (!state.authenticated) return;
  try {
    const result = await api("/api/v2/admin/me/notifications?limit=50");
    state.notifications = result.notifications || [];
    const unread = Number(result.unreadCount || 0);
    dom.notificationBadge.textContent = faNumber(unread);
    dom.notificationBadge.hidden = unread === 0;
    renderNotifications();
  } catch (error) {
    if (!(error instanceof ApiError && [401, 404].includes(error.status))) {
      console.warn("Notification refresh failed", error);
    }
  }
}

function renderNotifications() {
  if (!state.notifications.length) {
    dom.notificationList.replaceChildren(emptyState(
      "اعلان تازه‌ای ندارید",
      "رویدادهای مهم پروژه و سازمان در این صندوق نمایش داده می‌شوند.",
      { icon: "♢" },
    ));
    return;
  }
  dom.notificationList.replaceChildren(...state.notifications.map((item) =>
    node("article", {
      className: `ws-notification${item.readAt ? " is-read" : ""}`,
    }, [
      node("i", { attributes: { "aria-hidden": "true" } }),
      node("div", {}, [
        node("strong", { text: item.title }),
        node("span", { text: item.body }),
        node("small", { text: faDate(item.createdAt, true) }),
        item.actionUrl ? node("a", {
          href: item.actionUrl,
          text: "مشاهده",
          onclick: async (event) => {
            if (item.actionUrl.startsWith("#")) {
              event.preventDefault();
              await markNotifications([item.id]);
              navigate(item.actionUrl.replace(/^#\/?/, ""));
            }
          },
        }) : null,
      ]),
    ])));
}

async function markNotifications(ids = null) {
  try {
    const result = await api("/api/v2/admin/me/notifications", {
      method: "PATCH",
      body: ids ? { ids } : { all: true },
    });
    state.notifications = result.notifications || [];
    dom.notificationBadge.textContent = faNumber(result.unreadCount || 0);
    dom.notificationBadge.hidden = Number(result.unreadCount || 0) === 0;
    renderNotifications();
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function toggleNotificationDrawer(open = dom.notificationDrawer.hidden) {
  dom.notificationDrawer.hidden = !open;
  if (open) {
    refreshNotifications();
    $("[data-close-drawer]", dom.notificationDrawer)?.focus();
  } else {
    dom.notificationButton.focus();
  }
}

function startNotificationPolling() {
  stopNotificationPolling();
  refreshNotifications();
  state.notificationTimer = window.setInterval(refreshNotifications, 30_000);
}

function stopNotificationPolling() {
  if (state.notificationTimer) window.clearInterval(state.notificationTimer);
  state.notificationTimer = null;
}

function openProjectDialog(project = null) {
  const editing = Boolean(project);
  openEntityDialog({
    kicker: editing ? "ویرایش پروژه" : "پروژهٔ جدید",
    title: editing ? project.title : "ساخت پروژه یا طرح",
    submitLabel: editing ? "ذخیره تغییرات" : "ساخت پروژه",
    initial: project || {
      status: "draft",
      visibility: "private",
      lifecycle: "idea",
      currency: currentOrganization()?.defaultCurrency || "IRR",
    },
    fields: [
      { name: "title", label: "عنوان پروژه", required: true, minLength: 2, maxLength: 180 },
      { name: "slug", label: "شناسهٔ عمومی", required: !editing, dir: "ltr", maxLength: 80, help: "حروف انگلیسی کوچک، عدد و خط تیره" },
      { name: "summary", label: "خلاصه", type: "textarea", rows: 3, maxLength: 2000 },
      { name: "kind", label: "نوع طرح", maxLength: 80, placeholder: "مثلاً صنعتی، اجتماعی یا سرمایه‌گذاری" },
      { name: "industry", label: "صنعت", maxLength: 120 },
      {
        name: "lifecycle",
        label: "چرخهٔ عمر",
        type: "select",
        options: ["idea", "planning", "fundraising", "executing", "operating", "completed", "paused", "cancelled"]
          .map((value) => ({
            value,
            label: labels.lifecycle[value] || { paused: "متوقف" }[value] || translatedStatus(value),
          })),
      },
      {
        name: "status",
        label: "وضعیت انتشار",
        type: "select",
        options: [
          { value: "draft", label: "پیش‌نویس" },
          { value: "published", label: "منتشرشده" },
        ],
      },
      {
        name: "visibility",
        label: "دامنه مشاهده",
        type: "select",
        options: [
          { value: "private", label: "خصوصی" },
          { value: "unlisted", label: "فقط با لینک / سازمان" },
          { value: "public", label: "عمومی" },
        ],
      },
      { name: "location", label: "موقعیت", maxLength: 180 },
      { name: "startDate", label: "تاریخ شروع", type: "date" },
      { name: "targetDate", label: "تاریخ هدف", type: "date" },
      { name: "budgetAmount", label: "بودجهٔ اولیه", type: "number", min: 0, step: 1 },
      { name: "currency", label: "واحد پول", dir: "ltr", maxLength: 3 },
    ],
    onSubmit: async (values) => {
      const path = editing ? projectPath() : "/api/v2/admin/projects";
      const result = await api(path, {
        method: editing ? "PATCH" : "POST",
        body: editing ? values : { ...values, organizationId: state.organizationId },
      });
      toast(editing ? "پروژه به‌روزرسانی شد." : "پروژه ساخته شد.");
      await loadWorkspace({
        organizationId: state.organizationId,
        projectId: result.project?.id || state.projectId,
      });
    },
  });
}

async function renderOverview(sequence) {
  setPageActions([
    hasPermission("projects.create")
      ? button("پروژهٔ جدید", { variant: "primary", onClick: () => openProjectDialog() })
      : null,
  ]);
  const organizationRequest = api(
    `/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}/overview`,
  );
  const operationsRequest = state.projectId
    ? optionalApi(projectPath("operations/dashboard"))
    : Promise.resolve(null);
  const auditRequest = state.projectId && hasPermission("audit.read")
    ? optionalApi(projectPath("audit-events?limit=8"))
    : Promise.resolve(null);
  const [organization, operations, audit] = await Promise.all([
    organizationRequest,
    operationsRequest,
    auditRequest,
  ]);
  if (!ensureSequence(sequence)) return;
  const metrics = organization.metrics || {};
  const project = currentProject();
  const platform = state.dashboard || {};
  const executionProgress = operations?.executionProgressPercent;
  const selectedProgress = executionProgress ?? platform.overallProgressPercent;
  const openDecisions = platform.governance?.openResolutions || 0;
  const metricGrid = node("div", { className: "ws-metric-grid" }, [
    metricCard(
      "پروژه‌های سبد",
      faNumber(metrics.projects || state.projects.length),
      `${faNumber(metrics.activeProjects || 0)} پروژه در اجرا یا بهره‌برداری`,
      "◇",
    ),
    metricCard(
      project ? "پیشرفت اجرای پروژه" : "پروژهٔ جاری",
      project ? selectedProgress == null ? "داده کافی نیست" : faPercent(selectedProgress) : "—",
      project ? project.title : "برای شروع یک پروژه بسازید",
      "↗",
    ),
    metricCard(
      "بودجهٔ سبد",
      faMoney(metrics.portfolioBudget || 0, currentOrganization()?.defaultCurrency),
      "جمع بودجهٔ ثبت‌شدهٔ پروژه‌های فعال",
      "∿",
    ),
    metricCard(
      "اعضا و تصمیم‌ها",
      `${faNumber(metrics.members || 0)} / ${faNumber(openDecisions)}`,
      "عضو فعال / مصوبهٔ باز",
      "◉",
    ),
  ]);

  const projectRows = state.projects.slice(0, 8).map((item) => ({
    ...item,
    active: item.id === state.projectId,
  }));
  const progressList = node("div", { className: "ws-progress-list" });
  if (projectRows.length) {
    for (const item of projectRows) {
      const percent = item.id === state.projectId
        ? selectedProgress
        : item.lifecycle === "completed" ? 100 : null;
      const progress = progressItem(
        item.title,
        `${labels.lifecycle[item.lifecycle] || item.lifecycle || "بدون مرحله"}${item.active ? " · پروژهٔ جاری" : ""}`,
        percent,
      );
      progress.tabIndex = 0;
      progress.addEventListener("click", () => switchProject(item.id));
      progress.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          switchProject(item.id);
        }
      });
      progressList.append(progress);
    }
  } else {
    progressList.append(emptyState(
      "سبد پروژه هنوز خالی است",
      "نخستین پروژه یا طرح مشارکت را بسازید تا داشبورد فعال شود.",
      {
        action: hasPermission("projects.create")
          ? button("ساخت پروژه", { variant: "primary", onClick: () => openProjectDialog() })
          : null,
      },
    ));
  }

  const activityList = node("div", { className: "ws-activity-list" });
  const activities = audit?.auditEvents || [];
  if (activities.length) {
    for (const item of activities) {
      activityList.append(node("div", { className: "ws-activity" }, [
        node("span", { text: "•", attributes: { "aria-hidden": "true" } }),
        node("div", {}, [
          node("strong", { text: item.action || item.eventType || "تغییر در پروژه" }),
          node("small", { text: faDate(item.createdAt, true) }),
        ]),
      ]));
    }
  } else {
    activityList.append(node("p", {
      className: "ws-form-note",
      text: "رویداد قابل نمایشی برای این پروژه ثبت نشده است.",
    }));
  }

  dom.pageBody.replaceChildren(
    metricGrid,
    node("div", { className: "ws-dashboard-grid" }, [
      panel(
        "نبض سبد پروژه‌ها",
        "پیشرفت پروژهٔ جاری و وضعیت چرخهٔ عمر پروژه‌ها",
        progressList,
        node("button", {
          className: "ws-panel__link",
          type: "button",
          text: "مشاهدهٔ سبد",
          onclick: () => navigate("portfolio"),
        }),
      ),
      panel("آخرین فعالیت‌ها", "رویدادهای ممیزی پروژهٔ جاری", activityList),
    ]),
  );
}

async function switchProject(projectId) {
  if (!projectId || projectId === state.projectId) return;
  await loadWorkspace({ organizationId: state.organizationId, projectId });
}

async function renderPortfolio(sequence) {
  setPageActions([
    hasPermission("projects.create")
      ? button("پروژهٔ جدید", { variant: "primary", onClick: () => openProjectDialog() })
      : null,
  ]);
  const result = await api(
    `/api/v2/admin/projects?organizationId=${encodeURIComponent(state.organizationId)}`,
  );
  if (!ensureSequence(sequence)) return;
  const projects = result.projects || [];
  if (!projects.length) {
    dom.pageBody.replaceChildren(emptyState(
      "نخستین پروژه را بسازید",
      "هم‌ساخت برای هر نوع پروژه، طرح سرمایه‌گذاری یا مشارکت قابل استفاده است.",
      {
        icon: "◇",
        action: hasPermission("projects.create")
          ? button("ساخت پروژه", { variant: "primary", onClick: () => openProjectDialog() })
          : null,
      },
    ));
    return;
  }
  const grid = node("div", { className: "ws-card-grid" });
  for (const project of projects) {
    const card = node("article", { className: "ws-entity-card" }, [
      node("div", { className: "ws-entity-card__top" }, [
        node("div", {}, [
          node("h3", { text: project.title }),
          node("small", { text: project.code || project.industry || "پروژهٔ سازمان" }),
        ]),
        statusChip(project.archivedAt ? "archived" : project.status),
      ]),
      node("p", { text: project.summary || "هنوز خلاصه‌ای برای این پروژه ثبت نشده است." }),
      node("div", { className: "ws-entity-card__foot" }, [
        node("span", {
          text: labels.lifecycle[project.lifecycle] || labels.lifecycle[project.stage] || "چرخهٔ عمر نامشخص",
        }),
        node("div", {}, [
          button("ورود", {
            variant: project.id === state.projectId ? "primary" : "ghost",
            onClick: () => switchProject(project.id),
          }),
          hasPermission("project.manage") && project.id === state.projectId
            ? button("ویرایش", { variant: "ghost", onClick: () => openProjectDialog(project) })
            : null,
        ]),
      ]),
    ]);
    grid.append(card);
  }
  dom.pageBody.replaceChildren(grid);
}

function openProposalDialog(proposal) {
  openEntityDialog({
    kicker: `پیشنهاد ${proposal.referenceCode || ""}`,
    title: proposal.applicantName,
    submitLabel: "ثبت تصمیم",
    initial: {
      status: proposal.status,
      decisionMessage: proposal.decisionMessage || "",
      internalNote: proposal.internalNote || "",
      confirmUnaccept: false,
    },
    fields: [
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: [
          ["new", "جدید"],
          ["contacted", "تماس گرفته‌شده"],
          ["negotiating", "در مذاکره"],
          ["accepted", "پذیرفته‌شده"],
          ["rejected", "ردشده"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "decisionMessage", label: "پیام قابل مشاهده برای متقاضی", type: "textarea", rows: 3, maxLength: 1000 },
      { name: "internalNote", label: "یادداشت داخلی", type: "textarea", rows: 3, maxLength: 2000 },
      ...(proposal.status === "accepted"
        ? [{
            name: "confirmUnaccept",
            label: "لغو پذیرش قطعی را تأیید می‌کنم",
            type: "checkbox",
            help: "لغو پذیرش در تاریخچه ثبت می‌شود و پیشرفت نیاز اصلاح خواهد شد.",
          }]
        : []),
    ],
    note: `${proposal.need?.title || "نیاز"} · ${proposal.mobile || "بدون موبایل"}\n${proposal.contribution || ""}`,
    onSubmit: async (values) => {
      if (proposal.status === "accepted" && values.status !== "accepted" && !values.confirmUnaccept) {
        throw new ApiError(400, {
          error: { message: "برای لغو پذیرش، تأیید صریح لازم است.", fields: { confirmUnaccept: "این گزینه را تأیید کنید." } },
        });
      }
      await api(projectPath(`proposals/${encodeURIComponent(proposal.id)}`), {
        method: "PATCH",
        body: values,
      });
      toast("وضعیت پیشنهاد به‌روزرسانی شد.");
      await navigate("participation", { replace: true });
    },
  });
}

async function renderParticipation(sequence) {
  const [proposalResult, needResult] = await Promise.all([
    api(projectPath("proposals?limit=200")),
    api(projectPath("needs")),
  ]);
  if (!ensureSequence(sequence)) return;
  const proposals = proposalResult.proposals || [];
  const needs = needResult.needs || [];
  const summary = proposalResult.summary || {};
  dom.proposalBadge.textContent = faNumber(summary.new || 0);
  dom.proposalBadge.hidden = Number(summary.new || 0) === 0;
  const filters = node("div", { className: "ws-filter-row" });
  const search = node("input", {
    type: "search",
    placeholder: "جستجو در نام، موبایل یا آورده",
    attributes: { "aria-label": "جستجوی پیشنهادها" },
  });
  const status = node("select", { attributes: { "aria-label": "فیلتر وضعیت پیشنهاد" } }, [
    node("option", { value: "", text: "همهٔ وضعیت‌ها" }),
    ...["new", "contacted", "negotiating", "accepted", "rejected"].map((value) =>
      node("option", { value, text: translatedStatus(value) })),
  ]);
  filters.append(search, status);
  const tableHost = node("div");
  const renderFiltered = () => {
    const query = search.value.trim().toLocaleLowerCase("fa");
    const filtered = proposals.filter((proposal) => {
      const matchStatus = !status.value || proposal.status === status.value;
      const haystack = `${proposal.applicantName} ${proposal.mobile} ${proposal.contributionPreview} ${proposal.need?.title}`.toLocaleLowerCase("fa");
      return matchStatus && (!query || haystack.includes(query));
    });
    tableHost.replaceChildren(dataTable([
      { label: "متقاضی", title: true, render: (item) => titleCell(item.applicantName, item.mobile) },
      { label: "نیاز", render: (item) => item.need?.title || "—" },
      { label: "آورده / ظرفیت", render: (item) => item.contributionPreview || "—" },
      { label: "وضعیت", render: (item) => statusChip(item.status) },
      { label: "آخرین تغییر", render: (item) => faDate(item.updatedAt, true) },
      {
        label: "عملیات",
        render: (item) => hasPermission("proposals.manage")
          ? button("بررسی", {
              variant: "ghost",
              onClick: async () => {
                try {
                  const detail = await api(projectPath(`proposals/${encodeURIComponent(item.id)}`));
                  openProposalDialog(detail.proposal);
                } catch (error) {
                  toast(errorMessage(error), "error");
                }
              },
            })
          : "فقط مشاهده",
      },
    ], filtered, {
      emptyTitle: "پیشنهادی با این فیلتر وجود ندارد",
      emptyDescription: "فیلتر را تغییر دهید یا لینک عمومی پروژه را برای جذب مشارکت منتشر کنید.",
    }));
  };
  search.addEventListener("input", renderFiltered);
  status.addEventListener("change", renderFiltered);
  renderFiltered();
  const metricGrid = node("div", { className: "ws-metric-grid" }, [
    metricCard("کل پیشنهادها", faNumber(summary.total || proposals.length), "همهٔ پیشنهادهای دریافت‌شده", "◌"),
    metricCard("جدید", faNumber(summary.new || 0), "نیازمند نخستین بررسی", "•"),
    metricCard("در مذاکره", faNumber(summary.negotiating || 0), "در حال توافق روی مشارکت", "↔"),
    metricCard("نیازهای متعهد", faNumber(needs.filter((item) => item.statusKey === "committed" || item.status === "committed").length), `از ${faNumber(needs.filter((item) => !item.archivedAt).length)} نیاز فعال`, "✓"),
  ]);
  dom.pageBody.replaceChildren(metricGrid, filters, tableHost);
}

function openPhaseDialog(phase = null) {
  openEntityDialog({
    kicker: phase ? "ویرایش مرحله" : "برنامهٔ اجرا",
    title: phase ? phase.title : "مرحلهٔ جدید",
    submitLabel: phase ? "ذخیره مرحله" : "افزودن مرحله",
    initial: phase || { status: "planned", progressMethod: "tasks", manualProgress: 0 },
    fields: [
      { name: "title", label: "عنوان مرحله", required: true, maxLength: 200 },
      { name: "description", label: "شرح", type: "textarea", rows: 3, maxLength: 5000 },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: ["planned", "active", "completed", "blocked", "cancelled"].map((value) => ({ value, label: translatedStatus(value) })),
      },
      {
        name: "progressMethod",
        label: "روش محاسبه پیشرفت",
        type: "select",
        options: [
          { value: "tasks", label: "از وظایف" },
          { value: "manual", label: "دستی" },
          { value: "milestones", label: "از گزارش‌های مرحله" },
        ],
      },
      { name: "manualProgress", label: "پیشرفت دستی (درصد)", type: "number", min: 0, max: 100, step: 0.1 },
      { name: "plannedStart", label: "شروع برنامه‌ای", type: "date" },
      { name: "plannedEnd", label: "پایان برنامه‌ای", type: "date" },
    ],
    onSubmit: async (values) => {
      await api(projectPath(`phases${phase ? `/${encodeURIComponent(phase.id)}` : ""}`), {
        method: phase ? "PATCH" : "POST",
        body: values,
      });
      toast(phase ? "مرحله به‌روزرسانی شد." : "مرحله اضافه شد.");
      await navigate("execution", { replace: true });
    },
  });
}

function openTaskDialog(phases, task = null) {
  openEntityDialog({
    kicker: task ? "ویرایش وظیفه" : "برنامهٔ اجرا",
    title: task ? task.title : "وظیفهٔ جدید",
    submitLabel: task ? "ذخیره وظیفه" : "افزودن وظیفه",
    initial: task || { status: "todo", priority: "medium", progressPercent: 0, weight: 1 },
    fields: [
      { name: "title", label: "عنوان وظیفه", required: true, maxLength: 240 },
      { name: "description", label: "شرح", type: "textarea", rows: 3 },
      {
        name: "phaseId",
        label: "مرحله",
        type: "select",
        options: [{ value: "", label: "بدون مرحله" }, ...phases.map((phase) => ({ value: phase.id, label: phase.title }))],
      },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: ["backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"].map((value) => ({ value, label: translatedStatus(value) })),
      },
      {
        name: "priority",
        label: "اولویت",
        type: "select",
        options: Object.entries(labels.taskPriority).map(([value, label]) => ({ value, label })),
      },
      { name: "progressPercent", label: "پیشرفت (درصد)", type: "number", min: 0, max: 100, step: 0.1 },
      { name: "weight", label: "وزن", type: "number", min: 0.001, step: 0.1 },
      { name: "plannedStart", label: "شروع برنامه‌ای", type: "date" },
      { name: "dueDate", label: "مهلت", type: "date" },
      { name: "estimatedMinutes", label: "زمان برآوردی (دقیقه)", type: "number", min: 0, step: 1 },
    ],
    onSubmit: async (values) => {
      await api(projectPath(`tasks${task ? `/${encodeURIComponent(task.id)}` : ""}`), {
        method: task ? "PATCH" : "POST",
        body: values,
      });
      toast(task ? "وظیفه به‌روزرسانی شد." : "وظیفه اضافه شد.");
      await navigate("execution", { replace: true });
    },
  });
}

function openProgressDialog(phases, tasks) {
  openEntityDialog({
    kicker: "شاهد پیشرفت",
    title: "ثبت گزارش پیشرفت",
    submitLabel: "ثبت گزارش",
    initial: { progressPercent: 0 },
    fields: [
      {
        name: "phaseId",
        label: "مرحله",
        type: "select",
        options: [{ value: "", label: "انتخاب مرحله (اختیاری)" }, ...phases.map((item) => ({ value: item.id, label: item.title }))],
      },
      {
        name: "taskId",
        label: "وظیفه",
        type: "select",
        options: [{ value: "", label: "انتخاب وظیفه (اختیاری)" }, ...tasks.map((item) => ({ value: item.id, label: item.title }))],
      },
      { name: "progressPercent", label: "درصد پیشرفت", type: "number", min: 0, max: 100, step: 0.1, required: true },
      { name: "summary", label: "خلاصهٔ پیشرفت", type: "textarea", rows: 3, required: true, minLength: 2 },
      { name: "blockers", label: "موانع", type: "textarea", rows: 2 },
      { name: "nextSteps", label: "گام‌های بعدی", type: "textarea", rows: 2 },
    ],
    note: "حداقل یک مرحله یا وظیفه انتخاب کنید. گزارش در تاریخچهٔ ممیزی ذخیره می‌شود.",
    onSubmit: async (values) => {
      if (!values.phaseId && !values.taskId) {
        throw new ApiError(400, { error: { message: "یک مرحله یا وظیفه انتخاب کنید." } });
      }
      await api(projectPath("progress-updates"), { method: "POST", body: values });
      toast("گزارش پیشرفت ثبت شد.");
      await navigate("execution", { replace: true });
    },
  });
}

async function renderExecution(sequence) {
  const [dashboard, phaseResult, taskResult, progressResult] = await Promise.all([
    api(projectPath("operations/dashboard")),
    api(projectPath("phases")),
    api(projectPath("tasks")),
    api(projectPath("progress-updates")),
  ]);
  if (!ensureSequence(sequence)) return;
  const phases = phaseResult.phases || [];
  const tasks = taskResult.tasks || [];
  const updates = progressResult.progressUpdates || [];
  const manageable = hasPermission("project_work.write");
  setPageActions([
    manageable ? button("ثبت پیشرفت", { onClick: () => openProgressDialog(phases, tasks) }) : null,
    manageable ? button("وظیفهٔ جدید", { onClick: () => openTaskDialog(phases) }) : null,
    manageable ? button("مرحلهٔ جدید", { variant: "primary", onClick: () => openPhaseDialog() }) : null,
  ]);
  const metrics = node("div", { className: "ws-metric-grid" }, [
    metricCard("پیشرفت اجرا", faPercent(dashboard.executionProgressPercent), dashboard.progressCalculation === "equal_weighted_phases" ? "میانگین مراحل فعال" : "وظایف وزن‌دار", "↗"),
    metricCard("وظایف تکمیل‌شده", `${faNumber(dashboard.tasks?.done || 0)} / ${faNumber(dashboard.tasks?.total || 0)}`, `${faNumber(dashboard.tasks?.overdue || 0)} وظیفه عقب‌افتاده`, "✓"),
    metricCard("موانع فعال", faNumber((dashboard.tasks?.blocked || 0) + (dashboard.phases?.blocked || 0)), "مرحله یا وظیفهٔ مسدود", "!"),
    metricCard("گزارش پیشرفت", faNumber(updates.length), "شواهد ثبت‌شده در پروژه", "□"),
  ]);
  const phaseList = node("div", { className: "ws-progress-list" });
  if (phases.length) {
    for (const phase of phases) {
      const item = progressItem(
        phase.title,
        `${translatedStatus(phase.status)} · ${faDate(phase.plannedEnd)}`,
        phase.progressPercent,
      );
      if (manageable) {
        item.tabIndex = 0;
        item.addEventListener("click", () => openPhaseDialog(phase));
        item.addEventListener("keydown", (event) => {
          if (event.key === "Enter") openPhaseDialog(phase);
        });
      }
      phaseList.append(item);
    }
  } else {
    phaseList.append(emptyState(
      "هنوز مرحله‌ای تعریف نشده است",
      "ساختار شکست اجرای پروژه را با مرحله‌ها و وظایف ایجاد کنید.",
      { action: manageable ? button("مرحلهٔ جدید", { variant: "primary", onClick: () => openPhaseDialog() }) : null },
    ));
  }
  const taskTable = dataTable([
    { label: "وظیفه", title: true, render: (item) => titleCell(item.title, phases.find((phase) => phase.id === item.phaseId)?.title) },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    { label: "اولویت", render: (item) => labels.taskPriority[item.priority] || item.priority },
    { label: "پیشرفت", render: (item) => faPercent(item.calculatedProgressPercent ?? item.progressPercent) },
    { label: "مهلت", render: (item) => faDate(item.dueDate) },
    {
      label: "عملیات",
      render: (item) => manageable
        ? button("ویرایش", { variant: "ghost", onClick: () => openTaskDialog(phases, item) })
        : "فقط مشاهده",
    },
  ], tasks, {
    emptyTitle: "هنوز وظیفه‌ای وجود ندارد",
    emptyDescription: "وظایف را زیر مرحله‌های پروژه تعریف و پیشرفت واقعی را ثبت کنید.",
    emptyAction: manageable ? button("وظیفهٔ جدید", { variant: "primary", onClick: () => openTaskDialog(phases) }) : null,
  });
  dom.pageBody.replaceChildren(
    metrics,
    node("div", { className: "ws-dashboard-grid" }, [
      panel("مراحل پروژه", "برای ویرایش روی هر مرحله انتخاب کنید", phaseList),
      panel("آخرین گزارش‌ها", "جدیدترین شواهد پیشرفت", node("div", { className: "ws-activity-list" },
        updates.slice(0, 6).map((update) => node("div", { className: "ws-activity" }, [
          node("span", { text: faNumber(update.progressPercent) }),
          node("div", {}, [
            node("strong", { text: update.summary }),
            node("small", { text: faDate(update.reportedAt, true) }),
          ]),
        ])))),
    ]),
    node("br", { attributes: { "aria-hidden": "true" } }),
    taskTable,
  );
}

function openResourceDialog(resource = null) {
  openEntityDialog({
    kicker: resource ? "ویرایش منبع" : "ظرفیت پروژه",
    title: resource ? resource.name : "منبع جدید",
    submitLabel: resource ? "ذخیره منبع" : "افزودن منبع",
    initial: resource || { kind: "person", status: "available", currency: currentProject()?.currency || "IRR" },
    fields: [
      { name: "name", label: "نام منبع", required: true, maxLength: 200 },
      {
        name: "kind",
        label: "نوع",
        type: "select",
        options: [
          ["person", "نیروی انسانی"],
          ["equipment", "تجهیزات"],
          ["facility", "فضا / تأسیسات"],
          ["material", "مواد"],
          ["service", "خدمت"],
          ["capital", "سرمایه"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "unit", label: "واحد ظرفیت", required: true, maxLength: 40, placeholder: "نفر-ساعت، دستگاه، کیلوگرم…" },
      { name: "capacity", label: "ظرفیت", type: "number", min: 0, step: 0.01 },
      { name: "unitCost", label: "هزینهٔ واحد", type: "number", min: 0, step: 1 },
      { name: "currency", label: "واحد پول", dir: "ltr", maxLength: 3 },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: ["available", "allocated", "unavailable", "retired"].map((value) => ({ value, label: translatedStatus(value) })),
      },
    ],
    onSubmit: async (values) => {
      await api(projectPath(`resources${resource ? `/${encodeURIComponent(resource.id)}` : ""}`), {
        method: resource ? "PATCH" : "POST",
        body: values,
      });
      toast(resource ? "منبع به‌روزرسانی شد." : "منبع اضافه شد.");
      await navigate("resources", { replace: true });
    },
  });
}

function openAllocationDialog(resources, tasks, phases) {
  openEntityDialog({
    kicker: "برنامهٔ ظرفیت",
    title: "تخصیص منبع",
    submitLabel: "ثبت تخصیص",
    fields: [
      {
        name: "resourceId",
        label: "منبع",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب منبع" }, ...resources.map((item) => ({ value: item.id, label: item.name }))],
      },
      {
        name: "taskId",
        label: "وظیفه",
        type: "select",
        options: [{ value: "", label: "بدون وظیفه" }, ...tasks.map((item) => ({ value: item.id, label: item.title }))],
      },
      {
        name: "phaseId",
        label: "مرحله",
        type: "select",
        options: [{ value: "", label: "بدون مرحله" }, ...phases.map((item) => ({ value: item.id, label: item.title }))],
      },
      { name: "quantity", label: "مقدار", type: "number", min: 0.001, step: 0.01, required: true },
      { name: "startsOn", label: "از تاریخ", type: "date" },
      { name: "endsOn", label: "تا تاریخ", type: "date" },
      { name: "note", label: "یادداشت", type: "textarea", rows: 2 },
    ],
    onSubmit: async (values) => {
      await api(projectPath("allocations"), { method: "POST", body: values });
      toast("تخصیص منبع ثبت شد.");
      await navigate("resources", { replace: true });
    },
  });
}

function openTimeEntryDialog(tasks) {
  openEntityDialog({
    kicker: "مصرف واقعی",
    title: "ثبت زمان کار",
    submitLabel: "ثبت زمان",
    fields: [
      {
        name: "taskId",
        label: "وظیفه",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب وظیفه" }, ...tasks.map((item) => ({ value: item.id, label: item.title }))],
      },
      { name: "minutes", label: "مدت (دقیقه)", type: "number", min: 1, step: 1, required: true },
      { name: "workedOn", label: "تاریخ انجام", type: "date", required: true, value: new Date().toISOString().slice(0, 10) },
      { name: "note", label: "شرح کار", type: "textarea", rows: 2, required: true, maxLength: 2000 },
    ],
    onSubmit: async (values) => {
      await api(projectPath("time-entries"), { method: "POST", body: values });
      toast("زمان کار ثبت شد.");
      await navigate("resources", { replace: true });
    },
  });
}

async function renderResources(sequence) {
  const [dashboard, resourceResult, allocationResult, taskResult, phaseResult, timeResult] = await Promise.all([
    api(projectPath("operations/dashboard")),
    api(projectPath("resources")),
    api(projectPath("allocations")),
    api(projectPath("tasks")),
    api(projectPath("phases")),
    api(projectPath("time-entries")),
  ]);
  if (!ensureSequence(sequence)) return;
  const resources = resourceResult.resources || [];
  const allocations = allocationResult.allocations || [];
  const tasks = taskResult.tasks || [];
  const phases = phaseResult.phases || [];
  const timeEntries = timeResult.timeEntries || [];
  const manageable = hasPermission("project_work.write");
  setPageActions([
    manageable ? button("ثبت زمان", { onClick: () => openTimeEntryDialog(tasks) }) : null,
    manageable ? button("تخصیص منبع", { onClick: () => openAllocationDialog(resources, tasks, phases) }) : null,
    manageable ? button("منبع جدید", { variant: "primary", onClick: () => openResourceDialog() }) : null,
  ]);
  const totalMinutes = timeEntries.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
  const allocated = allocations.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const metrics = node("div", { className: "ws-metric-grid" }, [
    metricCard("منابع ثبت‌شده", faNumber(resources.length), `${faNumber(resources.filter((item) => item.status === "available").length)} منبع آماده`, "◫"),
    metricCard("تخصیص فعال", faNumber(allocations.length), `${faNumber(allocated, 1)} واحد تخصیص`, "↔"),
    metricCard("اضافه‌تخصیص", faNumber(dashboard.resources?.overallocated || 0), "بیش از ظرفیت تعریف‌شده", "!"),
    metricCard("زمان واقعی", `${faNumber(totalMinutes / 60, 1)} ساعت`, `${faNumber(timeEntries.length)} ثبت زمانی`, "◷"),
  ]);
  const table = dataTable([
    { label: "منبع", title: true, render: (item) => titleCell(item.name, item.unit) },
    { label: "نوع", render: (item) => ({ person: "نیروی انسانی", equipment: "تجهیزات", facility: "تأسیسات", material: "مواد", service: "خدمت", capital: "سرمایه" }[item.kind] || item.kind) },
    { label: "ظرفیت", render: (item) => item.capacity == null ? "نامحدود" : `${faNumber(item.capacity, 2)} ${item.unit}` },
    { label: "اوج تخصیص", render: (item) => `${faNumber(item.allocatedQuantityPeak || 0, 2)} ${item.unit}` },
    { label: "هزینه واحد", render: (item) => item.unitCost == null ? "—" : faMoney(item.unitCost, item.currency) },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    {
      label: "عملیات",
      render: (item) => manageable
        ? button("ویرایش", { variant: "ghost", onClick: () => openResourceDialog(item) })
        : "فقط مشاهده",
    },
  ], resources, {
    emptyTitle: "منابع پروژه تعریف نشده‌اند",
    emptyDescription: "ظرفیت افراد، تجهیزات، مواد و خدمات را برای برنامه‌ریزی واقع‌بینانه ثبت کنید.",
    emptyAction: manageable ? button("منبع جدید", { variant: "primary", onClick: () => openResourceDialog() }) : null,
  });
  dom.pageBody.replaceChildren(metrics, table);
}

function openRiskDialog(risk = null, forcedKind = "") {
  openEntityDialog({
    kicker: risk ? "بازبینی ریسک" : "ثبت ریسک و مسئله",
    title: risk ? risk.title : forcedKind === "issue" ? "مسئلهٔ جدید" : "ریسک جدید",
    submitLabel: risk ? "ذخیره تغییرات" : "ثبت مورد",
    initial: risk || { kind: forcedKind || "risk", probability: 3, impact: 3, status: "open" },
    fields: [
      { name: "title", label: "عنوان", required: true, maxLength: 240 },
      { name: "description", label: "شرح", type: "textarea", rows: 3 },
      {
        name: "kind",
        label: "نوع",
        type: "select",
        options: [
          ["risk", "ریسک"],
          ["issue", "مسئله"],
          ["assumption", "فرض"],
          ["dependency", "وابستگی"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "category", label: "دسته‌بندی", maxLength: 100 },
      { name: "probability", label: "احتمال (۱ تا ۵)", type: "number", min: 1, max: 5, step: 1 },
      { name: "impact", label: "اثر (۱ تا ۵)", type: "number", min: 1, max: 5, step: 1 },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: ["open", "mitigating", "accepted", "resolved", "closed"].map((value) => ({ value, label: translatedStatus(value) })),
      },
      { name: "responseStrategy", label: "راهبرد پاسخ", type: "textarea", rows: 2, maxLength: 5000 },
      { name: "dueDate", label: "مهلت اقدام", type: "date" },
    ],
    onSubmit: async (values) => {
      await api(projectPath(`risks${risk ? `/${encodeURIComponent(risk.id)}` : ""}`), {
        method: risk ? "PATCH" : "POST",
        body: values,
      });
      toast(risk ? "ریسک به‌روزرسانی شد." : "مورد ثبت شد.");
      await navigate("performance", { replace: true });
    },
  });
}

function openKpiDialog(kpi = null) {
  openEntityDialog({
    kicker: kpi ? "ویرایش شاخص" : "اندازه‌گیری عملکرد",
    title: kpi ? kpi.name : "شاخص کلیدی جدید",
    submitLabel: kpi ? "ذخیره شاخص" : "ساخت شاخص",
    initial: kpi || { direction: "increase", frequency: "monthly", baselineValue: 0 },
    fields: [
      { name: "name", label: "نام شاخص", required: true, maxLength: 200 },
      { name: "description", label: "تعریف شاخص", type: "textarea", rows: 2, maxLength: 5000 },
      { name: "unit", label: "واحد", required: true, maxLength: 40 },
      {
        name: "direction",
        label: "جهت مطلوب",
        type: "select",
        options: [
          { value: "increase", label: "افزایش بهتر است" },
          { value: "decrease", label: "کاهش بهتر است" },
          { value: "maintain", label: "حفظ مقدار هدف" },
        ],
      },
      { name: "baselineValue", label: "خط مبنا", type: "number", step: 0.01 },
      { name: "targetValue", label: "مقدار هدف", type: "number", step: 0.01, required: true },
      { name: "warningValue", label: "مرز هشدار", type: "number", step: 0.01 },
      {
        name: "frequency",
        label: "دوره اندازه‌گیری",
        type: "select",
        options: [
          ["daily", "روزانه"],
          ["weekly", "هفتگی"],
          ["monthly", "ماهانه"],
          ["quarterly", "فصلی"],
          ["annual", "سالانه"],
          ["on_demand", "موردی"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "targetDate", label: "تاریخ هدف", type: "date" },
    ],
    onSubmit: async (values) => {
      await api(projectPath(`kpis${kpi ? `/${encodeURIComponent(kpi.id)}` : ""}`), {
        method: kpi ? "PATCH" : "POST",
        body: values,
      });
      toast(kpi ? "شاخص به‌روزرسانی شد." : "شاخص ساخته شد.");
      await navigate("performance", { replace: true });
    },
  });
}

function openMeasurementDialog(kpi) {
  openEntityDialog({
    kicker: "ثبت اندازه‌گیری",
    title: kpi.name,
    submitLabel: "ثبت مقدار",
    fields: [
      { name: "value", label: `مقدار (${kpi.unit})`, type: "number", step: 0.01, required: true },
      { name: "measuredAt", label: "زمان اندازه‌گیری", type: "datetime-local" },
      { name: "note", label: "توضیح", type: "textarea", rows: 2 },
    ],
    onSubmit: async (values) => {
      if (values.measuredAt) values.measuredAt = new Date(values.measuredAt).toISOString();
      await api(projectPath(`kpis/${encodeURIComponent(kpi.id)}/measurements`), {
        method: "POST",
        body: values,
      });
      toast("اندازه‌گیری ثبت شد.");
      await navigate("performance", { replace: true });
    },
  });
}

async function renderPerformance(sequence) {
  const [dashboard, riskResult, kpiResult, goalResult] = await Promise.all([
    api(projectPath("operations/dashboard")),
    api(projectPath("risks")),
    api(projectPath("kpis")),
    optionalApi(projectPath("goals")),
  ]);
  if (!ensureSequence(sequence)) return;
  const risks = riskResult.risks || [];
  const kpis = kpiResult.kpis || [];
  const goals = goalResult?.goals || [];
  const manageable = hasPermission("project_work.write");
  setPageActions([
    manageable ? button("مسئلهٔ جدید", { onClick: () => openRiskDialog(null, "issue") }) : null,
    manageable ? button("ریسک جدید", { onClick: () => openRiskDialog() }) : null,
    manageable ? button("شاخص جدید", { variant: "primary", onClick: () => openKpiDialog() }) : null,
  ]);
  const metrics = node("div", { className: "ws-metric-grid" }, [
    metricCard("ریسک باز", faNumber(dashboard.risks?.open || 0), `${faNumber(dashboard.risks?.critical || 0)} مورد بحرانی`, "!"),
    metricCard("مسائل", faNumber(dashboard.risks?.issues || 0), "مسائل ثبت‌شدهٔ پروژه", "◉"),
    metricCard("KPI روی مسیر", `${faNumber(dashboard.kpis?.onTrack || 0)} / ${faNumber(dashboard.kpis?.measured || 0)}`, faPercent(dashboard.kpis?.achievementPercent), "↗"),
    metricCard("اهداف", faNumber(goals.length), `${faNumber(goals.filter((item) => item.status === "completed").length)} هدف محقق`, "✓"),
  ]);
  let activeTab = "risks";
  const host = node("div");
  const tabItems = [
    { value: "risks", label: `ریسک و مسئله (${faNumber(risks.length)})` },
    { value: "kpis", label: `شاخص‌ها (${faNumber(kpis.length)})` },
    { value: "goals", label: `اهداف (${faNumber(goals.length)})` },
  ];
  function renderTab(value) {
    if (value === "risks") {
      host.replaceChildren(dataTable([
        { label: "عنوان", title: true, render: (item) => titleCell(item.title, item.kind === "issue" ? "مسئله" : "ریسک") },
        { label: "امتیاز", render: (item) => `${faNumber(item.score)} · ${labels.riskBand[item.band] || item.band}` },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
        { label: "مهلت", render: (item) => faDate(item.dueDate) },
        { label: "پاسخ", render: (item) => item.responseStrategy || "—" },
        { label: "عملیات", render: (item) => manageable ? button("ویرایش", { variant: "ghost", onClick: () => openRiskDialog(item) }) : "فقط مشاهده" },
      ], risks));
    } else if (value === "kpis") {
      host.replaceChildren(dataTable([
        { label: "شاخص", title: true, render: (item) => titleCell(item.name, item.unit) },
        { label: "فعلی / هدف", render: (item) => `${item.currentValue == null ? "—" : faNumber(item.currentValue, 2)} / ${faNumber(item.targetValue, 2)}` },
        { label: "تحقق", render: (item) => faPercent(item.achievementPercent) },
        { label: "سلامت", render: (item) => statusChip(item.health, { on_track: "روی مسیر", warning: "هشدار", off_track: "خارج از مسیر", no_data: "بدون داده" }[item.health]) },
        { label: "تاریخ هدف", render: (item) => faDate(item.targetDate) },
        {
          label: "عملیات",
          render: (item) => manageable ? node("div", {}, [
            button("مقدار جدید", { variant: "ghost", onClick: () => openMeasurementDialog(item) }),
            button("ویرایش", { variant: "ghost", onClick: () => openKpiDialog(item) }),
          ]) : "فقط مشاهده",
        },
      ], kpis));
    } else {
      host.replaceChildren(dataTable([
        { label: "هدف", title: true, render: (item) => titleCell(item.title, item.description) },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
        { label: "وزن", render: (item) => faNumber(item.weight, 1) },
        { label: "پیشرفت", render: (item) => faPercent(item.progressPercent) },
        { label: "تاریخ هدف", render: (item) => faDate(item.targetDate) },
      ], goals, {
        emptyDescription: "هدف‌های سطح پروژه از بخش مدیریت کلاسیک نیز قابل ثبت هستند.",
      }));
    }
  }
  // Rebuild tabs without relying on unsafe HTML templating or global state.
  const tabContainer = node("div", { className: "ws-tabs", attributes: { role: "tablist" } });
  for (const item of tabItems) {
    const tabButton = node("button", {
      type: "button",
      text: item.label,
      className: item.value === activeTab ? "is-active" : "",
      attributes: { role: "tab", "aria-selected": item.value === activeTab ? "true" : "false" },
      onclick: () => {
        activeTab = item.value;
        for (const buttonItem of $$("button", tabContainer)) {
          const selected = buttonItem === tabButton;
          buttonItem.classList.toggle("is-active", selected);
          buttonItem.setAttribute("aria-selected", selected ? "true" : "false");
        }
        renderTab(activeTab);
      },
    });
    tabContainer.append(tabButton);
  }
  renderTab(activeTab);
  dom.pageBody.replaceChildren(metrics, tabContainer, host);
}

function openAccountDialog(account = null) {
  openEntityDialog({
    kicker: "دفتر کل",
    title: account ? account.name : "حساب جدید",
    submitLabel: account ? "ذخیره حساب" : "ساخت حساب",
    initial: account || { accountType: "asset", currency: currentProject()?.currency || "IRR", active: true },
    fields: [
      { name: "code", label: "کد حساب", required: true, maxLength: 40, dir: "ltr" },
      { name: "name", label: "نام حساب", required: true, maxLength: 200 },
      {
        name: "accountType",
        label: "نوع حساب",
        type: "select",
        options: [
          ["asset", "دارایی"],
          ["liability", "بدهی"],
          ["equity", "حقوق مالکانه"],
          ["revenue", "درآمد"],
          ["expense", "هزینه"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "currency", label: "واحد پول", dir: "ltr", maxLength: 3, disabled: Boolean(account) },
      { name: "systemKey", label: "کلید سیستمی (اختیاری)", dir: "ltr", maxLength: 80 },
      ...(account ? [{ name: "active", label: "حساب فعال باشد", type: "checkbox" }] : []),
    ],
    onSubmit: async (values) => {
      await api(projectPath(`accounts${account ? `/${encodeURIComponent(account.id)}` : ""}`), {
        method: account ? "PATCH" : "POST",
        body: values,
      });
      toast(account ? "حساب به‌روزرسانی شد." : "حساب ساخته شد.");
      await navigate("finance", { replace: true });
    },
  });
}

function openFiscalPeriodDialog() {
  const year = new Date().getFullYear();
  openEntityDialog({
    kicker: "دورهٔ حسابداری",
    title: "دورهٔ مالی جدید",
    submitLabel: "ساخت دوره",
    initial: { name: `دوره ${year}`, status: "open" },
    fields: [
      { name: "name", label: "نام دوره", required: true, maxLength: 150 },
      { name: "startsOn", label: "شروع", type: "date", required: true },
      { name: "endsOn", label: "پایان", type: "date", required: true },
      {
        name: "status",
        label: "وضعیت اولیه",
        type: "select",
        options: [
          { value: "open", label: "باز" },
          { value: "closing", label: "در حال بستن" },
        ],
      },
    ],
    onSubmit: async (values) => {
      await api(projectPath("fiscal-periods"), { method: "POST", body: values });
      toast("دورهٔ مالی ساخته شد.");
      await navigate("finance", { replace: true });
    },
  });
}

function openJournalDialog(accounts, periods) {
  const accountOptions = [
    { value: "", label: "انتخاب حساب" },
    ...accounts.filter((item) => item.active).map((item) => ({
      value: item.id,
      label: `${item.code} — ${item.name}`,
    })),
  ];
  openEntityDialog({
    kicker: "سند دوطرفه",
    title: "سند حسابداری جدید",
    submitLabel: "ثبت پیش‌نویس",
    initial: {
      occurredOn: new Date().toISOString().slice(0, 10),
      currency: currentProject()?.currency || "IRR",
      fiscalPeriodId: periods.find((item) => item.status === "open")?.id || "",
    },
    fields: [
      { name: "description", label: "شرح سند", required: true, maxLength: 2000 },
      { name: "occurredOn", label: "تاریخ رویداد", type: "date", required: true },
      {
        name: "fiscalPeriodId",
        label: "دورهٔ مالی",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب دوره" }, ...periods.map((item) => ({ value: item.id, label: `${item.name} — ${translatedStatus(item.status)}` }))],
      },
      { name: "debitAccountId", label: "حساب بدهکار", type: "select", required: true, options: accountOptions },
      { name: "creditAccountId", label: "حساب بستانکار", type: "select", required: true, options: accountOptions },
      { name: "amount", label: "مبلغ", type: "number", min: 1, step: 1, required: true },
      { name: "currency", label: "واحد پول", dir: "ltr", disabled: true },
    ],
    note: "سند ابتدا به‌صورت پیش‌نویس ذخیره می‌شود؛ ثبت قطعی تغییرناپذیر است.",
    onSubmit: async (values) => {
      if (values.debitAccountId === values.creditAccountId) {
        throw new ApiError(400, { error: { message: "حساب بدهکار و بستانکار باید متفاوت باشند." } });
      }
      const amount = values.amount;
      await api(projectPath("journal-entries"), {
        method: "POST",
        idempotent: true,
        body: {
          occurredOn: values.occurredOn,
          fiscalPeriodId: values.fiscalPeriodId,
          description: values.description,
          currency: values.currency || currentProject()?.currency,
          sourceType: "manual",
          lines: [
            { accountId: values.debitAccountId, debit: amount, credit: 0, description: values.description },
            { accountId: values.creditAccountId, debit: 0, credit: amount, description: values.description },
          ],
        },
      });
      toast("سند پیش‌نویس ثبت شد.");
      await navigate("finance", { replace: true });
    },
  });
}

function openInvoiceDialog(accounts) {
  const options = [
    { value: "", label: "انتخاب حساب" },
    ...accounts.filter((item) => item.active).map((item) => ({ value: item.id, label: `${item.code} — ${item.name}` })),
  ];
  openEntityDialog({
    kicker: "دریافتنی / پرداختنی",
    title: "صدور صورتحساب",
    submitLabel: "صدور و ثبت قطعی",
    initial: {
      kind: "receivable",
      issuedOn: new Date().toISOString().slice(0, 10),
      currency: currentProject()?.currency || "IRR",
      subtotal: 0,
      taxAmount: 0,
      discountAmount: 0,
    },
    fields: [
      {
        name: "kind",
        label: "نوع",
        type: "select",
        options: [
          { value: "receivable", label: "فروش / دریافتنی" },
          { value: "payable", label: "خرید / پرداختنی" },
        ],
      },
      { name: "invoiceNo", label: "شماره صورتحساب", required: true, dir: "ltr", maxLength: 100 },
      { name: "counterpartyName", label: "طرف حساب", required: true, maxLength: 300 },
      { name: "issuedOn", label: "تاریخ صدور", type: "date", required: true },
      { name: "dueOn", label: "سررسید", type: "date" },
      { name: "subtotal", label: "جمع جزء", type: "number", min: 1, step: 1, required: true },
      { name: "taxAmount", label: "مالیات", type: "number", min: 0, step: 1 },
      { name: "discountAmount", label: "تخفیف", type: "number", min: 0, step: 1 },
      { name: "debitAccountId", label: "حساب بدهکار", type: "select", required: true, options },
      { name: "creditAccountId", label: "حساب بستانکار", type: "select", required: true, options },
      { name: "currency", label: "واحد پول", dir: "ltr", disabled: true },
      { name: "notes", label: "توضیحات", type: "textarea", rows: 2 },
    ],
    onSubmit: async (values) => {
      await api(projectPath("invoices"), {
        method: "POST",
        idempotent: true,
        body: {
          ...values,
          counterpartyType: "external",
          currency: values.currency || currentProject()?.currency,
        },
      });
      toast("صورتحساب صادر و سند آن قطعی شد.");
      await navigate("finance", { replace: true });
    },
  });
}

function openPaymentDialog(invoices) {
  const availableInvoices = invoices.filter((item) => !["paid", "void"].includes(item.status));
  openEntityDialog({
    kicker: "گردش وجه",
    title: "درخواست پرداخت",
    submitLabel: "ساخت درخواست",
    initial: { direction: "incoming", provider: "manual", currency: currentProject()?.currency || "IRR" },
    fields: [
      {
        name: "invoiceId",
        label: "صورتحساب (اختیاری)",
        type: "select",
        options: [{ value: "", label: "بدون صورتحساب" }, ...availableInvoices.map((item) => ({
          value: item.id,
          label: `${item.kind === "payable" ? "پرداخت" : "دریافت"} · ${item.invoiceNo} — ${item.counterpartyName} — ${faMoney(item.totalAmount - item.paidAmount, item.currency)}`,
        }))],
      },
      {
        name: "direction",
        label: "جهت وجه",
        type: "select",
        options: [
          { value: "incoming", label: "دریافت" },
          { value: "outgoing", label: "پرداخت" },
        ],
      },
      { name: "amount", label: "مبلغ", type: "number", min: 1, step: 1, required: true },
      { name: "currency", label: "واحد پول", dir: "ltr", disabled: true },
      {
        name: "provider",
        label: "روش",
        type: "select",
        options: [{ value: "manual", label: "ثبت دستی بانکی" }],
      },
    ],
    note: "در صورت انتخاب صورتحساب، جهت وجه از نوع همان صورتحساب تعیین می‌شود. ساخت درخواست به‌معنای موفقیت پرداخت نیست و تأیید به مرجع بانکی واقعی نیاز دارد.",
    onSubmit: async (values) => {
      const invoice = availableInvoices.find((item) => item.id === values.invoiceId);
      const direction = invoice
        ? (invoice.kind === "payable" ? "outgoing" : "incoming")
        : values.direction;
      await api(projectPath("payment-intents"), {
        method: "POST",
        idempotent: true,
        body: {
          ...values,
          direction,
          currency: values.currency || currentProject()?.currency,
        },
      });
      toast("درخواست پرداخت ساخته شد؛ هنوز قطعی نیست.");
      await navigate("finance", { replace: true });
    },
  });
}

function openPaymentConfirmDialog(payment, accounts, returnView = "finance") {
  const options = [{ value: "", label: "انتخاب حساب" }, ...accounts.filter((item) => item.active).map((item) => ({
    value: item.id,
    label: `${item.code} — ${item.name}`,
  }))];
  openEntityDialog({
    kicker: "تأیید کنترل‌شده",
    title: `تأیید ${faMoney(payment.amount, payment.currency)}`,
    submitLabel: "تأیید پرداخت",
    fields: [
      { name: "manualReference", label: "شماره پیگیری بانکی", required: payment.provider === "manual", dir: "ltr", maxLength: 200 },
      { name: "providerEventId", label: "شناسه رویداد یکتا", required: true, dir: "ltr", value: crypto.randomUUID() },
      { name: "cashAccountId", label: "حساب بانک / صندوق", type: "select", required: true, options },
      ...(payment.invoiceId ? [] : [{ name: "counterAccountId", label: "حساب مقابل", type: "select", required: true, options }]),
      { name: "occurredOn", label: "تاریخ", type: "date", value: new Date().toISOString().slice(0, 10), required: true },
    ],
    note: "این عملیات سند حسابداری قطعی ایجاد می‌کند. تأیید ارائه‌دهندهٔ واقعی فقط از adapter رسمی پذیرفته می‌شود.",
    onSubmit: async (values) => {
      await api(projectPath(`payment-intents/${encodeURIComponent(payment.id)}/confirm`), {
        method: "POST",
        body: values,
      });
      toast("پرداخت تأیید و سند مالی ثبت شد.");
      await navigate(returnView, { replace: true });
    },
  });
}

function openDistributionDialog() {
  openEntityDialog({
    kicker: "سود و بازده",
    title: "پیش‌نمایش توزیع سود",
    submitLabel: "محاسبه و ذخیره پیش‌نویس",
    initial: {
      recordDate: new Date().toISOString().slice(0, 10),
      currency: currentProject()?.currency || "IRR",
    },
    fields: [
      { name: "title", label: "عنوان توزیع", required: true, maxLength: 200 },
      { name: "recordDate", label: "تاریخ مبنا", type: "date", required: true },
      { name: "payableOn", label: "تاریخ پرداخت", type: "date" },
      { name: "totalAmount", label: "مبلغ کل", type: "number", min: 1, step: 1, required: true },
      { name: "currency", label: "واحد پول", dir: "ltr", disabled: true },
    ],
    note: "تخصیص با روش بزرگ‌ترین باقیمانده و بر پایهٔ مالکیت در تاریخ مبنا محاسبه می‌شود؛ KYC معتبر ذی‌نفعان هنگام تصویب و پرداخت توسط policy سرور الزام و کنترل می‌شود.",
    onSubmit: async (values) => {
      await api(projectPath("distributions/preview"), {
        method: "POST",
        body: { ...values, currency: values.currency || currentProject()?.currency },
      });
      toast("پیش‌نمایش توزیع با تخصیص دقیق ذخیره شد.");
      await navigate("finance", { replace: true });
    },
  });
}

function openDistributionApprovalDialog(distribution, accounts) {
  const equityAccounts = accounts.filter((item) => item.active && item.accountType === "equity");
  const liabilityAccounts = accounts.filter((item) => item.active && item.accountType === "liability");
  openEntityDialog({
    kicker: "تصویب و ثبت حسابداری",
    title: distribution.title,
    submitLabel: "تصویب توزیع",
    initial: {
      retainedEarningsAccountId: equityAccounts.find((item) => item.systemKey === "retained_earnings")?.id || "",
      payableAccountId: liabilityAccounts.find((item) => item.systemKey === "distribution_payable")?.id || "",
    },
    fields: [
      {
        name: "retainedEarningsAccountId",
        label: "حساب سود انباشته / حقوق مالکانه",
        type: "select",
        required: true,
        options: [
          { value: "", label: "انتخاب حساب حقوق مالکانه" },
          ...equityAccounts.map((item) => ({ value: item.id, label: `${item.code} — ${item.name}` })),
        ],
      },
      {
        name: "payableAccountId",
        label: "حساب سود پرداختنی",
        type: "select",
        required: true,
        options: [
          { value: "", label: "انتخاب حساب بدهی" },
          ...liabilityAccounts.map((item) => ({ value: item.id, label: `${item.code} — ${item.name}` })),
        ],
      },
    ],
    note: "تصویب، سند حسابداری قطعی ایجاد می‌کند و فقط با حساب‌های هم‌نوع معتبر انجام می‌شود؛ الزام KYC را policy سرور کنترل می‌کند و UI هیچ پرچم تأییدی ارسال نمی‌کند.",
    onSubmit: async (values) => {
      await api(projectPath(`distributions/${encodeURIComponent(distribution.id)}/approve`), {
        method: "POST",
        body: values,
      });
      toast("توزیع سود تصویب و سند مالی ثبت شد.");
      await navigate("finance", { replace: true });
    },
  });
}

function openDistributionPaymentDialog(distribution, accounts, periods) {
  const liabilityAccounts = accounts.filter((item) => item.active && item.accountType === "liability");
  const assetAccounts = accounts.filter((item) => item.active && item.accountType === "asset");
  openEntityDialog({
    kicker: "پرداخت سود مصوب",
    title: distribution.title,
    submitLabel: "ثبت پرداخت دستی",
    initial: {
      paidOn: new Date().toISOString().slice(0, 10),
      payableAccountId: liabilityAccounts.find((item) => item.systemKey === "distribution_payable")?.id || "",
      cashAccountId: assetAccounts.find((item) => item.systemKey === "cash")?.id || "",
      fiscalPeriodId: periods.find((item) => item.status === "open")?.id || "",
    },
    fields: [
      { name: "manualReference", label: "مرجع پرداخت بانکی", required: true, dir: "ltr", maxLength: 200 },
      {
        name: "payableAccountId",
        label: "حساب سود پرداختنی",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب حساب بدهی" }, ...liabilityAccounts.map((item) => ({
          value: item.id,
          label: `${item.code} — ${item.name}`,
        }))],
      },
      {
        name: "cashAccountId",
        label: "حساب بانک / صندوق",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب حساب دارایی" }, ...assetAccounts.map((item) => ({
          value: item.id,
          label: `${item.code} — ${item.name}`,
        }))],
      },
      {
        name: "fiscalPeriodId",
        label: "دوره مالی",
        type: "select",
        options: [{ value: "", label: "تشخیص خودکار از تاریخ" }, ...periods.map((item) => ({
          value: item.id,
          label: item.name,
        }))],
      },
      { name: "paidOn", label: "تاریخ پرداخت", type: "date", required: true },
    ],
    note: "فقط پرداخت دستی با مرجع واقعی ثبت می‌شود. policy سرور KYC هر ذی‌نفع را کنترل و سهم فاقد KYC معتبر را نگه‌داری می‌کند؛ UI هیچ پرچم تأیید KYC ارسال نمی‌کند.",
    onSubmit: async (values) => {
      await api(projectPath(`distributions/${encodeURIComponent(distribution.id)}/pay`), {
        method: "POST",
        body: { ...values, provider: "manual" },
      });
      toast("پرداخت توزیع ثبت و وضعیت تخصیص‌ها به‌روزرسانی شد.");
      await navigate("finance", { replace: true });
    },
  });
}

function openBudgetDialog() {
  openEntityDialog({
    kicker: "کنترل هزینه",
    title: "نسخهٔ بودجهٔ جدید",
    submitLabel: "ساخت بودجه",
    initial: { currency: currentProject()?.currency || "IRR" },
    fields: [
      { name: "name", label: "عنوان بودجه", required: true, maxLength: 200 },
      { name: "periodStart", label: "شروع دوره", type: "date" },
      { name: "periodEnd", label: "پایان دوره", type: "date" },
      { name: "currency", label: "واحد پول", dir: "ltr", disabled: true },
    ],
    onSubmit: async (values) => {
      await api(projectPath("budgets"), {
        method: "POST",
        body: { ...values, currency: values.currency || currentProject()?.currency },
      });
      toast("نسخهٔ بودجه ساخته شد.");
      await navigate("finance", { replace: true });
    },
  });
}

function openValuationDialog() {
  openEntityDialog({
    kicker: "ارزش و بازده",
    title: "ثبت ارزش‌گذاری پروژه",
    submitLabel: "ثبت ارزش‌گذاری",
    initial: {
      valuedOn: new Date().toISOString().slice(0, 10),
      currency: currentProject()?.currency || "IRR",
      sourceType: "manual",
    },
    fields: [
      { name: "amount", label: "ارزش برآوردی پروژه", type: "number", min: 0, step: 1, required: true },
      { name: "valuedOn", label: "تاریخ ارزش‌گذاری", type: "date", required: true, max: new Date().toISOString().slice(0, 10) },
      { name: "currency", label: "واحد پول", dir: "ltr", disabled: true },
      { name: "description", label: "شرح و دامنه ارزش‌گذاری", type: "textarea", rows: 3, maxLength: 4000 },
      { name: "methodology", label: "روش‌شناسی", type: "textarea", rows: 3, maxLength: 8000 },
      { name: "sourceType", label: "منبع", type: "select", options: [{ value: "manual", label: "ارزش‌گذاری دستی مستند" }] },
    ],
    note: "این مقدار یک برآورد مدیریتی است و به‌عنوان قیمت قطعی یا تأییدشدهٔ provider معرفی نمی‌شود.",
    onSubmit: async (values) => {
      await api(projectPath("valuations"), {
        method: "POST",
        body: { ...values, currency: values.currency || currentProject()?.currency },
        idempotent: true,
      });
      toast("ارزش‌گذاری ثبت و در محاسبه بازده لحاظ شد.");
      await navigate("finance", { replace: true });
    },
  });
}

async function renderFinance(sequence) {
  const [
    accountResult,
    periodResult,
    journalResult,
    invoiceResult,
    paymentResult,
    distributionResult,
    budgetResult,
    pnl,
    balance,
    valuationResult,
    returns,
  ] = await Promise.all([
    api(projectPath("accounts")),
    api(projectPath("fiscal-periods")),
    api(projectPath("journal-entries")),
    api(projectPath("invoices")),
    api(projectPath("payment-intents")),
    api(projectPath("distributions")),
    api(projectPath("budgets")),
    api(projectPath("reports/profit-loss")),
    api(projectPath("reports/balance-sheet")),
    api(projectPath("valuations")),
    api(projectPath("reports/returns")),
  ]);
  if (!ensureSequence(sequence)) return;
  const accounts = accountResult.accounts || [];
  const periods = periodResult.fiscalPeriods || [];
  const journals = journalResult.journalEntries || [];
  const invoices = invoiceResult.invoices || [];
  const payments = paymentResult.paymentIntents || [];
  const distributions = distributionResult.distributions || [];
  const budgets = budgetResult.budgets || [];
  const valuations = valuationResult.valuations || [];
  const manageable = hasPermission("finance.manage");
  setPageActions([
    manageable ? button("حساب جدید", { onClick: () => openAccountDialog() }) : null,
    manageable ? button("دوره مالی", { onClick: () => openFiscalPeriodDialog() }) : null,
    manageable ? button("سند جدید", { onClick: () => openJournalDialog(accounts, periods) }) : null,
    manageable ? button("صورتحساب", { variant: "primary", onClick: () => openInvoiceDialog(accounts) }) : null,
  ]);
  const metrics = node("div", { className: "ws-metric-grid" }, [
    metricCard("درآمد", faMoney(pnl.revenue, pnl.currency), "بر پایه اسناد قطعی", "↗"),
    metricCard("هزینه", faMoney(pnl.expense, pnl.currency), "بر پایه اسناد قطعی", "↘"),
    metricCard("سود / زیان خالص", faMoney(pnl.netIncome, pnl.currency), Number(pnl.netIncome) >= 0 ? "عملکرد سودآور" : "عملکرد زیان‌ده", "∿"),
    metricCard("ترازنامه", balance.balanced ? "متوازن" : "نامتوازن", `${faMoney(balance.totalAssets, balance.currency)} دارایی`, balance.balanced ? "✓" : "!"),
  ]);
  const returnMetric = (metric) => metric?.available && metric.value !== null
    ? faPercent(metric.value)
    : "داده کافی نیست";
  const returnPanel = panel(
    "ارزش‌گذاری و بازده",
    `مبنای محاسبه تا ${faDate(returns.asOf)} · مقادیر بازده برآوردی هستند`,
    node("div", { className: "ws-metric-grid" }, [
      metricCard(
        "آخرین ارزش پروژه",
        returns.latestValuation
          ? faMoney(returns.latestValuation.amount, returns.currency)
          : "داده کافی نیست",
        returns.latestValuation
          ? `ارزش‌گذاری ${faDate(returns.latestValuation.valuedOn)}`
          : "یک ارزش‌گذاری مستند ثبت کنید",
        "◇",
      ),
      metricCard(
        "سرمایه مستند",
        returns.investedCapitalAvailability?.available
          ? faMoney(returns.investedCapital, returns.currency)
          : "داده کافی نیست",
        "از حساب سرمایه در اسناد قطعی",
        "▦",
      ),
      metricCard(
        "توزیع سود",
        faMoney(returns.distributions?.total || 0, returns.currency),
        `${faMoney(returns.distributions?.paid || 0, returns.currency)} پرداخت‌شده`,
        "↗",
      ),
      metricCard(
        "ROI کل",
        returnMetric(returns.totalReturnRoi),
        returns.totalReturnRoi?.available ? "ارزش جاری + توزیع − سرمایه" : "ارزش‌گذاری و سرمایه مستند لازم است",
        "∿",
      ),
      metricCard(
        "بازده سالانه",
        returnMetric(returns.annualizedReturn),
        returns.annualizedReturn?.available ? "برآورد XIRR جریان‌های نقدی" : "دوره و جریان نقدی کافی نیست",
        "◷",
      ),
    ]),
    manageable
      ? button("ثبت ارزش‌گذاری", { variant: "ghost", onClick: () => openValuationDialog() })
      : null,
  );

  const host = node("div");
  const tabContainer = node("div", { className: "ws-tabs", attributes: { role: "tablist" } });
  const tabItems = [
    { value: "journals", label: `اسناد (${faNumber(journals.length)})` },
    { value: "invoices", label: `صورتحساب (${faNumber(invoices.length)})` },
    { value: "payments", label: `پرداخت (${faNumber(payments.length)})` },
    { value: "budgets", label: `بودجه (${faNumber(budgets.length)})` },
    { value: "distributions", label: `توزیع سود (${faNumber(distributions.length)})` },
    { value: "accounts", label: `حساب‌ها (${faNumber(accounts.length)})` },
    { value: "periods", label: `دوره‌ها (${faNumber(periods.length)})` },
    { value: "valuations", label: `ارزش‌گذاری (${faNumber(valuations.length)})` },
  ];
  let selected = "journals";
  const renderSelected = () => {
    if (selected === "journals") {
      host.replaceChildren(dataTable([
        { label: "سند", title: true, render: (item) => titleCell(`سند ${faNumber(item.entryNo)}`, item.description) },
        { label: "تاریخ", render: (item) => faDate(item.occurredOn) },
        { label: "بدهکار", render: (item) => faMoney((item.lines || []).reduce((sum, line) => sum + Number(line.debit || 0), 0), item.currency) },
        { label: "بستانکار", render: (item) => faMoney((item.lines || []).reduce((sum, line) => sum + Number(line.credit || 0), 0), item.currency) },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
        {
          label: "عملیات",
          render: (item) => manageable && item.status === "draft"
            ? button("ثبت قطعی", {
                variant: "primary",
                onClick: async () => {
                  if (!confirm("سند قطعی و تغییرناپذیر شود؟")) return;
                  try {
                    await api(projectPath(`journal-entries/${encodeURIComponent(item.id)}/post`), { method: "POST", body: {} });
                    toast("سند قطعی شد.");
                    navigate("finance", { replace: true });
                  } catch (error) {
                    toast(errorMessage(error), "error");
                  }
                },
              })
            : "—",
        },
      ], journals, {
        emptyAction: manageable ? button("سند جدید", { variant: "primary", onClick: () => openJournalDialog(accounts, periods) }) : null,
      }));
    } else if (selected === "invoices") {
      host.replaceChildren(dataTable([
        { label: "صورتحساب", title: true, render: (item) => titleCell(item.invoiceNo, item.counterpartyName) },
        { label: "نوع", render: (item) => item.kind === "receivable" ? "دریافتنی" : "پرداختنی" },
        { label: "مبلغ", render: (item) => faMoney(item.totalAmount, item.currency) },
        { label: "پرداخت‌شده", render: (item) => faMoney(item.paidAmount, item.currency) },
        { label: "سررسید", render: (item) => faDate(item.dueOn) },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
      ], invoices, {
        emptyAction: manageable ? button("صدور صورتحساب", { variant: "primary", onClick: () => openInvoiceDialog(accounts) }) : null,
      }));
    } else if (selected === "payments") {
      host.replaceChildren(dataTable([
        { label: "پرداخت", title: true, render: (item) => titleCell(faMoney(item.amount, item.currency), item.direction === "incoming" ? "دریافت" : "پرداخت") },
        { label: "روش", render: (item) => item.provider === "manual" ? "دستی" : item.provider || "سرویس بانکی" },
        { label: "مرجع", render: (item) => item.providerReference || "—" },
        { label: "وضعیت", render: (item) => statusChip(item.status === "succeeded" ? "paid" : item.status) },
        { label: "زمان", render: (item) => faDate(item.createdAt, true) },
        {
          label: "عملیات",
          render: (item) => manageable && ["pending", "requires_action", "processing"].includes(item.status)
            ? button("تأیید", { variant: "primary", onClick: () => openPaymentConfirmDialog(item, accounts) })
            : "—",
        },
      ], payments, {
        emptyAction: manageable ? button("درخواست پرداخت", { variant: "primary", onClick: () => openPaymentDialog(invoices) }) : null,
      }));
    } else if (selected === "budgets") {
      host.replaceChildren(dataTable([
        { label: "نسخه بودجه", title: true, render: (item) => titleCell(item.name, `نسخه ${faNumber(item.versionNo)}`) },
        { label: "برنامه", render: (item) => faMoney(item.plannedAmount, item.currency) },
        { label: "واقعی", render: (item) => faMoney(item.actualAmount, item.currency) },
        { label: "انحراف", render: (item) => faMoney(item.varianceAmount, item.currency) },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
      ], budgets, {
        emptyAction: manageable ? button("بودجه جدید", { variant: "primary", onClick: () => openBudgetDialog() }) : null,
      }));
    } else if (selected === "distributions") {
      host.replaceChildren(dataTable([
        { label: "توزیع", title: true, render: (item) => titleCell(item.title, `${faNumber(item.allocations?.length || 0)} ذی‌نفع`) },
        { label: "تاریخ مبنا", render: (item) => faDate(item.recordDate) },
        { label: "مبلغ", render: (item) => faMoney(item.totalAmount, item.currency) },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
        {
          label: "عملیات",
          render: (item) => {
            if (!manageable) return "فقط مشاهده";
            if (item.status === "draft") {
              return button("تصویب", {
                variant: "primary",
                onClick: () => openDistributionApprovalDialog(item, accounts),
              });
            }
            if (["approved", "processing"].includes(item.status)) {
              return button("ثبت پرداخت", {
                variant: "primary",
                onClick: () => openDistributionPaymentDialog(item, accounts, periods),
              });
            }
            return "—";
          },
        },
      ], distributions, {
        emptyAction: manageable ? button("محاسبه توزیع", { variant: "primary", onClick: () => openDistributionDialog() }) : null,
      }));
    } else if (selected === "accounts") {
      host.replaceChildren(dataTable([
        { label: "حساب", title: true, render: (item) => titleCell(item.name, item.code) },
        { label: "نوع", render: (item) => ({ asset: "دارایی", liability: "بدهی", equity: "حقوق مالکانه", revenue: "درآمد", expense: "هزینه" }[item.accountType] || item.accountType) },
        { label: "ارز", render: (item) => item.currency },
        { label: "وضعیت", render: (item) => statusChip(item.active ? "active" : "inactive") },
        { label: "عملیات", render: (item) => manageable ? button("ویرایش", { variant: "ghost", onClick: () => openAccountDialog(item) }) : "فقط مشاهده" },
      ], accounts, {
        emptyAction: manageable ? button("حساب جدید", { variant: "primary", onClick: () => openAccountDialog() }) : null,
      }));
    } else if (selected === "periods") {
      host.replaceChildren(dataTable([
        { label: "دوره", title: true, render: (item) => titleCell(item.name, `${faDate(item.startsOn)} تا ${faDate(item.endsOn)}`) },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
        { label: "آخرین تغییر", render: (item) => faDate(item.updatedAt, true) },
        {
          label: "عملیات",
          render: (item) => manageable && item.status !== "closed"
            ? button("بستن دوره", {
                variant: "danger",
                onClick: async () => {
                  if (!confirm("دوره مالی بسته شود؟ همه اسناد پیش‌نویس باید تعیین تکلیف شده باشند.")) return;
                  try {
                    await api(projectPath(`fiscal-periods/${encodeURIComponent(item.id)}/close`), { method: "POST", body: {} });
                    toast("دوره مالی بسته شد.");
                    navigate("finance", { replace: true });
                  } catch (error) {
                    toast(errorMessage(error), "error");
                  }
                },
              })
            : "—",
        },
      ], periods, {
        emptyAction: manageable ? button("دوره جدید", { variant: "primary", onClick: () => openFiscalPeriodDialog() }) : null,
      }));
    } else {
      host.replaceChildren(dataTable([
        { label: "ارزش", title: true, render: (item) => titleCell(faMoney(item.amount, item.currency), item.description || "ارزش‌گذاری دستی") },
        { label: "تاریخ مبنا", render: (item) => faDate(item.valuedOn) },
        { label: "روش", render: (item) => item.methodology || "ثبت نشده" },
        { label: "منبع", render: (item) => item.sourceType === "manual" ? "دستی مستند" : item.sourceType },
        { label: "زمان ثبت", render: (item) => faDate(item.createdAt, true) },
      ], valuations, {
        emptyTitle: "ارزش‌گذاری ثبت نشده است",
        emptyDescription: "برای محاسبه ROI کل و بازده سالانه، آخرین ارزش مستند پروژه را ثبت کنید.",
        emptyAction: manageable ? button("ثبت ارزش‌گذاری", { variant: "primary", onClick: () => openValuationDialog() }) : null,
      }));
    }
  };
  for (const item of tabItems) {
    const control = node("button", {
      type: "button",
      text: item.label,
      className: item.value === selected ? "is-active" : "",
      attributes: { role: "tab", "aria-selected": item.value === selected ? "true" : "false" },
      onclick: () => {
        selected = item.value;
        for (const candidate of $$("button", tabContainer)) {
          const chosen = candidate === control;
          candidate.classList.toggle("is-active", chosen);
          candidate.setAttribute("aria-selected", chosen ? "true" : "false");
        }
        renderSelected();
      },
    });
    tabContainer.append(control);
  }
  renderSelected();
  dom.pageBody.replaceChildren(metrics, returnPanel, node("br", { attributes: { "aria-hidden": "true" } }), tabContainer, host);
}

const operationScopeFields = [
  "operationType",
  "actionType",
  "projectId",
  "shareClassId",
  "fromStakeholderId",
  "toStakeholderId",
  "stakeholderId",
  "destinationShareClassId",
  "units",
  "amount",
  "currency",
  "ratioNumerator",
  "ratioDenominator",
  "recordDate",
  "effectiveDate",
];

const operationScopeNumberFields = new Set([
  "units",
  "amount",
  "ratioNumerator",
  "ratioDenominator",
]);

function canonicalUiOperationScope(input) {
  return Object.fromEntries(operationScopeFields.map((field) => {
    const value = input?.[field];
    if (operationScopeNumberFields.has(field)) {
      return [field, value === null || value === undefined || value === ""
        ? null
        : Number(value)];
    }
    return [field, value === null || value === undefined || value === ""
      ? null
      : String(value)];
  }));
}

function operationScopesMatch(left, right) {
  if (!left || !right) return false;
  const first = canonicalUiOperationScope(left);
  const second = canonicalUiOperationScope(right);
  return operationScopeFields.every((field) => first[field] === second[field]);
}

function transferOperationScope(transfer) {
  return canonicalUiOperationScope({
    operationType: "share_transfer",
    actionType: "share_transfer",
    projectId: currentProject()?.id,
    shareClassId: transfer.shareClassId,
    fromStakeholderId: transfer.fromStakeholderId,
    toStakeholderId: transfer.toStakeholderId,
    stakeholderId: null,
    destinationShareClassId: null,
    units: transfer.units,
    amount: transfer.priceAmount,
    currency: currentProject()?.currency,
    ratioNumerator: null,
    ratioDenominator: null,
    recordDate: null,
    effectiveDate: null,
  });
}

function corporateOperationScope(values) {
  const unitsRequired = ["issuance", "capital_increase", "rights_issue"]
    .includes(values.actionType);
  const ratioRequired = ["split", "reverse_split"].includes(values.actionType);
  return canonicalUiOperationScope({
    operationType: "corporate_action",
    actionType: values.actionType,
    projectId: currentProject()?.id,
    shareClassId: values.shareClassId,
    fromStakeholderId: null,
    toStakeholderId: null,
    stakeholderId: values.actionType === "issuance"
      ? values.stakeholderId
      : null,
    destinationShareClassId: values.destinationShareClassId || null,
    units: unitsRequired ? values.units : null,
    amount: values.unitPrice,
    currency: currentProject()?.currency,
    ratioNumerator: ratioRequired ? values.ratioNumerator : null,
    ratioDenominator: ratioRequired ? values.ratioDenominator : null,
    recordDate: values.recordDate || null,
    effectiveDate: values.effectiveDate || null,
  });
}

function resolutionIsApproved(resolution) {
  const quorumMet = resolution?.result?.quorumMet === true
    || resolution?.result?.quorum?.quorumMet === true;
  return resolution?.meeting?.status === "held"
    && resolution.status === "closed"
    && resolution.result?.outcome === "approved"
    && quorumMet;
}

function corporateActionLabel(value) {
  return {
    capital_increase: "افزایش سرمایه",
    issuance: "صدور مستقیم",
    rights_issue: "حق‌تقدم",
    split: "تجزیه سهام",
    reverse_split: "تجمیع سهام",
  }[value] || value || "اقدام سرمایه";
}

function describeOperationScope(scope, stakeholders = [], classes = []) {
  if (!scope) return "مصوبه عمومی؛ بدون اتصال به عملیات سرمایه";
  const stakeholderName = (id) =>
    stakeholders.find((item) => item.id === id)?.name || id || "نامشخص";
  const shareClass = classes.find((item) => item.id === scope.shareClassId);
  const className = shareClass
    ? `${shareClass.name}${shareClass.symbol ? ` (${shareClass.symbol})` : ""}`
    : scope.shareClassId || "رده نامشخص";
  if (scope.operationType === "share_transfer") {
    const amount = scope.amount === null || scope.amount === undefined
      ? "بدون مبلغ"
      : faMoney(scope.amount, scope.currency);
    return `انتقال ${faNumber(scope.units)} واحد ${className} از ${stakeholderName(scope.fromStakeholderId)} به ${stakeholderName(scope.toStakeholderId)} · ${amount}`;
  }
  const parts = [
    corporateActionLabel(scope.actionType),
    className,
    scope.units == null ? null : `${faNumber(scope.units)} واحد`,
    scope.ratioNumerator && scope.ratioDenominator
      ? `نسبت ${faNumber(scope.ratioNumerator)}:${faNumber(scope.ratioDenominator)}`
      : null,
    scope.stakeholderId ? `برای ${stakeholderName(scope.stakeholderId)}` : null,
    scope.amount == null ? null : `مبلغ واحد ${faMoney(scope.amount, scope.currency)}`,
    scope.recordDate ? `مبنای ${faDate(scope.recordDate)}` : null,
    scope.effectiveDate ? `اجرای ${faDate(scope.effectiveDate)}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function activeMemberUsers(members = []) {
  const users = members
    .filter((member) => !member.status || member.status === "active")
    .map((member) => member.user || member)
    .filter((user) => user?.id);
  if (state.user?.id && !users.some((user) => user.id === state.user.id)) {
    users.unshift(state.user);
  }
  return users;
}

function openStakeholderDialog(stakeholder = null, members = []) {
  const memberUsers = activeMemberUsers(members);
  openEntityDialog({
    kicker: "ذی‌نفع پروژه",
    title: stakeholder ? stakeholder.name : "عضو یا سرمایه‌گذار جدید",
    submitLabel: stakeholder ? "ذخیره عضو" : "افزودن عضو",
    initial: stakeholder || { kind: "person", role: "investor" },
    fields: [
      { name: "name", label: "نام فرد یا مجموعه", required: true, maxLength: 200 },
      {
        name: "kind",
        label: "نوع",
        type: "select",
        options: [
          { value: "person", label: "شخص حقیقی" },
          { value: "organization", label: "شخص حقوقی" },
        ],
      },
      {
        name: "role",
        label: "نقش",
        type: "select",
        options: [
          ["owner", "مالک"],
          ["board", "عضو هیئت‌مدیره"],
          ["manager", "مدیر"],
          ["investor", "سرمایه‌گذار"],
          ["partner", "شریک"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "mobile", label: "موبایل", type: "tel", dir: "ltr" },
      { name: "email", label: "ایمیل", type: "email", dir: "ltr" },
      {
        name: "userId",
        label: "حساب کاربری متصل (اختیاری)",
        type: "select",
        options: [
          { value: "", label: "بدون حساب متصل" },
          ...memberUsers.map((user) => ({
            value: user.id,
            label: user.fullName
              ? `${user.fullName} — ${user.email || user.id}`
              : user.email || user.id,
          })),
        ],
        help: "اتصال حساب فقط برای شخص حقیقی فعال است و هویت رأی‌دهنده را تعیین می‌کند.",
      },
    ],
    note: "برای رأی مستقیم، حساب یکی از اعضای فعال سازمان را به شخص حقیقی متصل کنید. اشخاص حقوقی از مسیر نماینده و وکالت رأی می‌دهند.",
    onSubmit: async (values) => {
      values.userId = values.kind === "person"
        ? values.userId || null
        : null;
      await api(projectPath(`stakeholders${stakeholder ? `/${encodeURIComponent(stakeholder.id)}` : ""}`), {
        method: stakeholder ? "PATCH" : "POST",
        body: values,
      });
      toast(stakeholder ? "ذی‌نفع به‌روزرسانی شد." : "ذی‌نفع اضافه شد.");
      await navigate("capital", { replace: true });
    },
  });
  const kindControl = $('[name="kind"]', dom.dialogFields);
  const userControl = $('[name="userId"]', dom.dialogFields);
  const syncUserControl = () => {
    const person = kindControl?.value === "person";
    if (userControl) {
      userControl.disabled = !person;
      if (!person) userControl.value = "";
    }
  };
  kindControl?.addEventListener("change", syncUserControl);
  syncUserControl();
}

function openShareClassDialog(shareClass = null) {
  openEntityDialog({
    kicker: "ساختار سرمایه",
    title: shareClass ? shareClass.name : "رده سهام جدید",
    submitLabel: shareClass ? "ذخیره رده" : "ساخت رده",
    initial: shareClass || { votingWeight: 1 },
    fields: [
      { name: "name", label: "نام رده", required: true, maxLength: 120 },
      { name: "symbol", label: "نماد", required: true, dir: "ltr", maxLength: 20 },
      { name: "authorizedUnits", label: "سقف واحد مجاز", type: "number", min: 1, step: 1, required: true },
      { name: "votingWeight", label: "وزن رأی هر واحد", type: "number", min: 0, step: 0.01 },
    ],
    onSubmit: async (values) => {
      await api(projectPath(`share-classes${shareClass ? `/${encodeURIComponent(shareClass.id)}` : ""}`), {
        method: shareClass ? "PATCH" : "POST",
        body: values,
      });
      toast(shareClass ? "رده سهام به‌روزرسانی شد." : "رده سهام ساخته شد.");
      await navigate("capital", { replace: true });
    },
  });
}

function openTransferDialog(classes, stakeholders, offers = []) {
  const stakeholderOptions = [{ value: "", label: "انتخاب ذی‌نفع" }, ...stakeholders.filter((item) => !item.archivedAt).map((item) => ({ value: item.id, label: item.name }))];
  openEntityDialog({
    kicker: "انتقال مالکیت",
    title: "پیش‌نویس انتقال سهام",
    submitLabel: "ذخیره پیش‌نویس",
    initial: {},
    fields: [
      {
        name: "shareClassId",
        label: "رده سهام",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب رده" }, ...classes.map((item) => ({ value: item.id, label: `${item.name} (${item.symbol})` }))],
      },
      {
        name: "offerId",
        label: "عرضه مرتبط (اختیاری)",
        type: "select",
        options: [{ value: "", label: "بدون عرضه" }, ...offers.filter((item) =>
          ["open", "partially_filled"].includes(item.status) && !item.expired).map((item) => ({
          value: item.id,
          label: `${item.side === "sell" ? "فروش" : "خرید"} ${faNumber(item.remainingUnits)} واحد × ${faMoney(item.unitPrice, currentProject()?.currency)}`,
        }))],
      },
      { name: "fromStakeholderId", label: "انتقال‌دهنده", type: "select", required: true, options: stakeholderOptions },
      { name: "toStakeholderId", label: "انتقال‌گیرنده", type: "select", required: true, options: stakeholderOptions },
      { name: "units", label: "تعداد واحد", type: "number", min: 1, step: 1, required: true },
      { name: "priceAmount", label: "مبلغ کل معامله", type: "number", min: 0, step: 1 },
      { name: "note", label: "توضیحات", type: "textarea", rows: 2 },
    ],
    note: "ابتدا فقط مشخصات اقتصادی انتقال ذخیره می‌شود. مصوبه دامنه‌دار، قرارداد و پرداخت اختصاصی در مرحله بعد تکمیل و سپس درخواست برای بررسی ارسال خواهد شد.",
    onSubmit: async (values) => {
      if (values.fromStakeholderId === values.toStakeholderId) {
        throw new ApiError(400, { error: { message: "انتقال‌دهنده و انتقال‌گیرنده باید متفاوت باشند." } });
      }
      await api(projectPath("share-transfers"), {
        method: "POST",
        body: {
          shareClassId: values.shareClassId,
          offerId: values.offerId || null,
          fromStakeholderId: values.fromStakeholderId,
          toStakeholderId: values.toStakeholderId,
          units: values.units,
          priceAmount: values.priceAmount,
          note: values.note,
          status: "draft",
        },
        idempotent: true,
      });
      toast("پیش‌نویس انتقال ثبت شد؛ اکنون شواهد آن را تکمیل کنید.");
      await navigate("capital", { replace: true });
    },
  });
}

function matchingTransferResolution(transfer, resolution) {
  return resolutionIsApproved(resolution)
    && resolution.operationType === "share_transfer"
    && operationScopesMatch(resolution.operationScope, transferOperationScope(transfer));
}

function matchingTransferContract(transfer, contract) {
  const today = new Date().toISOString().slice(0, 10);
  const partyIds = new Set((contract?.parties || [])
    .filter((party) => party.partyType === "stakeholder")
    .map((party) => party.partyId));
  const price = Number(transfer.priceAmount || 0);
  return contract?.status === "active"
    && (!contract.effectiveOn || contract.effectiveOn <= today)
    && (!contract.expiresOn || contract.expiresOn >= today)
    && partyIds.has(transfer.fromStakeholderId)
    && partyIds.has(transfer.toStakeholderId)
    && (
      price <= 0
      || (
        contract.currency === currentProject()?.currency
        && contract.valueAmount != null
        && Number(contract.valueAmount) >= price
      )
    );
}

function transferPaymentMatches(transfer, payment, { succeeded = true } = {}) {
  const price = Number(transfer.priceAmount || 0);
  return price > 0
    && (!succeeded || payment?.status === "succeeded")
    && payment?.direction === "incoming"
    && !payment.invoiceId
    && payment.purposeType === "share_transfer"
    && payment.purposeId === transfer.id
    && Number(payment.amount) === price
    && payment.currency === currentProject()?.currency;
}

function openTransferResolutionDialog(transfer, meetings, stakeholders, classes) {
  const availableMeetings = meetings.filter((meeting) =>
    meeting.status !== "cancelled");
  const fromName = stakeholders.find((item) =>
    item.id === transfer.fromStakeholderId)?.name || "انتقال‌دهنده";
  const toName = stakeholders.find((item) =>
    item.id === transfer.toStakeholderId)?.name || "انتقال‌گیرنده";
  openEntityDialog({
    kicker: "مصوبه دامنه‌دار انتقال",
    title: `${faNumber(transfer.units)} واحد از ${fromName} به ${toName}`,
    submitLabel: "ساخت پیش‌نویس مصوبه",
    initial: {
      title: `تصویب انتقال ${faNumber(transfer.units)} واحد سهام`,
      publicVisible: false,
    },
    fields: [
      {
        name: "meetingId",
        label: "جلسه مرجع",
        type: "select",
        required: true,
        options: [
          { value: "", label: "انتخاب جلسه" },
          ...availableMeetings.map((meeting) => ({
            value: meeting.id,
            label: `${meeting.title} — ${translatedStatus(meeting.status)}`,
          })),
        ],
      },
      { name: "title", label: "عنوان مصوبه", required: true, maxLength: 300 },
      {
        name: "description",
        label: "شرح و ملاحظات رأی",
        type: "textarea",
        rows: 3,
        maxLength: 5000,
        value: describeOperationScope(
          transferOperationScope(transfer),
          stakeholders,
          classes,
        ),
      },
      { name: "publicVisible", label: "نتیجه برای عموم قابل مشاهده باشد", type: "checkbox" },
    ],
    note: "دامنه طرفین، رده سهام، تعداد، مبلغ و ارز به‌صورت ساختاری در مصوبه قفل می‌شود و این مصوبه فقط برای همین انتقال قابل استفاده است.",
    onSubmit: async (values) => {
      await api(projectPath(
        `meetings/${encodeURIComponent(values.meetingId)}/resolutions`,
      ), {
        method: "POST",
        body: {
          title: values.title,
          description: values.description,
          status: "draft",
          publicVisible: values.publicVisible,
          operationScope: transferOperationScope(transfer),
        },
      });
      toast("مصوبه دامنه‌دار ساخته شد؛ آن را در حاکمیت به رأی بگذارید.");
      await navigate("governance", { replace: true });
    },
  });
}

function openTransferEvidenceDialog(
  transfer,
  resolutions,
  contracts,
  payments,
  transfers,
) {
  const usedResolutionIds = new Set(transfers
    .filter((item) => item.id !== transfer.id && item.resolutionId)
    .map((item) => item.resolutionId));
  const validResolutions = resolutions.filter((resolution) =>
    matchingTransferResolution(transfer, resolution)
    && !usedResolutionIds.has(resolution.id));
  const validContracts = contracts.filter((contract) =>
    matchingTransferContract(transfer, contract));
  const validPayments = payments.filter((payment) =>
    transferPaymentMatches(transfer, payment));
  const paymentRequired = Number(transfer.priceAmount || 0) > 0;
  openEntityDialog({
    kicker: "تکمیل شواهد انتقال",
    title: `ارسال انتقال ${faNumber(transfer.units)} واحد برای بررسی`,
    submitLabel: "اتصال شواهد و ارسال",
    fields: [
      {
        name: "resolutionId",
        label: "مصوبه تصویب‌شده و منطبق",
        type: "select",
        required: true,
        options: [
          {
            value: "",
            label: validResolutions.length
              ? "انتخاب مصوبه اختصاصی"
              : "مصوبه تصویب‌شده منطبق موجود نیست",
          },
          ...validResolutions.map((item) => ({
            value: item.id,
            label: `${item.meeting.title} — ${item.title}`,
          })),
        ],
      },
      {
        name: "contractId",
        label: "قرارداد فعال و پوشش‌دهنده طرفین",
        type: "select",
        required: true,
        options: [
          {
            value: "",
            label: validContracts.length
              ? "انتخاب قرارداد منطبق"
              : "قرارداد فعال منطبق موجود نیست",
          },
          ...validContracts.map((item) => ({
            value: item.id,
            label: `${item.title} — ${item.valueAmount == null
              ? "بدون مبلغ"
              : faMoney(item.valueAmount, item.currency)}`,
          })),
        ],
      },
      ...(paymentRequired ? [{
        name: "paymentIntentId",
        label: "پرداخت موفق و اختصاصی همین انتقال",
        type: "select",
        required: true,
        options: [
          {
            value: "",
            label: validPayments.length
              ? "انتخاب پرداخت اختصاصی"
              : "پرداخت موفق منطبق موجود نیست",
          },
          ...validPayments.map((item) => ({
            value: item.id,
            label: `${faMoney(item.amount, item.currency)} — ${item.providerReference || item.id.slice(0, 8)}`,
          })),
        ],
      }] : []),
      {
        name: "decisionNote",
        label: "یادداشت ارسال",
        type: "textarea",
        rows: 2,
        maxLength: 2000,
      },
    ],
    note: "فقط مصوبه با دامنه دقیق همین انتقال، قرارداد فعال شامل هر دو طرف و پرداخت موفقِ purpose-bound با مبلغ و ارز دقیق نمایش داده می‌شود. KYC معتبر دو طرف نیز هنگام ارسال در سرور کنترل خواهد شد.",
    onSubmit: async (values) => {
      await api(projectPath(`share-transfers/${encodeURIComponent(transfer.id)}`), {
        method: "PATCH",
        body: {
          resolutionId: values.resolutionId,
          contractId: values.contractId,
          paymentIntentId: paymentRequired ? values.paymentIntentId : null,
          decisionNote: values.decisionNote,
          status: "pending",
        },
      });
      toast("شواهد متصل و انتقال برای بررسی ارسال شد.");
      await navigate("capital", { replace: true });
    },
  });
}

async function createTransferPaymentIntent(transfer, accounts) {
  if (!accounts.some((account) => account.active)) {
    toast("برای تأیید پرداخت ابتدا حساب بانک و حساب مقابل فعال بسازید.", "error");
    return;
  }
  try {
    const result = await api(projectPath("payment-intents"), {
      method: "POST",
      idempotent: true,
      body: {
        direction: "incoming",
        provider: "manual",
        amount: Number(transfer.priceAmount),
        currency: currentProject()?.currency,
        purposeType: "share_transfer",
        purposeId: transfer.id,
      },
    });
    toast("درخواست پرداخت اختصاصی ساخته شد؛ اکنون آن را تأیید کنید.");
    openPaymentConfirmDialog(result.paymentIntent, accounts, "capital");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function openShareOfferDialog(classes, stakeholders) {
  const stakeholderOptions = [{ value: "", label: "انتخاب ذی‌نفع" }, ...stakeholders.filter((item) =>
    !item.archivedAt).map((item) => ({ value: item.id, label: item.name }))];
  openEntityDialog({
    kicker: "بازار داخلی سهام",
    title: "عرضه یا تقاضای سهام",
    submitLabel: "انتشار پیشنهاد",
    initial: { side: "sell" },
    fields: [
      {
        name: "side",
        label: "نوع پیشنهاد",
        type: "select",
        options: [
          { value: "sell", label: "فروش" },
          { value: "buy", label: "خرید" },
        ],
      },
      {
        name: "shareClassId",
        label: "رده سهام",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب رده" }, ...classes.map((item) => ({
          value: item.id,
          label: `${item.name} (${item.symbol})`,
        }))],
      },
      { name: "sellerStakeholderId", label: "فروشنده (برای پیشنهاد فروش)", type: "select", options: stakeholderOptions },
      { name: "buyerStakeholderId", label: "خریدار (برای پیشنهاد خرید)", type: "select", options: stakeholderOptions },
      { name: "units", label: "تعداد واحد", type: "number", min: 1, step: 1, required: true },
      { name: "unitPrice", label: "قیمت هر واحد", type: "number", min: 0, step: 1, required: true },
      { name: "availableUntil", label: "مهلت پیشنهاد", type: "date" },
      { name: "note", label: "شرایط و توضیحات", type: "textarea", rows: 2, maxLength: 2000 },
    ],
    note: "نهایی‌شدن معامله فقط از مسیر انتقال سهام و پس از تأیید مدیر انجام می‌شود.",
    onSubmit: async (values) => {
      if (values.side === "sell" && !values.sellerStakeholderId) {
        throw new ApiError(400, { error: { message: "برای پیشنهاد فروش، فروشنده را انتخاب کنید." } });
      }
      if (values.side === "buy" && !values.buyerStakeholderId) {
        throw new ApiError(400, { error: { message: "برای پیشنهاد خرید، خریدار را انتخاب کنید." } });
      }
      await api(projectPath("share-offers"), {
        method: "POST",
        body: values,
        idempotent: true,
      });
      toast("پیشنهاد سهام منتشر شد.");
      await navigate("capital", { replace: true });
    },
  });
}

function openTransferDecisionDialog(transfer, status) {
  const title = {
    pending: "ارسال برای بررسی",
    approved: "تأیید انتقال",
    rejected: "رد انتقال",
    cancelled: "لغو انتقال",
  }[status] || "تغییر وضعیت انتقال";
  openEntityDialog({
    kicker: "تصمیم دفتر مالکیت",
    title,
    submitLabel: title,
    fields: [
      {
        name: "decisionNote",
        label: "یادداشت تصمیم",
        type: "textarea",
        rows: 3,
        required: ["approved", "rejected"].includes(status),
        maxLength: 2000,
      },
    ],
    note: status === "approved"
      ? "تأیید فقط توسط کاربری غیر از سازنده مجاز است. سرور کنترل چهارچشمی، مصوبه تصویب‌شده، KYC هر دو طرف، قرارداد، پرداخت، موجودی و مانده عرضه را اتمیک دوباره بررسی می‌کند."
      : "تاریخچه وضعیت و دلیل تصمیم در ممیزی پروژه باقی می‌ماند.",
    onSubmit: async (values) => {
      await api(projectPath(`share-transfers/${encodeURIComponent(transfer.id)}`), {
        method: "PATCH",
        body: { status, decisionNote: values.decisionNote },
      });
      toast("وضعیت انتقال سهام به‌روزرسانی شد.");
      await navigate("capital", { replace: true });
    },
  });
}

async function cancelShareOffer(offer) {
  if (!confirm("این پیشنهاد سهام بسته شود؟ انتقال‌های موجود مستقل باقی می‌مانند.")) return;
  try {
    await api(projectPath(`share-offers/${encodeURIComponent(offer.id)}`), {
      method: "PATCH",
      body: { status: "cancelled" },
    });
    toast("پیشنهاد سهام بسته شد.");
    await navigate("capital", { replace: true });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function openCorporateResolutionDialog(classes, stakeholders, meetings) {
  openEntityDialog({
    kicker: "درخواست تصمیم سرمایه",
    title: "مصوبه دامنه‌دار اقدام شرکتی",
    submitLabel: "ساخت پیش‌نویس مصوبه",
    initial: {
      actionType: "capital_increase",
      recordDate: new Date().toISOString().slice(0, 10),
      publicVisible: false,
    },
    fields: [
      {
        name: "meetingId",
        label: "جلسه مرجع",
        type: "select",
        required: true,
        options: [
          { value: "", label: "انتخاب جلسه" },
          ...meetings.filter((item) => item.status !== "cancelled").map((item) => ({
            value: item.id,
            label: `${item.title} — ${translatedStatus(item.status)}`,
          })),
        ],
      },
      {
        name: "actionType",
        label: "نوع اقدام",
        type: "select",
        options: [
          ["capital_increase", "افزایش سرمایه"],
          ["issuance", "صدور مستقیم"],
          ["rights_issue", "حق تقدم"],
          ["split", "تجزیه سهام"],
          ["reverse_split", "تجمیع سهام"],
        ].map(([value, label]) => ({ value, label })),
      },
      {
        name: "shareClassId",
        label: "رده سهام",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب رده" }, ...classes.map((item) => ({ value: item.id, label: item.name }))],
      },
      {
        name: "stakeholderId",
        label: "ذی‌نفع صدور مستقیم",
        type: "select",
        options: [{ value: "", label: "فقط برای صدور مستقیم" }, ...stakeholders.map((item) => ({ value: item.id, label: item.name }))],
      },
      { name: "title", label: "عنوان مصوبه و اقدام", required: true, maxLength: 240 },
      { name: "recordDate", label: "تاریخ مبنا", type: "date", required: true },
      { name: "effectiveDate", label: "تاریخ اجرا", type: "date" },
      { name: "units", label: "تعداد واحد", type: "number", min: 1, step: 1 },
      { name: "unitPrice", label: "قیمت واحد", type: "number", min: 0, step: 1 },
      { name: "ratioNumerator", label: "صورت نسبت", type: "number", min: 1, step: 1 },
      { name: "ratioDenominator", label: "مخرج نسبت", type: "number", min: 1, step: 1 },
      { name: "description", label: "مبنای حقوقی / توضیحات رأی", type: "textarea", rows: 3, maxLength: 5000 },
      { name: "publicVisible", label: "نتیجه برای عموم قابل مشاهده باشد", type: "checkbox" },
    ],
    note: "نوع اقدام، رده سهام، ذی‌نفع، تعداد، مبلغ، نسبت و تاریخ‌ها داخل دامنه ساختاری مصوبه ثبت می‌شوند. پس از بازشدن رأی‌گیری این دامنه تغییرپذیر نیست.",
    onSubmit: async (values) => {
      const unitsRequired = ["issuance", "capital_increase", "rights_issue"].includes(values.actionType);
      if (unitsRequired && (!Number.isInteger(values.units) || values.units < 1)) {
        throw new Error("برای این اقدام، تعداد واحد باید یک عدد صحیح بزرگ‌تر از صفر باشد.");
      }
      if (values.actionType === "issuance" && !values.stakeholderId) {
        throw new Error("برای صدور مستقیم، ذی‌نفع را انتخاب کنید.");
      }
      if (["split", "reverse_split"].includes(values.actionType)) {
        if (
          !Number.isInteger(values.ratioNumerator)
          || values.ratioNumerator < 1
          || !Number.isInteger(values.ratioDenominator)
          || values.ratioDenominator < 1
        ) {
          throw new Error("صورت و مخرج نسبت باید عدد صحیح بزرگ‌تر از صفر باشند.");
        }
        if (values.actionType === "split" && values.ratioNumerator <= values.ratioDenominator) {
          throw new Error("در تجزیه سهام، صورت نسبت باید از مخرج بزرگ‌تر باشد.");
        }
        if (values.actionType === "reverse_split" && values.ratioNumerator >= values.ratioDenominator) {
          throw new Error("در تجمیع سهام، صورت نسبت باید از مخرج کوچک‌تر باشد.");
        }
      }
      const operationScope = corporateOperationScope(values);
      await api(projectPath(
        `meetings/${encodeURIComponent(values.meetingId)}/resolutions`,
      ), {
        method: "POST",
        body: {
          title: values.title,
          description: values.description,
          status: "draft",
          publicVisible: values.publicVisible,
          operationScope,
        },
      });
      toast("مصوبه دامنه‌دار اقدام سرمایه ساخته شد؛ آن را در حاکمیت به رأی بگذارید.");
      await navigate("governance", { replace: true });
    },
  });
  const actionTypeControl = $('[name="actionType"]', dom.dialogFields);
  const stakeholderControl = $('[name="stakeholderId"]', dom.dialogFields);
  const unitsControl = $('[name="units"]', dom.dialogFields);
  const unitPriceControl = $('[name="unitPrice"]', dom.dialogFields);
  const numeratorControl = $('[name="ratioNumerator"]', dom.dialogFields);
  const denominatorControl = $('[name="ratioDenominator"]', dom.dialogFields);
  const syncActionFields = () => {
    const actionType = actionTypeControl?.value;
    const issuance = actionType === "issuance";
    const unitsRequired = ["issuance", "capital_increase", "rights_issue"]
      .includes(actionType);
    const ratioRequired = ["split", "reverse_split"].includes(actionType);
    if (stakeholderControl) {
      stakeholderControl.disabled = !issuance;
      stakeholderControl.required = issuance;
      if (!issuance) stakeholderControl.value = "";
    }
    if (unitsControl) {
      unitsControl.disabled = !unitsRequired;
      unitsControl.required = unitsRequired;
      if (!unitsRequired) unitsControl.value = "";
    }
    if (unitPriceControl) {
      unitPriceControl.disabled = ratioRequired;
      if (ratioRequired) unitPriceControl.value = "";
    }
    for (const control of [numeratorControl, denominatorControl]) {
      if (!control) continue;
      control.disabled = !ratioRequired;
      control.required = ratioRequired;
      if (!ratioRequired) control.value = "";
    }
  };
  actionTypeControl?.addEventListener("change", syncActionFields);
  syncActionFields();
}

function openCorporateActionDialog(resolutions, classes, stakeholders) {
  openEntityDialog({
    kicker: "اجرای مصوبه سرمایه",
    title: "ساخت اقدام شرکتی از مصوبه تصویب‌شده",
    submitLabel: "ثبت اقدام متصل",
    fields: [
      {
        name: "resolutionId",
        label: "مصوبه تصویب‌شده، منطبق و استفاده‌نشده",
        type: "select",
        required: true,
        options: [
          {
            value: "",
            label: resolutions.length
              ? "انتخاب مصوبه"
              : "مصوبه قابل استفاده موجود نیست",
          },
          ...resolutions.map((item) => ({
            value: item.id,
            label: `${item.meeting.title} — ${item.title}`,
          })),
        ],
      },
      {
        name: "scopeSummary",
        label: "دامنه عملیاتی قفل‌شده",
        type: "textarea",
        rows: 4,
        disabled: true,
        value: "پس از انتخاب مصوبه، دامنه دقیق عملیات اینجا نمایش داده می‌شود.",
      },
    ],
    note: "تمام مقادیر مؤثر اقدام از دامنه همان مصوبه استخراج می‌شود؛ امکان تغییر رده، ذی‌نفع، تعداد، مبلغ، نسبت یا تاریخ در این مرحله وجود ندارد.",
    onSubmit: async (values) => {
      const resolution = resolutions.find((item) =>
        item.id === values.resolutionId);
      if (!resolution?.operationScope) {
        throw new Error("مصوبه دامنه‌دار معتبر انتخاب کنید.");
      }
      const scope = canonicalUiOperationScope(resolution.operationScope);
      const body = {
        actionType: scope.actionType,
        shareClassId: scope.shareClassId,
        title: resolution.title,
        resolutionId: resolution.id,
        recordDate: scope.recordDate || undefined,
        effectiveDate: scope.effectiveDate || undefined,
        notes: resolution.description || `اجرای مصوبه ${resolution.title}`,
      };
      if (scope.stakeholderId) body.stakeholderId = scope.stakeholderId;
      if (scope.destinationShareClassId) {
        body.destinationShareClassId = scope.destinationShareClassId;
      }
      if (scope.units != null) body.units = scope.units;
      if (scope.amount != null) body.unitPrice = scope.amount;
      if (scope.ratioNumerator != null) {
        body.ratioNumerator = scope.ratioNumerator;
      }
      if (scope.ratioDenominator != null) {
        body.ratioDenominator = scope.ratioDenominator;
      }
      await api(projectPath("corporate-actions"), {
        method: "POST",
        body,
      });
      toast("اقدام شرکتی با دامنه مصوبه متصل و به‌صورت پیش‌نویس ثبت شد.");
      await navigate("capital", { replace: true });
    },
  });
  const resolutionControl = $('[name="resolutionId"]', dom.dialogFields);
  const summaryControl = $('[name="scopeSummary"]', dom.dialogFields);
  const syncSummary = () => {
    const resolution = resolutions.find((item) =>
      item.id === resolutionControl?.value);
    if (summaryControl) {
      summaryControl.value = resolution?.operationScope
        ? describeOperationScope(
            resolution.operationScope,
            stakeholders,
            classes,
          )
        : "یک مصوبه تصویب‌شده را انتخاب کنید.";
    }
  };
  resolutionControl?.addEventListener("change", syncSummary);
  syncSummary();
}

function openCertificateDialog(classes, stakeholders) {
  openEntityDialog({
    kicker: "گواهی مالکیت",
    title: "صدور گواهی سهام",
    submitLabel: "صدور گواهی",
    initial: { issuedOn: new Date().toISOString().slice(0, 10) },
    fields: [
      {
        name: "shareClassId",
        label: "رده سهام",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب رده" }, ...classes.map((item) => ({
          value: item.id,
          label: `${item.name} (${item.symbol})`,
        }))],
      },
      {
        name: "stakeholderId",
        label: "سهام‌دار",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب سهام‌دار" }, ...stakeholders.filter((item) => !item.archivedAt).map((item) => ({
          value: item.id,
          label: item.name,
        }))],
      },
      { name: "units", label: "تعداد واحد تحت پوشش", type: "number", min: 1, step: 1, required: true },
      { name: "certificateNo", label: "شماره گواهی (اختیاری)", dir: "ltr", maxLength: 100 },
      { name: "issuedOn", label: "تاریخ صدور", type: "date", required: true },
    ],
    note: "مجموع واحد گواهی‌های فعال نمی‌تواند از موجودی ثبت‌شده سهام‌دار بیشتر باشد.",
    onSubmit: async (values) => {
      await api(projectPath("share-certificates"), { method: "POST", body: values });
      toast("گواهی سهام صادر شد.");
      await navigate("capital", { replace: true });
    },
  });
}

function openCertificateReplacementDialog(certificate) {
  openEntityDialog({
    kicker: "جایگزینی کنترل‌شده",
    title: `جایگزینی ${certificate.certificateNo}`,
    submitLabel: "صدور جایگزین",
    initial: { issuedOn: new Date().toISOString().slice(0, 10) },
    fields: [
      { name: "certificateNo", label: "شماره گواهی جدید (اختیاری)", dir: "ltr", maxLength: 100 },
      { name: "issuedOn", label: "تاریخ صدور جدید", type: "date", required: true },
    ],
    note: "گواهی فعلی با حفظ تاریخچه «جایگزین‌شده» می‌شود و گواهی تازه فعال خواهد بود.",
    onSubmit: async (values) => {
      await api(projectPath(`share-certificates/${encodeURIComponent(certificate.id)}/replace`), {
        method: "POST",
        body: values,
      });
      toast("گواهی جایگزین صادر شد.");
      await navigate("capital", { replace: true });
    },
  });
}

function openExerciseRightDialog(right, payments) {
  const successfulPayments = payments.filter((item) =>
    item.status === "succeeded" && item.direction === "incoming");
  const paymentField = successfulPayments.length
    ? {
        name: "paymentIntentId",
        label: "پرداخت تسویه‌شده",
        type: "select",
        required: Number(right.unitPrice || 0) > 0,
        options: [
          { value: "", label: Number(right.unitPrice || 0) > 0 ? "انتخاب پرداخت" : "بدون پرداخت" },
          ...successfulPayments.map((item) => ({
            value: item.id,
            label: `${faMoney(item.amount, item.currency)} — ${item.providerReference || item.id.slice(0, 8)}`,
          })),
        ],
      }
    : {
        name: "paymentIntentId",
        label: "شناسه پرداخت تسویه‌شده",
        required: Number(right.unitPrice || 0) > 0,
        dir: "ltr",
        maxLength: 200,
      };
  openEntityDialog({
    kicker: "اعمال حق‌تقدم",
    title: `${faNumber(right.remainingUnits)} واحد باقیمانده`,
    submitLabel: "اعمال حق‌تقدم",
    fields: [
      {
        name: "units",
        label: "تعداد واحد",
        type: "number",
        min: 1,
        max: right.remainingUnits,
        step: 1,
        required: true,
      },
      paymentField,
    ],
    note: Number(right.unitPrice || 0) > 0
      ? `برای هر واحد ${faMoney(right.unitPrice, currentProject()?.currency)}؛ KYC معتبر، قرارداد فعال و پرداخت تسویه‌شده الزامی است.`
      : "KYC معتبر و قرارداد فعال سهام‌دار پیش از اعمال حق‌تقدم الزامی است.",
    onSubmit: async (values) => {
      if (!Number.isInteger(values.units) || values.units < 1 || values.units > Number(right.remainingUnits)) {
        throw new Error("تعداد واحد اعمال حق‌تقدم معتبر نیست.");
      }
      const requiredAmount = Number(right.unitPrice || 0) * values.units;
      if (requiredAmount > 0) {
        const selectedPayment = successfulPayments.find((item) => item.id === values.paymentIntentId);
        if (!selectedPayment || Number(selectedPayment.amount) < requiredAmount) {
          throw new Error(`یک پرداخت ورودی تسویه‌شده با مبلغ حداقل ${faMoney(requiredAmount, selectedPayment?.currency || currentProject()?.currency)} انتخاب کنید.`);
        }
      }
      await api(projectPath(`preemptive-rights/${encodeURIComponent(right.id)}/exercise`), {
        method: "POST",
        body: values,
      });
      toast("حق‌تقدم اعمال و سهام در دفتر مالکیت صادر شد.");
      await navigate("capital", { replace: true });
    },
  });
}

async function waivePreemptiveRight(right) {
  if (!confirm(`از مانده ${faNumber(right.remainingUnits)} واحد حق‌تقدم صرف‌نظر شود؟`)) return;
  try {
    await api(projectPath(`preemptive-rights/${encodeURIComponent(right.id)}/waive`), {
      method: "POST",
      body: {},
    });
    toast("صرف‌نظر از حق‌تقدم ثبت شد.");
    await navigate("capital", { replace: true });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function cancelCertificate(certificate) {
  if (!confirm(`گواهی ${certificate.certificateNo} لغو شود؟ دفتر مالکیت سهام تغییر نمی‌کند.`)) return;
  try {
    await api(projectPath(`share-certificates/${encodeURIComponent(certificate.id)}/cancel`), {
      method: "POST",
      body: {},
    });
    toast("گواهی سهام لغو شد.");
    await navigate("capital", { replace: true });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function renderCapital(sequence) {
  const [
    capResult,
    classResult,
    stakeholderResult,
    offerResult,
    transferResult,
    actionResult,
    rightsResult,
    certificateResult,
    paymentResult,
    meetingResult,
    contractResult,
    accountResult,
    memberResult,
  ] = await Promise.all([
    api(projectPath("cap-table")),
    api(projectPath("share-classes")),
    api(projectPath("stakeholders")),
    api(projectPath("share-offers")),
    api(projectPath("share-transfers")),
    api(projectPath("corporate-actions")),
    api(projectPath("preemptive-rights")),
    api(projectPath("share-certificates")),
    optionalApi(projectPath("payment-intents")),
    api(projectPath("meetings")),
    api(projectPath("contracts")),
    optionalApi(projectPath("accounts")),
    optionalApi(
      `/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}/members`,
    ),
  ]);
  if (!ensureSequence(sequence)) return;
  const cap = capResult || { holdings: [], classes: [], totalUnits: 0 };
  const classes = classResult.shareClasses || cap.classes || [];
  const stakeholders = stakeholderResult.stakeholders || [];
  const offers = offerResult.shareOffers || [];
  const transfers = transferResult.shareTransfers || [];
  const actions = actionResult.corporateActions || [];
  const rights = rightsResult.preemptiveRights || [];
  const certificates = certificateResult.shareCertificates || [];
  const payments = paymentResult?.paymentIntents || [];
  const contracts = contractResult.contracts || [];
  const accounts = accountResult?.accounts || [];
  const members = memberResult?.members || [];
  const meetings = meetingResult.meetings || [];
  const resolutions = meetings.flatMap((meeting) =>
    (meeting.resolutions || []).map((resolution) => ({
      ...resolution,
      meeting,
    })));
  const approvedCorporateResolutions = resolutions.filter((resolution) =>
    resolutionIsApproved(resolution)
    && resolution.operationType === "corporate_action"
    && resolution.operationScope?.projectId === currentProject()?.id
    && !actions.some((action) => action.resolutionId === resolution.id));
  const manageable = hasPermission("capital.manage");
  const financeManageable = hasPermission("finance.manage");
  setPageActions([
    manageable ? button("ذی‌نفع جدید", { onClick: () => openStakeholderDialog(null, members) }) : null,
    manageable ? button("رده سهام", { onClick: () => openShareClassDialog() }) : null,
    manageable ? button("مصوبه اقدام سرمایه", {
      onClick: () => openCorporateResolutionDialog(
        classes,
        stakeholders,
        meetings,
      ),
    }) : null,
    manageable ? button("اجرای مصوبه سرمایه", {
      onClick: () => openCorporateActionDialog(
        approvedCorporateResolutions,
        classes,
        stakeholders,
      ),
    }) : null,
    manageable ? button("گواهی سهام", { onClick: () => openCertificateDialog(classes, stakeholders) }) : null,
    manageable ? button("عرضه سهام", { onClick: () => openShareOfferDialog(classes, stakeholders) }) : null,
    manageable ? button("انتقال", { onClick: () => openTransferDialog(classes, stakeholders, offers) }) : null,
  ]);
  const totalAuthorized = classes.reduce((sum, item) => sum + Number(item.authorizedUnits || 0), 0);
  const metrics = node("div", { className: "ws-metric-grid" }, [
    metricCard("سهام صادرشده", faNumber(cap.totalUnits || 0), `از ${faNumber(totalAuthorized)} واحد مجاز`, "▦"),
    metricCard("سهام‌داران", faNumber(new Set((cap.holdings || []).map((item) => item.stakeholderId)).size), `${faNumber(stakeholders.length)} ذی‌نفع ثبت‌شده`, "◉"),
    metricCard("انتقال‌های باز", faNumber(transfers.filter((item) => ["draft", "pending"].includes(item.status)).length), `${faNumber(offers.filter((item) => ["open", "partially_filled"].includes(item.status)).length)} عرضه باز`, "↔"),
    metricCard("اقدام شرکتی", faNumber(actions.filter((item) => !["completed", "cancelled"].includes(item.status)).length), `${faNumber(rights.length)} حق‌تقدم · ${faNumber(certificates.length)} گواهی`, "◇"),
  ]);
  const host = node("div");
  const tabContainer = node("div", { className: "ws-tabs", attributes: { role: "tablist" } });
  const tabItems = [
    { value: "holdings", label: "جدول مالکیت" },
    { value: "stakeholders", label: "ذی‌نفعان" },
    { value: "transfers", label: "انتقال و عرضه" },
    { value: "actions", label: "اقدامات شرکتی" },
    { value: "certificates", label: "گواهی و حق‌تقدم" },
  ];
  let selected = "holdings";
  const renderSelected = () => {
    if (selected === "holdings") {
      host.replaceChildren(dataTable([
        { label: "سهام‌دار", title: true, render: (item) => titleCell(item.stakeholderName, item.className || item.symbol) },
        { label: "رده", render: (item) => item.symbol || item.classSymbol || "—" },
        { label: "واحد", render: (item) => faNumber(item.units) },
        { label: "درصد مالکیت", render: (item) => faPercent(item.ownershipPercent ?? (cap.totalUnits ? Number(item.units) / cap.totalUnits * 100 : 0)) },
        {
          label: "قدرت رأی",
          render: (item) => {
            const shareClass = classes.find((candidate) =>
              candidate.id === (item.shareClassId || item.classId));
            return faNumber(
              item.votingPower
                ?? Number(item.units) * Number(shareClass?.votingWeight || 1),
              2,
            );
          },
        },
      ], cap.holdings || [], {
        emptyTitle: "مالکیتی ثبت نشده است",
        emptyDescription: "ابتدا ذی‌نفع و رده سهام بسازید، سپس صدور اولیه را انجام دهید.",
        emptyAction: manageable && classes.length && stakeholders.length
          ? button("ساخت مصوبه اقدام سرمایه", {
              variant: "primary",
              onClick: () => openCorporateResolutionDialog(
                classes,
                stakeholders,
                meetings,
              ),
            })
          : null,
      }));
    } else if (selected === "stakeholders") {
      host.replaceChildren(dataTable([
        { label: "ذی‌نفع", title: true, render: (item) => titleCell(item.name, item.email || item.mobile) },
        { label: "نوع", render: (item) => item.kind === "organization" ? "حقوقی" : "حقیقی" },
        { label: "نقش", render: (item) => ({ owner: "مالک", board: "هیئت‌مدیره", manager: "مدیر", investor: "سرمایه‌گذار", partner: "شریک" }[item.role] || item.role) },
        {
          label: "هویت رأی",
          render: (item) => {
            if (item.kind === "organization") return "از مسیر نماینده";
            const linked = activeMemberUsers(members).find((user) =>
              user.id === item.userId);
            return item.userId
              ? titleCell(
                  "حساب متصل",
                  linked?.fullName || linked?.email || item.userId,
                )
              : "بدون حساب متصل";
          },
        },
        { label: "وضعیت", render: (item) => statusChip(item.archivedAt ? "archived" : "active") },
        { label: "عملیات", render: (item) => manageable ? button("ویرایش", { variant: "ghost", onClick: () => openStakeholderDialog(item, members) }) : "فقط مشاهده" },
      ], stakeholders));
    } else if (selected === "transfers") {
      const stakeholderName = (id) =>
        stakeholders.find((item) => item.id === id)?.name || id || "—";
      const transferTable = dataTable([
        { label: "انتقال", title: true, render: (item) => titleCell(`${faNumber(item.units)} واحد`, item.referenceCode || item.id.slice(0, 8)) },
        { label: "از / به", render: (item) => `${stakeholderName(item.fromStakeholderId)} ← ${stakeholderName(item.toStakeholderId)}` },
        { label: "مبلغ", render: (item) => item.priceAmount == null ? "—" : faMoney(item.priceAmount, currentProject()?.currency) },
        {
          label: "شواهد کنترل",
          render: (item) => {
            const paymentRequired = Number(item.priceAmount || 0) > 0;
            const linkedResolution = resolutions.find((candidate) =>
              candidate.id === item.resolutionId);
            const usedResolutionIds = new Set(transfers
              .filter((candidate) =>
                candidate.id !== item.id && candidate.resolutionId)
              .map((candidate) => candidate.resolutionId));
            const resolution = linkedResolution || resolutions.find((candidate) =>
              matchingTransferResolution(item, candidate)
              && !usedResolutionIds.has(candidate.id));
            const linkedContract = contracts.find((candidate) =>
              candidate.id === item.contractId);
            const contract = linkedContract || contracts.find((candidate) =>
              matchingTransferContract(item, candidate));
            const linkedPayment = payments.find((candidate) =>
              candidate.id === item.paymentIntentId);
            const payment = linkedPayment || payments.find((candidate) =>
              transferPaymentMatches(item, candidate));
            const resolutionReady = Boolean(
              resolution && matchingTransferResolution(item, resolution),
            );
            const contractReady = Boolean(
              contract && matchingTransferContract(item, contract),
            );
            const paymentReady = !paymentRequired || Boolean(
              payment && transferPaymentMatches(item, payment),
            );
            const evidenceAvailable = Boolean(
              resolutionReady
              && contractReady
              && paymentReady,
            );
            const evidenceConnected = Boolean(
              item.resolutionId
              && item.contractId
              && (!paymentRequired || item.paymentIntentId)
              && evidenceAvailable,
            );
            const bindingStatus = !item.resolutionId
              ? "مصوبه هنوز متصل نیست"
              : item.status === "approved"
                ? "مصوبه مصرف‌شده در انتقال قطعی"
                : item.status === "draft"
                  ? "مصوبه هنوز متصل نیست"
                  : "مصوبه به این انتقال متصل و رزرو است";
            const identifiers = [
              resolutionReady
                ? linkedResolution
                  ? "مصوبه منطبق و متصل"
                  : "مصوبه منطبق آماده اتصال"
                : "مصوبه ناقص یا نامنطبق",
              contractReady
                ? linkedContract
                  ? "قرارداد معتبر و متصل"
                  : "قرارداد معتبر آماده انتخاب"
                : "قرارداد ناقص یا نامعتبر",
              paymentRequired
                ? paymentReady
                  ? linkedPayment
                    ? "پرداخت موفق و اختصاصی متصل"
                    : "پرداخت موفق و اختصاصی آماده اتصال"
                  : "پرداخت موفق اختصاصی موجود نیست"
                : "پرداخت: بدون مبلغ",
              bindingStatus,
              "KYC هنگام ارسال/تأیید در سرور کنترل می‌شود",
              item.approvedByUserId
                ? `چهارچشمی ثبت‌شده · تأییدکننده ${item.approvedByUserId.slice(0, 8)}`
                : item.createdByUserId
                  ? "در انتظار تأیید کاربر دوم"
                  : "رکورد سازگاری قدیمی",
            ].join(" · ");
            return titleCell(
              evidenceConnected
                ? "شواهد متصل"
                : evidenceAvailable
                  ? "شواهد آماده ارسال"
                  : "شواهد ناقص",
              identifiers,
            );
          },
        },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
        { label: "زمان", render: (item) => faDate(item.updatedAt, true) },
        {
          label: "عملیات",
          render: (item) => {
            if (!manageable) return "فقط مشاهده";
            if (item.status === "draft") {
              const scopedPayment = payments.find((payment) =>
                ["pending", "processing", "succeeded"].includes(payment.status)
                && transferPaymentMatches(item, payment, { succeeded: false }));
              const paymentRequired = Number(item.priceAmount || 0) > 0;
              return node("div", {}, [
                button("ساخت مصوبه انتقال", {
                  variant: "ghost",
                  onClick: () => openTransferResolutionDialog(
                    item,
                    meetings,
                    stakeholders,
                    classes,
                  ),
                }),
                paymentRequired && financeManageable && !scopedPayment
                  ? button("ساخت پرداخت اختصاصی", {
                      variant: "ghost",
                      onClick: () => createTransferPaymentIntent(item, accounts),
                    })
                  : null,
                paymentRequired
                  && financeManageable
                  && scopedPayment
                  && scopedPayment.status !== "succeeded"
                  ? button("تأیید پرداخت", {
                      variant: "ghost",
                      onClick: () => openPaymentConfirmDialog(
                        scopedPayment,
                        accounts,
                        "capital",
                      ),
                    })
                  : null,
                button("تکمیل شواهد و ارسال", {
                  variant: "primary",
                  onClick: () => openTransferEvidenceDialog(
                    item,
                    resolutions,
                    contracts,
                    payments,
                    transfers,
                  ),
                }),
                button("لغو", { variant: "ghost", onClick: () => openTransferDecisionDialog(item, "cancelled") }),
              ]);
            }
            if (item.status === "pending") {
              return node("div", {}, [
                button("تأیید قطعی", { variant: "primary", onClick: () => openTransferDecisionDialog(item, "approved") }),
                button("رد", { variant: "danger", onClick: () => openTransferDecisionDialog(item, "rejected") }),
                button("لغو", { variant: "ghost", onClick: () => openTransferDecisionDialog(item, "cancelled") }),
              ]);
            }
            return item.decisionNote || "—";
          },
        },
      ], transfers, {
        emptyTitle: "انتقالی ثبت نشده است",
        emptyDescription: "انتقال را ابتدا به‌صورت پیش‌نویس ثبت و سپس مصوبه، قرارداد و پرداخت اختصاصی را متصل کنید.",
        emptyAction: manageable ? button("انتقال جدید", { variant: "primary", onClick: () => openTransferDialog(classes, stakeholders, offers) }) : null,
      });
      const offerTable = dataTable([
        {
          label: "پیشنهاد",
          title: true,
          render: (item) => titleCell(
            item.side === "sell" ? "پیشنهاد فروش" : "پیشنهاد خرید",
            stakeholderName(item.sellerStakeholderId || item.buyerStakeholderId),
          ),
        },
        { label: "واحد", render: (item) => `${faNumber(item.remainingUnits)} مانده از ${faNumber(item.units)}` },
        { label: "قیمت واحد", render: (item) => faMoney(item.unitPrice, currentProject()?.currency) },
        { label: "مهلت", render: (item) => faDate(item.availableUntil) },
        { label: "وضعیت", render: (item) => statusChip(item.effectiveStatus || item.status) },
        {
          label: "عملیات",
          render: (item) => manageable && ["open", "partially_filled"].includes(item.status)
            ? button("بستن پیشنهاد", { variant: "danger", onClick: () => cancelShareOffer(item) })
            : "—",
        },
      ], offers, {
        emptyTitle: "عرضه یا تقاضایی ثبت نشده است",
        emptyDescription: "پیشنهاد خرید و فروش را ثبت کنید و معامله را از مسیر انتقال قطعی کنید.",
        emptyAction: manageable ? button("پیشنهاد جدید", { variant: "primary", onClick: () => openShareOfferDialog(classes, stakeholders) }) : null,
      });
      host.replaceChildren(
        panel("انتقال‌های سهام", "تأیید چهارچشمی فقط پس از کنترل مصوبه، KYC، قرارداد، پرداخت و موجودی دفتر مالکیت انجام می‌شود", transferTable),
        node("br", { attributes: { "aria-hidden": "true" } }),
        panel("عرضه و تقاضای سهام", "مانده هر پیشنهاد با انتقال‌های تأییدشده به‌روزرسانی می‌شود", offerTable),
      );
    } else if (selected === "actions") {
      host.replaceChildren(dataTable([
        { label: "اقدام", title: true, render: (item) => titleCell(item.title, corporateActionLabel(item.actionType)) },
        { label: "تاریخ مبنا", render: (item) => faDate(item.recordDate) },
        { label: "واحد / نسبت", render: (item) => item.units ? faNumber(item.units) : `${faNumber(item.ratioNumerator)}:${faNumber(item.ratioDenominator)}` },
        {
          label: "مصوبه و اتصال",
          render: (item) => {
            const resolution = resolutions.find((candidate) =>
              candidate.id === item.resolutionId);
            const scopeMatches = Boolean(
              resolution
              && operationScopesMatch(
                resolution.operationScope,
                corporateOperationScope(item),
              ),
            );
            const binding = item.status === "completed"
              ? "مصوبه مصرف‌شده"
              : item.resolutionId
                ? "مصوبه متصل به این اقدام"
                : "بدون مصوبه متصل";
            return titleCell(
              scopeMatches ? binding : "اتصال یا دامنه نامعتبر",
              resolution
                ? describeOperationScope(
                    resolution.operationScope,
                    stakeholders,
                    classes,
                  )
                : "شواهد حاکمیتی ثبت نشده",
            );
          },
        },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
        {
          label: "عملیات",
          render: (item) => manageable
            ? node("div", {}, [
                item.status === "draft" ? node("div", {}, [
                button("پیش‌نمایش", {
                  variant: "ghost",
                  onClick: async () => {
                    try {
                      const preview = await api(projectPath(`corporate-actions/${encodeURIComponent(item.id)}/preview`));
                      toast(`پیش‌نمایش معتبر است؛ ${faNumber(preview.after?.length || preview.entitlements?.length || 0)} ذی‌نفع تحت تأثیر.`);
                    } catch (error) {
                      toast(errorMessage(error), "error");
                    }
                  },
                }),
                button("تأیید", {
                  variant: "primary",
                  onClick: async () => {
                    try {
                      await api(projectPath(`corporate-actions/${encodeURIComponent(item.id)}/approve`), { method: "POST", body: {} });
                      toast("اقدام شرکتی تأیید شد؛ برای اجرا آماده است.");
                      navigate("capital", { replace: true });
                    } catch (error) {
                      toast(errorMessage(error), "error");
                    }
                  },
                }),
                ]) : null,
                item.status === "approved" ? button("اجرای قطعی", {
                  variant: "danger",
                  onClick: async () => {
                    if (!confirm("اقدام شرکتی اجرا شود؟ این عملیات دفتر مالکیت یا سقف مجاز سهام را تغییر می‌دهد.")) return;
                    try {
                      await api(projectPath(`corporate-actions/${encodeURIComponent(item.id)}/execute`), {
                        method: "POST",
                        body: {},
                      });
                      toast("اقدام شرکتی اجرا و دفتر سرمایه به‌روزرسانی شد.");
                      await navigate("capital", { replace: true });
                    } catch (error) {
                      toast(errorMessage(error), "error");
                    }
                  },
                }) : null,
              ])
            : "—",
        },
      ], actions, {
        emptyTitle: "اقدام شرکتی متصلی ثبت نشده است",
        emptyDescription: "ابتدا دامنه اقدام را در یک مصوبه ثبت و پس از تصویب، اقدام را مستقیماً از همان مصوبه بسازید.",
        emptyAction: manageable ? node("div", {}, [
          button("ساخت مصوبه اقدام", {
            variant: "primary",
            onClick: () => openCorporateResolutionDialog(
              classes,
              stakeholders,
              meetings,
            ),
          }),
          button("ثبت از مصوبه تصویب‌شده", {
            variant: "ghost",
            onClick: () => openCorporateActionDialog(
              approvedCorporateResolutions,
              classes,
              stakeholders,
            ),
          }),
        ]) : null,
      }));
    } else {
      const combined = [
        ...certificates.map((item) => ({
          ...item,
          rowType: "certificate",
          stakeholderName: stakeholders.find((stakeholder) => stakeholder.id === item.stakeholderId)?.name,
        })),
        ...rights.map((item) => ({
          ...item,
          rowType: "right",
          stakeholderName: stakeholders.find((stakeholder) => stakeholder.id === item.stakeholderId)?.name,
        })),
      ];
      host.replaceChildren(dataTable([
        { label: "رکورد", title: true, render: (item) => titleCell(item.rowType === "certificate" ? item.certificateNo : "حق‌تقدم", item.stakeholderName || item.stakeholderId) },
        { label: "نوع", render: (item) => item.rowType === "certificate" ? "گواهی سهام" : "حق‌تقدم" },
        { label: "واحد", render: (item) => item.rowType === "right"
          ? `${faNumber(item.remainingUnits)} مانده از ${faNumber(item.entitledUnits)}`
          : faNumber(item.units || 0) },
        { label: "وضعیت", render: (item) => statusChip(item.status) },
        { label: "تاریخ", render: (item) => faDate(item.issuedOn || item.createdAt) },
        {
          label: "عملیات",
          render: (item) => {
            if (!manageable) return "فقط مشاهده";
            if (item.rowType === "certificate" && item.status === "active") {
              return node("div", {}, [
                button("جایگزینی", { variant: "ghost", onClick: () => openCertificateReplacementDialog(item) }),
                button("لغو", { variant: "danger", onClick: () => cancelCertificate(item) }),
              ]);
            }
            if (item.rowType === "right" && ["available", "partially_exercised"].includes(item.status)) {
              return node("div", {}, [
                button("اعمال", { variant: "primary", onClick: () => openExerciseRightDialog(item, payments) }),
                button("صرف‌نظر", { variant: "ghost", onClick: () => waivePreemptiveRight(item) }),
              ]);
            }
            return "—";
          },
        },
      ], combined));
    }
  };
  for (const item of tabItems) {
    const control = node("button", {
      type: "button",
      text: item.label,
      className: item.value === selected ? "is-active" : "",
      attributes: { role: "tab", "aria-selected": item.value === selected ? "true" : "false" },
      onclick: () => {
        selected = item.value;
        for (const candidate of $$("button", tabContainer)) {
          const chosen = candidate === control;
          candidate.classList.toggle("is-active", chosen);
          candidate.setAttribute("aria-selected", chosen ? "true" : "false");
        }
        renderSelected();
      },
    });
    tabContainer.append(control);
  }
  renderSelected();
  dom.pageBody.replaceChildren(metrics, tabContainer, host);
}

function openMeetingDialog(meeting = null) {
  const datetime = meeting?.scheduledAt
    ? new Date(meeting.scheduledAt).toISOString().slice(0, 16)
    : "";
  openEntityDialog({
    kicker: "حاکمیت پروژه",
    title: meeting ? meeting.title : "جلسهٔ جدید",
    submitLabel: meeting ? "ذخیره جلسه" : "برنامه‌ریزی جلسه",
    initial: { ...(meeting || { status: "scheduled", publicVisible: false }), scheduledAt: datetime },
    fields: [
      { name: "title", label: "عنوان جلسه", required: true, maxLength: 200 },
      { name: "scheduledAt", label: "زمان برگزاری", type: "datetime-local", required: true },
      { name: "location", label: "مکان یا لینک", maxLength: 300 },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: ["scheduled", "held", "cancelled"].map((value) => ({ value, label: translatedStatus(value) })),
      },
      { name: "minutes", label: "صورت‌جلسه", type: "textarea", rows: 5, maxLength: 20_000 },
      { name: "publicVisible", label: "در صفحه عمومی قابل مشاهده باشد", type: "checkbox" },
    ],
    onSubmit: async (values) => {
      values.scheduledAt = new Date(values.scheduledAt).toISOString();
      await api(projectPath(`meetings${meeting ? `/${encodeURIComponent(meeting.id)}` : ""}`), {
        method: meeting ? "PATCH" : "POST",
        body: values,
      });
      toast(meeting ? "جلسه به‌روزرسانی شد." : "جلسه برنامه‌ریزی شد.");
      await navigate("governance", { replace: true });
    },
  });
}

function openResolutionDialog(meeting) {
  openEntityDialog({
    kicker: meeting.title,
    title: "مصوبهٔ جدید",
    submitLabel: "ثبت مصوبه",
    initial: { status: "draft", publicVisible: false },
    fields: [
      { name: "title", label: "عنوان مصوبه", required: true, maxLength: 300 },
      { name: "description", label: "متن پیشنهادی", type: "textarea", rows: 4, maxLength: 5000 },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: [
          { value: "draft", label: "پیش‌نویس" },
          { value: "open", label: "رأی‌گیری باز" },
        ],
      },
      { name: "publicVisible", label: "نتیجه برای عموم قابل مشاهده باشد", type: "checkbox" },
    ],
    onSubmit: async (values) => {
      await api(projectPath(`meetings/${encodeURIComponent(meeting.id)}/resolutions`), {
        method: "POST",
        body: {
          ...values,
          operationScope: null,
        },
      });
      toast("مصوبه ثبت شد.");
      await navigate("governance", { replace: true });
    },
  });
}

function openProxyDialog(meetings, stakeholders, resolutions) {
  const activeStakeholders = stakeholders.filter((item) => !item.archivedAt);
  const grantors = activeStakeholders.filter((item) =>
    item.userId && item.userId === state.user?.id);
  if (!grantors.length) {
    toast(
      "برای اعطای وکالت، ابتدا حساب خود را به یک ذی‌نفع حقیقی فعال متصل کنید.",
      "error",
    );
    return;
  }
  const grantorOptions = [
    { value: "", label: "انتخاب هویت متصل به حساب من" },
    ...grantors.map((item) => ({ value: item.id, label: item.name })),
  ];
  const proxyOptions = [
    { value: "", label: "انتخاب نماینده" },
    ...activeStakeholders.map((item) => ({ value: item.id, label: item.name })),
  ];
  openEntityDialog({
    kicker: "نمایندگی رأی",
    title: "اعطای وکالت رأی",
    submitLabel: "ثبت وکالت",
    initial: { scope: "meeting" },
    fields: [
      {
        name: "meetingId",
        label: "جلسه",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب جلسه" }, ...meetings.map((item) => ({ value: item.id, label: item.title }))],
      },
      { name: "grantorStakeholderId", label: "اعطاکننده", type: "select", required: true, options: grantorOptions },
      { name: "proxyStakeholderId", label: "نماینده", type: "select", required: true, options: proxyOptions },
      {
        name: "scope",
        label: "دامنه",
        type: "select",
        options: [
          { value: "meeting", label: "کل جلسه" },
          { value: "resolution", label: "فقط یک مصوبه" },
        ],
      },
      {
        name: "resolutionId",
        label: "مصوبه (برای دامنهٔ مصوبه)",
        type: "select",
        options: [
          { value: "", label: "برای وکالت کل جلسه خالی بماند" },
          ...resolutions.map((item) => ({
            value: item.id,
            label: `${item.meeting.title} — ${item.title}`,
          })),
        ],
      },
      { name: "expiresAt", label: "انقضا", type: "datetime-local" },
    ],
    note: "وکالت فقط توسط حساب متصل به اعطاکننده ثبت می‌شود و تمام قدرت رأی او را در دامنهٔ انتخاب‌شده منتقل می‌کند؛ رأی شکسته پشتیبانی نمی‌شود.",
    onSubmit: async (values) => {
      if (values.grantorStakeholderId === values.proxyStakeholderId) {
        throw new Error("اعطاکننده و نماینده باید متفاوت باشند.");
      }
      if (values.scope === "resolution") {
        const resolution = resolutions.find((item) => item.id === values.resolutionId);
        if (!resolution) throw new Error("برای وکالت محدود، یک مصوبه انتخاب کنید.");
        if (resolution.meeting.id !== values.meetingId) {
          throw new Error("مصوبهٔ انتخاب‌شده متعلق به جلسهٔ انتخاب‌شده نیست.");
        }
      } else {
        values.resolutionId = "";
      }
      if (values.expiresAt) values.expiresAt = new Date(values.expiresAt).toISOString();
      await api(projectPath("governance-proxies"), { method: "POST", body: values });
      toast("وکالت رأی ثبت شد.");
      await navigate("governance", { replace: true });
    },
  });
}

function openAttendanceDialog(meeting, stakeholders) {
  openEntityDialog({
    kicker: "حضور و حدنصاب",
    title: meeting.title,
    submitLabel: "ثبت وضعیت حضور",
    initial: { attendance: "present" },
    fields: [
      {
        name: "stakeholderId",
        label: "عضو / سهام‌دار",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب عضو" }, ...stakeholders.filter((item) => !item.archivedAt).map((item) => ({
          value: item.id,
          label: item.name,
        }))],
      },
      {
        name: "attendance",
        label: "وضعیت حضور",
        type: "select",
        options: [
          { value: "invited", label: "دعوت‌شده" },
          { value: "present", label: "حاضر" },
          { value: "absent", label: "غایب" },
        ],
      },
    ],
    note: "وضعیت حضور مستقیماً در محاسبه حدنصاب جلسه و نمایندگی‌های معتبر اثر دارد.",
    onSubmit: async (values) => {
      await api(projectPath(
        `meetings/${encodeURIComponent(meeting.id)}/attendees/${encodeURIComponent(values.stakeholderId)}`,
      ), {
        method: "PUT",
        body: { attendance: values.attendance },
      });
      toast("وضعیت حضور ثبت شد.");
      await navigate("governance", { replace: true });
    },
  });
}

function eligibleVoteActors(resolution, stakeholders, proxies) {
  const ownStakeholderIds = new Set(stakeholders
    .filter((item) => !item.archivedAt && item.userId === state.user?.id)
    .map((item) => item.id));
  const choices = stakeholders
    .filter((item) => ownStakeholderIds.has(item.id))
    .map((item) => ({
      stakeholderId: item.id,
      label: `${item.name} — رأی مستقیم من`,
    }));
  const now = Date.now();
  for (const proxy of proxies) {
    if (
      proxy.status !== "active"
      || proxy.meetingId !== resolution.meeting.id
      || !ownStakeholderIds.has(proxy.proxyStakeholderId)
      || (proxy.scope === "resolution" && proxy.resolutionId !== resolution.id)
      || !["meeting", "resolution"].includes(proxy.scope)
      || (proxy.grantedAt && Date.parse(proxy.grantedAt) > now)
      || (proxy.expiresAt && Date.parse(proxy.expiresAt) <= now)
    ) {
      continue;
    }
    const grantor = stakeholders.find((item) =>
      !item.archivedAt && item.id === proxy.grantorStakeholderId);
    if (
      grantor
      && !choices.some((item) => item.stakeholderId === grantor.id)
    ) {
      choices.push({
        stakeholderId: grantor.id,
        label: `${grantor.name} — به نمایندگی معتبر`,
      });
    }
  }
  return choices;
}

function openVoteDialog(resolution, actorChoices) {
  if (!actorChoices.length) {
    toast("حساب شما به هیچ ذی‌نفع رأی‌دهنده یا وکالت فعال این مصوبه متصل نیست.", "error");
    return;
  }
  openEntityDialog({
    kicker: resolution.meeting.title,
    title: `ثبت رأی — ${resolution.title}`,
    submitLabel: "ثبت یا اصلاح رأی",
    initial: { choice: "yes" },
    fields: [
      {
        name: "stakeholderId",
        label: "رأی‌دهنده",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب هویت مجاز" }, ...actorChoices.map((item) => ({
          value: item.stakeholderId,
          label: item.label,
        }))],
      },
      {
        name: "choice",
        label: "رأی",
        type: "select",
        options: [
          { value: "yes", label: "موافق" },
          { value: "no", label: "مخالف" },
          { value: "abstain", label: "ممتنع" },
        ],
      },
    ],
    note: "فقط ذی‌نفع متصل به حساب فعلی یا اعطاکننده‌ای که شما نماینده فعال او هستید قابل انتخاب است. قدرت رأی در سرور از دفتر مالکیت محاسبه می‌شود.",
    onSubmit: async (values) => {
      await api(projectPath(
        `meetings/${encodeURIComponent(resolution.meeting.id)}/resolutions/${encodeURIComponent(resolution.id)}/votes`,
      ), {
        method: "PUT",
        body: {
          stakeholderId: values.stakeholderId,
          choice: values.choice,
        },
      });
      toast("رأی ثبت شد؛ رأی قبلی همین عضو در صورت وجود اصلاح شد.");
      await navigate("governance", { replace: true });
    },
  });
}

async function openFinalizeResolutionDialog(resolution) {
  try {
    const path = projectPath(
      `meetings/${encodeURIComponent(resolution.meeting.id)}/resolutions/${encodeURIComponent(resolution.id)}`,
    );
    const result = await api(`${path}/outcome`);
    const outcome = result.outcome && typeof result.outcome === "object"
      ? result.outcome
      : result;
    const outcomeLabels = {
      approved: "تصویب‌شده",
      rejected: "ردشده",
      tied: "مساوی",
      no_quorum: "فاقد حدنصاب",
    };
    const decision = resolution.decision || [
      `نتیجه محاسبه‌شده: ${outcomeLabels[outcome.outcome] || outcome.outcome}`,
      `موافق ${faNumber(outcome.tally?.yes || 0)}`,
      `مخالف ${faNumber(outcome.tally?.no || 0)}`,
      `ممتنع ${faNumber(outcome.tally?.abstain || 0)}`,
      `حدنصاب ${outcome.quorum?.quorumMet ? "برقرار" : "برقرار نیست"}`,
    ].join(" · ");
    openEntityDialog({
      kicker: "ثبت نتیجه قابل ممیزی",
      title: resolution.title,
      submitLabel: "نهایی‌سازی و بستن رأی‌گیری",
      initial: { decision },
      fields: [
        { name: "decision", label: "متن تصمیم نهایی", type: "textarea", rows: 5, required: true, maxLength: 5000 },
      ],
      note: `نتیجه موتور رأی: ${outcomeLabels[outcome.outcome] || outcome.outcome}؛ حدنصاب ${faPercent(outcome.quorum?.quorumPercent || 0)}.`,
      onSubmit: async (values) => {
        await api(`${path}/finalize-outcome`, { method: "POST", body: {} });
        await api(path, {
          method: "PATCH",
          body: { status: "closed", decision: values.decision },
        });
        toast("نتیجه رأی محاسبه، ثبت و مصوبه بسته شد.");
        await navigate("governance", { replace: true });
      },
    });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function openResolutionVoting(resolution) {
  if (!confirm(`رأی‌گیری مصوبه «${resolution.title}» باز شود؟`)) return;
  try {
    await api(projectPath(
      `meetings/${encodeURIComponent(resolution.meeting.id)}/resolutions/${encodeURIComponent(resolution.id)}`,
    ), {
      method: "PATCH",
      body: { status: "open" },
    });
    toast("رأی‌گیری باز شد.");
    await navigate("governance", { replace: true });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function revokeGovernanceProxy(proxy) {
  if (!confirm("این وکالت رأی لغو شود؟")) return;
  try {
    await api(projectPath(`governance-proxies/${encodeURIComponent(proxy.id)}/revoke`), {
      method: "POST",
      body: {},
    });
    toast("وکالت رأی لغو شد.");
    await navigate("governance", { replace: true });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function decisionActionAssigneeOptions(members, action = null) {
  const candidates = [];
  for (const member of members) {
    if (member.status !== "active" || !member.user?.id) continue;
    candidates.push({
      value: member.user.id,
      label: member.user.fullName || member.user.email,
    });
  }
  if (state.user?.id && !candidates.some((item) => item.value === state.user.id)) {
    candidates.push({
      value: state.user.id,
      label: `${state.user.fullName || state.user.email} (خودم)`,
    });
  }
  if (
    action?.assignee?.id
    && !candidates.some((item) => item.value === action.assignee.id)
  ) {
    candidates.push({
      value: action.assignee.id,
      label: action.assignee.fullName || action.assignee.email || "مسئول فعلی",
    });
  }
  return [{ value: "", label: "بدون مسئول مشخص" }, ...candidates];
}

function openDecisionActionDialog({
  action = null,
  meetings,
  resolutions,
  members,
}) {
  const fields = [
    { name: "title", label: "عنوان اقدام", required: true, maxLength: 300 },
    {
      name: "description",
      label: "شرح و معیار انجام",
      type: "textarea",
      rows: 3,
      maxLength: 20_000,
    },
    {
      name: "assigneeUserId",
      label: "مسئول پیگیری",
      type: "select",
      options: decisionActionAssigneeOptions(members, action),
    },
    { name: "dueDate", label: "مهلت انجام", type: "date" },
    {
      name: "priority",
      label: "اولویت",
      type: "select",
      options: Object.entries(labels.taskPriority).map(([value, label]) => ({
        value,
        label,
      })),
    },
  ];
  if (!action) {
    fields.push(
      {
        name: "meetingId",
        label: "جلسه مرتبط",
        type: "select",
        options: [
          { value: "", label: "بدون جلسه" },
          ...meetings.map((item) => ({ value: item.id, label: item.title })),
        ],
      },
      {
        name: "resolutionId",
        label: "مصوبه مرتبط",
        type: "select",
        options: [
          { value: "", label: "بدون مصوبه" },
          ...resolutions.map((item) => ({
            value: item.id,
            label: `${item.meeting.title} — ${item.title}`,
          })),
        ],
      },
    );
  }
  openEntityDialog({
    kicker: action ? "ویرایش اقدام مصوبه" : "پیگیری اجرای تصمیم",
    title: action?.title || "اقدام پیگیری جدید",
    submitLabel: action ? "ذخیره تغییرات" : "ساخت اقدام",
    initial: action || {
      priority: "medium",
      meetingId: "",
      resolutionId: "",
      assigneeUserId: state.user?.id || "",
    },
    fields,
    note: action
      ? "تغییر وضعیت از مسیر جداگانه ثبت می‌شود تا تاریخچهٔ اجرای تصمیم قابل ممیزی بماند."
      : "اقدام را می‌توانید به جلسه یا مصوبه متصل کنید؛ انتخاب مصوبه، جلسهٔ همان مصوبه را نیز ثبت می‌کند.",
    onSubmit: async (values) => {
      if (action) {
        await api(projectPath(`decision-actions/${encodeURIComponent(action.id)}`), {
          method: "PATCH",
          body: {
            title: values.title,
            description: values.description,
            assigneeUserId: values.assigneeUserId || null,
            dueDate: values.dueDate || null,
            priority: values.priority,
          },
        });
      } else {
        const resolution = resolutions.find((item) => item.id === values.resolutionId);
        if (
          resolution
          && values.meetingId
          && resolution.meeting.id !== values.meetingId
        ) {
          throw new Error("مصوبهٔ انتخاب‌شده متعلق به جلسهٔ انتخاب‌شده نیست.");
        }
        await api(projectPath("decision-actions"), {
          method: "POST",
          body: {
            title: values.title,
            description: values.description,
            assigneeUserId: values.assigneeUserId || null,
            dueDate: values.dueDate || null,
            priority: values.priority,
            meetingId: resolution?.meeting.id || values.meetingId || null,
            resolutionId: values.resolutionId || null,
          },
        });
      }
      toast(action ? "اقدام پیگیری به‌روزرسانی شد." : "اقدام پیگیری مصوبه ساخته شد.");
      await navigate("governance", { replace: true });
    },
  });
}

function decisionActionTransitions(status) {
  const next = {
    open: [
      ["in_progress", "شروع اجرا"],
      ["cancelled", "لغو اقدام"],
    ],
    in_progress: [
      ["blocked", "ثبت مانع"],
      ["completed", "تکمیل اقدام"],
      ["cancelled", "لغو اقدام"],
    ],
    blocked: [
      ["in_progress", "ادامه اجرا"],
      ["completed", "تکمیل اقدام"],
      ["cancelled", "لغو اقدام"],
    ],
    completed: [["open", "بازگشایی"]],
    cancelled: [["open", "بازگشایی"]],
  }[status] || [];
  return next.map(([value, label]) => ({ value, label }));
}

function openDecisionActionTransitionDialog(action) {
  const options = decisionActionTransitions(action.status);
  if (!options.length) {
    toast("گذار دیگری برای این وضعیت تعریف نشده است.", "error");
    return;
  }
  openEntityDialog({
    kicker: "گردش اجرای مصوبه",
    title: action.title,
    submitLabel: "ثبت تغییر وضعیت",
    initial: { toStatus: options[0].value },
    fields: [
      {
        name: "toStatus",
        label: "وضعیت بعدی",
        type: "select",
        required: true,
        options,
      },
      {
        name: "note",
        label: "یادداشت اجرا / مانع",
        type: "textarea",
        rows: 3,
        maxLength: 4000,
      },
    ],
    note: "همهٔ گذارها همراه با عامل، زمان و یادداشت در تاریخچهٔ قابل ممیزی ثبت می‌شوند.",
    onSubmit: async (values) => {
      await api(projectPath(
        `decision-actions/${encodeURIComponent(action.id)}/transitions`,
      ), {
        method: "POST",
        body: values,
      });
      toast(values.toStatus === "open"
        ? "اقدام دوباره باز شد."
        : "وضعیت اقدام به‌روزرسانی شد.");
      await navigate("governance", { replace: true });
    },
  });
}

async function openDecisionActionHistory(action) {
  try {
    const result = await api(projectPath(
      `decision-actions/${encodeURIComponent(action.id)}/history?limit=100`,
    ));
    const history = result.history || [];
    const lines = history.map((item) => {
      const statusChange = item.fromStatus || item.toStatus
        ? `${translatedStatus(item.fromStatus)} ← ${translatedStatus(item.toStatus)}`
        : item.eventType === "created" ? "ایجاد اقدام" : "ویرایش اطلاعات";
      const note = item.metadata?.note ? ` · ${item.metadata.note}` : "";
      return `${faDate(item.createdAt, true)} · ${statusChange}${note}`;
    });
    openEntityDialog({
      kicker: "ردپای ممیزی",
      title: action.title,
      submitLabel: "بستن",
      fields: [
        {
          name: "history",
          label: "تاریخچه اقدام",
          type: "textarea",
          rows: 10,
          disabled: true,
          value: lines.length ? lines.join("\n") : "هنوز رویدادی ثبت نشده است.",
        },
      ],
      note: `${faNumber(result.total || history.length)} رویداد ثبت‌شده`,
      onSubmit: async () => {},
    });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function renderGovernance(sequence) {
  const [
    meetingResult,
    proxyResult,
    stakeholderResult,
    decisionActionResult,
    memberResult,
    classResult,
    transferResult,
    corporateActionResult,
  ] = await Promise.all([
    api(projectPath("meetings")),
    api(projectPath("governance-proxies")),
    api(projectPath("stakeholders")),
    api(projectPath("decision-actions?limit=200")),
    optionalApi(
      `/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}/members`,
    ),
    optionalApi(projectPath("share-classes")),
    optionalApi(projectPath("share-transfers")),
    optionalApi(projectPath("corporate-actions")),
  ]);
  if (!ensureSequence(sequence)) return;
  const meetings = meetingResult.meetings || [];
  const proxies = proxyResult.governanceProxies || [];
  const stakeholders = stakeholderResult.stakeholders || [];
  const decisionActions = decisionActionResult.actions || [];
  const members = memberResult?.members || [];
  const classes = classResult?.shareClasses || [];
  const transfers = transferResult?.shareTransfers || [];
  const corporateActions = corporateActionResult?.corporateActions || [];
  const resolutions = meetings.flatMap((meeting) =>
    (meeting.resolutions || []).map((resolution) => ({ ...resolution, meeting })));
  const manageable = hasPermission("governance.manage");
  setPageActions([
    manageable ? button("اقدام پیگیری", {
      onClick: () => openDecisionActionDialog({
        meetings,
        resolutions,
        members,
      }),
    }) : null,
    manageable ? button("وکالت رأی", { onClick: () => openProxyDialog(meetings, stakeholders, resolutions) }) : null,
    manageable ? button("جلسهٔ جدید", { variant: "primary", onClick: () => openMeetingDialog() }) : null,
  ]);
  const metrics = node("div", { className: "ws-metric-grid" }, [
    metricCard("جلسات", faNumber(meetings.length), `${faNumber(meetings.filter((item) => item.status === "scheduled").length)} جلسه پیش‌رو`, "◉"),
    metricCard("مصوبات باز", faNumber(resolutions.filter((item) => item.status === "open").length), `${faNumber(resolutions.length)} مصوبه ثبت‌شده`, "◇"),
    metricCard(
      "اقدام‌های باز",
      faNumber(decisionActions.filter((item) =>
        !["completed", "cancelled"].includes(item.status)).length),
      `${faNumber(decisionActionResult.summary?.blocked || 0)} اقدام مسدود`,
      "◷",
    ),
    metricCard("وکالت فعال", faNumber(proxies.filter((item) => item.status === "active").length), "نمایندگی رأی مستند", "↔"),
    metricCard("جلسات مستند", faPercent(meetings.length ? meetings.filter((item) => item.minutes).length / meetings.length * 100 : 0), "دارای صورت‌جلسه", "✓"),
  ]);
  const meetingGrid = node("div", { className: "ws-card-grid" });
  if (!meetings.length) {
    meetingGrid.append(emptyState(
      "جلسه‌ای برنامه‌ریزی نشده است",
      "جلسه‌های مدیریتی و هیئت‌مدیره را ثبت کنید تا تصمیم‌ها قابل ممیزی باشند.",
      { action: manageable ? button("جلسهٔ جدید", { variant: "primary", onClick: () => openMeetingDialog() }) : null },
    ));
  } else {
    for (const meeting of meetings) {
      meetingGrid.append(node("article", { className: "ws-entity-card" }, [
        node("div", { className: "ws-entity-card__top" }, [
          node("h3", { text: meeting.title }),
          statusChip(meeting.status),
        ]),
        node("p", { text: meeting.minutes || `${faDate(meeting.scheduledAt, true)} · ${meeting.location || "مکان ثبت نشده"}` }),
        node("div", { className: "ws-entity-card__foot" }, [
          node("span", { text: `${faNumber(meeting.resolutions?.length || 0)} مصوبه · ${faNumber(meeting.attendees?.length || 0)} عضو` }),
          node("div", {}, [
            manageable ? button("مصوبه", { variant: "ghost", onClick: () => openResolutionDialog(meeting) }) : null,
            manageable ? button("حضور", { variant: "ghost", onClick: () => openAttendanceDialog(meeting, stakeholders) }) : null,
            manageable ? button("ویرایش", { variant: "ghost", onClick: () => openMeetingDialog(meeting) }) : null,
            button("حدنصاب", {
              variant: "ghost",
              onClick: async () => {
                try {
                  const result = await api(projectPath(`meetings/${encodeURIComponent(meeting.id)}/quorum`));
                  toast(result.quorumMet
                    ? `حدنصاب برقرار است: ${faPercent(result.participationPercent || result.quorumPercent)}`
                    : `حدنصاب برقرار نیست: ${faPercent(result.participationPercent || result.quorumPercent)}`);
                } catch (error) {
                  toast(errorMessage(error), "error");
                }
              },
            }),
          ]),
        ]),
      ]));
    }
  }
  const resolutionTable = dataTable([
    { label: "مصوبه", title: true, render: (item) => titleCell(item.title, item.meeting.title) },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    {
      label: "دامنه و اتصال",
      render: (item) => {
        if (!item.operationScope) {
          return titleCell(
            "مصوبه عمومی",
            "به عملیات سرمایه متصل نمی‌شود",
          );
        }
        const transfer = transfers.find((candidate) =>
          candidate.resolutionId === item.id);
        const corporateAction = corporateActions.find((candidate) =>
          candidate.resolutionId === item.id);
        const linkedOperation = transfer || corporateAction;
        const bindingStatus = linkedOperation
          ? (
              (transfer?.status === "approved"
                || corporateAction?.status === "completed")
                ? "مصوبه مصرف‌شده"
                : "متصل و رزرو برای یک عملیات"
            )
          : item.status === "draft"
            ? "دامنه قابل ویرایش"
            : item.status === "open"
              ? "دامنه قفل‌شده در رأی‌گیری"
              : resolutionIsApproved(item)
                ? "تصویب‌شده و آماده اتصال"
                : "بسته و غیرقابل استفاده";
        return titleCell(
          bindingStatus,
          describeOperationScope(
            item.operationScope,
            stakeholders,
            classes,
          ),
        );
      },
    },
    { label: "موافق", render: (item) => faNumber(item.tally?.yes?.votingPower ?? item.tally?.yes ?? 0) },
    { label: "مخالف", render: (item) => faNumber(item.tally?.no?.votingPower ?? item.tally?.no ?? 0) },
    { label: "ممتنع", render: (item) => faNumber(item.tally?.abstain?.votingPower ?? item.tally?.abstain ?? 0) },
    { label: "تصمیم", render: (item) => item.decision || "—" },
    {
      label: "عملیات",
      render: (item) => {
        if (!manageable) return "فقط مشاهده";
        if (item.status === "draft") {
          return button("بازکردن رأی‌گیری", { variant: "primary", onClick: () => openResolutionVoting(item) });
        }
        if (item.status === "open") {
          const actorChoices = eligibleVoteActors(
            item,
            stakeholders,
            proxies,
          );
          return node("div", {}, [
            button("ثبت رأی", {
              variant: "ghost",
              disabled: !actorChoices.length,
              title: actorChoices.length
                ? "ثبت رأی با هویت متصل یا وکالت معتبر"
                : "حساب شما ذی‌نفع متصل یا وکالت معتبر ندارد",
              onClick: () => openVoteDialog(item, actorChoices),
            }),
            button("نهایی‌سازی", { variant: "primary", onClick: () => openFinalizeResolutionDialog(item) }),
          ]);
        }
        return "نهایی‌شده";
      },
    },
  ], resolutions, {
    emptyTitle: "مصوبه‌ای ثبت نشده است",
    emptyDescription: "مصوبات را زیر جلسه مربوط ثبت و گردش رأی را مستند کنید.",
  });
  const proxyTable = dataTable([
    {
      label: "اعطاکننده / نماینده",
      title: true,
      render: (item) => titleCell(
        stakeholders.find((stakeholder) => stakeholder.id === item.grantorStakeholderId)?.name || item.grantorStakeholderId,
        stakeholders.find((stakeholder) => stakeholder.id === item.proxyStakeholderId)?.name || item.proxyStakeholderId,
      ),
    },
    { label: "دامنه", render: (item) => item.scope === "resolution" ? "مصوبه" : "جلسه" },
    { label: "قدرت رأی", render: (item) => faNumber(item.votingPower) },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    {
      label: "عملیات",
      render: (item) => {
        const grantor = stakeholders.find((stakeholder) =>
          stakeholder.id === item.grantorStakeholderId);
        return manageable
          && item.status === "active"
          && grantor?.userId === state.user?.id
          ? button("لغو وکالت", {
              variant: "danger",
              onClick: () => revokeGovernanceProxy(item),
            })
          : "—";
      },
    },
  ], proxies, {
    emptyTitle: "وکالت رأی فعالی ثبت نشده است",
    emptyDescription: "در صورت نیاز، نمایندگی تمام قدرت رأی را با دامنهٔ جلسه یا مصوبه ثبت کنید.",
  });
  const decisionActionTable = dataTable([
    {
      label: "اقدام",
      title: true,
      render: (item) => {
        const resolution = resolutions.find((candidate) =>
          candidate.id === item.resolutionId);
        const meeting = meetings.find((candidate) =>
          candidate.id === item.meetingId);
        return titleCell(
          item.title,
          resolution
            ? `مصوبه: ${resolution.title}`
            : meeting ? `جلسه: ${meeting.title}` : "اقدام مستقل",
        );
      },
    },
    {
      label: "مسئول",
      render: (item) => item.assignee?.fullName
        || item.assignee?.email
        || "تعیین نشده",
    },
    { label: "مهلت", render: (item) => faDate(item.dueDate) },
    {
      label: "اولویت",
      render: (item) => labels.taskPriority[item.priority] || item.priority,
    },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    {
      label: "عملیات",
      render: (item) => node("div", {}, [
        button("تاریخچه", {
          variant: "ghost",
          onClick: () => openDecisionActionHistory(item),
        }),
        manageable ? button("ویرایش", {
          variant: "ghost",
          onClick: () => openDecisionActionDialog({
            action: item,
            meetings,
            resolutions,
            members,
          }),
        }) : null,
        manageable ? button(
          ["completed", "cancelled"].includes(item.status)
            ? "بازگشایی"
            : "تغییر وضعیت",
          {
            variant: item.status === "blocked" ? "danger" : "ghost",
            onClick: () => openDecisionActionTransitionDialog(item),
          },
        ) : null,
      ]),
    },
  ], decisionActions, {
    emptyTitle: "اقدامی برای پیگیری مصوبات ثبت نشده است",
    emptyDescription: "هر تصمیم را به مسئول، مهلت و گردش وضعیت قابل ممیزی تبدیل کنید.",
    emptyAction: manageable ? button("اقدام پیگیری جدید", {
      variant: "primary",
      onClick: () => openDecisionActionDialog({
        meetings,
        resolutions,
        members,
      }),
    }) : null,
  });
  dom.pageBody.replaceChildren(
    metrics,
    meetingGrid,
    node("br", { attributes: { "aria-hidden": "true" } }),
    panel("مصوبات و رأی‌گیری", "قدرت رأی از دفتر مالکیت و نقش هیئت‌مدیره محاسبه می‌شود", resolutionTable),
    node("br", { attributes: { "aria-hidden": "true" } }),
    panel(
      "پیگیری مصوبات",
      "از تصمیم جلسه تا اجرا، مانع، تکمیل یا بازگشایی",
      decisionActionTable,
      manageable ? button("اقدام جدید", {
        variant: "ghost",
        onClick: () => openDecisionActionDialog({
          meetings,
          resolutions,
          members,
        }),
      }) : null,
    ),
    node("br", { attributes: { "aria-hidden": "true" } }),
    panel("وکالت‌های رأی", "نمایندگی فعال در محاسبه حدنصاب لحاظ می‌شود", proxyTable),
  );
}

function openKycDialog(stakeholders) {
  const subjectOptions = [
    ...stakeholders.filter((item) => !item.archivedAt).map((item) => ({
      value: `stakeholder:${item.id}`,
      label: `ذی‌نفع پروژه — ${item.name}`,
    })),
    ...(state.user?.id ? [{
      value: `user:${state.user.id}`,
      label: `کاربر سامانه — ${state.user.fullName || state.user.email}`,
    }] : []),
    ...(state.organizationId ? [{
      value: `organization:${state.organizationId}`,
      label: `سازمان — ${currentOrganization()?.name || "سازمان جاری"}`,
    }] : []),
  ];
  openEntityDialog({
    kicker: "شناخت ذی‌نفع",
    title: "پرونده احراز هویت جدید",
    submitLabel: "ساخت پرونده",
    initial: { subjectRef: subjectOptions[0]?.value || "", level: "basic", provider: "manual" },
    fields: [
      {
        name: "subjectRef",
        label: "موضوع احراز هویت",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب موضوع" }, ...subjectOptions],
      },
      {
        name: "level",
        label: "سطح بررسی",
        type: "select",
        options: [
          { value: "basic", label: "پایه" },
          { value: "enhanced", label: "تکمیلی" },
        ],
      },
      { name: "provider", label: "ارائه‌دهنده", type: "select", options: [{ value: "manual", label: "بررسی دستی مستند" }] },
    ],
    note: "این سامانه نتیجهٔ ارائه‌دهنده را جعل نمی‌کند. تا اتصال provider رسمی، تنها بررسی دستی با سند معتبر است.",
    onSubmit: async (values) => {
      const separator = values.subjectRef.indexOf(":");
      const subjectType = separator > 0 ? values.subjectRef.slice(0, separator) : "";
      const subjectId = separator > 0 ? values.subjectRef.slice(separator + 1) : "";
      if (!["stakeholder", "user", "organization"].includes(subjectType) || !subjectId) {
        throw new Error("موضوع احراز هویت معتبر نیست.");
      }
      await api(projectPath("kyc-cases"), {
        method: "POST",
        body: {
          subjectType,
          subjectId,
          level: values.level,
          provider: values.provider,
        },
      });
      toast("پرونده KYC ساخته شد؛ هنوز تأیید نشده است.");
      await navigate("compliance", { replace: true });
    },
  });
}

function openKycCheckDialog(kycCase, documents) {
  openEntityDialog({
    kicker: "بازبینی دستی",
    title: "ثبت نتیجه بررسی",
    submitLabel: "ثبت بررسی",
    initial: { status: "passed" },
    fields: [
      { name: "checkType", label: "نوع بررسی", required: true, maxLength: 100, placeholder: "هویت، نشانی، ذی‌نفع واقعی…" },
      {
        name: "status",
        label: "نتیجه",
        type: "select",
        options: [
          { value: "passed", label: "قبول" },
          { value: "failed", label: "رد" },
          { value: "needs_review", label: "نیازمند بازبینی" },
          { value: "pending", label: "در انتظار" },
        ],
      },
      {
        name: "evidenceDocumentId",
        label: "مدرک شاهد",
        type: "select",
        options: [{ value: "", label: "بدون مدرک" }, ...documents.map((item) => ({ value: item.id, label: item.title }))],
      },
      { name: "note", label: "یادداشت نتیجه", type: "textarea", rows: 3 },
    ],
    onSubmit: async (values) => {
      await api(projectPath(`kyc-cases/${encodeURIComponent(kycCase.id)}/checks`), {
        method: "POST",
        body: { ...values, provider: "manual", result: { note: values.note } },
      });
      toast("نتیجه بررسی KYC ثبت شد.");
      await navigate("compliance", { replace: true });
    },
  });
}

function openKycReviewDialog(kycCase) {
  openEntityDialog({
    kicker: "تصمیم مسئول انطباق",
    title: "نهایی‌سازی پرونده KYC",
    submitLabel: "ثبت تصمیم نهایی",
    initial: { status: "verified", riskRating: "low" },
    fields: [
      {
        name: "status",
        label: "تصمیم",
        type: "select",
        options: [
          { value: "verified", label: "تأیید دستی" },
          { value: "rejected", label: "رد" },
        ],
      },
      {
        name: "riskRating",
        label: "سطح ریسک",
        type: "select",
        options: [
          { value: "low", label: "کم" },
          { value: "medium", label: "متوسط" },
          { value: "high", label: "زیاد" },
          { value: "unknown", label: "نامشخص" },
        ],
      },
      { name: "decisionReason", label: "دلیل تصمیم", type: "textarea", rows: 3, required: true },
      { name: "expiresAt", label: "انقضای اعتبار", type: "date" },
    ],
    note: "تأیید فقط وقتی ممکن است که همه بررسی‌های پرونده موفق باشند.",
    onSubmit: async (values) => {
      await api(projectPath(`kyc-cases/${encodeURIComponent(kycCase.id)}/review`), {
        method: "POST",
        body: values,
      });
      toast("تصمیم KYC ثبت شد.");
      await navigate("compliance", { replace: true });
    },
  });
}

function openContractDialog(documents) {
  openEntityDialog({
    kicker: "چرخه قرارداد",
    title: "قرارداد جدید",
    submitLabel: "ساخت پیش‌نویس",
    initial: { contractType: "other", currency: currentProject()?.currency || "IRR" },
    fields: [
      { name: "title", label: "عنوان قرارداد", required: true, maxLength: 300 },
      { name: "contractType", label: "نوع قرارداد", required: true, maxLength: 100 },
      {
        name: "documentId",
        label: "سند قرارداد",
        type: "select",
        options: [{ value: "", label: "بعداً متصل می‌کنم" }, ...documents.map((item) => ({ value: item.id, label: item.title }))],
      },
      { name: "effectiveOn", label: "شروع اعتبار", type: "date" },
      { name: "expiresOn", label: "پایان اعتبار", type: "date" },
      { name: "valueAmount", label: "ارزش قرارداد", type: "number", min: 0, step: 1 },
      { name: "currency", label: "واحد پول", dir: "ltr", disabled: true },
    ],
    onSubmit: async (values) => {
      await api(projectPath("contracts"), {
        method: "POST",
        body: { ...values, currency: values.currency || currentProject()?.currency },
      });
      toast("پیش‌نویس قرارداد ساخته شد.");
      await navigate("compliance", { replace: true });
    },
  });
}

function openContractPartyDialog(contract, stakeholders) {
  openEntityDialog({
    kicker: "طرف‌های قرارداد",
    title: contract.title,
    submitLabel: "افزودن طرف",
    initial: {
      partyType: stakeholders.length ? "stakeholder" : "external",
      role: "party",
      signingOrder: contract.parties?.length || 0,
    },
    fields: [
      {
        name: "partyType",
        label: "نوع طرف",
        type: "select",
        options: [
          { value: "stakeholder", label: "ذی‌نفع پروژه" },
          { value: "external", label: "طرف بیرونی" },
          { value: "organization", label: "سازمان جاری" },
          { value: "user", label: "کاربر جاری" },
        ],
      },
      {
        name: "partyId",
        label: "ذی‌نفع (برای نوع ذی‌نفع)",
        type: "select",
        options: [{ value: "", label: "انتخاب ذی‌نفع" }, ...stakeholders.filter((item) => !item.archivedAt).map((item) => ({
          value: item.id,
          label: item.name,
        }))],
      },
      { name: "displayName", label: "نام نمایشی طرف", required: true, maxLength: 300 },
      { name: "email", label: "ایمیل", type: "email", dir: "ltr", maxLength: 320 },
      { name: "role", label: "نقش در قرارداد", maxLength: 100 },
      { name: "signingOrder", label: "ترتیب امضا", type: "number", min: 0, step: 1 },
    ],
    note: "پس از ارسال قرارداد برای امضا، فهرست طرف‌ها قفل می‌شود.",
    onSubmit: async (values) => {
      if (values.partyType === "stakeholder" && !values.partyId) {
        throw new ApiError(400, { error: { message: "ذی‌نفع قرارداد را انتخاب کنید.", fields: { partyId: "انتخاب ذی‌نفع الزامی است." } } });
      }
      if (values.partyType === "organization") values.partyId = state.organizationId;
      if (values.partyType === "user") values.partyId = state.user?.id || "";
      if (values.partyType === "external") values.partyId = null;
      await api(projectPath(`contracts/${encodeURIComponent(contract.id)}/parties`), {
        method: "POST",
        body: values,
      });
      toast("طرف قرارداد افزوده شد.");
      await navigate("compliance", { replace: true });
    },
  });
}

async function requestContractSignatures(contract) {
  if (!confirm(`درخواست امضای دستی برای ${faNumber(contract.parties?.length || 0)} طرف قرارداد ساخته شود؟`)) return;
  try {
    await api(projectPath(`contracts/${encodeURIComponent(contract.id)}/request-signatures`), {
      method: "POST",
      body: { provider: "manual" },
    });
    toast("درخواست‌های امضای دستی ساخته شد.");
    await navigate("compliance", { replace: true });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function openManualSignatureDialog(contract, signature, documents) {
  const party = (contract.parties || []).find((item) => item.id === signature.partyId);
  openEntityDialog({
    kicker: "ثبت شاهد امضای دستی",
    title: party?.displayName || "طرف قرارداد",
    submitLabel: "ثبت امضای مستند",
    initial: { signedDocumentId: contract.documentId || "" },
    fields: [
      {
        name: "signatureHash",
        label: "SHA-256 شاهد امضا",
        required: true,
        dir: "ltr",
        minLength: 64,
        maxLength: 64,
        pattern: "[0-9a-fA-F]{64}",
        inputMode: "text",
        placeholder: "64 نویسه hexadecimal",
      },
      {
        name: "signedDocumentId",
        label: "سند امضاشده",
        type: "select",
        options: [{ value: "", label: "سند اصلی قرارداد" }, ...documents.map((item) => ({
          value: item.id,
          label: item.title,
        }))],
      },
    ],
    note: "ثبت دستی، تأیید provider نیست؛ هش باید از فایل واقعی امضاشده محاسبه و در زنجیره ممیزی نگهداری شود.",
    onSubmit: async (values) => {
      await api(projectPath(
        `contracts/${encodeURIComponent(contract.id)}/signatures/${encodeURIComponent(signature.partyId)}/manual`,
      ), {
        method: "POST",
        body: { ...values, provider: "manual" },
      });
      toast("امضای دستی ثبت شد.");
      await navigate("compliance", { replace: true });
    },
  });
}

async function renderCompliance(sequence) {
  const [kycResult, contractResult, stakeholderResult, documentResult] = await Promise.all([
    api(projectPath("kyc-cases")),
    api(projectPath("contracts")),
    api(projectPath("stakeholders")),
    api(projectPath("documents")),
  ]);
  if (!ensureSequence(sequence)) return;
  const cases = kycResult.kycCases || [];
  const contracts = contractResult.contracts || [];
  const stakeholders = stakeholderResult.stakeholders || [];
  const documents = documentResult.documents || [];
  const complianceManage = hasPermission("compliance.manage");
  const contractManage = hasPermission("contracts.manage");
  setPageActions([
    complianceManage ? button("پرونده KYC", { onClick: () => openKycDialog(stakeholders) }) : null,
    contractManage ? button("قرارداد جدید", { variant: "primary", onClick: () => openContractDialog(documents) }) : null,
  ]);
  const metrics = node("div", { className: "ws-metric-grid" }, [
    metricCard("پرونده KYC", faNumber(cases.length), `${faNumber(cases.filter((item) => item.status === "verified").length)} تأیید معتبر`, "⌾"),
    metricCard("نیازمند بازبینی", faNumber(cases.filter((item) => ["pending", "in_review", "needs_review"].includes(item.status)).length), "پرونده باز", "!"),
    metricCard("قراردادها", faNumber(contracts.length), `${faNumber(contracts.filter((item) => item.status === "signed" || item.status === "active").length)} فعال / امضاشده`, "□"),
    metricCard("امضاهای در انتظار", faNumber(contracts.reduce((sum, item) => sum + (item.signatures || []).filter((signature) => signature.status !== "signed").length, 0)), "امضای مستند", "◇"),
  ]);
  const caseTable = dataTable([
    { label: "پرونده", title: true, render: (item) => titleCell(item.subjectId, item.subjectType) },
    { label: "سطح", render: (item) => item.level === "enhanced" ? "تکمیلی" : "پایه" },
    { label: "بررسی‌ها", render: (item) => faNumber(item.checks?.length || 0) },
    { label: "ریسک", render: (item) => labels.riskBand[item.riskRating] || item.riskRating || "نامشخص" },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    {
      label: "عملیات",
      render: (item) => complianceManage && !["verified", "rejected", "expired"].includes(item.status)
        ? node("div", {}, [
            button("بررسی", { variant: "ghost", onClick: () => openKycCheckDialog(item, documents) }),
            button("تصمیم", { variant: "primary", onClick: () => openKycReviewDialog(item) }),
          ])
        : "—",
    },
  ], cases, {
    emptyTitle: "پرونده KYC ثبت نشده است",
    emptyDescription: "برای نقل‌وانتقال‌های حساس و توزیع سود، ذی‌نفعان را بررسی کنید.",
    emptyAction: complianceManage ? button("پرونده جدید", { variant: "primary", onClick: () => openKycDialog(stakeholders) }) : null,
  });
  const contractTable = dataTable([
    { label: "قرارداد", title: true, render: (item) => titleCell(item.title, item.contractType) },
    { label: "ارزش", render: (item) => item.valueAmount == null ? "—" : faMoney(item.valueAmount, item.currency) },
    { label: "طرف‌ها", render: (item) => faNumber(item.parties?.length || 0) },
    { label: "امضا", render: (item) => `${faNumber((item.signatures || []).filter((signature) => signature.status === "signed").length)} / ${faNumber(item.parties?.length || 0)}` },
    { label: "انقضا", render: (item) => faDate(item.expiresOn) },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    {
      label: "عملیات",
      render: (item) => {
        if (!contractManage) return "فقط مشاهده";
        const pendingSignatures = (item.signatures || []).filter((signature) => signature.status === "pending");
        return node("div", {}, [
          ["draft", "review"].includes(item.status)
            ? button("افزودن طرف", { variant: "ghost", onClick: () => openContractPartyDialog(item, stakeholders) })
            : null,
          ["draft", "review"].includes(item.status)
            ? button("ارسال برای امضا", {
                variant: "primary",
                disabled: !item.documentId || !(item.parties || []).length,
                title: !item.documentId ? "ابتدا سند قرارداد را متصل کنید" : !(item.parties || []).length ? "ابتدا طرف قرارداد را اضافه کنید" : "",
                onClick: () => requestContractSignatures(item),
              })
            : null,
          ...pendingSignatures.map((signature) => {
            const party = (item.parties || []).find((candidate) => candidate.id === signature.partyId);
            return button(`امضای ${party?.displayName || "طرف"}`, {
              variant: "ghost",
              onClick: () => openManualSignatureDialog(item, signature, documents),
            });
          }),
        ]);
      },
    },
  ], contracts, {
    emptyTitle: "قراردادی وجود ندارد",
    emptyDescription: "قرارداد را به نسخه مشخص یک سند متصل و امضاها را مرحله‌به‌مرحله ثبت کنید.",
    emptyAction: contractManage ? button("قرارداد جدید", { variant: "primary", onClick: () => openContractDialog(documents) }) : null,
  });
  dom.pageBody.replaceChildren(
    metrics,
    panel("احراز هویت و انطباق", "تأیید provider فقط از adapter رسمی پذیرفته می‌شود", caseTable),
    node("br", { attributes: { "aria-hidden": "true" } }),
    panel("قراردادها و امضا", "نسخه سند، طرف‌ها و امضاها قابل ممیزی هستند", contractTable),
  );
}

function openDocumentDialog(documentItem = null) {
  openEntityDialog({
    kicker: "مخزن اسناد",
    title: documentItem ? documentItem.title : "سند جدید",
    submitLabel: documentItem ? "ذخیره مشخصات" : "ساخت سند",
    initial: documentItem || { category: "project", visibility: "project", status: "draft" },
    fields: [
      { name: "title", label: "عنوان سند", required: true, maxLength: 240 },
      { name: "folder", label: "پوشه", maxLength: 240, placeholder: "مثلاً قراردادها/۱۴۰۵" },
      {
        name: "category",
        label: "دسته",
        type: "select",
        options: [
          ["project", "پروژه"],
          ["financial", "مالی"],
          ["legal", "حقوقی"],
          ["contract", "قرارداد"],
          ["identity", "هویتی"],
          ["meeting", "جلسه"],
          ["evidence", "شاهد پیشرفت"],
          ["report", "گزارش"],
          ["other", "سایر"],
        ].map(([value, label]) => ({ value, label })),
      },
      {
        name: "visibility",
        label: "دامنه دسترسی",
        type: "select",
        options: [
          { value: "private", label: "خصوصی" },
          { value: "organization", label: "سازمان" },
          { value: "project", label: "اعضای پروژه" },
          { value: "public", label: "عمومی" },
        ],
      },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: ["draft", "active", "archived"].map((value) => ({ value, label: translatedStatus(value) })),
      },
    ],
    onSubmit: async (values) => {
      const result = await api(projectPath(`documents${documentItem ? `/${encodeURIComponent(documentItem.id)}` : ""}`), {
        method: documentItem ? "PATCH" : "POST",
        body: values,
      });
      toast(documentItem ? "مشخصات سند به‌روزرسانی شد." : "سند ساخته شد؛ اکنون یک نسخه بارگذاری کنید.");
      if (!documentItem && result.document) uploadDocumentVersion(result.document);
      await navigate("documents", { replace: true });
    },
  });
}

function uploadDocumentVersion(documentItem) {
  const input = node("input", {
    type: "file",
    accept: ".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.json,.docx,.xlsx",
  });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const note = prompt("توضیح کوتاه تغییر این نسخه (اختیاری):", "") || "";
    try {
      await api(projectPath(`documents/${encodeURIComponent(documentItem.id)}/versions`), {
        method: "POST",
        raw: true,
        body: file,
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeHeaderValue(file.name, 240),
          "X-Change-Note": encodeHeaderValue(note, 1000),
        },
      });
      toast(`نسخهٔ «${file.name}» با موفقیت بارگذاری شد.`);
      if (state.activeView === "documents") navigate("documents", { replace: true });
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }, { once: true });
  input.click();
}

async function downloadDocumentVersion(documentItem, version) {
  try {
    const response = await api(
      projectPath(`documents/${encodeURIComponent(documentItem.id)}/versions/${encodeURIComponent(version.id)}`),
      { response: "blob" },
    );
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = node("a", { href: url, download: version.filename || documentItem.title });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function renderDocuments(sequence) {
  const result = await api(projectPath("documents"));
  if (!ensureSequence(sequence)) return;
  const documents = result.documents || [];
  const manageable = hasPermission("project_work.write");
  setPageActions([
    manageable ? button("سند جدید", { variant: "primary", onClick: () => openDocumentDialog() }) : null,
  ]);
  const grid = node("div", { className: "ws-card-grid" });
  if (!documents.length) {
    grid.append(emptyState(
      "مخزن اسناد خالی است",
      "اسناد مالی، حقوقی، جلسات و شواهد پیشرفت را نسخه‌بندی کنید.",
      { action: manageable ? button("سند جدید", { variant: "primary", onClick: () => openDocumentDialog() }) : null },
    ));
  } else {
    for (const documentItem of documents) {
      const latest = documentItem.versions?.[0] || null;
      grid.append(node("article", { className: "ws-entity-card" }, [
        node("div", { className: "ws-entity-card__top" }, [
          node("div", {}, [
            node("h3", { text: documentItem.title }),
            node("small", { text: documentItem.folder || "پوشه اصلی" }),
          ]),
          statusChip(documentItem.status),
        ]),
        node("p", {
          text: latest
            ? `${latest.filename} · ${faNumber(latest.sizeBytes / 1024, 1)} کیلوبایت · SHA-256 ثبت‌شده`
            : "هنوز هیچ فایل و نسخه‌ای برای این سند بارگذاری نشده است.",
        }),
        node("div", { className: "ws-entity-card__foot" }, [
          node("span", { text: `${documentItem.category} · نسخه ${faNumber(documentItem.currentVersionNo)}` }),
          node("div", {}, [
            latest ? button("دریافت", { variant: "ghost", onClick: () => downloadDocumentVersion(documentItem, latest) }) : null,
            manageable ? button("نسخه جدید", { variant: "ghost", onClick: () => uploadDocumentVersion(documentItem) }) : null,
            manageable ? button("ویرایش", { variant: "ghost", onClick: () => openDocumentDialog(documentItem) }) : null,
          ]),
        ]),
      ]));
    }
  }
  const totalBytes = documents.reduce((sum, item) =>
    sum + (item.versions || []).reduce((versionSum, version) => versionSum + Number(version.sizeBytes || 0), 0), 0);
  dom.pageBody.replaceChildren(
    node("div", { className: "ws-metric-grid" }, [
      metricCard("اسناد", faNumber(documents.length), "رکوردهای نسخه‌پذیر", "□"),
      metricCard("نسخه‌ها", faNumber(documents.reduce((sum, item) => sum + (item.versions?.length || 0), 0)), "هر نسخه با SHA-256", "≡"),
      metricCard("حجم مخزن", `${faNumber(totalBytes / 1024 / 1024, 2)} مگابایت`, "ذخیره پایدار تک‌سرور", "◫"),
      metricCard("اسناد فعال", faNumber(documents.filter((item) => item.status === "active").length), "قابل استفاده در گردش‌کار", "✓"),
    ]),
    grid,
  );
}

function openListingDialog(listing = null) {
  openEntityDialog({
    kicker: "بازار فرصت‌ها",
    title: listing ? listing.title : "فرصت جدید",
    submitLabel: listing ? "ذخیره فرصت" : "ساخت فرصت",
    initial: listing || {
      type: "collaboration",
      status: "draft",
      currency: currentProject()?.currency || "IRR",
      tags: "",
    },
    fields: [
      {
        name: "type",
        label: "نوع فرصت",
        type: "select",
        options: [
          ["collaboration", "همکاری"],
          ["investment", "سرمایه‌گذاری"],
          ["share_offer", "عرضه سهام"],
          ["supplier", "تأمین‌کننده"],
          ["expert", "متخصص"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "title", label: "عنوان", required: true, maxLength: 240 },
      { name: "summary", label: "شرح فرصت", type: "textarea", rows: 4, required: true, maxLength: 3000 },
      { name: "tags", label: "برچسب‌ها", placeholder: "سرمایه، فناوری، صادرات", help: "با ویرگول جدا کنید" },
      { name: "minimumAmount", label: "حداقل مبلغ", type: "number", min: 0, step: 1 },
      { name: "maximumAmount", label: "حداکثر مبلغ", type: "number", min: 0, step: 1 },
      { name: "currency", label: "واحد پول", dir: "ltr", maxLength: 8 },
      { name: "location", label: "موقعیت", maxLength: 240 },
      { name: "closesAt", label: "مهلت", type: "datetime-local" },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: [
          { value: "draft", label: "پیش‌نویس" },
          { value: "published", label: "منتشرشده" },
          { value: "paused", label: "متوقف‌شده" },
          { value: "closed", label: "بسته" },
          { value: "archived", label: "بایگانی‌شده" },
        ],
      },
    ],
    note: "انتشار فرصت فقط وقتی ممکن است که خود پروژه عمومی و منتشرشده باشد.",
    onSubmit: async (values) => {
      values.tags = String(values.tags || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (values.closesAt) values.closesAt = new Date(values.closesAt).toISOString();
      await api(projectPath(`marketplace-listings${listing ? `/${encodeURIComponent(listing.id)}` : ""}`), {
        method: listing ? "PATCH" : "POST",
        body: values,
      });
      toast(listing ? "فرصت به‌روزرسانی شد." : "فرصت ساخته شد.");
      await navigate("marketplace", { replace: true });
    },
  });
}

async function renderMarketplace(sequence) {
  const [ownResult, publicResult, savedResult] = await Promise.all([
    api(projectPath("marketplace-listings")),
    api("/api/v2/marketplace/listings?limit=50", { csrf: false }),
    optionalApi("/api/v2/admin/me/saved-listings"),
  ]);
  if (!ensureSequence(sequence)) return;
  const own = ownResult.listings || ownResult.marketplaceListings || [];
  const publicItems = publicResult.listings || [];
  const savedIds = new Set((savedResult?.listings || savedResult?.savedListings || []).map((item) => item.id || item.listingId));
  const manageable = hasPermission("project.manage");
  setPageActions([
    manageable ? button("فرصت جدید", { variant: "primary", onClick: () => openListingDialog() }) : null,
  ]);
  const host = node("div");
  let selected = "own";
  const tabsHost = node("div", { className: "ws-tabs", attributes: { role: "tablist" } });
  const renderSelected = () => {
    const items = selected === "own" ? own : publicItems;
    const grid = node("div", { className: "ws-card-grid" });
    if (!items.length) {
      grid.append(emptyState(
        selected === "own" ? "فرصتی برای این پروژه ثبت نشده است" : "فرصت عمومی فعالی وجود ندارد",
        selected === "own" ? "فرصت سرمایه‌گذاری، فروش سهام یا همکاری را منتشر کنید." : "فیلترها یا زمان مراجعه را تغییر دهید.",
        { action: selected === "own" && manageable ? button("فرصت جدید", { variant: "primary", onClick: () => openListingDialog() }) : null },
      ));
    } else {
      for (const item of items) {
        grid.append(node("article", { className: "ws-entity-card" }, [
          node("div", { className: "ws-entity-card__top" }, [
            node("h3", { text: item.title }),
            statusChip(item.status),
          ]),
          node("p", { text: item.summary }),
          node("div", { className: "ws-entity-card__foot" }, [
            node("span", {
              text: item.minimumAmount == null
                ? item.location || item.type
                : `${faMoney(item.minimumAmount, item.currency)} تا ${item.maximumAmount == null ? "نامحدود" : faMoney(item.maximumAmount, item.currency)}`,
            }),
            selected === "own" && manageable
              ? button("ویرایش", { variant: "ghost", onClick: () => openListingDialog(item) })
              : button(savedIds.has(item.id) ? "ذخیره‌شده" : "ذخیره", {
                  variant: savedIds.has(item.id) ? "primary" : "ghost",
                  onClick: async () => {
                    try {
                      const saved = !savedIds.has(item.id);
                      await api(`/api/v2/admin/me/saved-listings/${encodeURIComponent(item.id)}`, {
                        method: "PUT",
                        body: { saved },
                      });
                      if (saved) savedIds.add(item.id);
                      else savedIds.delete(item.id);
                      toast(saved ? "فرصت ذخیره شد." : "از ذخیره‌ها حذف شد.");
                      renderSelected();
                    } catch (error) {
                      toast(errorMessage(error), "error");
                    }
                  },
                }),
          ]),
        ]));
      }
    }
    host.replaceChildren(grid);
  };
  for (const item of [
    { value: "own", label: `فرصت‌های پروژه (${faNumber(own.length)})` },
    { value: "public", label: `بازار عمومی (${faNumber(publicItems.length)})` },
  ]) {
    const control = node("button", {
      type: "button",
      text: item.label,
      className: item.value === selected ? "is-active" : "",
      attributes: { role: "tab", "aria-selected": item.value === selected ? "true" : "false" },
      onclick: () => {
        selected = item.value;
        for (const candidate of $$("button", tabsHost)) {
          const chosen = candidate === control;
          candidate.classList.toggle("is-active", chosen);
          candidate.setAttribute("aria-selected", chosen ? "true" : "false");
        }
        renderSelected();
      },
    });
    tabsHost.append(control);
  }
  renderSelected();
  dom.pageBody.replaceChildren(
    node("div", { className: "ws-metric-grid" }, [
      metricCard("فرصت‌های پروژه", faNumber(own.length), `${faNumber(own.filter((item) => item.status === "published").length)} منتشرشده`, "◈"),
      metricCard("بازار عمومی", faNumber(publicItems.length), "فرصت فعال در پلتفرم", "◇"),
      metricCard("ذخیره‌های من", faNumber(savedIds.size), "برای پیگیری بعدی", "□"),
      metricCard("مهلت‌دار", faNumber(own.filter((item) => item.closesAt).length), "فرصت با تاریخ پایان", "◷"),
    ]),
    tabsHost,
    host,
  );
}

async function downloadReport(reportKey, format) {
  try {
    const response = await api(projectPath(`reports/${encodeURIComponent(reportKey)}`), {
      method: "POST",
      body: { format },
      response: "blob",
    });
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || `${currentProject()?.slug || "report"}-${reportKey}.${format}`;
    const url = URL.createObjectURL(blob);
    const link = node("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("گزارش تولید و دریافت شد.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function renderReports(sequence) {
  if (!ensureSequence(sequence)) return;
  const reports = [
    { key: "financial-summary", title: "خلاصه مالی", description: "درآمد، هزینه، سرمایه‌گذاری، سود و بازده پروژه", icon: "∿" },
    { key: "trial-balance", title: "تراز آزمایشی", description: "گردش بدهکار و بستانکار همه حساب‌ها", icon: "≡" },
    { key: "tasks", title: "گزارش اجرا", description: "مراحل، وظایف، مهلت و پیشرفت واقعی", icon: "✓" },
    { key: "risks", title: "ریسک و مسئله", description: "ماتریس ریسک، مالک اقدام و وضعیت پاسخ", icon: "!" },
    { key: "kpis", title: "عملکرد و KPI", description: "مقدار فعلی، هدف و درصد تحقق شاخص‌ها", icon: "↗" },
    { key: "cap-table", title: "جدول سرمایه", description: "مالکیت، رده سهام و قدرت رأی", icon: "▦" },
    { key: "governance", title: "حاکمیت", description: "جلسات، مصوبات و نتایج رأی‌گیری", icon: "◉" },
  ];
  const grid = node("div", { className: "ws-card-grid" });
  for (const report of reports) {
    grid.append(node("article", { className: "ws-entity-card" }, [
      node("div", { className: "ws-entity-card__top" }, [
        node("h3", { text: report.title }),
        node("span", { className: "ws-metric__icon", text: report.icon, attributes: { "aria-hidden": "true" } }),
      ]),
      node("p", { text: report.description }),
      node("div", { className: "ws-entity-card__foot" }, [
        node("span", { text: "خروجی امن و قابل بایگانی" }),
        node("div", {}, [
          button("CSV", { variant: "ghost", onClick: () => downloadReport(report.key, "csv") }),
          button("HTML", { variant: "ghost", onClick: () => downloadReport(report.key, "html") }),
          button("JSON", { variant: "ghost", onClick: () => downloadReport(report.key, "json") }),
        ]),
      ]),
    ]));
  }
  dom.pageBody.replaceChildren(
    node("div", { className: "ws-alert", text: "خروجی HTML برای چاپ یا ذخیره PDF مرورگر آماده است؛ CSV و JSON برای تحلیل و اتصال سامانه‌ها ارائه می‌شوند." }),
    node("br", { attributes: { "aria-hidden": "true" } }),
    grid,
  );
}

function openInvitationDialog() {
  const currentProjectId = state.projectId || "";
  openEntityDialog({
    kicker: "دسترسی سازمانی",
    title: "دعوت عضو جدید",
    submitLabel: "ساخت دعوت",
    initial: {
      accessProfile: currentProjectId ? "project:contributor" : "organization:viewer",
      projectId: currentProjectId,
    },
    fields: [
      { name: "email", label: "ایمیل عضو", type: "email", required: true, dir: "ltr", maxLength: 254 },
      {
        name: "accessProfile",
        label: "دامنه و نقش",
        type: "select",
        options: [
          ["organization:admin", "سازمان · مدیر"],
          ["organization:project_manager", "سازمان · مدیر پروژه‌ها"],
          ["organization:finance", "سازمان · مدیر مالی"],
          ["organization:board", "سازمان · عضو هیئت‌مدیره"],
          ["organization:auditor", "سازمان · حسابرس"],
          ["organization:viewer", "سازمان · مشاهده‌گر"],
          ["project:project_manager", "یک پروژه · مدیر پروژه"],
          ["project:contributor", "یک پروژه · همکار اجرایی"],
          ["project:finance", "یک پروژه · مدیر مالی"],
          ["project:board", "یک پروژه · عضو هیئت‌مدیره"],
          ["project:auditor", "یک پروژه · حسابرس"],
          ["project:viewer", "یک پروژه · مشاهده‌گر"],
        ].map(([value, label]) => ({ value, label })),
      },
      {
        name: "projectId",
        label: "محدود به پروژه",
        type: "select",
        options: [
          { value: "", label: "دسترسی سازمانی مطابق نقش" },
          ...state.projects.map((item) => ({ value: item.id, label: item.title })),
        ],
      },
    ],
    note: "برای نقش‌های «یک پروژه»، انتخاب پروژه الزامی است. نقش سازمانی به همهٔ پروژه‌های مجاز آن نقش اعمال می‌شود.",
    onSubmit: async (values) => {
      const [scope, roleKey] = values.accessProfile.split(":");
      if (!["organization", "project"].includes(scope) || !roleKey) {
        throw new Error("دامنه و نقش دعوت معتبر نیست.");
      }
      if (scope === "project" && !values.projectId) {
        throw new Error("برای دسترسی پروژه‌ای، پروژه را انتخاب کنید.");
      }
      const result = await api(
        `/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}/invitations`,
        {
          method: "POST",
          body: {
            email: values.email,
            roleKey,
            projectId: scope === "project" ? values.projectId : "",
          },
        },
      );
      const invitationUrl = `${location.origin}/accept-invitation#token=${encodeURIComponent(result.token)}`;
      try {
        await navigator.clipboard.writeText(invitationUrl);
        toast("دعوت ساخته و لینک امن در کلیپ‌بورد کپی شد.");
      } catch {
        prompt("این لینک فقط اکنون نمایش داده می‌شود؛ آن را امن ارسال کنید:", invitationUrl);
      }
      await navigate("team", { replace: true });
    },
  });
}

function openMemberDialog(member) {
  const canManageOwnership = hasOrganizationPermission("ownership.manage");
  openEntityDialog({
    kicker: "عضویت سازمان",
    title: member.user?.fullName || member.user?.email || "ویرایش عضو",
    submitLabel: "ذخیره دسترسی",
    initial: member,
    fields: [
      {
        name: "roleKey",
        label: "نقش",
        type: "select",
        options: [
          ...(canManageOwnership ? [["owner", "مالک"]] : []),
          ["admin", "مدیر سازمان"],
          ["project_manager", "مدیر پروژه"],
          ["finance", "مدیر مالی"],
          ["board", "هیئت‌مدیره"],
          ["auditor", "حسابرس"],
          ["viewer", "مشاهده‌گر"],
        ].map(([value, label]) => ({ value, label })),
      },
      {
        name: "status",
        label: "وضعیت عضویت",
        type: "select",
        options: [
          { value: "active", label: "فعال" },
          { value: "suspended", label: "تعلیق" },
        ],
      },
    ],
    note: member.roleKey === "owner"
      ? "تغییر نقش مالک فقط توسط مالک و با حفظ حداقل یک مالک فعال ممکن است."
      : "",
    onSubmit: async (values) => {
      await api(
        `/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}/members/${encodeURIComponent(member.id)}`,
        { method: "PATCH", body: values },
      );
      toast("دسترسی عضو به‌روزرسانی شد.");
      await navigate("team", { replace: true });
    },
  });
}

async function renderTeam(sequence) {
  const base = `/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}`;
  const [memberResult, invitationResult] = await Promise.all([
    api(`${base}/members`),
    api(`${base}/invitations?includeClosed=true`),
  ]);
  if (!ensureSequence(sequence)) return;
  const members = memberResult.members || [];
  const invitations = invitationResult.invitations || [];
  const manageable = hasOrganizationPermission("members.manage");
  const canManageOwnership = hasOrganizationPermission("ownership.manage");
  setPageActions([
    manageable ? button("دعوت عضو", { variant: "primary", onClick: () => openInvitationDialog() }) : null,
  ]);
  const activeInvitations = invitations.filter((item) => !item.acceptedAt && !item.revokedAt && new Date(item.expiresAt) > new Date());
  const metrics = node("div", { className: "ws-metric-grid" }, [
    metricCard("اعضای فعال", faNumber(members.filter((item) => item.status === "active").length), `${faNumber(members.length)} عضویت ثبت‌شده`, "◉"),
    metricCard("دعوت باز", faNumber(activeInvitations.length), "در انتظار پذیرش", "◇"),
    metricCard("مدیران پروژه", faNumber(members.filter((item) => item.roleKey === "project_manager").length), "دسترسی اجرایی", "✓"),
    metricCard("کنترل و حسابرسی", faNumber(members.filter((item) => ["finance", "board", "auditor"].includes(item.roleKey)).length), "مالی، هیئت‌مدیره و حسابرس", "⌾"),
  ]);
  const memberTable = dataTable([
    { label: "عضو", title: true, render: (item) => titleCell(item.user?.fullName || "بدون نام", item.user?.email) },
    { label: "نقش", render: (item) => labels.roles[item.roleKey] || item.roleKey },
    { label: "MFA", render: (item) => statusChip(item.user?.mfaEnabled ? "active" : "inactive", item.user?.mfaEnabled ? "فعال" : "غیرفعال") },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    { label: "عضویت از", render: (item) => faDate(item.joinedAt || item.createdAt) },
    {
      label: "عملیات",
      render: (item) => manageable && (item.roleKey !== "owner" || canManageOwnership)
        ? button("دسترسی", { variant: "ghost", onClick: () => openMemberDialog(item) })
        : "فقط مشاهده",
    },
  ], members);
  const invitationTable = dataTable([
    { label: "دعوت", title: true, render: (item) => titleCell(item.email, item.projectTitle || "سطح سازمان") },
    { label: "نقش", render: (item) => labels.roles[item.roleKey] || item.roleKey },
    { label: "انقضا", render: (item) => faDate(item.expiresAt, true) },
    {
      label: "وضعیت",
      render: (item) => statusChip(
        item.acceptedAt ? "accepted" : item.revokedAt ? "cancelled" : new Date(item.expiresAt) < new Date() ? "failed" : "pending",
        item.acceptedAt ? "پذیرفته‌شده" : item.revokedAt ? "لغوشده" : new Date(item.expiresAt) < new Date() ? "منقضی" : "در انتظار",
      ),
    },
    {
      label: "عملیات",
      render: (item) => manageable && !item.acceptedAt && !item.revokedAt
        ? button("لغو", {
            variant: "danger",
            onClick: async () => {
              if (!confirm(`دعوت ${item.email} لغو شود؟`)) return;
              try {
                await api(`${base}/invitations/${encodeURIComponent(item.id)}`, { method: "DELETE", body: {} });
                toast("دعوت لغو شد.");
                navigate("team", { replace: true });
              } catch (error) {
                toast(errorMessage(error), "error");
              }
            },
          })
        : "—",
    },
  ], invitations, {
    emptyTitle: "دعوتی ثبت نشده است",
    emptyDescription: "اعضای سازمان را با نقش حداقلی موردنیاز دعوت کنید.",
    emptyAction: manageable ? button("دعوت عضو", { variant: "primary", onClick: () => openInvitationDialog() }) : null,
  });
  dom.pageBody.replaceChildren(
    metrics,
    panel("اعضای سازمان", "نقش و وضعیت دسترسی جاری", memberTable),
    node("br", { attributes: { "aria-hidden": "true" } }),
    panel("دعوت‌ها", "لینک خام دعوت فقط هنگام ساخت نمایش داده می‌شود", invitationTable),
  );
}

function openOrganizationDialog(organization) {
  openEntityDialog({
    kicker: "مشخصات سازمان",
    title: organization.name,
    submitLabel: "ذخیره سازمان",
    initial: organization,
    fields: [
      { name: "name", label: "نام سازمان", required: true, maxLength: 200 },
      { name: "legalName", label: "نام ثبتی", maxLength: 240 },
      { name: "nationalId", label: "شناسه ملی", dir: "ltr", maxLength: 40 },
      { name: "website", label: "وب‌سایت", type: "url", dir: "ltr", maxLength: 500 },
      { name: "description", label: "معرفی", type: "textarea", rows: 4, maxLength: 5000 },
      { name: "timezone", label: "منطقه زمانی", dir: "ltr", maxLength: 80 },
      { name: "defaultCurrency", label: "ارز پیش‌فرض", dir: "ltr", maxLength: 3 },
    ],
    onSubmit: async (values) => {
      await api(`/api/v2/admin/organizations/${encodeURIComponent(organization.id)}`, {
        method: "PATCH",
        body: values,
      });
      toast("مشخصات سازمان به‌روزرسانی شد.");
      await loadWorkspace({ organizationId: organization.id, projectId: state.projectId });
    },
  });
}

function openPublicProfileDialog(profile) {
  openEntityDialog({
    kicker: "نمایه عمومی",
    title: "معرفی سازمان در بازار",
    submitLabel: "ذخیره نمایه",
    initial: profile,
    fields: [
      { name: "headline", label: "تیتر معرفی", maxLength: 240 },
      { name: "description", label: "شرح", type: "textarea", rows: 4, maxLength: 5000 },
      { name: "website", label: "وب‌سایت", type: "url", dir: "ltr", maxLength: 500 },
      { name: "contactEmail", label: "ایمیل تماس", type: "email", dir: "ltr", maxLength: 320 },
      { name: "published", label: "نمایه عمومی منتشر باشد", type: "checkbox" },
    ],
    onSubmit: async (values) => {
      await api(`/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}/public-profile`, {
        method: "PATCH",
        body: values,
      });
      toast("نمایه عمومی به‌روزرسانی شد.");
      await navigate("settings", { replace: true });
    },
  });
}

function openIntegrationDialog(connection = null) {
  openEntityDialog({
    kicker: "اتصال بیرونی",
    title: connection ? connection.displayName : "اتصال جدید",
    submitLabel: "ذخیره اتصال",
    initial: connection || { mode: "manual", status: "inactive" },
    fields: [
      {
        name: "providerKey",
        label: "شناسه سرویس",
        required: true,
        dir: "ltr",
        minLength: 2,
        maxLength: 80,
        pattern: "[a-z0-9][a-z0-9_-]{1,79}",
        inputMode: "text",
        disabled: Boolean(connection),
      },
      { name: "displayName", label: "نام نمایشی", required: true, maxLength: 120 },
      {
        name: "mode",
        label: "حالت",
        type: "select",
        options: [
          { value: "manual", label: "دستی" },
          { value: "sandbox", label: "آزمایشی" },
          { value: "live", label: "زنده" },
        ],
      },
      {
        name: "status",
        label: "وضعیت",
        type: "select",
        options: [
          { value: "inactive", label: "غیرفعال" },
          { value: "configured", label: "پیکربندی‌شده" },
          { value: "healthy", label: "سالم", disabled: !connection?.lastCheckedAt },
          { value: "degraded", label: "اختلال" },
          { value: "disabled", label: "از مدار خارج" },
        ],
      },
      { name: "endpoint", label: "نشانی endpoint (در پیکربندی رمزگذاری می‌شود)", type: "url", dir: "ltr" },
      { name: "apiKey", label: "کلید دسترسی (در پیکربندی رمزگذاری می‌شود)", type: "password", dir: "ltr", autocomplete: "new-password" },
    ],
    note: "UI هیچ اتصال زنده‌ای را بدون بررسی واقعی سالم علامت نمی‌زند؛ اسرار در خروجی API بازگردانده نمی‌شوند.",
    onSubmit: async (values) => {
      if (values.mode === "live" && values.status === "healthy" && !connection?.lastCheckedAt) {
        throw new Error("اتصال زنده فقط پس از بررسی واقعی سرویس می‌تواند سالم شود.");
      }
      await api(`/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}/integrations`, {
        method: "POST",
        body: {
          providerKey: values.providerKey || connection?.providerKey,
          displayName: values.displayName,
          mode: values.mode,
          status: values.status,
          config: values.endpoint || values.apiKey ? { endpoint: values.endpoint, apiKey: values.apiKey } : undefined,
        },
      });
      toast("اتصال ذخیره شد؛ وضعیت سلامت نیازمند بررسی provider است.");
      await navigate("settings", { replace: true });
    },
  });
}

function outboxTemplateLabel(templateKey) {
  return {
    "organization-invitation": "دعوت عضویت",
    "password-reset": "بازیابی رمز عبور",
  }[templateKey] || templateKey;
}

async function updateOutboxItem(item, action) {
  const messages = {
    mark_sent: "ارسال دستی این پیام تأیید شود؟",
    retry: "این پیام دوباره در صف ارسال قرار بگیرد؟",
    cancel: "این پیام لغو شود؟ این اقدام از ارسال بعدی جلوگیری می‌کند.",
  };
  if (!confirm(messages[action] || "این اقدام انجام شود؟")) return;
  try {
    const orgId = encodeURIComponent(state.organizationId);
    await api(
      `/api/v2/admin/organizations/${orgId}/notification-outbox/${encodeURIComponent(item.id)}`,
      { method: "PATCH", body: { action } },
    );
    toast({
      mark_sent: "ارسال دستی ثبت شد.",
      retry: "پیام دوباره در صف قرار گرفت.",
      cancel: "پیام لغو شد.",
    }[action] || "صف اعلان به‌روزرسانی شد.");
    await navigate("settings", { replace: true });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function renderSettings(sequence) {
  const orgId = encodeURIComponent(state.organizationId);
  const [organizationResult, profileResult, integrationResult, auditResult, outboxResult] = await Promise.all([
    api(`/api/v2/admin/organizations/${orgId}`),
    api(`/api/v2/admin/organizations/${orgId}/public-profile`),
    api(`/api/v2/admin/organizations/${orgId}/integrations`),
    hasPermission("audit.read")
      ? optionalApi(`/api/v2/admin/organizations/${orgId}/audit-events/verify`)
      : Promise.resolve(null),
    hasPermission("organization.manage")
      ? api(`/api/v2/admin/organizations/${orgId}/notification-outbox?limit=100`)
      : Promise.resolve({ outbox: [] }),
  ]);
  if (!ensureSequence(sequence)) return;
  const organization = organizationResult.organization;
  const profile = profileResult.profile || {};
  const connections = integrationResult.connections || [];
  const outbox = outboxResult?.outbox || [];
  const manageable = hasPermission("organization.manage");
  setPageActions([
    manageable ? button("ویرایش سازمان", { variant: "primary", onClick: () => openOrganizationDialog(organization) }) : null,
  ]);
  const organizationPanel = panel(
    "مشخصات سازمان",
    "اطلاعات مبنا برای همه پروژه‌ها",
    node("div", { className: "ws-card-list" }, [
      titleCell(organization.name, organization.legalName || "نام ثبتی ثبت نشده"),
      node("p", { className: "ws-form-note", text: organization.description || "معرفی سازمان ثبت نشده است." }),
      node("div", { className: "ws-entity-card__foot" }, [
        node("span", { text: `${organization.defaultCurrency} · ${organization.timezone}` }),
        manageable ? button("ویرایش", { variant: "ghost", onClick: () => openOrganizationDialog(organization) }) : null,
      ]),
    ]),
  );
  const profilePanel = panel(
    "نمایه عمومی",
    profile.verified ? "هویت سازمان تأیید شده است" : "هنوز نشان تأیید عمومی ندارد",
    node("div", { className: "ws-card-list" }, [
      titleCell(profile.headline || "تیتر معرفی ثبت نشده", profile.website || profile.contactEmail),
      node("p", { className: "ws-form-note", text: profile.description || "شرح عمومی سازمان ثبت نشده است." }),
      node("div", { className: "ws-entity-card__foot" }, [
        statusChip(profile.published ? "published" : "draft"),
        manageable ? button("ویرایش", { variant: "ghost", onClick: () => openPublicProfileDialog(profile) }) : null,
      ]),
    ]),
  );
  const connectionTable = dataTable([
    { label: "اتصال", title: true, render: (item) => titleCell(item.displayName, item.providerKey) },
    { label: "حالت", render: (item) => item.mode === "live" ? "زنده" : item.mode === "sandbox" ? "آزمایشی" : "دستی" },
    { label: "پیکربندی", render: (item) => item.configured ? "رمزگذاری‌شده" : "ثبت نشده" },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    { label: "آخرین بررسی", render: (item) => faDate(item.lastCheckedAt, true) },
    { label: "عملیات", render: (item) => manageable ? button("ویرایش", { variant: "ghost", onClick: () => openIntegrationDialog(item) }) : "فقط مشاهده" },
  ], connections, {
    emptyTitle: "اتصال بیرونی تعریف نشده است",
    emptyDescription: "درگاه، پیامک، ایمیل و webhook با adapter و اطلاعات معتبر فعال می‌شوند.",
    emptyAction: manageable ? button("اتصال جدید", { variant: "primary", onClick: () => openIntegrationDialog() }) : null,
  });
  const outboxTable = dataTable([
    {
      label: "پیام",
      title: true,
      render: (item) => titleCell(outboxTemplateLabel(item.templateKey), item.destination),
    },
    { label: "کانال", render: (item) => `${item.channel} · ${item.provider}` },
    { label: "وضعیت", render: (item) => statusChip(item.status) },
    { label: "تلاش", render: (item) => faNumber(item.attempts || 0) },
    { label: "زمان", render: (item) => faDate(item.sentAt || item.nextAttemptAt || item.createdAt, true) },
    {
      label: "عملیات",
      render: (item) => node("div", {}, [
        item.provider === "manual" && !["sent", "cancelled"].includes(item.status)
          ? button("ارسال شد", { variant: "primary", onClick: () => updateOutboxItem(item, "mark_sent") })
          : null,
        !["sent", "cancelled"].includes(item.status)
          ? button("لغو", { variant: "danger", onClick: () => updateOutboxItem(item, "cancel") })
          : null,
        ["failed", "processing"].includes(item.status)
          ? button("تلاش مجدد", { variant: "ghost", onClick: () => updateOutboxItem(item, "retry") })
          : null,
      ]),
    },
  ], outbox, {
    emptyTitle: "پیامی در صف تحویل نیست",
    emptyDescription: "وضعیت تحویل اعلان‌ها اینجا دیده می‌شود؛ محتوای محرمانه و لینک‌های یک‌بارمصرف هرگز در صف مدیریتی نمایش داده نمی‌شوند.",
  });
  dom.pageBody.replaceChildren(
    node("div", { className: "ws-metric-grid" }, [
      metricCard("وضعیت سازمان", organization.status === "active" ? "فعال" : translatedStatus(organization.status), organization.slug, "✓"),
      metricCard("نمایه عمومی", profile.published ? "منتشرشده" : "پیش‌نویس", profile.verified ? "تأییدشده" : "بدون تأیید", "◇"),
      metricCard("اتصال‌ها", faNumber(connections.length), `${faNumber(connections.filter((item) => item.status === "healthy").length)} اتصال سالم`, "↔"),
      metricCard("زنجیره ممیزی", auditResult?.valid === true ? "سالم" : auditResult ? "نیازمند بررسی" : "محدود", auditResult?.checked ? `${faNumber(auditResult.checked)} رویداد بررسی شد` : "طبق سطح دسترسی", "⌾"),
    ]),
    node("div", { className: "ws-dashboard-grid" }, [organizationPanel, profilePanel]),
    node("br", { attributes: { "aria-hidden": "true" } }),
    panel(
      "اتصال‌ها و adapterها",
      "وضعیت واقعی سرویس از ورودی کاربر جعل نمی‌شود",
      connectionTable,
      manageable ? button("اتصال جدید", { variant: "ghost", onClick: () => openIntegrationDialog() }) : null,
    ),
    manageable ? node("br", { attributes: { "aria-hidden": "true" } }) : null,
    manageable ? panel(
      "صف تحویل اعلان‌ها",
      "برای حفظ امنیت حساب‌ها، payload و لینک‌های دعوت یا بازیابی در هیچ خروجی مدیریتی نمایش داده نمی‌شوند",
      outboxTable,
    ) : null,
  );
}

function openProfileDialog() {
  openEntityDialog({
    kicker: "حساب شخصی",
    title: "ویرایش پروفایل",
    submitLabel: "ذخیره پروفایل",
    initial: state.user || {},
    fields: [
      { name: "fullName", label: "نام و نام خانوادگی", required: true, minLength: 2, maxLength: 160 },
      { name: "mobile", label: "موبایل", type: "tel", dir: "ltr", maxLength: 30 },
      { name: "avatarUrl", label: "نشانی تصویر پروفایل", type: "url", dir: "ltr", maxLength: 1000 },
      {
        name: "locale",
        label: "زبان",
        type: "select",
        options: [
          { value: "fa-IR", label: "فارسی" },
          { value: "en-US", label: "English" },
        ],
      },
    ],
    onSubmit: async (values) => {
      const result = await api("/api/v2/admin/me", { method: "PATCH", body: values });
      state.user = result.user;
      renderWorkspaceChrome();
      toast("پروفایل به‌روزرسانی شد.");
      await navigate("security", { replace: true });
    },
  });
}

function openPasswordDialog() {
  openEntityDialog({
    kicker: "امنیت حساب",
    title: "تغییر رمز عبور",
    submitLabel: "تغییر رمز",
    fields: [
      { name: "currentPassword", label: "رمز فعلی", type: "password", required: true, minLength: 12, autocomplete: "current-password" },
      { name: "newPassword", label: "رمز جدید", type: "password", required: true, minLength: 12, autocomplete: "new-password" },
      { name: "newPasswordConfirm", label: "تکرار رمز جدید", type: "password", required: true, minLength: 12, autocomplete: "new-password" },
    ],
    note: "رمز جدید حداقل ۱۲ نویسه باشد. نشست‌های دیگر حساب باطل می‌شوند.",
    onSubmit: async (values) => {
      if (values.newPassword !== values.newPasswordConfirm) {
        throw new ApiError(400, {
          error: { message: "تکرار رمز عبور یکسان نیست.", fields: { newPasswordConfirm: "رمز را عیناً تکرار کنید." } },
        });
      }
      await api("/api/v2/admin/me/password", {
        method: "POST",
        body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      });
      toast("رمز عبور تغییر کرد و نشست‌های دیگر بسته شدند.");
    },
  });
}

function showBackupCodes(codes) {
  const value = (codes || []).join("\n");
  if (!value) return;
  navigator.clipboard?.writeText(value).then(
    () => toast("کدهای بازیابی در کلیپ‌بورد کپی شدند؛ آن‌ها را در محل امن نگه دارید."),
    () => prompt("کدهای بازیابی را اکنون ذخیره کنید؛ دوباره نمایش داده نمی‌شوند:", value),
  );
}

function openMfaConfirmDialog(enrollment) {
  openEntityDialog({
    kicker: "تأیید دومرحله‌ای",
    title: "تأیید برنامهٔ احراز هویت",
    submitLabel: "فعال‌سازی MFA",
    fields: [
      { name: "secret", label: "کلید دستی", value: enrollment.secret, dir: "ltr", disabled: true },
      { name: "code", label: "کد شش‌رقمی برنامه", required: true, dir: "ltr", maxLength: 6, autocomplete: "one-time-code" },
    ],
    note: `این کلید را در برنامه احراز هویت وارد کنید. مهلت: ${faDate(enrollment.expiresAt, true)}`,
    onSubmit: async (values) => {
      const result = await api("/api/v2/admin/me/mfa/totp/confirm", {
        method: "POST",
        body: { code: values.code },
      });
      state.user = { ...state.user, mfaEnabled: true };
      showBackupCodes(result.backupCodes);
      toast("ورود دومرحله‌ای فعال شد.");
      await navigate("security", { replace: true });
    },
  });
}

function openMfaSetupDialog() {
  openEntityDialog({
    kicker: "افزایش امنیت",
    title: "راه‌اندازی ورود دومرحله‌ای",
    submitLabel: "ساخت کلید MFA",
    fields: [
      { name: "currentPassword", label: "رمز فعلی", type: "password", required: true, minLength: 12, autocomplete: "current-password" },
    ],
    note: "پس از تأیید رمز، کلید یک‌بارمصرف برای برنامه‌هایی مانند Google Authenticator نمایش داده می‌شود.",
    onSubmit: async (values) => {
      const enrollment = await api("/api/v2/admin/me/mfa/totp/setup", {
        method: "POST",
        body: { currentPassword: values.currentPassword, issuer: "هم‌ساخت" },
      });
      window.setTimeout(() => openMfaConfirmDialog(enrollment), 80);
    },
  });
}

function openMfaDisableDialog() {
  openEntityDialog({
    kicker: "عملیات حساس",
    title: "غیرفعال‌کردن ورود دومرحله‌ای",
    submitLabel: "غیرفعال‌کردن و خروج",
    fields: [
      { name: "currentPassword", label: "رمز فعلی", type: "password", required: true, minLength: 12 },
      { name: "verificationCode", label: "کد برنامه یا بازیابی", required: true, dir: "ltr" },
    ],
    note: "با غیرفعال‌سازی MFA، همه نشست‌ها از جمله این نشست باطل می‌شوند.",
    onSubmit: async (values) => {
      const codePayload = /^\d{6}$/.test(values.verificationCode)
        ? { totpCode: values.verificationCode }
        : { backupCode: values.verificationCode };
      await api("/api/v2/admin/me/mfa/disable", {
        method: "POST",
        body: { currentPassword: values.currentPassword, ...codePayload },
      });
      toast("ورود دومرحله‌ای غیرفعال شد؛ دوباره وارد شوید.");
      endWorkspaceSession();
    },
  });
}

function openBackupRegenerationDialog() {
  openEntityDialog({
    kicker: "کدهای اضطراری",
    title: "ساخت کدهای بازیابی جدید",
    submitLabel: "باطل‌سازی و ساخت کدها",
    fields: [
      { name: "currentPassword", label: "رمز فعلی", type: "password", required: true, minLength: 12 },
      { name: "verificationCode", label: "کد برنامه یا بازیابی", required: true, dir: "ltr" },
    ],
    note: "تمام کدهای بازیابی قبلی بلافاصله باطل می‌شوند.",
    onSubmit: async (values) => {
      const codePayload = /^\d{6}$/.test(values.verificationCode)
        ? { totpCode: values.verificationCode }
        : { backupCode: values.verificationCode };
      const result = await api("/api/v2/admin/me/mfa/backup-codes/regenerate", {
        method: "POST",
        body: { currentPassword: values.currentPassword, ...codePayload },
      });
      showBackupCodes(result.backupCodes);
    },
  });
}

async function saveNotificationDefaults() {
  try {
    await api("/api/v2/admin/me/notification-preferences", {
      method: "PUT",
      body: {
        preferences: [
          { channel: "in_app", eventKey: "project.*", enabled: true },
          { channel: "in_app", eventKey: "proposal.*", enabled: true },
          { channel: "in_app", eventKey: "governance.*", enabled: true },
          { channel: "email", eventKey: "security.*", enabled: true },
          { channel: "email", eventKey: "invitation.*", enabled: true },
        ],
      },
    });
    toast("ترجیحات پیشنهادی اعلان ذخیره شد.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function renderSecurity(sequence) {
  const me = await api("/api/v2/admin/me");
  if (!ensureSequence(sequence)) return;
  state.user = me.user || state.user;
  renderWorkspaceChrome();
  setPageActions([
    button("ویرایش پروفایل", { variant: "primary", onClick: () => openProfileDialog() }),
  ]);
  const user = state.user;
  const securityCards = node("div", { className: "ws-card-grid" }, [
    node("article", { className: "ws-entity-card" }, [
      node("div", { className: "ws-entity-card__top" }, [
        node("h3", { text: "پروفایل شخصی" }),
        statusChip(user.status),
      ]),
      node("p", { text: `${user.fullName}\n${user.email}${user.mobile ? ` · ${user.mobile}` : ""}` }),
      node("div", { className: "ws-entity-card__foot" }, [
        node("span", { text: `آخرین ورود: ${faDate(user.lastLoginAt, true)}` }),
        button("ویرایش", { variant: "ghost", onClick: () => openProfileDialog() }),
      ]),
    ]),
    node("article", { className: "ws-entity-card" }, [
      node("div", { className: "ws-entity-card__top" }, [
        node("h3", { text: "رمز عبور" }),
        statusChip("active", "محافظت‌شده"),
      ]),
      node("p", { text: "تغییر رمز، همه نشست‌های دیگر را باطل می‌کند و رویداد ممیزی می‌سازد." }),
      node("div", { className: "ws-entity-card__foot" }, [
        node("span", { text: `آخرین تغییر: ${faDate(user.passwordChangedAt, true)}` }),
        button("تغییر رمز", { variant: "ghost", onClick: () => openPasswordDialog() }),
      ]),
    ]),
    node("article", { className: "ws-entity-card" }, [
      node("div", { className: "ws-entity-card__top" }, [
        node("h3", { text: "ورود دومرحله‌ای" }),
        statusChip(user.mfaEnabled ? "active" : "inactive", user.mfaEnabled ? "فعال" : "غیرفعال"),
      ]),
      node("p", {
        text: user.mfaEnabled
          ? "حساب با کد TOTP و کدهای بازیابی محافظت می‌شود."
          : "برای کاهش خطر سرقت رمز، ورود دومرحله‌ای را فعال کنید.",
      }),
      node("div", { className: "ws-entity-card__foot" }, [
        node("span", { text: user.mfaEnabled ? "TOTP استاندارد" : "اقدام پیشنهادی" }),
        node("div", {}, user.mfaEnabled ? [
          button("کد بازیابی", { variant: "ghost", onClick: () => openBackupRegenerationDialog() }),
          button("غیرفعال‌سازی", { variant: "danger", onClick: () => openMfaDisableDialog() }),
        ] : button("فعال‌سازی", { variant: "primary", onClick: () => openMfaSetupDialog() })),
      ]),
    ]),
    node("article", { className: "ws-entity-card" }, [
      node("div", { className: "ws-entity-card__top" }, [
        node("h3", { text: "اعلان‌های امنیتی" }),
        statusChip("active", "پیشنهادی"),
      ]),
      node("p", { text: "اعلان‌های ورود، دعوت، تصمیم و تغییر حساس را درون سامانه و ایمیل دریافت کنید." }),
      node("div", { className: "ws-entity-card__foot" }, [
        node("span", { text: "کانال‌های واقعی پس از تنظیم adapter" }),
        button("اعمال تنظیم پیشنهادی", { variant: "ghost", onClick: saveNotificationDefaults }),
      ]),
    ]),
  ]);
  dom.pageBody.replaceChildren(
    node("div", { className: "ws-alert", text: "نشست شما HttpOnly، SameSite و محدود به ۱۲ ساعت است. رویدادهای حساس با زنجیره ممیزی ثبت می‌شوند." }),
    node("br", { attributes: { "aria-hidden": "true" } }),
    securityCards,
  );
}

function readinessTemplatePath(resource = "") {
  const base = `/api/v2/admin/organizations/${encodeURIComponent(state.organizationId)}/readiness-templates`;
  return resource ? `${base}/${resource}` : base;
}

function readinessActionLabel(value) {
  return ({
    manual: "اقدام دستی",
    form: "تکمیل فرم",
    document: "ارائه سند معتبر",
    task: "تکمیل وظیفه اجرایی",
    resolution: "تصویب مصوبه",
  })[value] || value;
}

function readinessRuleLabel(rule) {
  if (rule.label) return rule.label;
  return ({
    manual_checkbox: "تأیید چک‌باکس",
    form_field: "شرط پاسخ فرم",
    document_exists: "وجود سند معتبر",
    task_status: "تکمیل وظیفه",
    resolution_approved: "تصویب مصوبه با حدنصاب",
  })[rule.type] || rule.type;
}

function openReadinessTemplateDialog(template = null) {
  openEntityDialog({
    kicker: template ? "ویرایش الگوی سازمان" : "الگوی قابل استفاده مجدد",
    title: template ? template.name : "قالب فرایند جدید",
    submitLabel: template ? "ذخیره قالب" : "ساخت قالب",
    initial: template || { active: true },
    fields: [
      { name: "name", label: "نام قالب", required: true, maxLength: 200, placeholder: "مثلاً راه‌اندازی واحد تولیدی" },
      { name: "description", label: "هدف و دامنه", type: "textarea", rows: 3, maxLength: 3000 },
      { name: "projectKind", label: "نوع پروژه", maxLength: 120, placeholder: "اختیاری؛ مثلاً کارخانه" },
      { name: "industry", label: "صنعت", maxLength: 120, placeholder: "اختیاری؛ مثلاً تولید" },
      { name: "active", label: "قالب فعال و قابل انتخاب باشد", type: "checkbox" },
    ],
    note: "اگر نوع پروژه و صنعت خالی باشد، قالب برای همهٔ پروژه‌های سازمان قابل استفاده است.",
    onSubmit: async (values) => {
      await api(readinessTemplatePath(template ? encodeURIComponent(template.id) : ""), {
        method: template ? "PATCH" : "POST",
        body: values,
      });
      toast(template ? "قالب به‌روزرسانی شد." : "قالب ساخته شد؛ اکنون مراحل آن را تعریف کنید.");
      await navigate("readiness", { replace: true });
    },
  });
}

function linkedReadinessRule(step, type) {
  return (step?.gateRules || []).find((rule) => rule.type === type) || null;
}

function openReadinessStepDialog(template, context, step = null) {
  const taskRule = linkedReadinessRule(step, "task_status");
  const resolutionRule = linkedReadinessRule(step, "resolution_approved");
  openEntityDialog({
    kicker: step ? "ویرایش مرحلهٔ قالب" : "طراحی گردش کار",
    title: step ? step.title : "مرحلهٔ جدید",
    submitLabel: step ? "ذخیره مرحله" : "افزودن مرحله",
    initial: {
      ...(step || { position: (template.steps?.length || 0) + 1, actionType: "form", required: true }),
      taskId: taskRule?.taskId || "",
      resolutionId: resolutionRule?.resolutionId || "",
    },
    fields: [
      { name: "title", label: "عنوان مرحله", required: true, maxLength: 240 },
      { name: "description", label: "توضیح و معیار انجام", type: "textarea", rows: 3, maxLength: 3000 },
      { name: "position", label: "ترتیب", type: "number", min: 0, max: 10000, step: 1, required: true },
      {
        name: "actionType",
        label: "نوع اقدام",
        type: "select",
        options: ["form", "manual", "document", "task", "resolution"].map((value) => ({ value, label: readinessActionLabel(value) })),
      },
      {
        name: "taskId",
        label: "وظیفهٔ مرتبط (فقط برای نوع وظیفه)",
        type: "select",
        options: [{ value: "", label: "انتخاب نشده" }, ...(context.tasks || []).map((item) => ({ value: item.id, label: item.title }))],
      },
      {
        name: "resolutionId",
        label: "مصوبهٔ مرتبط (فقط برای نوع مصوبه)",
        type: "select",
        options: [{ value: "", label: "انتخاب نشده" }, ...(context.resolutions || []).map((item) => ({ value: item.id, label: item.title }))],
      },
      { name: "required", label: "مرحله برای بهره‌برداری الزامی است", type: "checkbox" },
      { name: "approvalRequired", label: "پس از ارسال، تأیید جداگانه مدیر لازم است", type: "checkbox" },
    ],
    note: "برای مرحلهٔ وظیفه یا مصوبه، رکورد مرتبط را انتخاب کنید. فرم مرحله را پس از ذخیره با افزودن فیلد می‌سازید.",
    onSubmit: async (values) => {
      const gateRules = (step?.gateRules || []).filter((rule) => !["task_status", "resolution_approved", "document_exists"].includes(rule.type));
      if (values.actionType === "task") {
        if (!values.taskId) throw new Error("برای این نوع مرحله یک وظیفه انتخاب کنید.");
        gateRules.push({ type: "task_status", taskId: values.taskId, status: "done", label: "وظیفهٔ اجرایی تکمیل شده باشد" });
      }
      if (values.actionType === "resolution") {
        if (!values.resolutionId) throw new Error("برای این نوع مرحله یک مصوبه انتخاب کنید.");
        gateRules.push({ type: "resolution_approved", resolutionId: values.resolutionId, label: "مصوبه با حدنصاب تصویب شده باشد" });
      }
      if (values.actionType === "document") {
        gateRules.push({ type: "document_exists", label: "سند فعال و دارای نسخه پیوست شده باشد" });
      }
      await api(readinessTemplatePath(`${encodeURIComponent(template.id)}/steps${step ? `/${encodeURIComponent(step.id)}` : ""}`), {
        method: step ? "PATCH" : "POST",
        body: {
          title: values.title,
          description: values.description,
          position: values.position,
          actionType: values.actionType,
          required: values.required,
          approvalRequired: values.approvalRequired,
          formSchema: step?.formSchema || [],
          gateRules,
        },
      });
      toast(step ? "مرحله به‌روزرسانی شد." : "مرحله به قالب اضافه شد.");
      await navigate("readiness", { replace: true });
    },
  });
}

function readinessRuleValue(value, fieldType, operator) {
  if (["filled", "true"].includes(operator)) return null;
  if (operator === "in") return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (fieldType === "number") return Number(value);
  if (fieldType === "checkbox") return String(value).toLowerCase() === "true";
  return value;
}

function openReadinessFieldDialog(template, step, field = null) {
  const existingRule = (step.gateRules || []).find((rule) => rule.fieldKey === field?.key);
  openEntityDialog({
    kicker: field ? "ویرایش فرم مرحله" : "فرم مرحله",
    title: field ? field.label : "فیلد جدید",
    submitLabel: field ? "ذخیره فیلد" : "افزودن فیلد",
    initial: {
      ...(field || { type: "text", required: true }),
      optionsText: (field?.options || []).join("، "),
      gateRequired: Boolean(existingRule),
      gateOperator: existingRule?.type === "manual_checkbox" ? "true" : existingRule?.operator || "filled",
      gateValue: Array.isArray(existingRule?.value) ? existingRule.value.join(", ") : existingRule?.value ?? "",
    },
    fields: [
      { name: "key", label: "کلید فنی کوتاه", required: true, pattern: "[A-Za-z][A-Za-z0-9_]{0,63}", dir: "ltr", placeholder: "licenseApproved" },
      { name: "label", label: "عنوانی که کاربر می‌بیند", required: true, maxLength: 160 },
      {
        name: "type",
        label: "نوع پاسخ",
        type: "select",
        options: [
          ["text", "متن کوتاه"], ["textarea", "متن چندخطی"], ["number", "عدد"],
          ["date", "تاریخ"], ["select", "انتخاب از فهرست"], ["checkbox", "تأیید بله/خیر"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "optionsText", label: "گزینه‌ها (برای فهرست انتخابی)", placeholder: "گزینه اول، گزینه دوم" },
      { name: "help", label: "راهنمای تکمیل", maxLength: 300 },
      { name: "min", label: "حداقل عدد", type: "number", step: 0.01 },
      { name: "max", label: "حداکثر عدد", type: "number", step: 0.01 },
      { name: "maxLength", label: "حداکثر طول متن", type: "number", min: 1, max: 20000, value: field?.maxLength || 2000 },
      { name: "required", label: "پاسخ این فیلد الزامی است", type: "checkbox" },
      { name: "gateRequired", label: "پاسخ این فیلد شرط عبور مرحله باشد", type: "checkbox" },
      {
        name: "gateOperator",
        label: "شرط عبور",
        type: "select",
        options: [
          ["filled", "پر شده باشد"], ["true", "تأیید شده باشد"], ["eq", "برابر باشد با"],
          ["neq", "برابر نباشد با"], ["gte", "بزرگ‌تر یا مساوی"], ["lte", "کوچک‌تر یا مساوی"], ["in", "یکی از مقادیر باشد"],
        ].map(([value, label]) => ({ value, label })),
      },
      { name: "gateValue", label: "مقدار شرط (در صورت نیاز)", placeholder: "برای چند مقدار، با ویرگول جدا کنید" },
    ],
    onSubmit: async (values) => {
      const normalized = {
        key: values.key,
        label: values.label,
        type: values.type,
        required: values.required,
        options: values.type === "select" ? values.optionsText.split(/[،,]/).map((item) => item.trim()).filter(Boolean) : [],
        min: values.min,
        max: values.max,
        maxLength: values.maxLength || 2000,
        help: values.help,
      };
      const formSchema = [...(step.formSchema || [])];
      const index = formSchema.findIndex((item) => item.key === field?.key);
      if (index >= 0) formSchema[index] = normalized;
      else formSchema.push(normalized);
      const gateRules = (step.gateRules || []).filter((rule) => rule.fieldKey !== field?.key && rule.fieldKey !== values.key);
      if (values.gateRequired) {
        if (!["filled", "true"].includes(values.gateOperator) && !String(values.gateValue || "").trim()) {
          throw new Error("برای شرط انتخاب‌شده، مقدار مقایسه را وارد کنید.");
        }
        if (values.type === "checkbox" && values.gateOperator === "true") {
          gateRules.push({ type: "manual_checkbox", fieldKey: values.key, label: `${values.label} تأیید شده باشد` });
        } else {
          gateRules.push({
            type: "form_field",
            fieldKey: values.key,
            operator: values.gateOperator,
            value: readinessRuleValue(values.gateValue, values.type, values.gateOperator),
            label: `شرط «${values.label}» برقرار باشد`,
          });
        }
      }
      await api(readinessTemplatePath(`${encodeURIComponent(template.id)}/steps/${encodeURIComponent(step.id)}`), {
        method: "PATCH",
        body: { formSchema, gateRules },
      });
      toast(field ? "فیلد فرم به‌روزرسانی شد." : "فیلد به فرم مرحله اضافه شد.");
      await navigate("readiness", { replace: true });
    },
  });
}

async function removeReadinessField(template, step, field) {
  if (!window.confirm(`فیلد «${field.label}» از فرم حذف شود؟`)) return;
  await api(readinessTemplatePath(`${encodeURIComponent(template.id)}/steps/${encodeURIComponent(step.id)}`), {
    method: "PATCH",
    body: {
      formSchema: step.formSchema.filter((item) => item.key !== field.key),
      gateRules: step.gateRules.filter((rule) => rule.fieldKey !== field.key),
    },
  });
  toast("فیلد حذف شد.");
  await navigate("readiness", { replace: true });
}

async function removeReadinessStep(template, step) {
  if (!window.confirm(`مرحلهٔ «${step.title}» از قالب حذف شود؟ فرایندهای قبلی تغییر نمی‌کنند.`)) return;
  await api(readinessTemplatePath(`${encodeURIComponent(template.id)}/steps/${encodeURIComponent(step.id)}`), { method: "DELETE" });
  toast("مرحله از قالب حذف شد.");
  await navigate("readiness", { replace: true });
}

function readinessTemplateCard(template, context, canManageOrganization, canManageProject, initialized) {
  const steps = node("div", { className: "ws-readiness-template-steps" });
  for (const step of template.steps || []) {
    const fields = node("div", { className: "ws-readiness-fields" }, (step.formSchema || []).map((field) =>
      node("span", { className: "ws-readiness-field" }, [
        node("button", { type: "button", text: field.label, onclick: canManageOrganization ? () => openReadinessFieldDialog(template, step, field) : null }),
        canManageOrganization ? node("button", { type: "button", className: "ws-readiness-field__remove", text: "×", title: "حذف فیلد", onclick: () => removeReadinessField(template, step, field) }) : null,
      ].filter(Boolean))));
    steps.append(node("article", { className: "ws-readiness-template-step" }, [
      node("div", { className: "ws-readiness-template-step__head" }, [
        node("div", {}, [node("strong", { text: step.title }), node("small", { text: `${faNumber(step.position)} · ${readinessActionLabel(step.actionType)}` })]),
        node("div", { className: "ws-inline-actions" }, [
          statusChip(step.required ? "active" : "inactive", step.required ? "الزامی" : "اختیاری"),
          step.approvalRequired ? statusChip("pending", "تأیید مدیر") : null,
        ].filter(Boolean)),
      ]),
      step.description ? node("p", { text: step.description }) : null,
      fields,
      canManageOrganization ? node("div", { className: "ws-inline-actions" }, [
        button("فیلد فرم", { variant: "ghost", onClick: () => openReadinessFieldDialog(template, step) }),
        button("ویرایش", { variant: "ghost", onClick: () => openReadinessStepDialog(template, context, step) }),
        button("حذف", { variant: "ghost", onClick: () => removeReadinessStep(template, step) }),
      ]) : null,
    ].filter(Boolean)));
  }
  if (!(template.steps || []).length) {
    steps.append(node("p", { className: "ws-muted-copy", text: "هنوز مرحله‌ای برای این قالب تعریف نشده است." }));
  }
  return node("article", { className: "ws-readiness-template" }, [
    node("div", { className: "ws-readiness-template__head" }, [
      node("div", {}, [
        node("h3", { text: template.name }),
        node("p", { text: template.description || "قالب عمومی آمادگی بهره‌برداری" }),
      ]),
      statusChip(template.active ? "active" : "inactive", template.active ? `نسخه ${faNumber(template.version)}` : "غیرفعال"),
    ]),
    node("div", { className: "ws-readiness-template__meta" }, [
      node("span", { text: template.projectKind || "همه انواع پروژه" }),
      node("span", { text: template.industry || "همه صنایع" }),
      node("span", { text: `${faNumber(template.steps?.length || 0)} مرحله` }),
    ]),
    steps,
    node("div", { className: "ws-readiness-template__actions" }, [
      canManageOrganization ? button("مرحله جدید", { onClick: () => openReadinessStepDialog(template, context) }) : null,
      canManageOrganization ? button("ویرایش قالب", { variant: "ghost", onClick: () => openReadinessTemplateDialog(template) }) : null,
      !initialized && canManageProject && template.active && template.steps?.length
        ? button("شروع برای این پروژه", {
          variant: "primary",
          onClick: async () => {
            if (!window.confirm(`فرایند «${template.name}» برای پروژه آغاز شود؟ مراحل به‌صورت نسخه ثابت ثبت می‌شوند.`)) return;
            await api(projectPath("readiness/initialize"), { method: "POST", body: { templateId: template.id, participationRequired: true } });
            toast("فرایند آمادگی پروژه آغاز شد.");
            await loadWorkspace({ organizationId: state.organizationId, projectId: state.projectId });
          },
        }) : null,
    ].filter(Boolean)),
  ]);
}

function openReadinessSubmission(step, documents) {
  const schemaFields = (step.formSchema || []).map((field) => ({
    name: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.type === "select" ? field.options.map((value) => ({ value, label: value })) : undefined,
    min: field.min,
    max: field.max,
    maxLength: field.maxLength,
    help: field.help,
    rows: field.type === "textarea" ? 4 : undefined,
  }));
  const needsDocument = step.actionType === "document" || step.gateRules.some((rule) => rule.type === "document_exists");
  openEntityDialog({
    kicker: "اجرای مرحلهٔ بهره‌برداری",
    title: step.title,
    submitLabel: step.approvalRequired ? "ارسال برای تأیید" : "ثبت انجام مرحله",
    initial: { ...(step.submission?.values || {}), note: step.note || "", evidenceDocumentId: step.evidenceDocumentId || "" },
    fields: [
      ...schemaFields,
      ...(needsDocument ? [{
        name: "evidenceDocumentId",
        label: "سند شاهد",
        type: "select",
        required: true,
        options: [{ value: "", label: "انتخاب سند فعال" }, ...documents.map((item) => ({ value: item.id, label: item.title }))],
      }] : []),
      { name: "note", label: "یادداشت اجرا", type: "textarea", rows: 3, maxLength: 3000 },
    ],
    note: step.approvalRequired ? "پس از ارسال، مدیر پروژه باید این مرحله را جداگانه تأیید کند." : "قواعد مرحله هنگام ثبت، دوباره با داده‌های واقعی پروژه کنترل می‌شوند.",
    onSubmit: async (values) => {
      const evidenceDocumentId = values.evidenceDocumentId || "";
      const note = values.note || "";
      delete values.evidenceDocumentId;
      delete values.note;
      await api(projectPath(`readiness/steps/${encodeURIComponent(step.id)}/submit`), {
        method: "POST",
        body: { values, evidenceDocumentId, note },
      });
      toast(step.approvalRequired ? "مرحله برای تأیید ارسال شد." : "مرحله تکمیل شد.");
      await navigate("readiness", { replace: true });
    },
  });
}

function openReadinessReopen(step) {
  openEntityDialog({
    kicker: "کنترل تغییرات",
    title: `بازگشایی «${step.title}»`,
    submitLabel: "بازگشایی مرحله",
    fields: [{ name: "note", label: "دلیل بازگشایی", type: "textarea", rows: 4, required: true, minLength: 1, maxLength: 3000 }],
    onSubmit: async (values) => {
      await api(projectPath(`readiness/steps/${encodeURIComponent(step.id)}/reopen`), { method: "POST", body: values });
      toast("مرحله برای اصلاح بازگشایی شد.");
      await navigate("readiness", { replace: true });
    },
  });
}

function openReadinessSuspend() {
  openEntityDialog({
    kicker: "تصمیم حساس",
    title: "توقف بهره‌برداری پروژه",
    submitLabel: "ثبت توقف بهره‌برداری",
    fields: [{ name: "note", label: "دلیل و اقدام اصلاحی", type: "textarea", rows: 5, required: true, maxLength: 3000 }],
    note: "پروژه به وضعیت متوقف منتقل می‌شود و این تصمیم در تاریخچهٔ غیرقابل‌انکار ثبت خواهد شد.",
    onSubmit: async (values) => {
      await api(projectPath("readiness/suspend"), { method: "POST", body: values });
      toast("بهره‌برداری پروژه متوقف و دلیل ثبت شد.");
      await loadWorkspace({ organizationId: state.organizationId, projectId: state.projectId });
      await navigate("readiness", { replace: true });
    },
  });
}

function readinessRunStepCard(step, canManageProject, runStatus, documents) {
  const locked = runStatus === "operating";
  const actions = [];
  if (canManageProject && !locked && ["pending", "in_progress", "submitted"].includes(step.status)) {
    actions.push(button(step.status === "submitted" ? "اصلاح و ارسال دوباره" : "انجام مرحله", { variant: "primary", onClick: () => openReadinessSubmission(step, documents) }));
  }
  if (canManageProject && !locked && step.status === "submitted" && step.approvalRequired) {
    actions.push(button("تأیید مدیر", {
      onClick: async () => {
        if (!window.confirm(`مرحلهٔ «${step.title}» تأیید شود؟`)) return;
        await api(projectPath(`readiness/steps/${encodeURIComponent(step.id)}/approve`), { method: "POST", body: {} });
        toast("مرحله تأیید شد.");
        await navigate("readiness", { replace: true });
      },
    }));
  }
  if (canManageProject && !locked && ["completed", "submitted", "blocked", "waived"].includes(step.status)) {
    actions.push(button("بازگشایی", { variant: "ghost", onClick: () => openReadinessReopen(step) }));
  }
  return node("article", { className: `ws-readiness-step${step.passed ? " is-complete" : ""}` }, [
    node("div", { className: "ws-readiness-step__index", text: faNumber(step.position) }),
    node("div", { className: "ws-readiness-step__body" }, [
      node("div", { className: "ws-readiness-step__head" }, [
        node("div", {}, [node("h3", { text: step.title }), node("small", { text: readinessActionLabel(step.actionType) })]),
        statusChip(step.status),
      ]),
      step.description ? node("p", { text: step.description }) : null,
      step.rules.length ? node("div", { className: "ws-readiness-rules" }, step.rules.map((rule) =>
        node("div", { className: rule.passed ? "is-passed" : "is-failed" }, [
          node("span", { text: rule.passed ? "✓" : "!" }),
          node("div", {}, [node("strong", { text: readinessRuleLabel(rule) }), node("small", { text: rule.message })]),
        ]))) : null,
      step.note ? node("blockquote", { text: step.note }) : null,
      actions.length ? node("div", { className: "ws-inline-actions" }, actions) : null,
    ].filter(Boolean)),
  ]);
}

async function renderReadiness(sequence) {
  const organizationId = state.organizationId;
  const [readiness, templateResult, taskResult, meetingResult, documentResult] = await Promise.all([
    api(projectPath("readiness")),
    api(readinessTemplatePath()),
    optionalApi(projectPath("tasks")),
    optionalApi(projectPath("meetings")),
    optionalApi(projectPath("documents")),
  ]);
  if (!ensureSequence(sequence)) return;
  const templates = templateResult.templates || [];
  const context = {
    tasks: taskResult?.tasks || [],
    resolutions: (meetingResult?.meetings || []).flatMap((meeting) => meeting.resolutions || []),
  };
  const documents = (documentResult?.documents || []).filter((item) => item.status === "active" && Number(item.currentVersionNo || 0) > 0);
  const canManageOrganization = hasOrganizationPermission("organization.manage");
  const canManageProject = hasPermission("project.manage");
  setPageActions([
    canManageOrganization ? button("قالب فرایند جدید", { onClick: () => openReadinessTemplateDialog() }) : null,
    readiness.initialized && canManageProject && readiness.run?.status === "operating"
      ? button("توقف بهره‌برداری", { variant: "danger", onClick: openReadinessSuspend }) : null,
    readiness.initialized && canManageProject && readiness.eligibleToOperate && readiness.run?.status !== "operating"
      ? button("فعال‌سازی بهره‌برداری", {
        variant: "primary",
        onClick: async () => {
          if (!window.confirm("همه شروط برقرار است. وضعیت پروژه به «بهره‌برداری» منتقل شود؟")) return;
          await api(projectPath("readiness/activate"), { method: "POST" });
          toast("پروژه به بهره‌برداری رسید.");
          await loadWorkspace({ organizationId, projectId: state.projectId });
          await navigate("readiness", { replace: true });
        },
      }) : null,
  ]);

  const templateGrid = node("div", { className: "ws-readiness-templates" }, templates.map((template) =>
    readinessTemplateCard(template, context, canManageOrganization, canManageProject, readiness.initialized)));
  if (!templates.length) {
    templateGrid.append(emptyState(
      "قالبی برای بهره‌برداری تعریف نشده است",
      "یک قالب سازمانی بسازید، مراحل را بچینید و فرم و شروط هر مرحله را بدون کدنویسی تعریف کنید.",
      { action: canManageOrganization ? button("ساخت نخستین قالب", { variant: "primary", onClick: () => openReadinessTemplateDialog() }) : null },
    ));
  }

  if (!readiness.initialized) {
    dom.pageBody.replaceChildren(
      node("section", { className: "ws-readiness-hero" }, [
        node("div", {}, [
          node("span", { className: "ws-kicker", text: "دروازهٔ شروع عملیات" }),
          node("h2", { text: "بهره‌برداری یک وضعیت دستی نیست" }),
          node("p", { text: "پس از قطعی‌شدن مشارکت‌ها، پروژه باید از شروط اجرایی، حقوقی و مدیریتی تعریف‌شده عبور کند. یک قالب مناسب را انتخاب یا قالب تازه‌ای طراحی کنید." }),
        ]),
        node("div", { className: "ws-readiness-hero__mark", text: "۰٪" }),
      ]),
      node("div", { className: "ws-section-heading" }, [node("div", {}, [node("h2", { text: "قالب‌های فرایند" }), node("p", { text: "قالب بر اساس نوع پروژه و صنعت قابل استفاده مجدد است." })])]),
      templateGrid,
    );
    return;
  }

  const run = readiness.run;
  const effectiveStatus = run.effectiveStatus || run.status;
  if (effectiveStatus === "attention_required") {
    showPageAlert("یکی از شروط پروژه پس از شروع بهره‌برداری از اعتبار افتاده است. موضوع را بررسی و در صورت لزوم بهره‌برداری را با ثبت دلیل متوقف کنید.", "error");
  }
  const steps = node("div", { className: "ws-readiness-run" }, readiness.steps.map((step) =>
    readinessRunStepCard(step, canManageProject, run.status, documents)));
  const blockers = node("div", { className: "ws-readiness-blockers" }, (readiness.blockers || []).map((blocker) =>
    node("div", {}, [node("span", { text: "!" }), node("p", { text: blocker.message })])));
  const eventTable = dataTable([
    { label: "رویداد", title: true, render: (item) => titleCell(({
      initialized: "شروع فرایند", submitted: "ارسال مرحله", approved: "تأیید مرحله", completed: "تکمیل مرحله",
      reopened: "بازگشایی مرحله", ready: "آماده بهره‌برداری", activated: "شروع بهره‌برداری",
      suspended: "توقف بهره‌برداری", evaluation_failed: "ارزیابی ناموفق",
    })[item.eventType] || item.eventType, item.note) },
    { label: "تغییر وضعیت", render: (item) => item.toStatus ? `${translatedStatus(item.fromStatus)} ← ${translatedStatus(item.toStatus)}` : "—" },
    { label: "زمان", render: (item) => faDate(item.createdAt, true) },
  ], readiness.events || []);
  dom.pageBody.replaceChildren(
    node("div", { className: "ws-metric-grid" }, [
      metricCard("وضعیت دروازه", translatedStatus(effectiveStatus), run.templateName, "◈"),
      metricCard("مشارکت قطعی", faPercent(readiness.participation.percent), `${faNumber(readiness.participation.committedNeeds)} از ${faNumber(readiness.participation.totalNeeds)} نیاز`, "◌"),
      metricCard("مراحل الزامی", `${faNumber(readiness.progress.completedRequiredSteps)} / ${faNumber(readiness.progress.totalRequiredSteps)}`, faPercent(readiness.progress.percent), "✓"),
      metricCard("مجوز شروع", readiness.eligibleToOperate ? "برقرار" : "مسدود", readiness.eligibleToOperate ? "همه شروط معتبر است" : `${faNumber(readiness.blockers.length)} مانع باقی مانده`, readiness.eligibleToOperate ? "✓" : "!"),
    ]),
    blockers.childElementCount ? blockers : node("div", { className: "ws-alert ws-alert--success", text: "همهٔ شروط لازم برقرار است؛ مدیر پروژه می‌تواند بهره‌برداری را فعال کند." }),
    node("div", { className: "ws-section-heading" }, [node("div", {}, [node("h2", { text: "مراحل اجرایی" }), node("p", { text: `نسخه ${faNumber(run.templateVersion)} از قالب «${run.templateName}»` })])]),
    steps,
    node("details", { className: "ws-readiness-history" }, [
      node("summary", { text: `تاریخچهٔ ممیزی (${faNumber(readiness.events?.length || 0)} رویداد)` }),
      eventTable,
    ]),
    node("details", { className: "ws-readiness-history" }, [
      node("summary", { text: `مدیریت قالب‌های سازمان (${faNumber(templates.length)})` }),
      templateGrid,
    ]),
  );
}

const viewRenderers = {
  overview: renderOverview,
  portfolio: renderPortfolio,
  participation: renderParticipation,
  execution: renderExecution,
  resources: renderResources,
  performance: renderPerformance,
  readiness: renderReadiness,
  finance: renderFinance,
  capital: renderCapital,
  governance: renderGovernance,
  compliance: renderCompliance,
  documents: renderDocuments,
  marketplace: renderMarketplace,
  reports: renderReports,
  team: renderTeam,
  settings: renderSettings,
  security: renderSecurity,
};

function bindEvents() {
  dom.accountForm.addEventListener("submit", submitAccountLogin);
  dom.mfaForm.addEventListener("submit", submitMfa);
  dom.resetForm.addEventListener("submit", submitResetRequest);
  dom.legacyForm.addEventListener("submit", submitLegacyLogin);
  dom.bootstrapForm.addEventListener("submit", submitBootstrap);
  dom.entityForm.addEventListener("submit", handleDialogSubmit);

  $("#forgotPasswordButton").addEventListener("click", () => {
    $("#resetEmail").value = $("#loginEmail").value;
    authStep("reset");
  });
  for (const control of $$("[data-auth-back]")) {
    control.addEventListener("click", () => {
      state.pendingLogin = null;
      authStep("account");
    });
  }
  for (const control of $$("[data-toggle-password]")) {
    control.addEventListener("click", () => {
      const input = $(`#${CSS.escape(control.dataset.togglePassword)}`);
      if (!input) return;
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      control.textContent = visible ? "نمایش" : "پنهان";
      control.setAttribute("aria-label", visible ? "نمایش رمز" : "پنهان‌کردن رمز");
    });
  }

  dom.organizationSelect.addEventListener("change", () => {
    loadWorkspace({ organizationId: dom.organizationSelect.value });
  });
  dom.projectSelect.addEventListener("change", () => {
    switchProject(dom.projectSelect.value);
  });
  dom.workspaceNav.addEventListener("click", (event) => {
    const control = event.target.closest("[data-view]");
    if (control && !control.hidden) navigate(control.dataset.view);
  });
  for (const control of $$("[data-view]", $(".ws-sidebar__foot"))) {
    control.addEventListener("click", () => navigate(control.dataset.view));
  }
  for (const control of $$("[data-view]", dom.profileMenu)) {
    control.addEventListener("click", () => navigate(control.dataset.view));
  }
  $("#openSidebarButton").addEventListener("click", openSidebar);
  $("#closeSidebarButton").addEventListener("click", closeSidebar);
  dom.sidebarBackdrop.addEventListener("click", closeSidebar);
  dom.profileButton.addEventListener("click", toggleProfileMenu);
  $("#logoutButton").addEventListener("click", logout);
  dom.notificationButton.addEventListener("click", () => toggleNotificationDrawer());
  $("#markAllReadButton").addEventListener("click", () => markNotifications());
  for (const control of $$("[data-close-drawer]")) {
    control.addEventListener("click", () => toggleNotificationDrawer(false));
  }
  for (const control of $$("[data-close-dialog]")) {
    control.addEventListener("click", closeEntityDialog);
  }
  dom.entityDialog.addEventListener("click", (event) => {
    if (event.target === dom.entityDialog) closeEntityDialog();
  });

  document.addEventListener("click", (event) => {
    if (!dom.profileMenu.hidden && !dom.profileMenu.contains(event.target) && !dom.profileButton.contains(event.target)) {
      dom.profileMenu.hidden = true;
      dom.profileButton.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!dom.notificationDrawer.hidden) toggleNotificationDrawer(false);
    else if (dom.sidebar.classList.contains("is-open")) closeSidebar();
  });
  window.addEventListener("online", () => {
    updateConnection();
    toast("اتصال شبکه دوباره برقرار شد.");
    if (state.authenticated) refreshNotifications();
  });
  window.addEventListener("offline", () => {
    updateConnection();
    toast("اتصال شبکه قطع شد؛ داده‌های ذخیره‌نشده را نگه دارید.", "error");
  });
  window.addEventListener("popstate", () => {
    if (state.authenticated) navigate(viewFromLocation(), { replace: true });
  });
}

async function initialize() {
  bindEvents();
  updateConnection();
  try {
    const session = await api("/api/v2/auth/session", {
      csrf: false,
      keepSession: true,
    });
    if (!session.authenticated) {
      showAuth();
      return;
    }
    state.csrfToken = session.csrfToken || "";
    state.user = session.user;
    showWorkspace();
    await loadWorkspace({
      organizationId: localStorage.getItem("hamkari.workspace.organization") || "",
      projectId: localStorage.getItem("hamkari.workspace.project") || "",
    });
    startNotificationPolling();
  } catch (error) {
    showAuth();
    if (!(error instanceof ApiError && error.status === 401)) {
      showInline(dom.accountError, errorMessage(error));
    }
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

initialize();

const state = {
  listings: [],
  cursor: null,
  loading: false,
};

const typeLabels = {
  collaboration: 'همکاری',
  investment: 'سرمایه‌گذاری',
  share_offer: 'عرضهٔ سهم',
  supplier: 'تأمین‌کننده',
  expert: 'متخصص',
};

const elements = {
  form: document.querySelector('#marketFilters'),
  query: document.querySelector('#marketQuery'),
  type: document.querySelector('#marketType'),
  currency: document.querySelector('#marketCurrency'),
  status: document.querySelector('#marketStatus'),
  grid: document.querySelector('#marketGrid'),
  error: document.querySelector('#marketError'),
  more: document.querySelector('#marketMore'),
};

function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'className') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'href') element.setAttribute('href', value);
    else element.setAttribute(key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) {
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return element;
}

function money(value, currency) {
  if (value === null || value === undefined) return 'بدون کف مبلغ';
  const formatted = new Intl.NumberFormat('fa-IR', {
    maximumFractionDigits: 0,
  }).format(value);
  return `${formatted} ${currency === 'IRR' ? 'ریال' : currency}`;
}

function card(listing) {
  const type = node('span', {
    className: 'market-card__type',
    text: typeLabels[listing.type] || listing.type,
  });
  const topChildren = [type];
  if (listing.organization?.verified) {
    topChildren.push(node('span', {
      className: 'market-card__verified',
      text: '● سازمان تأییدشده',
      title: 'وضعیت سازمان توسط مدیر پلتفرم تأیید شده است',
    }));
  }
  const meta = node('div', { className: 'market-card__meta' }, [
    node('span', { text: listing.location || 'بدون محدودیت مکانی' }),
    node('span', { text: listing.project?.industry || 'چندحوزه‌ای' }),
  ]);
  const identity = node('div', {}, [
    node('small', { text: listing.organization?.name || 'سازمان پروژه' }),
    node('strong', { text: listing.project?.title || 'پروژه' }),
  ]);
  const link = node('a', {
    href: `/projects/${encodeURIComponent(listing.project?.slug || '')}`,
    text: 'دیدن پروژه',
  });
  return node('article', { className: 'market-card' }, [
    node('div', { className: 'market-card__top' }, topChildren),
    node('h3', { text: listing.title }),
    node('p', { text: listing.summary }),
    meta,
    node('div', { className: 'market-card__footer' }, [identity, link]),
    listing.minimumAmount !== null
      ? node('span', {
        className: 'sr-only',
        text: `حداقل مبلغ ${money(listing.minimumAmount, listing.currency)}`,
      })
      : null,
  ]);
}

function render() {
  elements.grid.replaceChildren(...state.listings.map(card));
  elements.grid.setAttribute('aria-busy', String(state.loading));
  if (!state.loading && state.listings.length === 0) {
    elements.grid.append(node('div', {
      className: 'market-empty',
      text: 'با این فیلتر فرصتی پیدا نشد. فیلترها را تغییر دهید.',
    }));
  }
  elements.status.textContent = state.loading
    ? 'در حال دریافت فرصت‌ها…'
    : `${new Intl.NumberFormat('fa-IR').format(state.listings.length)} فرصت نمایش داده شده است`;
  elements.more.hidden = !state.cursor || state.loading;
}

function queryString(cursor) {
  const parameters = new URLSearchParams();
  const values = {
    q: elements.query.value.trim(),
    type: elements.type.value,
    currency: elements.currency.value,
    cursor,
    limit: '24',
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) parameters.set(key, value);
  }
  return parameters.toString();
}

async function load({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  elements.error.hidden = true;
  render();
  try {
    const response = await fetch(
      `/api/v2/marketplace/listings?${queryString(append ? state.cursor : null)}`,
      { headers: { Accept: 'application/json' } },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'دریافت فرصت‌ها ناموفق بود.');
    state.listings = append
      ? [...state.listings, ...(body.listings || [])]
      : (body.listings || []);
    state.cursor = body.nextCursor || null;
    const nextUrl = new URL(location.href);
    for (const key of ['q', 'type', 'currency']) {
      const value = elements[key === 'q' ? 'query' : key].value.trim();
      if (value) nextUrl.searchParams.set(key, value);
      else nextUrl.searchParams.delete(key);
    }
    history.replaceState(null, '', nextUrl);
  } catch (error) {
    elements.error.textContent = navigator.onLine
      ? error.message
      : 'اتصال قطع است؛ اگر قبلاً این صفحه را دیده باشید دادهٔ ذخیره‌شده نمایش داده می‌شود.';
    elements.error.hidden = false;
  } finally {
    state.loading = false;
    render();
  }
}

function restoreFilters() {
  const query = new URLSearchParams(location.search);
  elements.query.value = query.get('q') || '';
  elements.type.value = query.get('type') || '';
  elements.currency.value = query.get('currency') || '';
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  state.cursor = null;
  load();
});
elements.more.addEventListener('click', () => load({ append: true }));
window.addEventListener('offline', () => {
  elements.status.textContent = 'آفلاین — دادهٔ ذخیره‌شده';
});

restoreFilters();
load();

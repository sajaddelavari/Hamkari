const CACHE_NAME = 'hamsakht-public-v5';
const PUBLIC_SHELL = [
  '/',
  '/projects',
  '/marketplace',
  '/offline.html',
  '/styles.css',
  '/app.js',
  '/marketplace.css',
  '/marketplace.js',
  '/pwa.js',
  '/favicon.svg',
  '/icon-maskable.svg',
  '/assets/fonts/vazirmatn.woff2',
];

const PRIVATE_PREFIXES = [
  '/api/v1/admin',
  '/api/v2/admin',
  '/api/v2/auth',
  '/api/v1/proposals',
  '/api/v1/proposals/track',
  '/workspace',
  '/admin',
  '/accept-invitation',
  '/reset-password',
  '/my-proposals',
];

function isPrivate(url) {
  return PRIVATE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function isPublicApi(url) {
  return (
    url.pathname.startsWith('/api/v1/projects') ||
    url.pathname.startsWith('/api/v2/marketplace')
  );
}

async function cacheSanitizedPublicJson(request, response) {
  const data = await response.clone().json();
  const sanitizeNeed = (need) => {
    if (!need || typeof need !== 'object') return need;
    const copy = { ...need };
    delete copy.viewerState;
    return copy;
  };
  if (data?.project?.needs) {
    data.project = {
      ...data.project,
      needs: data.project.needs.map(sanitizeNeed),
    };
  }
  if (data?.need) data.need = sanitizeNeed(data.need);
  const safeResponse = new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Hamkari-Offline-Data': 'sanitized',
    },
  });
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, safeResponse);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PUBLIC_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isPrivate(url)) return;
  if (
    url.pathname.endsWith('/events') ||
    request.headers.get('accept')?.includes('text/event-stream')
  ) {
    // Streaming responses must stay on the network. Intercepting them breaks
    // connection-state detection and prevents the polling fallback.
    return;
  }

  if (isPublicApi(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
            cacheSanitizedPublicJson(request, response).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || caches.match('/offline.html'));
      return cached || network;
    }),
  );
});

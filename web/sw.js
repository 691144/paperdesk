// PaperDesk service worker: works offline, and picks up new versions on the
// next launch. App files are fetched from the network first (falling back to
// the cache when offline or slow); web fonts and the pinned AI libraries from
// jsDelivr are cached once. AI model files are cached by the AI code itself.
const CACHE = 'paperdesk-v11';
const LIBS = 'paperdesk-libs-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './freeboard_features.css',
  './freeboard_features.js',
  './config.js',
  './sync-core.js',
  './sync-cloud.js',
  './sync.js',
  './send-formats.js',
  './send-catalog.js',
  './send-connectors.js',
  './send.js',
  './send.css',
  './ai.css',
  './ai.js',
  './ai-render.js',
  './ai-store.js',
  './ai-asr-worker.js',
  './ai-llm-worker.js',
  './ai-image-worker.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  // Bypass the browser's HTTP cache so a new version never mixes with old files.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Only PaperDesk's own old caches: downloaded AI models live in other caches and must survive updates.
    caches.keys().then((keys) => Promise.all(keys.filter((k) => /^paperdesk-(v\d+|libs-v\d+)$/.test(k) && k !== CACHE && k !== LIBS).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

/** Network first; the cached copy answers if the network fails or takes over 2.5 s. */
function networkFirst(req, cacheKey) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
    const fromCache = () => caches.match(cacheKey || req, { ignoreSearch: true });
    const slow = setTimeout(() => fromCache().then(finish), 2500);
    // Revalidate with the server every time (GitHub Pages lets browsers reuse files for 10 minutes).
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then((res) => {
        clearTimeout(slow);
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(cacheKey || req, copy)); }
        finish(res);
      })
      .catch(() => { clearTimeout(slow); fromCache().then((hit) => finish(hit || Response.error())); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') { event.respondWith(networkFirst(req, './index.html')); return; }
  if (url.origin === location.origin) { event.respondWith(networkFirst(req)); return; }
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
  // AI libraries pinned to an exact version never change: cache them for offline use.
  if (url.host === 'cdn.jsdelivr.net' && /@\d+\.\d+\.\d+/.test(url.pathname)) {
    event.respondWith(caches.open(LIBS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  // Everything else (sign-in, storage APIs, model downloads) goes straight to the network.
});

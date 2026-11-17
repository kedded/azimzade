// Offline cache for Flanna (Latin practice + Anki). Bump VERSION to force a full refresh.
const VERSION = 'flanna-v2';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './recall.html', './recall.css', './recall-engine.js', './recall-app.js', './jszip.min.js', './fzstd.js', './sql-wasm.js', './sql-wasm.wasm'];

self.addEventListener('install', e => {
  // best effort: one missing file must never stop the app from installing
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(FILES.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Open instantly from the cache; refresh the cache in the background so the next start has the newest version.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then(res => { if (res && res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    const res = await network;
    return res || (e.request.mode === 'navigate' ? cache.match('./index.html') : Response.error());
  }));
});

/* Personal responses belong to the account-keyed IndexedDB cache, never CacheStorage. */
const SHELL = 'kram-shell-__KRAM_BUILD__';
const PUBLIC = ['/', '/manifest.webmanifest', '/icons/kram-192.png', '/icons/kram-512.png', '/icons/kram-maskable-512.png'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PUBLIC);
    const response = await fetch('/pwa-assets.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('The public offline asset manifest is unavailable.');
    const manifest = await response.clone().json();
    if (manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length > 1000 || manifest.assets.some(path => typeof path !== 'string' || !/^\/assets\/[^?#]+\.(?:js|css|woff2?|ttf|otf|png|svg|webp|avif|jpe?g|gif)$/.test(path) || path.includes('..'))) throw new Error('The public offline asset manifest is invalid.');
    await cache.put('/pwa-assets.json', response);
    await cache.addAll(manifest.assets);
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(key => key.startsWith('kram-shell-') && key !== SHELL).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.headers.get('Content-Type')?.includes('text/html')) {
          const cache = await caches.open(SHELL); await cache.put('/', response.clone());
        }
        return response;
      } catch {
        return await (await caches.open(SHELL)).match('/') ?? new Response('Reconnect to load Kram for the first time.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }
  if (!url.pathname.startsWith('/assets/') && !PUBLIC.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(request);
    if (cached && url.pathname.startsWith('/assets/')) return cached;
    const update = fetch(request).then(async response => { if (response.ok && response.type === 'basic') await cache.put(request, response.clone()); return response; });
    if (cached) { event.waitUntil(update.catch(() => undefined)); return cached; }
    return update;
  })());
});

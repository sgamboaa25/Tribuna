const CACHE = 'tribuna-v2';
const SHELL = [
  '/',
  '/public/manifest.json',
  '/public/icon-192.png',
  '/public/icon-512.png',
  '/public/icon-maskable-512.png',
  '/public/tribuna-logo-wordmark.jpg'
];

const isDocument = (req, url) =>
  req.mode === 'navigate' ||
  req.destination === 'document' ||
  url.pathname === '/' ||
  url.pathname.endsWith('.html');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // El feed se regenera con cada nota nueva. Cache-first lo serviría desde la
  // copia vieja sin avisar, así que un suscriptor con la PWA instalada
  // simplemente dejaría de recibir noticias nuevas.
  if (url.pathname === '/rss.xml' || url.pathname === '/feed') return;

  if (isDocument(req, url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});

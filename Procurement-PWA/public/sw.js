self.addEventListener('install', (e) => {
    e.waitUntil(
      caches.open('procurement-store').then((cache) => cache.addAll([
        '/',
        '/index.html',
      ])),
    );
  });
  no
  self.addEventListener('fetch', (e) => {
    e.respondWith(
      caches.match(e.request).then((response) => response || fetch(e.request)),
    );
  });
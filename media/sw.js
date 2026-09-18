/* The shell, and only the shell.

   This caches the files that draw NikUI — the script, the stylesheet, the
   icons — so opening it from the home screen is instant rather than a white
   rectangle while a socket connects.

   What it never caches is a conversation. There is nothing to cache: every byte
   of an instance's state arrives over the WebSocket, and the pages the server
   sends are empty. That is not an accident of this file, it is the reason the
   pages were made empty in the first place — a stale transcript shown as if it
   were live is worse than no transcript at all. */

const VERSION = 'nikui-shell-v1';

// Everything needed to draw the app before a socket exists. Deliberately not
// the pages themselves: those come from the network first, so a client that has
// been updated on the laptop is not a client from last week.
const SHELL = [
  '/media/browser.css',
  '/media/panel.css',
  '/media/icons.js',
  '/media/markdown.js',
  '/media/prompts.js',
  '/media/snippets.js',
  '/media/charts.js',
  '/media/status.js',
  '/media/device.js',
  '/media/transport.js',
  '/media/boot.js',
  '/media/panel.js',
  '/media/home.js',
  '/media/theme.js',
  '/media/mobile.js',
  '/media/pwa.js',
  '/media/icons/nikui-192.png',
  '/media/icons/nikui-512.png',
  '/manifest.webmanifest',
  // The fleet page itself, so opening the app cold — with the laptop asleep,
  // the tunnel down, the train in a tunnel — draws something.
  '/'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => { /* a missing file is not a reason to refuse to install */ }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never from a cache: the health probe is the question "are you there", and a
  // cached yes is a lie. Pairing is a live exchange for the same reason.
  if (url.pathname === '/health' || url.pathname === '/pair') return;

  // The pages: network first, so an updated client wins, with the cached shell
  // as the answer when the laptop is unreachable. The page carries no data, so
  // what comes back from the cache is a frame around an honest "offline".
  if (request.mode === 'navigate') {
    // Keyed by path alone: the same page is served whatever the query said, and
    // the one query this app uses — the key in the address bar — is traded for
    // a cookie and taken straight back out.
    const key = new Request(url.origin + url.pathname);
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(key, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(key).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // Everything else is a shell file: from the cache at once, and refreshed
  // behind it so the next open has the newer one.
  event.respondWith(
    caches.match(request).then((hit) => {
      const live = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => hit);
      return hit || live;
    })
  );
});

/* ---- being told ---------------------------------------------------------

   Three things are worth a buzz in a pocket: an instance is waiting for an
   answer, the quota ran out, an instance failed. The laptop decides which of
   those to send; this only draws them. */

self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch (_) { message = {}; }

  const title = message.title || 'NikUI';
  const options = {
    body: message.body || '',
    icon: '/media/icons/nikui-192.png',
    badge: '/media/icons/nikui-192.png',
    // One notification per instance per kind: an instance that needs you twice
    // is still one thing needing you.
    tag: message.tag || 'nikui',
    renotify: !!message.renotify,
    requireInteraction: message.kind === 'needs-you',
    timestamp: message.at || Date.now(),
    data: { url: message.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Already open somewhere: go to it rather than stacking another copy.
      for (const client of windows) {
        if (client.url.indexOf(url) >= 0 && 'focus' in client) return client.focus();
      }
      for (const client of windows) {
        if ('navigate' in client && 'focus' in client) return client.navigate(url).then(() => client.focus());
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : null;
    })
  );
});

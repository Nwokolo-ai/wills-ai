// ═══════════════════════════════════════════════════════════
//  sw.js — Service worker for push notifications + PWA
// ═══════════════════════════════════════════════════════════

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Push notification received ──
self.addEventListener('push', (event) => {
  let payload = {
    title: "Will's AI",
    body: 'New event update',
    icon: '/icons/icon-192.svg',
    badge: '/icons/icon-192.svg',
  };

  if (event.data) {
    try {
      const data = event.data.json();
      payload = { ...payload, ...data };
    } catch (e) {
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    icon: payload.icon,
    badge: payload.badge,
    tag: payload.tag || 'wills-alert',
    renotify: true,
    vibrate: [200, 100, 200],
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

// ── Notification click ──
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

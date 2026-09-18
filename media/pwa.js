/* Installing to the home screen, and being told when something needs you.

   Loaded only by the pages the server serves. The service worker keeps the
   shell so a cold start is instant; the push subscription belongs to this
   device and dies with it when the laptop forgets the device. */
(function () {
  'use strict';

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    // Served from the root so it can look after every page, not just /media.
    return navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch(function (err) {
        console.warn('NikUI: the shell will not be cached — ' + (err && err.message));
        return null;
      });
  }

  /**
   * Ask to be told about the three things worth a buzz in a pocket: an instance
   * waiting for an answer, the quota running out, an instance failing.
   *
   * Only ever after pairing, because a subscription belongs to a device: the
   * laptop keeps it against that device's record and throws it away when the
   * device is forgotten.
   */
  function subscribe(registration) {
    if (!registration || !registration.pushManager) return Promise.resolve(null);
    if (!window.nikDevice || !window.nikDevice.available()) return Promise.resolve(null);

    return window.nikDevice.load().then(function (record) {
      if (!record || !record.id) return null;
      return fetch('/push/key').then(function (response) {
        if (!response.ok) return null;
        return response.json();
      }).then(function (body) {
        if (!body || !body.key) return null;
        return registration.pushManager.getSubscription().then(function (existing) {
          if (existing) return existing;
          if (Notification.permission === 'denied') return null;
          return Notification.requestPermission().then(function (permission) {
            if (permission !== 'granted') return null;
            return registration.pushManager.subscribe({
              // The only kind anybody may use: every push shows a notification.
              userVisibleOnly: true,
              applicationServerKey: fromBase64(body.key)
            });
          });
        }).then(function (subscription) {
          if (!subscription) return null;
          return tell(record, subscription);
        });
      });
    }).catch(function (err) {
      console.warn('NikUI: no notifications on this device — ' + (err && err.message));
      return null;
    });
  }

  /** Hand the subscription to the laptop, signed, so it knows whose it is. */
  function tell(record, subscription) {
    const raw = subscription.toJSON();
    const body = {
      device: record.id,
      endpoint: raw.endpoint,
      keys: raw.keys
    };
    return window.nikDevice.sign('nikui-push:' + raw.endpoint).then(function (signature) {
      body.signature = signature;
      return fetch('/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    }).then(function (response) { return response.ok ? subscription : null; });
  }

  function fromBase64(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const binary = window.atob(padded + '==='.slice((padded.length + 3) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  registerWorker().then(function (registration) {
    if (!registration) return;
    // Wait for it to be in charge before asking it for a push subscription.
    return navigator.serviceWorker.ready.then(function (ready) {
      window.nikPush = { subscribe: function () { return subscribe(ready); } };
      return subscribe(ready);
    });
  });
})();

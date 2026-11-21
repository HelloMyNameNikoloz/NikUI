'use strict';

const fs = require('fs');
const { loadIdentity } = require('./identity');
const { DeviceStore } = require('./devices');
const { PairingWindow } = require('./pairing');
const { Audience } = require('./audience');
const push = require('./push');
const apple = require('./apns');
const { Notifier } = require('./notify');
const { NotificationStream } = require('./notificationStream');

/**
 * One host identity and its matching devices/delivery records. Stores use
 * synchronous get/update with the existing keys and shapes, without migration.
 * A selected policy is read-only for keys and refuses absent/corrupt pins.
 * Paths, key access and network transports are supplied by the adapter.
 */
function createDelivery({ store, settings, secretPolicy, manager, paths = {},
  fs: io = fs, readApnsKey, send = push.send, sendApple = apple.send,
  pushRequest, appleRequest, now = Date.now, timers, log = () => {} } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.update !== 'function') throw new Error('Delivery store is required');
  if (!settings) throw new Error('Delivery settings are required');
  if (!secretPolicy || !['legacy-window', 'selected'].includes(secretPolicy.mode)) throw new Error('Explicit delivery secret policy is required');
  const selected = secretPolicy.mode === 'selected';
  if (selected && (!secretPolicy.fingerprint || !secretPolicy.applicationServerKey)) throw new Error('Selected host and VAPID pins are required');
  // Validate both before exposing any grants or starting watchers. There is no
  // fallback to global state, another source profile or newly generated keys.
  const identity = loadIdentity(store, { required: selected, fingerprint: secretPolicy.fingerprint });
  const vapid = push.loadVapid(store, { required: selected, applicationServerKey: secretPolicy.applicationServerKey });
  const devices = new DeviceStore(store, { now });
  const pairing = new PairingWindow({ now });
  const audience = new Audience({ now });
  const source = () => typeof settings === 'function' ? settings() : settings;
  const get = (key, fallback) => source().get(key, fallback);
  const apns = apple.loadApns(() => {
    try {
      return { teamId: get('apns.teamId', ''), keyId: get('apns.keyId', ''),
        keyFile: paths.apnsKeyFile === undefined ? get('apns.keyFile', '') : paths.apnsKeyFile,
        bundleId: get('apns.bundleId', 'com.nikoloz.nikui'), production: get('apns.production', true) };
    } catch (_) { return {}; }
  }, { fs: io, readKey: readApnsKey });
  let transport = null, started = false, disposed = false, unavailable = null;
  let stopWatching = null, secretSubscription = null;
  let logger = log;
  const stream = new NotificationStream({ devices, timers, log: (line) => logger(line) });
  const notifier = new Notifier({ devices, vapid, apns, audience, now,
    reachable: () => !disposed && !!transport && transport.listening,
    toSockets: (message) => !disposed && transport ? transport.notifyDevices(message) : 0,
    send: (subscription, message, options) => disposed
      ? Promise.resolve({ ok: false, gone: false, reason: 'Delivery is closed' })
      : send(subscription, message, Object.assign({}, options, pushRequest ? { request: pushRequest } : {})),
    sendApple: (token, message, options) => disposed
      ? Promise.resolve({ ok: false, gone: false, reason: 'Delivery is closed' })
      : sendApple(token, message, Object.assign({}, options, appleRequest ? { request: appleRequest } : {})),
    settings: () => {
      try {
        const phone = Object.assign({}, get('notifyDevices', {}) || {});
        if (get('notifyWhenDone', false)) phone.turnFinished = true;
        if (get('notifyCI', true)) phone.ci = true;
        if (get('notifyOnAttention', true)) phone.needsYou = true;
        return phone;
      } catch (_) { return {}; }
    },
    log: (line) => logger('push: ' + line)
  });

  function assertAvailable() {
    if (disposed) throw new Error(unavailable || 'Delivery is closed');
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    const previous = transport, watcher = stopWatching, subscription = secretSubscription;
    transport = null;
    stopWatching = null;
    secretSubscription = null;
    for (const close of [() => { if (watcher) watcher(); }, () => { if (subscription) subscription.dispose(); },
      () => pairing.close('delivery closed'), () => stream.dispose(), () => apns.forget(),
      () => { if (previous && previous.stop) return previous.stop(); }]) {
      try { Promise.resolve(close()).catch(() => logger('delivery: could not close a resource')); }
      catch (_) { logger('delivery: could not close a resource'); }
    }
  }
  const runtime = {
    identity, devices, pairing, vapid, audience, apns, notifier, stream,
    get available() { return !disposed; },
    get error() { return unavailable; },
    assertAvailable,
    // RemoteServer calls this before construction/listen and on every request.
    // Its stop/start cycle closes streams but does not own this service graph.
    serverOptions() { assertAvailable(); return { identity, devices, pairing, vapid, audience, notificationStream: stream }; },
    connect(server, { log: nextLog } = {}) {
      assertAvailable();
      if (transport && transport !== server) throw new Error('Delivery already belongs to another server');
      transport = server;
      if (nextLog) logger = nextLog;
    },
    start() {
      if (disposed || started) return;
      started = true;
      if (manager) stopWatching = notifier.watch(manager);
      if (secretPolicy.onDidChange) {
        try {
          const subscription = secretPolicy.onDidChange(() => {
            // A selected snapshot is immutable for a generation. Close its
            // routes before constructing the replacement graph explicitly.
            unavailable = 'Selected delivery secrets changed; reopen the selected identity';
            dispose();
          });
          if (disposed) subscription.dispose();
          else secretSubscription = subscription;
        } catch (_) {
          unavailable = 'Delivery secret subscription unavailable';
          dispose();
          throw new Error(unavailable);
        }
      }
    },
    dispose
  };
  return runtime;
}

module.exports = { createDelivery };

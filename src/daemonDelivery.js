'use strict';

const { createDelivery } = require('./deliveryRuntime');
const path = require('path');

/**
 * Strict daemon adapter for an explicitly selected, already imported store.
 * No source-profile lookup, store merging or key generation is permitted.
 * P1 callers supply synthetic private stores/transports; daemon entry is P1-10.
 */
function createSelectedDelivery({ selection, ...services } = {}) {
  if (!selection || !selection.store || !selection.fingerprint || !selection.applicationServerKey) {
    throw new Error('An explicit selected identity, VAPID pin and store are required');
  }
  if ((typeof services.send !== 'function' && typeof services.pushRequest !== 'function') ||
      (typeof services.sendApple !== 'function' && typeof services.appleRequest !== 'function')) {
    throw new Error('Selected delivery requires explicit push and APNs transports');
  }
  // Preserve an imported reference only when the adapter explicitly supplies
  // it. Never follow a legacy settings path into a source profile's secrets.
  const paths = Object.assign({}, services.paths, { apnsKeyFile: services.paths && services.paths.apnsKeyFile || null });
  if (paths.apnsKeyFile && (typeof paths.apnsKeyFile !== 'string' || !path.isAbsolute(paths.apnsKeyFile))) {
    throw new Error('Selected APNs key path must be absolute');
  }
  return createDelivery({ ...services, paths, store: selection.store, secretPolicy: {
    mode: 'selected', fingerprint: selection.fingerprint, applicationServerKey: selection.applicationServerKey,
    onDidChange: selection.onDidChange && ((fn) => selection.onDidChange(fn))
  } });
}

module.exports = { createSelectedDelivery };

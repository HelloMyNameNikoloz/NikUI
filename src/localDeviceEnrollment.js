'use strict';

// This entry is reachable only over the owner-only c.sock, never HTTP/pairing.
// Its ledger retains forgotten/revoked keys: reconnect cannot mint a new seat.
const { readPublicKey, verifyWith } = require('./identity');
const crypto = require('crypto');
const { fail } = require('./daemonPaths');
const LEDGER = 'engine.localDevices.v1';
const REVOKED = 'engine.localDeviceRevocations.v1';
const keyHash = (key) => crypto.createHash('sha256').update(key).digest('hex');
const insist = (v, code) => { if (!v) throw fail(code, code); };
const reservation = (device) => device?.pendingLocalEnrollment === true && device.local !== true &&
  device.control === false && !Object.hasOwn(device, 'controlChangedAt');
const proofText = ({ engineId, generation, publicKey }) =>
  'nikui-local-device-v1:' + JSON.stringify([engineId, generation, publicKey]);

function createLocalDeviceEnrollment({ authority, devices, identity, engine, generation, port, running }) {
  let lane = Promise.resolve();
  async function enroll(request) {
    insist(running(), 'DRAINING');
    insist(request && Object.keys(request).every((k) => ['op', 'kind', 'protocol', 'device'].includes(k)) &&
      request.op === 'enroll' && request.kind === 'local' && request.protocol === 2, 'LOCAL_DEVICE_INVALID');
    const d = request.device;
    insist(d && Object.keys(d).sort().join(',') === 'engineId,generation,publicKey,signature' &&
      d.engineId === engine.id, 'ENGINE_IDENTITY_MISMATCH');
    insist(d.generation === generation, 'STALE_GENERATION');
    const key = readPublicKey(d.publicKey);
    insist(key && key.spki === d.publicKey && typeof d.publicKey === 'string' && d.publicKey.length < 256 &&
      typeof d.signature === 'string' && d.signature.length === 86 && verifyWith(key.spki, proofText(d), d.signature), 'LOCAL_DEVICE_PROOF_INVALID');
    const values = authority.snapshot().values;
    const records = values[LEDGER] || [], revoked = values[REVOKED] || [];
    insist(Array.isArray(records) && records.length <= 32 && records.every((r) => r && typeof r.publicKey === 'string' && typeof r.id === 'string'), 'LOCAL_DEVICE_STORE_CORRUPT');
    insist(Array.isArray(revoked) && revoked.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)), 'LOCAL_DEVICE_STORE_CORRUPT');
    insist(!revoked.includes(keyHash(key.spki)), 'LOCAL_DEVICE_REVOKED');
    let selected = records.find((r) => r.publicKey === key.spki);
    if (selected) {
      const device = devices.get(selected.id);
      insist(device && device.publicKey === selected.publicKey &&
        (device.local === true && device.control === true || reservation(device)), 'LOCAL_DEVICE_REVOKED');
    } else {
      const active = records.filter((r) => {
        const device = devices.get(r.id);
        return device?.publicKey === r.publicKey && (device.local === true && device.control === true || reservation(device));
      });
      insist(active.length < 32, 'LOCAL_DEVICE_ENROLLMENT_FULL');
      // A key paired through another route cannot be silently promoted.
      let added = devices.list().find((r) => r.publicKey === key.spki);
      insist(!added || reservation(added), 'LOCAL_DEVICE_IDENTITY_CONFLICT');
      if (!added) {
        const at = Date.now();
        // A crash before the ledger fsync leaves only a recoverable read-only
        // reservation. This internal marker is never accepted from pairing.
        added = { id: crypto.randomBytes(9).toString('base64url'), name: 'NikUI for Mac',
          publicKey: key.spki, fingerprint: key.fingerprint, protection: 'keychain', biometric: false,
          pairedAt: at, lastSeenAt: at, lastAddress: 'local-control', control: false, pendingLocalEnrollment: true };
        devices.save([...devices.list(), added]);
      }
      selected = { id: added.id, publicKey: key.spki };
      await authority.commit((saved) => {
        insist(running(), 'DRAINING');
        // Compact full revoked records, retaining irreversible key hashes.
        // A reset with a new key must not consume the active-seat budget.
        const live = [], tombstones = new Set(saved.values[REVOKED] || []);
        for (const record of saved.values[LEDGER] || []) {
          const device = devices.get(record.id);
          if (device?.publicKey === record.publicKey && (device.local === true && device.control === true || reservation(device))) live.push(record);
          else tombstones.add(keyHash(record.publicKey));
        }
        insist(live.length < 32, 'LOCAL_DEVICE_ENROLLMENT_FULL');
        saved.values[LEDGER] = [...live, selected];
        saved.values[REVOKED] = [...tombstones];
      });
    }
    insist(running(), 'DRAINING');
    const device = devices.get(selected.id);
    // The asynchronous ledger fsync is also a revocation/rekey boundary.
    insist(device && device.publicKey === selected.publicKey &&
      (device.local === true && device.control === true || reservation(device)), 'LOCAL_DEVICE_REVOKED');
    if (device.pendingLocalEnrollment === true) {
      const all = devices.list(), reserved = all.find((r) => r.id === selected.id);
      Object.assign(reserved, { local: true, control: true }); delete reserved.pendingLocalEnrollment;
      // The ledger binding is durable before the first full-control seat.
      devices.save(all);
    }
    const endpoint = port();
    insist(Number.isInteger(endpoint) && endpoint > 0 && endpoint <= 65535, 'LOCAL_ENDPOINT_UNAVAILABLE');
    return { ok: true, kind: 'local', protocol: 2, engineId: engine.id, generation,
      device: selected.id, publicKey: key.spki, serverKey: identity.publicKeySpki,
      fingerprint: identity.fingerprint, baseURL: 'http://127.0.0.1:' + endpoint,
      seat: { id: selected.id, local: true, control: true, editor: false } };
  }
  return { enroll(request) {
    const captured = structuredClone(request);
    const next = lane.then(() => enroll(captured)).catch((e) => ({ ok: false,
      code: /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code || '') ? e.code : 'LOCAL_DEVICE_UNAVAILABLE' }));
    lane = next; return next;
  }, flush: () => lane };
}
module.exports = { createLocalDeviceEnrollment, proofText, LEDGER, REVOKED, keyHash };

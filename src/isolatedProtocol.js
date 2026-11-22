'use strict';

// Admission is installed by the finished private composition, after recovery
// and loopback bind. Supplying applicationProtocol/testOnlyV2 to an arbitrary
// RemoteServer cannot advertise a partial v2 network service.
const { CORE, requireThat } = require('./protocolV2');
const { privateDirectory, privateFile } = require('./daemonPaths');
const services = new WeakMap();

function enableIsolatedProtocol({ remote, engine, currentState, authority, paths, bridge, running }) {
  privateDirectory(paths.root, false); privateFile(paths.lock);
  requireThat(engine.remote === remote && engine.delivery && engine.policy && engine.prCi &&
    currentState.dispatcher.authority === authority && authority.status().writable && currentState.status().running &&
    remote.server?.address()?.address === '127.0.0.1' && bridge && typeof bridge.connect === 'function' &&
    CORE.every((cap) => remote.applicationProtocol.caps.includes(cap)), 'ISOLATED_COMPOSITION_REQUIRED');
  services.set(remote, { currentState, running });
}
function applicationSocket(remote, client, options) {
  const service = services.get(remote);
  if (!service || !service.running()) return null;
  // Only the selected device store may confer the local seat. The signed
  // network proof still authenticates the device principal, never a browser.
  const device = remote.devices?.get(client.device?.id);
  if (device?.local === true) {
    options.context.seat.local = true;
    const send = options.post;
    options.post = (message) => {
      if (client.wants && ['init', 'queue'].includes(message?.type)) {
        const queue = service.currentState.snapshot().outbox.filter((q) => q.target === 'session:' + client.wants &&
          q.queueId && ['queued', 'dispatching', 'accepted', 'unknown'].includes(q.state)).map((q) => ({
          id: q.queueId, text: q.payload.message.text, sent: q.payload.message.sent || null,
          attachments: structuredClone(q.payload.message.attachments || []), snippets: structuredClone(q.payload.message.snippets || []),
          images: q.payload.message.attachments?.length || 0, lostImages: 0, state: q.state, revision: q.revision,
          mid: q.mid, error: q.error, actions: q.state === 'queued' && device.control ? ['unqueue', 'promoteQueued'] : []
        }));
        message = { ...message, queue };
      }
      return send(message);
    };
  }
  return service.currentState.createSocket({ ...options, testOnlyV2: true, client, server: remote,
    hub: client.wants ? remote.hubs.hubFor(remote.sessions.get(client.wants), remote.host) : null });
}
function disableIsolatedProtocol(remote) { services.delete(remote); }
module.exports = { enableIsolatedProtocol, applicationSocket, disableIsolatedProtocol };

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
  return service.currentState.createSocket({ ...options, testOnlyV2: true, client, server: remote,
    hub: client.wants ? remote.hubs.hubFor(remote.sessions.get(client.wants), remote.host) : null });
}
function disableIsolatedProtocol(remote) { services.delete(remote); }
module.exports = { enableIsolatedProtocol, applicationSocket, disableIsolatedProtocol };

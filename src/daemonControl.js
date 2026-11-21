'use strict';

const fs = require('fs');
const net = require('net');
const { privateFile, fail } = require('./daemonPaths');

async function createControl({ paths, handle, connect, observe }) {
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    socket.setEncoding('utf8');
    let text = '', handled = false;
    const receive = (chunk) => {
      if (handled) return;
      text += chunk;
      if (Buffer.byteLength(text) > 8192) { handled = true; return socket.end(JSON.stringify({ ok: false, code: 'CONTROL_TOO_LARGE' }) + '\n'); }
      const at = text.indexOf('\n');
      if (at === -1) return;
      handled = true;
      let request;
      try { request = JSON.parse(text.slice(0, at)); }
      catch (_) { return socket.end(JSON.stringify({ ok: false, code: 'CONTROL_INVALID' }) + '\n'); }
      if (request?.op === 'connect' && connect) {
        socket.removeListener('data', receive);
        try { connect(request, socket, text.slice(at + 1)); } catch (_) { socket.destroy(); }
        return;
      }
      if (request?.op === 'menu-observe' && observe) {
        socket.removeListener('data', receive);
        socket.setTimeout(0);
        Promise.resolve().then(() => observe(request, socket)).catch(() => {
          socket.end(JSON.stringify({ ok: false, code: 'CONTROL_FAILED' }) + '\n');
        });
        return;
      }
      Promise.resolve().then(() => handle(request)).then(
        (result) => socket.end(JSON.stringify(result) + '\n'),
        // No raw request, exception message, stack or credentials on the wire.
        () => socket.end(JSON.stringify({ ok: false, code: 'CONTROL_FAILED' }) + '\n'));
    };
    socket.on('data', receive);
  });
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, resolve);
  });
  let entry;
  try { fs.chmodSync(paths.socket, 0o600); entry = privateFile(paths.socket, { socket: true }); }
  catch (err) { await new Promise((resolve) => server.close(resolve)); throw err; }
  let closing;
  return {
    async dispose() {
      if (!closing) closing = new Promise((resolve, reject) => {
        for (const socket of clients) socket.destroy();
        server.close(() => {
          // Node normally unlinks its own Unix socket on close. Check inode
          // before cleaning up on platforms that leave it behind.
          try {
            const after = privateFile(paths.socket, { socket: true, optional: true });
            if (after && after.dev === entry.dev && after.ino === entry.ino) fs.unlinkSync(paths.socket);
            resolve();
          } catch (err) { reject(err); }
        });
      });
      return closing;
    }
  };
}

function controlRequest(paths, request, { timeoutMs = 4000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail('CONTROL_INVALID', 'Invalid control deadline');
  privateFile(paths.socket, { socket: true });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: paths.socket });
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(fail('CONTROL_UNAVAILABLE', 'The private daemon did not answer')); });
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.length > 262144) { socket.destroy(); reject(fail('CONTROL_INVALID', 'Invalid private daemon reply')); }
    });
    socket.once('error', reject);
    socket.once('end', () => {
      socket.destroy();
      try { resolve(JSON.parse(data)); }
      catch (_) { reject(fail('CONTROL_INVALID', 'Invalid private daemon reply')); }
    });
  });
}

module.exports = { createControl, controlRequest };

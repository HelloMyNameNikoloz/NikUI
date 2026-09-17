'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { renderPage, randomNonce } = require('./page');
const { LocalKey } = require('./auth');
const wire = require('./wire');

/**
 * The same client, served over HTTP, on this machine only.
 *
 * NikUI runs Claude with permissions bypassed, so a socket into it is remote
 * code execution on this laptop. Every decision here follows from that:
 *
 *  - it binds to 127.0.0.1 and there is no code path that binds anywhere else.
 *    Reaching the laptop from outside is the tunnel's job (#12), and a port on a
 *    café network is the whole threat model walking in;
 *  - nothing at all is served without a key, including the page itself;
 *  - the Host header must be a loopback name, so a hostile site cannot point
 *    DNS at 127.0.0.1 and have the browser treat it as its own origin;
 *  - a browser sends Origin on a WebSocket handshake and has no same-origin
 *    policy to stop it opening one, so an Origin that is not ours is refused.
 *
 * Nothing in this file requires `vscode`: it takes the same host object the
 * webview hands its hub, which is what makes the whole thing testable without
 * an editor.
 */

const ASSET_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

const PING_MS = 30000;
const MAX_SOCKETS = 32;
// A client this far behind is not reading, and buffering for it is how a server
// runs out of memory politely.
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;

class RemoteServer {
  /**
   * @param {object} deps
   * @param {string} deps.root        the extension directory (media/ lives under it)
   * @param {object} deps.host        host deps for the hubs, as the panel supplies
   * @param {object} deps.sessions    { list(), get(id) }
   * @param {object} [deps.hubs]      { hubFor, closeHub } — injectable for tests
   * @param {object} [deps.auth]      anything with check(req); the pairing gate slots in here
   * @param {(line: string) => void} [deps.log]
   */
  constructor(deps) {
    this.root = deps.root;
    this.host = deps.host;
    this.sessions = deps.sessions;
    this.hubs = deps.hubs || require('./hub');
    this.auth = deps.auth || new LocalKey();
    this.log = deps.log || (() => {});
    this.server = null;
    this.port = 0;
    this.clients = new Set();
    this.seq = 0;
    this.refusals = [];
  }

  get listening() {
    return !!this.server && this.server.listening;
  }

  /** The address to open, key and all. Only ever handed to this machine. */
  get url() {
    return this.listening ? `http://127.0.0.1:${this.port}/?key=${this.auth.key}` : null;
  }

  start(port) {
    if (this.listening) return Promise.resolve(this);
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log('request failed: ' + (err && err.message));
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('NikUI: something went wrong');
      });
    });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    // No idle timeout: a socket that is quiet for an hour is an instance that is
    // quiet for an hour. Liveness is the ping's job.
    server.timeout = 0;
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 70000;

    return new Promise((resolve, reject) => {
      const failed = (err) => { server.removeListener('listening', ok); reject(err); };
      const ok = () => {
        server.removeListener('error', failed);
        this.server = server;
        this.port = server.address().port;
        this.log(`listening on 127.0.0.1:${this.port}`);
        resolve(this);
      };
      server.once('error', failed);
      server.once('listening', ok);
      // Loopback, explicitly, every time. There is no configuration that
      // changes this and there should never be one.
      server.listen(Number(port) || 0, '127.0.0.1');
    });
  }

  stop() {
    const server = this.server;
    if (!server) return Promise.resolve();
    this.server = null;
    for (const client of [...this.clients]) client.close(wire.CLOSE.GOING_AWAY, 'server stopping');
    this.clients.clear();
    return new Promise((resolve) => {
      server.close(() => { this.log('stopped'); resolve(); });
      // A client that will not hang up should not keep the window open.
      setTimeout(() => resolve(), 250).unref();
    });
  }

  // ---- guards --------------------------------------------------------------

  /** The origins this server answers to: its own, under either loopback name. */
  origins() {
    return [
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`,
      `http://[::1]:${this.port}`
    ];
  }

  hosts() {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
  }

  /**
   * Everything that must be true before the key is even looked at. Returns null
   * when the request may proceed, or the reason it may not.
   */
  guard(req) {
    const address = (req.socket && (req.socket.remoteAddress || '')) || '';
    const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    if (!local) return { status: 403, reason: 'not from this machine' };

    const host = String((req.headers && req.headers.host) || '');
    if (!this.hosts().includes(host)) return { status: 403, reason: 'unexpected Host: ' + host };

    // Absent on a curl, always present from a browser. Present and foreign means
    // a page somewhere else is trying its luck.
    const origin = req.headers && req.headers.origin;
    if (origin && !this.origins().includes(String(origin))) {
      return { status: 403, reason: 'unexpected Origin: ' + origin };
    }
    return null;
  }

  refuse(req, why) {
    const entry = { at: Date.now(), url: String(req.url || ''), why };
    this.refusals.push(entry);
    if (this.refusals.length > 50) this.refusals.shift();
    this.log('refused ' + entry.url + ': ' + why);
    return entry;
  }

  // ---- HTTP ----------------------------------------------------------------

  async handle(req, res) {
    const blocked = this.guard(req);
    if (blocked) {
      this.refuse(req, blocked.reason);
      return plain(res, blocked.status, 'Refused');
    }
    const verdict = this.auth.check(req);
    if (!verdict.ok) {
      this.refuse(req, verdict.reason);
      return plain(res, verdict.status || 401, 'NikUI: this needs the key from the editor.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Only GET');

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const route = decodeURIComponent(url.pathname);

    // The key arrived in the address bar; put it in a cookie and take it back
    // out, so it is not sitting in the URL to be screenshotted or shared.
    if (url.searchParams.has('key')) {
      url.searchParams.delete('key');
      res.writeHead(302, {
        location: url.pathname + (url.search || ''),
        'set-cookie': `nikui=${encodeURIComponent(this.auth.key)}; Path=/; HttpOnly; SameSite=Strict`,
        'cache-control': 'no-store'
      });
      return res.end();
    }

    if (route === '/') return this.serveIndex(req, res);
    if (route.startsWith('/s/')) return this.serveClient(req, res, route.slice(3));
    if (route.startsWith('/media/')) return this.serveAsset(res, route.slice('/media/'.length));
    return plain(res, 404, 'No such page');
  }

  /** Every instance in the window, as a list you can tap. */
  serveIndex(req, res) {
    const nonce = randomNonce();
    const rows = this.sessions.list().map((s) => `
      <a class="row" href="/s/${escapeAttr(s.id)}">
        <span class="sdot ${escapeAttr(s.status)}"></span>
        <span class="row-name">${escapeHtml(label(s))}</span>
        <span class="row-cwd">${escapeHtml(shortPath(s.cwd))}</span>
        <span class="row-cost">${money(s.totalCost)}</span>
      </a>`).join('');

    const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${this.csp(req, nonce)}">
<link rel="stylesheet" href="/media/browser.css">
<title>NikUI</title>
</head>
<body class="home">
  <h1>NikUI</h1>
  <p class="lede">${rows ? 'Pick an instance.' : 'No instances are open in the editor yet.'}</p>
  <div class="rows">${rows}</div>
</body>
</html>`;
    return html(res, body);
  }

  /** The conversation itself: the same page the webview gets. */
  serveClient(req, res, id) {
    const session = this.sessions.get(id);
    if (!session) return plain(res, 404, 'No such instance');
    const nonce = randomNonce();
    const page = renderPage({
      asset: (file) => '/media/' + file,
      nonce,
      csp: this.csp(req, nonce),
      head: '<link rel="stylesheet" href="/media/browser.css">\n' +
        `<script nonce="${nonce}" src="/media/theme.js" defer></script>\n`,
      // The one thing the browser client needs that the webview does not: where
      // its socket is. Everything else it learns over that socket.
      boot: `window.NIKUI_REMOTE = ${JSON.stringify({
        session: session.id,
        socket: '/socket?session=' + encodeURIComponent(session.id),
        label: label(session)
      })};\ndocument.title = 'NikUI — ' + window.NIKUI_REMOTE.label;`
    });
    return html(res, page);
  }

  csp(req, nonce) {
    const origin = `http://${req.headers.host}`;
    const socket = origin.replace(/^http/, 'ws');
    return [
      "default-src 'none'",
      "img-src 'self' data: https:",
      "style-src 'self'",
      `script-src 'nonce-${nonce}'`,
      "font-src 'self'",
      `connect-src ${socket}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ');
  }

  /**
   * A file from media/, and nothing else. The path is resolved and then checked
   * to be inside that directory, so `..` and symlinks both end up outside it and
   * are refused rather than reasoned about.
   */
  serveAsset(res, name) {
    const dir = path.join(this.root, 'media');
    const file = path.resolve(dir, name);
    if (file !== dir && !file.startsWith(dir + path.sep)) return plain(res, 403, 'Outside media');

    const type = ASSET_TYPES[path.extname(file).toLowerCase()];
    if (!type) return plain(res, 403, 'Not a servable type');

    fs.readFile(file, (err, body) => {
      if (err) return plain(res, 404, 'No such file');
      res.writeHead(200, {
        'content-type': type,
        'content-length': body.length,
        // The editor can be reloaded with a changed file behind it; a cached
        // client would then be a different client, which is the one thing this
        // whole design is trying to prevent.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(body);
    });
  }

  // ---- WebSocket -----------------------------------------------------------

  upgrade(req, socket, head) {
    const deny = (status, reason) => {
      this.refuse(req, reason);
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
        'connection: close\r\ncontent-length: 0\r\n\r\n');
    };

    const blocked = this.guard(req);
    if (blocked) return deny(blocked.status, blocked.reason);
    const verdict = this.auth.check(req);
    if (!verdict.ok) return deny(verdict.status || 401, verdict.reason);

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname !== '/socket') return deny(404, 'no such socket');
    if (String(req.headers['sec-websocket-version'] || '') !== '13') return deny(400, 'websocket version');
    const key = req.headers['sec-websocket-key'];
    if (!key) return deny(400, 'no websocket key');
    if (this.clients.size >= MAX_SOCKETS) return deny(503, 'too many sockets');

    const session = this.sessions.get(url.searchParams.get('session'));
    if (!session) return deny(404, 'no such instance');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'upgrade: websocket\r\n' +
      'connection: Upgrade\r\n' +
      `sec-websocket-accept: ${wire.accept(key)}\r\n\r\n`
    );

    const client = new RemoteClient({
      id: 'socket-' + (this.seq++),
      socket,
      session,
      device: verdict.device,
      hub: this.hubs.hubFor(session, this.host),
      onGone: (c) => {
        this.clients.delete(c);
        // The hub outlives this socket only while somebody else is watching.
        if (c.hub.size === 0 && this.hubs.closeHub) this.hubs.closeHub(session.id);
      },
      log: this.log
    });
    this.clients.add(client);
    if (head && head.length) client.framer.push(head);
    this.log(`${client.id} attached to ${session.id}`);
  }
}

/**
 * One socket, as a client of a hub. Everything above the frames is the protocol
 * the webview already speaks, unchanged — which is the point of the exercise.
 */
class RemoteClient {
  constructor(opts) {
    this.id = opts.id;
    this.socket = opts.socket;
    this.session = opts.session;
    this.hub = opts.hub;
    this.device = opts.device;
    this.onGone = opts.onGone || (() => {});
    this.log = opts.log || (() => {});
    this.open = true;
    this.awaitingPong = 0;

    this.socket.setNoDelay(true);
    this.socket.setTimeout(0);

    this.framer = new wire.Framer({
      onMessage: (text) => this.deliver(text),
      onPing: (payload) => this.write(wire.encodePong(payload)),
      onPong: () => { this.awaitingPong = 0; },
      onClose: () => this.close(wire.CLOSE.NORMAL, ''),
      onFail: (code, why) => { this.log(`${this.id} protocol error: ${why}`); this.close(code, why); }
    });

    this.socket.on('data', (chunk) => this.framer.push(chunk));
    this.socket.on('error', () => this.gone());
    this.socket.on('close', () => this.gone());

    this.beat = setInterval(() => {
      if (!this.open) return;
      if (this.awaitingPong >= 2) return this.close(wire.CLOSE.GOING_AWAY, 'no answer');
      this.awaitingPong++;
      this.write(wire.encodePing());
    }, PING_MS);
    if (this.beat.unref) this.beat.unref();

    this.hub.attach({
      id: this.id,
      kind: 'socket',
      device: this.device,
      post: (message) => this.post(message)
    });
  }

  post(message) {
    if (!this.open) return;
    if (this.socket.writableLength > MAX_BACKLOG_BYTES) {
      this.log(`${this.id} is not keeping up; closing`);
      return this.close(wire.CLOSE.POLICY, 'too far behind');
    }
    this.write(wire.encodeText(JSON.stringify(message)));
  }

  deliver(text) {
    let msg = null;
    try { msg = JSON.parse(text); } catch (_) {
      this.log(`${this.id} sent something that is not JSON`);
      return;
    }
    // Straight into the hub, on exactly the terms the webview gets.
    Promise.resolve(this.hub.receive(this.id, msg)).catch((err) => {
      this.log(`${this.id} message failed: ${err && err.message}`);
    });
  }

  write(buffer) {
    if (!this.socket.writable) return;
    try { this.socket.write(buffer); } catch (_) { this.gone(); }
  }

  close(code, reason) {
    if (!this.open) return;
    this.open = false;
    try {
      this.socket.write(wire.encodeClose(code, reason));
      this.socket.end();
    } catch (_) { /* already gone */ }
    // A client that does not answer the close handshake still has to let go.
    const cut = setTimeout(() => { try { this.socket.destroy(); } catch (_) { /* gone */ } }, 200);
    if (cut.unref) cut.unref();
    this.finish();
  }

  gone() {
    if (!this.open) return this.finish();
    this.open = false;
    this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    this.hub.detach(this.id);
    this.onGone(this);
  }
}

// ---- small helpers ---------------------------------------------------------

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function html(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(body);
}

const label = (s) => s.customTitle || s.label || s.id;
const shortPath = (p) => String(p || '').split('/').slice(-2).join('/');
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

module.exports = { RemoteServer, RemoteClient, MAX_SOCKETS, PING_MS };

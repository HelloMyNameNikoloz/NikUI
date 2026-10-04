'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { renderPage, randomNonce, jsonForScript } = require('./page');
const { Gate, LocalKey, localDevice, forwarded } = require('./auth');
const wire = require('./wire');
const voiceMaxBytes = () => require('./voice').MAX_BYTES;

/**
 * The same client, served over HTTP, to this machine and to devices it knows.
 *
 * NikUI runs Claude with permissions bypassed, so a socket into it is code
 * execution on this laptop. Every decision here follows from that:
 *
 *  - it binds to 127.0.0.1 and there is no code path that binds anywhere else.
 *    Reaching the laptop from outside is the tunnel's job (#12), and a port on a
 *    café network is the whole threat model walking in;
 *  - the pages are an empty shell — markup, stylesheet, script — and carry no
 *    data at all. Everything worth having arrives over the socket, and the
 *    socket is where the authority check lives;
 *  - a socket is either this machine, holding the key this window minted, or a
 *    paired device proving on this connection that it still holds the private
 *    key it paired with. There is no bearer token in between;
 *  - the Host header must be a name we serve, so a hostile site cannot point DNS
 *    at 127.0.0.1 and have the browser treat it as its own origin;
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
// A pairing body is a name, a public key and a signature. Nothing here is large.
const MAX_BODY_BYTES = 8 * 1024;

class RemoteServer {
  /**
   * @param {object} deps
   * @param {string} deps.root        the extension directory (media/ lives under it)
   * @param {object} deps.host        host deps for the hubs, as the panel supplies
   * @param {object} deps.sessions    { list(), get(id) }
   * @param {object} [deps.devices]   the paired devices, and their trail
   * @param {object} [deps.identity]  this laptop's own key
   * @param {object} [deps.pairing]   the pairing window
   * @param {object} [deps.hubs]      { hubFor, closeHub } — injectable for tests
   * @param {Function} [deps.watchFleet] subscribe to "the window changed"
   * @param {Function} [deps.announce] tell a person something happened
   * @param {() => boolean} [deps.requireSealed] must a device seal the channel
   * @param {() => boolean} [deps.appOnly] serve the app only, never a page
   * @param {object} [deps.folders] the user's own folders, so a phone sees the same ones
   * @param {(cwd: string) => string} [deps.projectRoot] which project a directory belongs to
   * @param {(opts: object) => Promise<Array>} [deps.history] past conversations on this machine
   * @param {() => object} [deps.report] exactly what /status draws
   * @param {(line: string) => void} [deps.log]
   */
  constructor(deps) {
    this.root = deps.root;
    this.host = deps.host;
    this.sessions = deps.sessions;
    this.devices = deps.devices || null;
    // Who is using the app, and who asked for what. Notifications are sent to
    // one phone rather than all of them, and this is what knows which.
    this.audience = deps.audience || null;
    this.identity = deps.identity || null;
    this.pairing = deps.pairing || null;
    this.vapid = deps.vapid || null;
    this.hubs = deps.hubs || require('./hub');
    // Read through a function rather than copied at construction, so changing
    // the setting takes effect on the next connection rather than the next
    // window — a security setting you have to restart to apply is a security
    // setting that stays wrong.
    // A phone should see the window the way the editor shows it — the same
    // folders, the same projects, the same history — rather than a flat list
    // that happens to contain the same instances.
    this.folders = deps.folders || null;
    // Running a command on this machine, when a device is allowed to. Null when
    // the window has not been given one, which is how the feature is turned off.
    this.terminals = deps.terminals || null;
    // Whether this laptop may go to sleep: `state()` and `set(on)`. Null when the
    // window has not offered it, which a phone reads as "nothing to show".
    this.keepAwake = deps.keepAwake || null;
    // Hearing what was said into the phone: `state()` and `transcribe(wav)`
    // (voice.js). Null when the window has not offered it.
    this.voice = deps.voice || null;
    this.projectRoot = deps.projectRoot || null;
    this.history = deps.history || null;
    this.report = deps.report || null;
    this.requireSealed = deps.requireSealed || (() => true);
    this.appOnly = deps.appOnly || (() => false);
    this.gate = deps.gate || new Gate({
      localKey: deps.localKey || new LocalKey(),
      devices: this.devices,
      identity: this.identity,
      requireSealed: () => this.requireSealed()
    });
    this.log = deps.log || (() => {});
    this.announcer = deps.announce || null;
    // What this window is running, told to a device once it has proved itself.
    // An app carries its own copy of the client, so the two can drift — and a
    // phone showing a version of the client the laptop no longer speaks is the
    // kind of problem that presents as everything being subtly wrong.
    this.version = deps.version || require('../package.json').version;
    this.server = null;
    this.port = 0;
    this.clients = new Set();
    // Android phones' background services, each holding the notification
    // stream open: { device, hash, res, timer }.
    this.listeners = new Set();
    this.fleetClients = new Set();
    this.seq = 0;
    this.refusals = [];
    this.attempts = new Map();
    this.movedFrom = null;
    this.stopWatching = null;
    this.stateWatchers = new Set();

    // A grant taken away has to reach a socket that is already open, or
    // revoking would mean "next time". The same change is also news to every
    // other device watching the list — a phone removed on the laptop should
    // disappear from the other phone's screen, not linger until it is reopened.
    if (this.devices && this.devices.onChange) {
      this.stopWatchingDevices = this.devices.onChange(() => {
        this.reconcile();
        this.broadcastDevices();
        // Who may flip the keep-awake switch is a grant, so a grant changing is
        // news to that row as well.
        this.broadcastAwake();
      });
    }
    if (typeof deps.watchFleet === 'function') {
      this.stopWatching = deps.watchFleet(() => this.broadcastFleet());
    }
  }

  get listening() {
    return !!this.server && this.server.listening;
  }

  /** Told whenever the server starts or stops, for anything that follows it. */
  onState(fn) {
    this.stateWatchers.add(fn);
    return () => this.stateWatchers.delete(fn);
  }

  /**
   * Something a person should be told, rather than a line in a log nobody is
   * reading. Rare by design — a notification you learn to dismiss is worse than
   * none — so this is for the handful of things that change what a device is
   * allowed to be.
   */
  announce(event) {
    if (!this.announcer) return;
    try { this.announcer(event); } catch (_) { /* a listener's problem, not the server's */ }
  }

  /**
   * Something a person should see, to every device that is already here.
   *
   * Not a session message: it belongs to the device rather than to any one
   * instance, so it goes to every socket a device is holding, whether that
   * socket is watching the window or one conversation in it.
   *
   * @returns {number} how many were told
   */
  notifyDevices(message) {
    // `to` names the one device this is for. Everything about a notification —
    // which phone asked for the work, whether it has been put down — is decided
    // before it gets here; this only has to not undo that by shouting.
    const only = message && message.to;
    let told = 0;
    for (const client of this.clients) {
      if (!client.device || client.device.kind !== 'device') continue;
      if (only && client.device.id !== only) continue;
      client.post(Object.assign({ type: '@notify' }, message));
      told++;
    }
    const event = 'event: notify\ndata: ' + JSON.stringify(Object.assign({ type: '@notify' }, message)) + '\n\n';
    for (const listener of [...this.listeners]) {
      if (only && listener.device !== only) continue;
      if (this.writeListener(listener, event)) told++;
    }
    return told;
  }

  /**
   * A secret for this phone's background service, handed over on the socket it
   * has just signed in on — sealed, if the socket is — and only to a paired
   * device. A new one replaces the old, so a stream still open with the old one
   * is closed the next time anything is written to it.
   */
  issueListener(client) {
    const device = client && client.device;
    if (!this.devices || !device || device.kind !== 'device') return false;
    const secret = crypto.randomBytes(32).toString('base64url');
    if (!this.devices.setListener(device.id, sha256(secret))) return false;
    client.post({ type: '@listener', secret });
    this.log(`${device.name} can be told things while NikUI is closed`);
    return true;
  }

  /**
   * The stream an Android phone's background service holds open, so it is told
   * while the app is closed and the screen is off.
   *
   * Server-sent events, opened with the listener secret. It carries @notify and
   * nothing else — no instance, no prompt, nothing that can be sent back — so
   * the secret is worth exactly the notifications that phone is shown anyway.
   */
  serveListener(req, res) {
    const offered = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ''));
    const device = offered && this.devices ? this.devices.byListener(sha256(offered[1])) : null;
    if (!device) {
      if (!this.allowAttempt(req, 'listen')) return plain(res, 429, 'Too many tries; wait a minute');
      this.refuse(req, 'listener: no such secret');
      return plain(res, 401, 'Not a listener');
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    });
    if (req.socket) { req.socket.setTimeout(0); req.socket.setKeepAlive(true, LISTENER_PING_MS); }
    res.write(': listening\n\n');
    const listener = { device: device.id, hash: device.listener.hash, res, timer: null };
    // Something every half minute, so neither end — nor tailscale between
    // them — takes a quiet line for a dead one.
    listener.timer = setInterval(() => this.writeListener(listener, ': ping\n\n'), LISTENER_PING_MS);
    if (listener.timer.unref) listener.timer.unref();
    this.listeners.add(listener);
    const gone = () => { clearInterval(listener.timer); this.listeners.delete(listener); };
    req.on('close', gone);
    res.on('close', gone);
    this.log(`${device.name} is listening in the background`);
  }

  /** Written only while the device still holds this secret; closed otherwise. */
  writeListener(listener, text) {
    const device = this.devices && this.devices.get(listener.device);
    if (!device || !device.listener || device.listener.hash !== listener.hash) {
      clearInterval(listener.timer);
      this.listeners.delete(listener);
      try { listener.res.end(); } catch (_) { /* already gone */ }
      return false;
    }
    try { listener.res.write(text); return true; } catch (_) { return false; }
  }

  /**
   * An iPhone saying where Apple can find it. Refused for anything that is not
   * a paired device, because a token is a thing this window will later send to
   * a third party and it should only ever be one a device it knows asked for.
   */
  rememberApple(device, token) {
    if (!this.devices || !device || device.kind !== 'device') return false;
    const kept = this.devices.subscribeApple(device.id, token);
    if (!kept) {
      this.log(`${device.name} offered something that is not a device token`);
      return false;
    }
    this.log(`${device.name} can be reached through Apple when it is closed`);
    return true;
  }

  announceState() {
    for (const fn of this.stateWatchers) {
      try { fn(this.listening); } catch (_) { /* a watcher's problem */ }
    }
  }

  /** The address to open on this machine, key and all. */
  get url() {
    return this.listening ? `http://127.0.0.1:${this.port}/?key=${this.gate.key}` : null;
  }

  /** Where a device should be told to find this server. */
  get publicHost() {
    return this.host_ || `127.0.0.1:${this.port}`;
  }

  set publicHost(value) {
    this.host_ = value || null;
  }

  /**
   * https once something with a certificate is in front of this, which is the
   * only way a phone can hold a device key: Web Crypto does not exist outside a
   * secure context, and loopback is the only insecure origin browsers trust.
   */
  get publicScheme() {
    return this.host_ ? 'https' : 'http';
  }

  /** Whether anything outside this machine can currently reach the server. */
  get exposed() {
    return !!this.host_;
  }

  /**
   * Listen, on the port asked for if it is free and on any free one if it is
   * not. A second window is a normal thing to have open, and telling somebody
   * to go and change a setting they share between windows is not an answer —
   * especially as the address is handed out rather than typed.
   */
  async start(port, options) {
    try {
      return await this.listen(port);
    } catch (err) {
      const taken = err && err.code === 'EADDRINUSE';
      if (!taken || (options && options.exactly) || !Number(port)) throw err;
      this.log(`port ${port} is taken; asking for any free one`);
      const server = await this.listen(0);
      this.movedFrom = Number(port);
      return server;
    }
  }

  listen(port) {
    if (this.listening) return Promise.resolve(this);
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log('request failed: ' + ((err && err.stack) || err));
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
        this.announceState();
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
    for (const listener of [...this.listeners]) {
      clearInterval(listener.timer);
      try { listener.res.end(); } catch (_) { /* already gone */ }
    }
    this.listeners.clear();
    this.clients.clear();
    this.fleetClients.clear();
    this.announceState();
    return new Promise((resolve) => {
      server.close(() => { this.log('stopped'); resolve(); });
      // A client that will not hang up should not keep the window open.
      setTimeout(() => resolve(), 250).unref();
    });
  }

  dispose() {
    if (this.stopWatching) { this.stopWatching(); this.stopWatching = null; }
    if (this.stopWatchingDevices) { this.stopWatchingDevices(); this.stopWatchingDevices = null; }
    return this.stop();
  }

  // ---- guards --------------------------------------------------------------

  hosts() {
    const names = this.loopbackHosts();
    if (this.host_) names.push(this.host_);
    return names;
  }

  loopbackHosts() {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
  }

  /**
   * Which scheme the client sees. The tailnet's proxy terminates TLS and says
   * so; everything else here is plain http on this machine.
   */
  schemeOf(req) {
    const forwarded = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
    if (forwarded === 'https' || forwarded === 'http') return forwarded;
    return this.host_ && req.headers && req.headers.host === this.host_ ? 'https' : 'http';
  }

  /**
   * The origins that are an app rather than a web page.
   *
   * A WebView serves the bundle from a fixed origin of its own, so everything
   * the app asks of a laptop is cross-origin — which the Origin check was
   * written to refuse, because a web page asking on somebody's behalf is the
   * attack it exists to stop. These three are not web pages: nothing can be
   * published at them, and a phone has no localhost for a site to sit on.
   */
  appOrigins() {
    return ['https://localhost', 'capacitor://localhost', 'ionic://localhost'];
  }

  /**
   * Whether an Origin may talk to this server, and whether it is an app.
   *
   * A loopback origin is allowed only while the request itself is loopback —
   * that is somebody developing against their own machine, and it is refused
   * the moment anything is forwarding, so a tunnel never widens this.
   */
  allowedOrigin(req, host) {
    const origin = String((req.headers && req.headers.origin) || '');
    if (!origin) return { ok: true, origin: null, app: false };
    if (origin === `http://${host}` || origin === `https://${host}`) {
      return { ok: true, origin, app: false };
    }
    if (this.appOrigins().includes(origin)) return { ok: true, origin, app: true };
    const loopbackOrigin = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
    if (loopbackOrigin && this.isLoopbackHost(req) && !forwarded(req)) {
      return { ok: true, origin, app: true };
    }
    return { ok: false, origin, app: false };
  }

  /**
   * Everything that must be true before anything is served. Returns null when
   * the request may proceed, or the reason it may not.
   */
  guard(req) {
    const address = (req.socket && (req.socket.remoteAddress || '')) || '';
    const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    if (!local) return { status: 403, reason: 'not from this machine' };

    const host = String((req.headers && req.headers.host) || '');
    if (!this.hosts().includes(host)) return { status: 403, reason: 'unexpected Host: ' + host };

    // Absent on a curl, always present from a browser. Present and neither
    // ours nor an app's means a page somewhere else is trying its luck.
    const allowed = this.allowedOrigin(req, host);
    if (!allowed.ok) return { status: 403, reason: 'unexpected Origin: ' + allowed.origin };
    return null;
  }

  /**
   * What an app is allowed to read of an answer.
   *
   * Named exactly, never `*`, and without credentials: the app proves itself
   * with a signature, not with a cookie, so there is nothing here worth
   * carrying one for.
   */
  corsHeaders(req) {
    const host = String((req.headers && req.headers.host) || '');
    const allowed = this.allowedOrigin(req, host);
    if (!allowed.ok || !allowed.app) return null;
    return {
      'access-control-allow-origin': allowed.origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin'
    };
  }

  /**
   * Pairing and subscribing are deliberate, occasional acts. Neither the code
   * nor the signature can be guessed at, so this is not what stops an attack —
   * it is what stops a mistake or a loop from being answered ten thousand times.
   */
  allowAttempt(req, kind) {
    const now = Date.now();
    const address = (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = kind + ':' + address;
    const seen = this.attempts.get(key) || [];
    const recent = seen.filter((at) => now - at < ATTEMPT_WINDOW_MS);
    if (recent.length >= ATTEMPTS_ALLOWED) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    if (this.attempts.size > 64) {
      // Nothing here is worth remembering once it has gone quiet.
      for (const [at, times] of this.attempts) {
        if (!times.some((time) => now - time < ATTEMPT_WINDOW_MS)) this.attempts.delete(at);
      }
    }
    return true;
  }

  refuse(req, why) {
    const entry = { at: Date.now(), url: String((req && req.url) || ''), why };
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

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const route = decodeURIComponent(url.pathname);
    const cors = this.corsHeaders(req);

    // An app's POST carries JSON, which a browser asks permission for first.
    if (req.method === 'OPTIONS') {
      res.writeHead(cors ? 204 : 405, Object.assign({ 'content-length': 0 }, cors || null));
      return res.end();
    }
    if (cors) for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);

    // App-only: from anywhere but this machine, the only things that exist are
    // the ones the app actually uses. No page, no client, no worker, no
    // manifest — nothing to find, nothing to render, nothing to get wrong.
    // Loopback is untouched, because that is this laptop's own browser.
    if (this.appOnly() && !this.isLoopbackHost(req) && !isAppRoute(req.method, route)) {
      this.refuse(req, 'app-only: ' + route);
      return plain(res, 404, 'No such page');
    }

    if (req.method === 'POST' && route === '/pair') return this.pair(req, res);
    if (req.method === 'POST' && route === '/push/subscribe') return this.subscribe(req, res);
    if (req.method === 'GET' && route === '/notify/listen') return this.serveListener(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Only GET');

    // The key arrived in the address bar; put it in a cookie and take it back
    // out, so it is not sitting in the URL to be screenshotted or shared.
    if (url.searchParams.has('key')) {
      const offered = this.gate.http(req, { loopbackHost: this.isLoopbackHost(req) });
      url.searchParams.delete('key');
      const headers = { location: url.pathname + (url.search || ''), 'cache-control': 'no-store' };
      if (offered.ok) {
        headers['set-cookie'] = `nikui=${encodeURIComponent(this.gate.key)}; Path=/; HttpOnly; SameSite=Strict` +
          (this.schemeOf(req) === 'https' ? '; Secure' : '');
      }
      res.writeHead(302, headers);
      return res.end();
    }

    if (route === '/media/' || route.startsWith('/media/')) {
      return this.serveAsset(res, route.slice('/media/'.length));
    }
    // Enough for a phone to tell "the laptop is not reachable" from "the laptop
    // is there and would not have me". No data, so it costs nothing to answer.
    if (route === '/health') return json(res, 200, { ok: true });
    // The public half of this window's sending identity. Public by definition:
    // it is what the browser hands the push service to say who may send.
    if (route === '/push/key') {
      return json(res, 200, { key: this.vapid ? this.vapid.applicationServerKey : null });
    }
    // The worker has to come from the root or it cannot look after the pages.
    if (route === '/sw.js') return this.serveWorker(res);
    if (route === '/manifest.webmanifest') return this.serveManifest(res);
    if (route === '/pair') return this.servePairing(req, res);
    if (route === '/') return this.serveHome(req, res);
    // The shell carries no data, so an unpaired device gets markup and nothing
    // else. Which instance it is for — and whether that instance still exists —
    // is a matter for the socket.
    if (route.startsWith('/s/')) {
      const id = route.slice(3);
      // An id is a name this window made, and nothing else is one. Refusing the
      // rest here means no part of a URL somebody else chose is ever put into a
      // page — the check below this is the belt, and this is the braces.
      if (!SESSION_ID.test(id)) return plain(res, 404, 'No such instance');
      return this.serveClient(req, res, id);
    }
    return plain(res, 404, 'No such page');
  }

  /** Every instance in the window, drawn by the client from the socket. */
  serveHome(req, res) {
    const nonce = randomNonce();
    const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${this.csp(req, nonce)}">
<link rel="stylesheet" href="/media/browser.css">
<title>NikUI</title>
${this.appHead(nonce)}</head>
<body class="home">
  <header class="home-head">
    <h1>NikUI</h1>
    <div class="link" id="link" role="status" aria-live="polite" hidden></div>
  </header>
  <p class="lede" id="lede">Connecting&hellip;</p>
  <div class="rows" id="rows"></div>
  <script nonce="${nonce}">window.NIKUI_REMOTE = ${jsonForScript({ session: null, socket: '/socket' })};</script>
  <script nonce="${nonce}" src="/media/device.js"></script>
  <script nonce="${nonce}" src="/media/secure.js"></script>
  <script nonce="${nonce}" src="/media/transport.js"></script>
  <script nonce="${nonce}" src="/media/home.js"></script>
</body>
</html>`;
    return html(res, page, this.csp(req, nonce));
  }

  /** The client itself: the same page the webview gets, with no data in it. */
  serveClient(req, res, id) {
    const nonce = randomNonce();
    const page = renderPage({
      asset: (file) => '/media/' + file,
      nonce,
      csp: this.csp(req, nonce),
      head: '<link rel="stylesheet" href="/media/browser.css">\n' +
        this.appHead(nonce),
      // The only thing the browser client needs that the webview does not:
      // where its socket is. Everything else it learns over that socket.
      boot: `window.NIKUI_REMOTE = ${JSON.stringify({
        session: id,
        socket: '/socket' + (id ? '?session=' + encodeURIComponent(id) : '')
      })};`
    });
    return html(res, page, this.csp(req, nonce));
  }

  serveWorker(res) {
    return this.sendFile(res, 'sw.js', 'text/javascript; charset=utf-8', {
      // Served from /sw.js, so its scope is the whole site rather than /media.
      'service-worker-allowed': '/'
    });
  }

  serveManifest(res) {
    return this.sendFile(res, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8');
  }

  sendFile(res, name, type, extra) {
    fs.readFile(path.join(this.root, 'media', name), (err, body) => {
      if (err) return plain(res, 404, 'No such file');
      res.writeHead(200, Object.assign({
        'content-type': type,
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }, extra || {}));
      res.end(body);
    });
  }

  /**
   * A device asking to be told about things while it is not looking.
   *
   * The subscription belongs to the device that signed for it, and is kept on
   * that device's record — so forgetting a device forgets where to reach it,
   * without anything else having to remember to.
   */
  async subscribe(req, res) {
    if (!this.allowAttempt(req, 'subscribe')) {
      this.refuse(req, 'too many subscription attempts');
      return json(res, 429, { error: 'too many attempts — wait a minute' });
    }
    let body;
    try { body = await readJson(req); } catch (err) {
      this.refuse(req, 'bad subscription body: ' + err.message);
      return json(res, 400, { error: 'that was not a subscription' });
    }
    if (!this.devices) return json(res, 503, { error: 'this window has no devices' });

    const endpoint = String(body.endpoint || '');
    if (!isPushEndpoint(endpoint)) {
      this.refuse(req, 'push endpoint is not a push service: ' + endpoint.slice(0, 120));
      return json(res, 400, { error: 'that is not a push service' });
    }
    if (!body.keys || !body.keys.p256dh || !body.keys.auth) return json(res, 400, { error: 'no keys' });

    // Signed over the endpoint and a time, so a subscription cannot be filed
    // against somebody else's device and a captured body is not good forever.
    const at = Number(body.at || 0);
    if (!at || Math.abs(Date.now() - at) > SUBSCRIBE_WINDOW_MS) {
      this.refuse(req, 'push subscription is from another time');
      return json(res, 403, { error: 'that subscription is too old to accept' });
    }
    if (!this.devices.verify(String(body.device || ''), `nikui-push:${at}:${endpoint}`, body.signature)) {
      this.refuse(req, 'push subscription was not signed by that device');
      return json(res, 403, { error: 'that signature is not this device' });
    }

    const device = this.devices.subscribe(body.device, {
      endpoint,
      keys: { p256dh: String(body.keys.p256dh), auth: String(body.keys.auth) }
    });
    if (!device) return json(res, 404, { error: 'no such device' });
    this.log(`${device.name} will be told about things`);
    return json(res, 200, { ok: true });
  }

  /** The page a device lands on from the QR, or from a typed code. */
  servePairing(req, res) {
    const nonce = randomNonce();
    const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${this.csp(req, nonce)}">
<link rel="stylesheet" href="/media/browser.css">
<title>Pair with NikUI</title>
<meta name="theme-color" content="#17171a">
<script nonce="${nonce}" src="/media/theme.js" defer></script>
</head>
<body class="home pairing">
  <h1>Pair this device</h1>
  <p class="lede" id="lede">Checking this device&rsquo;s key&hellip;</p>
  <form class="pair-form" id="form" hidden>
    <label for="code">Code from the editor</label>
    <input id="code" name="code" inputmode="latin" autocapitalize="characters" autocomplete="off"
           spellcheck="false" maxlength="9" placeholder="ABCD2345">
    <label for="name">Name for this device</label>
    <input id="name" name="name" autocomplete="off" maxlength="32" placeholder="My phone">
    <button id="go" type="submit">Pair</button>
  </form>
  <p class="note" id="note"></p>
  <script nonce="${nonce}" src="/media/device.js"></script>
  <script nonce="${nonce}" src="/media/pair.js"></script>
</body>
</html>`;
    return html(res, page, this.csp(req, nonce));
  }

  /**
   * A device introducing itself. This is the one route that answers without a
   * key, so everything it accepts is bounded: a code that is open for a minute
   * and dies on first use or first wrong guess, a body that cannot be large,
   * and a signature that has to be over that exact code.
   */
  async pair(req, res) {
    if (!this.allowAttempt(req, 'pair')) {
      this.refuse(req, 'too many pairing attempts');
      return json(res, 429, { error: 'too many attempts — wait a minute' });
    }
    let body;
    try { body = await readJson(req); } catch (err) {
      this.refuse(req, 'bad pairing body: ' + err.message);
      return json(res, 400, { error: 'that was not a pairing request' });
    }
    if (!this.pairing || !this.devices || !this.identity) {
      return json(res, 503, { error: 'this window cannot pair devices' });
    }

    const claim = this.pairing.claim(body.code);
    if (!claim.ok) {
      this.refuse(req, 'pairing refused: ' + claim.reason);
      return json(res, 403, { error: claim.reason });
    }

    // The signature proves two things at once: the device holds the private key
    // for the public one it is offering, and it knew the code.
    const signed = `nikui-pair:${String(body.code || '').trim().toUpperCase()}`;
    const { verifyWith } = require('./identity');
    if (!body.publicKey || !verifyWith(body.publicKey, signed, body.signature)) {
      this.refuse(req, 'pairing signature did not verify');
      return json(res, 403, { error: 'that signature does not match the key offered' });
    }

    const address = (req.socket && req.socket.remoteAddress) || null;
    const device = this.devices.add({
      name: body.name, publicKey: body.publicKey, address,
      protection: body.protection, biometric: body.biometric
    });
    if (!device) return json(res, 400, { error: 'that is not a P-256 public key' });
    this.devices.record({ device, action: 'paired', allowed: true });
    this.log(`paired ${device.name} (${device.id})`);

    return json(res, 200, {
      device: device.id,
      name: device.name,
      control: device.control,
      serverKey: this.identity.publicKeySpki,
      fingerprint: this.identity.fingerprint
    });
  }

  /**
   * What makes it an app on a home screen rather than a page in a browser: a
   * manifest, an icon, a colour for the bar at the top, and a worker that keeps
   * the shell so a cold start is not a white rectangle.
   */
  appHead(nonce) {
    return '<link rel="manifest" href="/manifest.webmanifest">\n' +
      '<meta name="theme-color" content="#17171a">\n' +
      '<meta name="apple-mobile-web-app-capable" content="yes">\n' +
      '<meta name="apple-mobile-web-app-title" content="NikUI">\n' +
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n' +
      '<link rel="apple-touch-icon" href="/media/icons/apple-touch-icon-180.png">\n' +
      `<script nonce="${nonce}" src="/media/theme.js" defer></script>\n` +
      `<script nonce="${nonce}" src="/media/mobile.js" defer></script>\n` +
      `<script nonce="${nonce}" src="/media/pwa.js" defer></script>\n`;
  }

  csp(req, nonce) {
    const origin = `${this.schemeOf(req)}://${req.headers.host}`;
    const socket = origin.replace(/^http/, 'ws');
    return [
      "default-src 'none'",
      "img-src 'self' data: https:",
      "style-src 'self'",
      `script-src 'nonce-${nonce}'`,
      "font-src 'self'",
      // A service worker and a manifest are both fetched under their own
      // directives, and both fall back to default-src — which is 'none'. Without
      // these two lines the app is not installable and the shell is not cached,
      // and the only sign of it is a line in a console nobody is watching.
      "worker-src 'self'",
      "manifest-src 'self'",
      `connect-src ${origin} ${socket}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ');
  }

  /**
   * A file from media/, and nothing else.
   *
   * Two checks, because one is not enough. `path.resolve` is lexical: it settles
   * `..` but knows nothing about symlinks, so the resolved path is then resolved
   * again on the disk and checked a second time. Only then is the extension
   * consulted, and only a handful of them are servable at all.
   */
  serveAsset(res, name) {
    const dir = path.join(this.root, 'media');
    const file = path.resolve(dir, name);
    if (file !== dir && !file.startsWith(dir + path.sep)) return plain(res, 403, 'Outside media');

    const type = ASSET_TYPES[path.extname(file).toLowerCase()];
    if (!type) return plain(res, 403, 'Not a servable type');

    fs.realpath(file, (err, real) => {
      if (err) return plain(res, 404, 'No such file');
      if (real !== dir && !real.startsWith(dir + path.sep)) return plain(res, 403, 'Outside media');
      this.readAsset(res, real, type);
    });
  }

  readAsset(res, file, type) {
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

  isLoopbackHost(req) {
    return this.loopbackHosts().includes(String((req.headers && req.headers.host) || ''));
  }

  upgrade(req, socket, head) {
    const deny = (status, reason) => {
      this.refuse(req, reason);
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
        'connection: close\r\ncontent-length: 0\r\n\r\n');
    };

    const blocked = this.guard(req);
    if (blocked) return deny(blocked.status, blocked.reason);

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname !== '/socket') return deny(404, 'no such socket');
    if (String(req.headers['sec-websocket-version'] || '') !== '13') return deny(400, 'websocket version');
    const key = req.headers['sec-websocket-key'];
    if (!key) return deny(400, 'no websocket key');
    if (this.clients.size >= MAX_SOCKETS) return deny(503, 'too many sockets');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'upgrade: websocket\r\n' +
      'connection: Upgrade\r\n' +
      `sec-websocket-accept: ${wire.accept(key)}\r\n\r\n`
    );

    const client = new RemoteClient({
      id: 'socket-' + (this.seq++),
      socket,
      wants: url.searchParams.get('session') || null,
      version: this.version,
      address: (req.socket && req.socket.remoteAddress) || null,
      server: this,
      log: this.log
    });
    this.clients.add(client);
    if (head && head.length) client.framer.push(head);

    // Everyone is challenged, including this machine's own browser holding the
    // key. It does not have to sign — a seat it could take by opening the editor
    // is not worth proving — but the challenge goes out anyway, so that a client
    // which *can* prove things is never seated without being asked to. A welcome
    // that arrives unprompted is then always somebody skipping the question.
    client.allowLocal = this.gate.http(req, { loopbackHost: this.isLoopbackHost(req) }).ok;
    client.challenge(this.gate);
  }

  /** Plug an authorised socket into whatever it asked for. */
  seat(client) {
    if (client.wants) {
      const session = this.sessions.get(client.wants);
      if (!session) return client.deny('that instance is not open any more');
      const hub = this.hubs.hubFor(session, this.host);
      hub.attach({ id: client.id, kind: 'socket', device: client.device, post: (m) => client.post(m) });
      client.bind({
        receive: (message) => {
          // Voice is the laptop's, not the instance's: the conversation's
          // socket is simply the one the phone is holding when it talks.
          if (message && (message.type === 'voice' || message.type === 'voice:state')) {
            return this.voiceMessage(client, message);
          }
          return hub.receive(client.id, message);
        },
        device: (device) => hub.setDevice(client.id, device),
        detach: () => {
          hub.detach(client.id);
          // The hub outlives this socket only while somebody else is watching.
          if (hub.size === 0 && this.hubs.closeHub) this.hubs.closeHub(session.id);
        }
      });
      this.log(`${client.id} attached to ${session.id} as ${client.device.name}`);
      return true;
    }

    this.fleetClients.add(client);
    // Who is connected is part of what the list says, so arriving and leaving
    // are both changes to it.
    this.broadcastDevices();
    client.bind({
      receive: async (message) => {
        if (!message) return;
        // Anything at all from a device is somebody using the app, which is
        // what wakes it back up if it had gone quiet.
        if (this.audience && client.device && client.device.kind === 'device') {
          this.audience.active(client.device.id);
        }
        try {
          if (message.type === 'ready') return void client.post(this.fleetMessage());
          if (message.type === 'history') return void client.post(await this.historyMessage(message));
          if (message.type === 'status') return void client.post(this.statusMessage());
          if (message.type === 'devices') return void client.post(this.devicesMessage(client));
          if (message.type === 'forget') return void this.forgetFor(client, message.id);
          if (message.type === 'awake') return void this.tellAwake(client);
          if (message.type === 'awake:set') return void (await this.setAwakeFor(client, message.on));
          if (message.type === 'lid:set') return void (await this.setLidFor(client, message.on));
          if (message.type.indexOf('term:') === 0) return void this.terminalFor(client, message);
          if (message.type === 'voice' || message.type === 'voice:state') return void (await this.voiceMessage(client, message));
        } catch (err) {
          // A handler that throws used to answer nothing at all, and nothing at
          // all is the one answer a phone cannot act on: it waits, and then it
          // says the laptop is unreachable, which is a lie about a typo. One
          // stale variable name in `terminalFor` did exactly that.
          this.log(`${client.id} asked ${message.type} and it threw: ${(err && err.message) || err}`);
          client.post({
            type: message.type.indexOf('term:') === 0 ? 'term:no'
              : '@refused',
            id: message.id,
            what: message.type,
            reason: 'That went wrong on the laptop: ' + ((err && err.message) || 'unknown error')
          });
        }
      },
      device: () => {},
      detach: () => {
        this.fleetClients.delete(client);
        this.broadcastDevices();
      }
    });
    this.log(`${client.id} is watching the window as ${client.device.name}`);
    return true;
  }

  fleetMessage() {
    const placed = this.folders ? this.folders.list() : [];
    const instances = this.sessions.list().map((session) => {
      const folder = placed.find((f) => (f.sessions || []).includes(session.id)) || null;
      const root = this.projectRoot ? this.projectRoot(session.cwd) : '';
      return {
        id: session.id,
        label: session.customTitle || session.label,
        status: session.status,
        cwd: session.cwd,
        cost: session.totalCost || 0,
        queued: (session.queue || []).length,
        paused: !!session.isPaused,
        asleep: !!session.isAsleep,
        unread: !!session.unread,
        // Where the editor files it: a folder somebody made, or the project its
        // directory belongs to. Sent rather than guessed from the path, because
        // a worktree belongs to its project and a path does not say so.
        folder: folder ? { id: folder.id, name: folder.name } : null,
        project: root ? { path: root, name: root.split(/[\\/]/).filter(Boolean).pop() || root } : null
      };
    });
    return {
      type: 'fleet',
      instances,
      // Folders that exist but have nothing in them are still folders.
      folders: placed.map((f) => ({ id: f.id, name: f.name })),
      at: Date.now()
    };
  }

  /**
   * Exactly what `/status` draws, built the same way the hub builds it.
   *
   * Not a summary of it and not a second opinion about it: the same
   * `buildReport` over the same facts, rendered on the phone by the same
   * `media/status.js`. A screen that says almost what another screen says is
   * two screens to keep in step.
   */
  statusMessage() {
    if (!this.report) return { type: 'status', report: null, available: false };
    try {
      return { type: 'status', report: this.report(), available: true };
    } catch (err) {
      this.log('the status report could not be built: ' + (err && err.message));
      return { type: 'status', report: null, available: true, trouble: 'could not be built' };
    }
  }

  /**
   * Conversations this machine has had before, which is what the editor's
   * History view lists. Read-only, and the same information a watching device
   * already sees the live half of.
   */
  async historyMessage(ask) {
    if (!this.history) return { type: 'history', entries: [], available: false };
    try {
      const entries = await this.history({
        limit: Math.min(Math.max(Number((ask && ask.limit) || 40), 1), 200),
        cwd: ask && ask.cwd ? String(ask.cwd) : undefined
      });
      return { type: 'history', entries: entries || [], available: true };
    } catch (err) {
      this.log('history could not be read: ' + (err && err.message));
      return { type: 'history', entries: [], available: true, trouble: 'could not be read' };
    }
  }

  /**
   * The other devices paired with this window, as one of them sees them.
   *
   * A phone that can be paired should be able to see what else is paired, and
   * take one off — losing a phone is exactly when you are not at the laptop, and
   * the laptop is where the only remove button was.
   *
   * `here` is measured from the sockets that are open right now rather than
   * from `lastSeenAt`, because "is my other phone connected" is a question about
   * now. `me` is how the app knows which row is its own.
   */
  devicesMessage(client) {
    const seat = client && client.device;
    const open = new Set();
    for (const other of this.clients) {
      if (other.device && other.device.kind === 'device') open.add(other.device.id);
    }
    const list = (this.devices ? this.devices.list() : []).map((device) => ({
      id: device.id,
      name: device.name,
      control: !!device.control,
      protection: device.protection || 'software',
      biometric: !!device.biometric,
      pairedAt: device.pairedAt || null,
      lastSeenAt: device.lastSeenAt || null,
      here: open.has(device.id),
      me: !!(seat && seat.id === device.id)
    }));
    return {
      type: 'devices',
      devices: list,
      // Removing your own is always yours to do. Removing somebody else's is
      // the same authority as sending a prompt, and for the same reason: it is
      // a change to what this machine will accept, not a thing you are reading.
      mayManage: !!(seat && seat.kind === 'device' && seat.control),
      me: seat && seat.kind === 'device' ? seat.id : null
    };
  }

  /**
   * Take a device off, at another device's asking.
   *
   * Its own is always allowed — a phone should be able to hand itself back
   * without needing the laptop. Anyone else's needs control, because a watching
   * device that could unpair the others would be a way to lock somebody out of
   * their own machine from a seat that is supposed to be read-only.
   */
  forgetFor(client, id) {
    const seat = client && client.device;
    const wanted = String(id || '');
    const target = this.devices ? this.devices.get(wanted) : null;
    const mine = !!(seat && seat.id === wanted);

    if (!seat || seat.kind !== 'device') {
      return void client.post({ type: 'devices', refused: 'only a paired device can do that' });
    }
    if (!target) {
      return void client.post(Object.assign(this.devicesMessage(client),
        { refused: 'that device is already gone' }));
    }
    if (!mine && !seat.control) {
      this.devices.record({
        device: { id: seat.id, name: seat.name }, allowed: false,
        action: 'tried to remove another device', detail: target.name
      });
      return void client.post(Object.assign(this.devicesMessage(client),
        { refused: 'this device may watch, but not remove another' }));
    }

    this.devices.record({
      device: { id: seat.id, name: seat.name }, allowed: true,
      action: mine ? 'removed itself' : 'removed another device',
      detail: mine ? null : target.name
    });
    // The store's own change fires `reconcile`, which closes whatever socket
    // the removed device was holding — including this one, when it is its own.
    this.devices.forget(target.id);
    if (this.audience) this.audience.forget(target.id);
  }

  /**
   * Whether this laptop will stay awake, as one device sees it.
   *
   * Anybody paired may know — "will I still be able to reach it tonight" is a
   * question about reading, not changing. Only a device that may send prompts
   * may flip it, and `mayChange` is how the phone knows which it is.
   */
  awakeMessage(client) {
    if (!this.keepAwake) return { type: 'awake', available: false };
    const seat = client && client.device;
    const now = this.keepAwake.state() || {};
    return {
      type: 'awake',
      available: true,
      on: !!now.on,
      held: !!now.held,
      since: now.since || null,
      reason: now.reason || null,
      supported: now.supported !== false,
      mayChange: this.mayKeepAwake(seat),
      // The lid: the other way this laptop goes to sleep, and the one that
      // matters most when you are not at it.
      lid: now.lid ? {
        on: !!now.lid.on,
        supported: !!now.lid.supported,
        approved: now.lid.approved === true,
        held: !!now.lid.held,
        reason: now.lid.reason || null,
        finishing: !!now.lid.finishing,
        lowBattery: !!now.lid.lowBattery,
        battery: now.lid.battery || null
      } : null
    };
  }

  /**
   * The same grant as sending a prompt, for the same reason as removing another
   * device: it changes what this machine does, rather than showing what it is
   * doing. A watching seat that could keep a laptop awake all week, or let it
   * sleep in the middle of somebody else's job, would not be watching.
   *
   * The editor's own browser on loopback is this machine, as it is for the
   * terminal, and may.
   */
  mayKeepAwake(seat) {
    if (!seat) return false;
    return seat.kind === 'device' ? !!seat.control : true;
  }

  /** Answer one device, and remember that it has been told. */
  tellAwake(client) {
    const message = this.awakeMessage(client);
    client.awakeSaid = JSON.stringify(message);
    client.post(message);
  }

  /** A phone switching it: on, off, and what is true afterwards. */
  async setAwakeFor(client, on) {
    const seat = client && client.device;
    const wanted = !!on;
    if (!this.keepAwake) return void client.post(this.awakeMessage(client));

    if (!this.mayKeepAwake(seat)) {
      this.note(seat, wanted ? 'tried to keep the laptop awake' : 'tried to let the laptop sleep', '', false);
      return void client.post(Object.assign(this.awakeMessage(client), {
        refused: 'This device can watch but not change that. Grant it control in the editor.'
      }));
    }

    try {
      await this.keepAwake.set(wanted);
    } catch (err) {
      return void client.post(Object.assign(this.awakeMessage(client), {
        refused: err && err.code === 'NOT_LOADED'
          ? 'VS Code on your laptop needs reloading once before this works: NikUI was updated and it has not loaded the new settings yet.'
          : 'The laptop would not change it: ' + ((err && err.message) || 'unknown error')
      }));
    }
    this.note(seat, wanted ? 'kept the laptop awake' : 'let the laptop sleep', '');
    // Answered directly as well as broadcast: switching it to what it already
    // was changes nothing, so nothing would be broadcast, and a phone waiting
    // on an answer that never comes says the laptop is unreachable.
    this.tellAwake(client);
  }

  /**
   * The lid switch, from a phone. The same grant as the other one, and one
   * thing it will not do: raise the one-time approval. That is a password
   * dialog on the laptop's screen, and a phone asking for one would put it in
   * front of nobody — so a phone is told where to approve it instead.
   */
  async setLidFor(client, on) {
    const seat = client && client.device;
    const wanted = !!on;
    if (!this.keepAwake || !this.keepAwake.setLid) return void this.tellAwake(client);

    if (!this.mayKeepAwake(seat)) {
      this.note(seat, wanted ? 'tried to keep the laptop working with the lid closed'
        : 'tried to let the lid put the laptop to sleep', '', false);
      return void client.post(Object.assign(this.awakeMessage(client), {
        refused: 'This device can watch but not change that. Grant it control in the editor.'
      }));
    }

    try {
      await this.keepAwake.setLid(wanted);
    } catch (err) {
      return void client.post(Object.assign(this.awakeMessage(client), {
        refused: err && err.code === 'NEEDS_APPROVAL'
          ? 'Approve it once on your laptop first: click NikUI in the status bar, then Keep working with the lid closed.'
          : err && err.code === 'NOT_LOADED'
            ? 'VS Code on your laptop needs reloading once before this works: NikUI was updated and it has not loaded the new settings yet.'
            : 'The laptop would not change it: ' + ((err && err.message) || 'unknown error')
      }));
    }
    this.note(seat, wanted ? 'let the laptop work with the lid closed' : 'let the lid put the laptop to sleep', '');
    this.tellAwake(client);
  }

  /**
   * Every watching device, told what the switch says now — each in its own
   * terms, and only when those changed. This is called whenever the device list
   * moves, which includes a device merely being seen again; saying the same
   * thing to four sockets every time a phone is looked at is noise.
   */
  broadcastAwake() {
    if (!this.keepAwake || !this.fleetClients.size) return;
    for (const client of this.fleetClients) {
      if (!client.open) continue;
      const message = this.awakeMessage(client);
      const said = JSON.stringify(message);
      if (said === client.awakeSaid) continue;
      client.awakeSaid = said;
      client.post(message);
    }
  }

  /**
   * Whether this laptop can turn speech into text for this device, and why not.
   *
   * Behind the same grant as sending a prompt: the words go into a prompt, and
   * a watching seat has nothing to type into.
   */
  /** Either socket's voice messages, with an answer even when something throws. */
  async voiceMessage(client, message) {
    try {
      if (message.type === 'voice:state') return await this.voiceStateFor(client);
      return await this.voiceFor(client, message);
    } catch (err) {
      this.log(`${client.id} asked ${message.type} and it threw: ${(err && err.message) || err}`);
      client.post(message.type === 'voice'
        ? { type: 'voice:no', id: typeof message.id === 'string' ? message.id.slice(0, 64) : '', code: 'FAILED',
          reason: 'That went wrong on the laptop: ' + ((err && err.message) || 'unknown error') }
        : { type: 'voice:state', available: false, code: 'FAILED', reason: 'That went wrong on the laptop.' });
    }
  }

  async voiceStateFor(client) {
    const seat = client.device;
    if (!this.voice) {
      return void client.post({ type: 'voice:state', available: false, code: 'OFF',
        reason: 'This window is not offering voice.' });
    }
    if (seat && seat.kind === 'device' && !seat.control) {
      return void client.post({ type: 'voice:state', available: false, code: 'WATCH_ONLY',
        reason: 'This device can watch but not send prompts. Grant it control in the editor.' });
    }
    const state = await this.voice.state();
    // Asked about means about to be used: the first build is started now, not
    // when somebody has already said something and is waiting.
    if (state.available && state.needsBuild && this.voice.ensure) this.voice.ensure();
    client.post(Object.assign({ type: 'voice:state' }, state));
  }

  /**
   * One recording from the phone, turned into words for its composer.
   *
   * Never sent anywhere and never kept: written to a private temporary folder
   * for as long as the transcriber takes, then removed. The words go back only
   * to the device that asked, which puts them in its composer for somebody to
   * read — nothing is sent to an instance from here.
   */
  async voiceFor(client, message) {
    const seat = client.device;
    const id = typeof message.id === 'string' ? message.id.slice(0, 64) : '';
    const no = (code, reason) => client.post({ type: 'voice:no', id, code, reason });
    if (!this.voice) return void no('OFF', 'This window is not offering voice.');
    if (seat && seat.kind === 'device' && !seat.control) {
      this.note(seat, 'voice', 'refused', false);
      return void no('WATCH_ONLY', 'This device can watch but not send prompts. Grant it control in the editor.');
    }
    if (typeof message.audio !== 'string' || !message.audio) return void no('NO_AUDIO', 'Nothing was recorded.');
    if (message.audio.length > Math.ceil(voiceMaxBytes() / 3) * 4 + 8) {
      return void no('TOO_LONG', 'That recording is longer than five minutes.');
    }
    const state = await this.voice.state();
    if (!state.available) return void no(state.code || 'OFF', state.reason);
    if (state.building || state.needsBuild) {
      if (this.voice.ensure) this.voice.ensure();
      return void no('BUILDING', 'The laptop is setting up voice for the first time. ' +
        'It takes a few minutes; your recording is kept, so try again then.');
    }
    let heard;
    try {
      heard = await this.voice.transcribe(Buffer.from(message.audio, 'base64'));
    } catch (err) {
      return void no((err && err.code) || 'FAILED', (err && err.message) || 'That could not be transcribed.');
    }
    client.post({ type: 'voice:text', id, text: heard.text, seconds: heard.seconds, ms: heard.ms });
  }

  /**
   * A command on this machine, asked for from somewhere else.
   *
   * Behind `control`, and it has to be: this is a shell, and NikUI already runs
   * Claude with permissions bypassed, so a device that may send prompts can
   * already cause anything a terminal could. What it must never be is something
   * a *watching* device can reach — that seat is for reading, and reading is
   * what it should stay.
   *
   * Every refusal is written down with the rest, and so is every command, so
   * "what did that phone do" has one answer in one place.
   */
  terminalFor(client, message) {
    const seat = client.device;
    const say = (extra) => client.post(Object.assign({ type: 'term:no' }, extra));

    if (!this.terminals) {
      return say({ reason: 'this window is not offering a terminal' });
    }
    // The editor's own browser on loopback holds the key and is this machine;
    // a paired device needs the grant.
    const isDevice = !!(seat && seat.kind === 'device');
    if (isDevice && !seat.control) {
      this.note(seat, 'terminal', String(message.command || message.type).slice(0, 80), false);
      return say({ reason: 'This device can watch but not run commands. Grant it control in the editor.' });
    }

    const watched = client.terminals || (client.terminals = new Set());

    if (message.type === 'term:list') {
      return void client.post({ type: 'term:list', terminals: this.terminals.list() });
    }

    if (message.type === 'term:open') {
      // A path is never taken from the device. It says which instance it wants
      // to be beside and the window looks up where that is, so no string from
      // outside ever ends up as a working directory.
      //
      // Nothing named means home, not "whichever instance happens to be first".
      // A terminal that opens somewhere different depending on what the editor
      // had open is a terminal you have to check the top of before you trust
      // what you just typed.
      const session = message.session ? this.sessions.get(message.session) : null;
      const made = this.terminals.open({
        cwd: session ? session.cwd : null,
        name: session ? (session.customTitle || session.label) : 'Home'
      });
      watched.add(made.id);
      this.note(seat, 'opened a terminal', made.cwd);
      return void client.post({ type: 'term:opened', terminal: made });
    }

    const id = String(message.id || '');
    const there = this.terminals.get(id);
    if (!there) return say({ id, reason: 'that terminal is not open any more' });

    if (message.type === 'term:attach') {
      watched.add(id);
      return void client.post(Object.assign({ type: 'term:scrollback' }, this.terminals.scrollback(id)));
    }
    if (message.type === 'term:detach') { watched.delete(id); return; }
    if (message.type === 'term:close') {
      watched.delete(id);
      this.terminals.close(id);
      this.note(seat, 'closed a terminal', '');
      return void client.post({ type: 'term:closed', id });
    }
    if (message.type === 'term:stop') {
      this.note(seat, 'stopped a command', there.running ? there.running.command : '');
      this.terminals.stop(id);
      return;
    }
    if (message.type === 'term:run') {
      watched.add(id);
      const out = this.terminals.run(id, message.command);
      this.note(seat, 'ran a command', String(message.command || '').slice(0, 80), out.ok);
      if (!out.ok) return say({ id, reason: out.reason });
      return;
    }
  }

  /** One line in the same trail everything else a device does goes into. */
  note(seat, action, detail, allowed) {
    if (!this.devices || !seat || seat.kind !== 'device') return;
    this.devices.record({
      device: { id: seat.id, name: seat.name },
      action, detail, allowed: allowed !== false
    });
  }

  /** Whatever a terminal says, to whoever is watching that terminal. */
  terminalSaid(event) {
    const which = event.terminal && event.terminal.id ? event.terminal.id : event.terminal;
    for (const client of this.fleetClients) {
      if (!client.open || !client.terminals || !client.terminals.has(which)) continue;
      client.post(event);
    }
  }

  /**
   * Everyone still connected learns who is left — but only when that changed.
   *
   * The store fires one change event for everything it writes, including a line
   * in the trail, and a trail line is not news about who is paired. Sending the
   * list anyway put an unasked-for message in front of every answer to a
   * question, which is both noise and a way for a reply to arrive second.
   *
   * What counts as changed is what the other devices can see, so a device
   * merely being seen again does not wake four sockets.
   */
  broadcastDevices() {
    if (!this.fleetClients.size) return;
    const shape = JSON.stringify((this.devices ? this.devices.list() : []).map((d) =>
      [d.id, d.name, !!d.control, d.protection, !!d.biometric]));
    const here = JSON.stringify([...this.clients]
      .filter((c) => c.device && c.device.kind === 'device').map((c) => c.device.id).sort());
    const now = shape + here;
    if (now === this.lastDevices) return;
    this.lastDevices = now;
    for (const client of this.fleetClients) {
      if (!client.open) continue;
      client.post(this.devicesMessage(client));
    }
  }

  broadcastFleet() {
    if (!this.fleetClients.size) return;
    const message = this.fleetMessage();
    for (const client of this.fleetClients) client.post(message);
  }

  /**
   * A device's grant changed, or it was forgotten. Neither is allowed to mean
   * "from the next connection": a revoked device loses the socket it is holding.
   */
  reconcile() {
    if (!this.devices) return;
    for (const client of [...this.clients]) {
      const seat = client.device;
      if (!seat || seat.kind !== 'device') continue;
      const fresh = this.devices.get(seat.id);
      if (!fresh) {
        this.log(`${client.id} closed: ${seat.name} was removed`);
        client.close(wire.CLOSE.POLICY, 'this device was removed');
        continue;
      }
      if (!!fresh.control !== !!seat.control || fresh.name !== seat.name) {
        client.device = { id: fresh.id, name: fresh.name, kind: 'device', control: !!fresh.control };
        client.tellDevice();
      }
    }
  }
}

/**
 * One socket: the frames, the handshake, and then whatever it was let in for.
 *
 * Nothing above the frames is invented here — once the handshake is done this
 * carries the protocol the webview already speaks, unchanged.
 */
class RemoteClient {
  constructor(opts) {
    this.id = opts.id;
    this.socket = opts.socket;
    this.server = opts.server;
    this.wants = opts.wants;
    this.version = opts.version || null;
    this.address = opts.address;
    this.log = opts.log || (() => {});
    this.open = true;
    this.device = null;
    this.binding = null;
    this.pending = null;
    this.awaitingPong = 0;
    // The sealed channel, once the handshake agrees one. Null means this
    // connection is carrying plaintext inside TLS and nothing more — which is
    // only ever this machine's own browser, on loopback.
    this.box = null;
    this.sealed = false;

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
  }

  /** Ask the device to prove itself, and give up if it does not. */
  challenge(gate) {
    this.gate = gate;
    this.pending = gate.challenge();
    this.post(gate.challengeMessage(this.pending));
    this.deadline = setTimeout(() => {
      if (!this.device) this.deny('no answer to the challenge');
    }, 10000);
    if (this.deadline.unref) this.deadline.unref();
  }

  /**
   * @param {object} device
   * @param {object} [welcomeMessage]
   * @param {object} [box] the sealed channel, when one was agreed
   */
  welcome(device, welcomeMessage, box) {
    if (this.deadline) { clearTimeout(this.deadline); this.deadline = null; }
    this.device = device;
    this.pending = null;
    // Set before the welcome goes out, so the welcome is the first thing inside
    // the envelope rather than the last thing outside it.
    this.box = box || null;
    // Said once, to a client that has proved who it is: an app carrying its own
    // copy of the client needs to know whether it is the same copy.
    this.post(Object.assign({ type: '@welcome', device }, welcomeMessage || null,
      this.version ? { version: this.version } : null));
    this.server.seat(this);
  }

  deny(reason, extra) {
    this.log(`${this.id} denied: ${reason}`);
    this.post(Object.assign({ type: '@denied', reason }, extra || null));
    this.close(wire.CLOSE.POLICY, reason);
  }

  tellDevice() {
    this.post({ type: '@device', device: this.device });
    if (this.binding && this.binding.device) this.binding.device(this.device);
  }

  bind(binding) {
    this.binding = binding;
  }

  post(message) {
    if (!this.open) return;
    if (this.socket.writableLength > MAX_BACKLOG_BYTES) {
      this.log(`${this.id} is not keeping up; closing`);
      return this.close(wire.CLOSE.POLICY, 'too far behind');
    }
    let frame = message;
    if (this.box) {
      try { frame = this.box.seal(JSON.stringify(message)); }
      catch (_) { return this.close(wire.CLOSE.POLICY, 'this connection has said enough'); }
    }
    this.write(wire.encodeText(JSON.stringify(frame)));
  }

  deliver(text) {
    let msg = null;
    try { msg = JSON.parse(text); } catch (_) {
      this.log(`${this.id} sent something that is not JSON`);
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    // Until the handshake is done, the only message that means anything is the
    // answer to it. Everything else is dropped rather than queued.
    if (!this.device) {
      if (msg.type !== '@auth') return;
      // A client with nothing to prove says so, and is seated only if the key it
      // arrived with was good. One that offers a device must be that device.
      if (!msg.device) {
        // Nothing to prove and no key either: the one refusal that has an
        // obvious next step, so it is offered rather than left to be guessed.
        if (!this.allowLocal) return this.deny('this device is not paired', { pair: true });
        return this.welcome(localDevice(), this.gate.localWelcome(this.pending, msg));
      }
      const verdict = this.gate.answer(this.pending, msg, { address: this.address });
      if (!verdict.ok && this.allowLocal) {
        return this.welcome(localDevice(), this.gate.localWelcome(this.pending, msg));
      }
      if (!verdict.ok) return this.deny(verdict.reason);
      this.sealed = !!verdict.sealed;
      if (verdict.rekeyed) {
        // A device replacing its own key is exactly what a stolen key would do
        // to make the theft permanent, so it is never silent: the trail has it,
        // the log has it, and the window says so out loud.
        this.log(`${verdict.rekeyed.name} replaced its key — now held in ${verdict.rekeyed.protection}`);
        this.server.announce({
          kind: 'rekeyed',
          device: verdict.rekeyed.name,
          protection: verdict.rekeyed.protection,
          biometric: !!verdict.rekeyed.biometric
        });
      }
      return this.welcome(verdict.device, verdict.welcome, verdict.box);
    }

    // Once the channel is sealed it stays sealed: a plaintext frame arriving
    // afterwards is either a mistake or somebody trying to talk around the
    // envelope, and neither is a message.
    if (this.box) {
      if (msg.type !== '@box') return this.close(wire.CLOSE.POLICY, 'that was not sealed');
      const inside = this.box.open(msg);
      if (inside === null) return this.close(wire.CLOSE.POLICY, 'that did not open');
      try { msg = JSON.parse(inside); } catch (_) { return; }
      if (!msg || typeof msg.type !== 'string') return;
    } else if (msg.type === '@box') {
      return;
    }

    // Where to reach this device when it is not running. Only an app has one,
    // it only ever arrives on a socket the device has already proved itself on,
    // and it is stored against that device's record — so forgetting the device
    // forgets where to reach it, with no second list to remember to clean.
    if (msg.type === '@apple') return this.server.rememberApple(this.device, msg.token);
    if (msg.type === '@listen') return this.server.issueListener(this);

    if (msg.type.charCodeAt(0) === 64) return; // '@' frames are the transport's, not the session's
    if (!this.binding) return;
    Promise.resolve(this.binding.receive(msg)).catch((err) => {
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
    if (this.deadline) clearTimeout(this.deadline);
    this.beat = null;
    this.deadline = null;
    if (this.binding && this.binding.detach) this.binding.detach();
    this.binding = null;
    if (this.server) this.server.clients.delete(this);
  }
}

// ---- small helpers ---------------------------------------------------------

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object') return reject(new Error('not an object'));
        resolve(parsed);
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res, body, csp) {
  res.writeHead(200, Object.assign({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  }, csp ? { 'content-security-policy': csp } : null));
  res.end(body);
}

/** The shape of an id this window makes: see nextId() in session.js. */
/**
 * What an app asks for, and only in the way it asks for it.
 *
 * The socket is not here because it never reaches this function — it is an
 * upgrade, guarded separately. `/pair` is a POST from an app and a page in a
 * browser, and app-only means the page does not exist: the method is the whole
 * difference, so the method is checked.
 */
function isAppRoute(method, route) {
  if (route === '/health' || route === '/push/key') return method === 'GET' || method === 'HEAD';
  if (route === '/pair' || route === '/push/subscribe') return method === 'POST';
  if (route === '/notify/listen') return method === 'GET';
  return false;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

// How often a background listener hears something, even if only a ping.
const LISTENER_PING_MS = 30000;

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

// A subscription is only accepted for a minute after the device signed for it.
const SUBSCRIBE_WINDOW_MS = 60000;

// How often one address may try to pair or subscribe before being told to wait.
const ATTEMPT_WINDOW_MS = 60000;
const ATTEMPTS_ALLOWED = 12;

/**
 * The push services a browser can actually hand back.
 *
 * Without this, a paired device — including one that may only watch — could
 * name any host it liked and have this laptop POST to it on every notification,
 * which is a hole in the shape of a proxy into whatever the laptop can reach.
 */
const PUSH_SERVICES = [
  'push.apple.com',
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.windows.com'
];

function isPushEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch (_) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICES.some((service) => host === service || host.endsWith('.' + service));
}

module.exports = { RemoteServer, RemoteClient, isPushEndpoint, MAX_SOCKETS, PING_MS, PUSH_SERVICES };

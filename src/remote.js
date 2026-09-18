'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { renderPage, randomNonce, jsonForScript } = require('./page');
const { Gate, LocalKey, localDevice, forwarded } = require('./auth');
const wire = require('./wire');

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
   * @param {(line: string) => void} [deps.log]
   */
  constructor(deps) {
    this.root = deps.root;
    this.host = deps.host;
    this.sessions = deps.sessions;
    this.devices = deps.devices || null;
    this.identity = deps.identity || null;
    this.pairing = deps.pairing || null;
    this.vapid = deps.vapid || null;
    this.hubs = deps.hubs || require('./hub');
    // Read through a function rather than copied at construction, so changing
    // the setting takes effect on the next connection rather than the next
    // window — a security setting you have to restart to apply is a security
    // setting that stays wrong.
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
    this.fleetClients = new Set();
    this.seq = 0;
    this.refusals = [];
    this.attempts = new Map();
    this.movedFrom = null;
    this.stopWatching = null;
    this.stateWatchers = new Set();

    // A grant taken away has to reach a socket that is already open, or
    // revoking would mean "next time".
    if (this.devices && this.devices.onChange) {
      this.stopWatchingDevices = this.devices.onChange(() => this.reconcile());
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
    let told = 0;
    for (const client of this.clients) {
      if (!client.device || client.device.kind !== 'device') continue;
      client.post(Object.assign({ type: '@notify' }, message));
      told++;
    }
    return told;
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
        receive: (message) => hub.receive(client.id, message),
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
    client.bind({
      receive: (message) => {
        if (message && message.type === 'ready') client.post(this.fleetMessage());
      },
      device: () => {},
      detach: () => this.fleetClients.delete(client)
    });
    this.log(`${client.id} is watching the window as ${client.device.name}`);
    return true;
  }

  fleetMessage() {
    const instances = this.sessions.list().map((session) => ({
      id: session.id,
      label: session.customTitle || session.label,
      status: session.status,
      cwd: session.cwd,
      cost: session.totalCost || 0,
      queued: (session.queue || []).length,
      paused: !!session.isPaused,
      asleep: !!session.isAsleep
    }));
    return { type: 'fleet', instances, at: Date.now() };
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
  return false;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

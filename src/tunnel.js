'use strict';

const fs = require('fs');
const https = require('https');
const { execFile, spawn } = require('child_process');

/**
 * Reaching this laptop from a phone that is somewhere else.
 *
 * The server keeps binding to loopback and there is still no code path that
 * binds anywhere else. What changes is that Tailscale's own proxy listens on
 * the tailnet and forwards to 127.0.0.1 — so the thing exposed to the phone is
 * theirs, already authenticated by the mesh and already wearing a real TLS
 * certificate, and ours stays where it was.
 *
 * The certificate is not a nicety. Web Crypto only exists in a secure context,
 * so a device cannot hold a key at all over a plain http address on a network.
 * `tailscale serve` gives https on a name the tailnet already trusts, which is
 * the whole reason this is the first option rather than the third.
 *
 * Nothing here shells out on its own: the runner is injected, so the parsing
 * and the argument-building are tested without a tailnet.
 */

// Where the CLI lives, in the order worth trying. The Mac app ships the same
// binary inside the bundle, which is the one most people actually have.
const PLACES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale'
];

class Tailscale {
  /**
   * @param {object} [deps]
   * @param {(argv: string[]) => Promise<{code: number, stdout: string, stderr: string}>} [deps.run]
   * @param {(path: string) => boolean} [deps.exists]
   * @param {string[]} [deps.places]
   */
  constructor(deps) {
    const d = deps || {};
    this.places = d.places || PLACES;
    this.exists = d.exists || ((file) => { try { return fs.existsSync(file); } catch (_) { return false; } });
    this.runner = d.run || runCommand;
    // Injected so the tests never touch the network: warming is a real request
    // to a real name, which is exactly what a test must not do.
    this.probe = d.probe || knock;
    this.binary = d.binary || null;
  }

  /** The CLI, or null when it is not installed. */
  find() {
    if (this.binary) return this.binary;
    this.binary = this.places.find((place) => this.exists(place)) || null;
    return this.binary;
  }

  async run(argv) {
    const binary = this.find();
    if (!binary) return { code: -1, stdout: '', stderr: 'tailscale is not installed' };
    return this.runner([binary].concat(argv));
  }

  /**
   * What the mesh thinks of this machine.
   *
   * @returns {Promise<{installed: boolean, running: boolean, state: string,
   *   name: string|null, tailnet: string|null, https: boolean, reason: string|null}>}
   */
  async status() {
    if (!this.find()) {
      return {
        installed: false, running: false, state: 'not installed', name: null,
        tailnet: null, https: false,
        reason: 'Tailscale is not installed on this machine.'
      };
    }
    const out = await this.run(['status', '--json']);
    if (out.code !== 0) {
      return {
        installed: true, running: false, state: 'unreachable', name: null, tailnet: null, https: false,
        reason: firstLine(out.stderr) || 'Tailscale did not answer.'
      };
    }

    let parsed;
    try { parsed = JSON.parse(out.stdout); } catch (_) {
      return {
        installed: true, running: false, state: 'unreadable', name: null, tailnet: null, https: false,
        reason: 'Tailscale answered with something this does not understand.'
      };
    }

    const state = String(parsed.BackendState || 'Unknown');
    const self = parsed.Self || {};
    const name = trimDot(self.DNSName || '');
    // CertDomains is how the daemon says which names it can get a certificate
    // for. Without one there is no https, and without https there is no phone.
    const certs = Array.isArray(parsed.CertDomains) ? parsed.CertDomains : [];
    const https = certs.some((domain) => matchesDomain(domain, name));

    return {
      installed: true,
      running: state === 'Running',
      state,
      name: name || null,
      tailnet: trimDot(parsed.MagicDNSSuffix || '') || null,
      https,
      reason: state === 'Running'
        ? (name ? (https ? null : 'This tailnet has no HTTPS certificates enabled.') : 'This machine has no MagicDNS name.')
        : state === 'NeedsLogin' ? 'Tailscale is installed but not logged in.'
          : 'Tailscale is not running.'
    };
  }

  /**
   * Put the local server behind the tailnet's own https proxy.
   *
   * @returns {Promise<{ok: true, host: string, url: string} | {ok: false, reason: string}>}
   */
  async expose(port) {
    const state = await this.status();
    if (!state.installed || !state.running) return { ok: false, reason: state.reason };
    if (!state.name) return { ok: false, reason: state.reason || 'no name to serve on' };
    if (!state.https) {
      return {
        ok: false,
        reason: (state.reason || 'HTTPS is not enabled for this tailnet.') +
          ' Turn on HTTPS certificates in the Tailscale admin console, then try again — ' +
          'a phone cannot hold a device key without it.'
      };
    }

    const out = await this.run(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
    if (out.code !== 0) {
      return { ok: false, reason: firstLine(out.stderr) || firstLine(out.stdout) || 'tailscale serve refused' };
    }
    const url = `https://${state.name}/`;
    // The very first request to a name mints its certificate, and that takes
    // long enough to look like a failure — measured at over fifteen seconds
    // cold against twenty-one milliseconds warm. Paying for it here means the
    // phone's first visit is a page rather than "cannot reach the laptop".
    await this.warm(url);
    return { ok: true, host: state.name, url };
  }

  /**
   * Knock on the door until somebody answers, or give up quietly.
   *
   * Nothing depends on the result: a tunnel that is up but not yet certified is
   * still up, and the client retries on its own. This only moves the waiting to
   * where somebody has already been told to wait.
   */
  async warm(url, options) {
    const o = options || {};
    const attempts = o.attempts || 3;
    const each = o.timeoutMs || 8000;
    const probe = o.probe || this.probe;
    for (let i = 0; i < attempts; i++) {
      if (await probe(url + 'health', each)) return true;
    }
    return false;
  }

  /** Take it down again. */
  async hide() {
    const out = await this.run(['serve', '--https=443', 'off']);
    return out.code === 0
      ? { ok: true }
      : { ok: false, reason: firstLine(out.stderr) || 'tailscale serve would not stop' };
  }

  /**
   * Whether the tailnet is already forwarding to this port — which it may be
   * from a window that was closed without tidying up.
   */
  async serving(port) {
    const out = await this.run(['serve', 'status', '--json']);
    if (out.code !== 0) return false;
    try {
      const parsed = JSON.parse(out.stdout || '{}');
      return JSON.stringify(parsed).indexOf(`127.0.0.1:${port}`) >= 0;
    } catch (_) { return false; }
  }
}

function knock(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function runCommand(argv) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && err.message) || '')
        });
      });
  });
}

const trimDot = (text) => String(text || '').replace(/\.$/, '');
const firstLine = (text) => String(text || '').trim().split('\n')[0] || '';

/** `*.tail1234.ts.net` covers `laptop.tail1234.ts.net`. */
function matchesDomain(domain, name) {
  if (!domain || !name) return false;
  if (domain === name) return true;
  if (domain.startsWith('*.')) return name.endsWith(domain.slice(1));
  return false;
}

/**
 * The other way out: a public hostname, through Cloudflare.
 *
 * Second choice on purpose, and gated behind something you have to read. A
 * tailnet is a set of devices you authorised; a `trycloudflare.com` hostname is
 * the internet, and the difference is the whole of the threat model's third
 * attacker. It is here because a tailnet needs an app on the phone and there are
 * places that will not have one.
 *
 * What it does have going for it: TLS to the edge, so Web Crypto works and a
 * device can hold a key, and nothing of ours listening anywhere but loopback.
 */
class Cloudflared {
  constructor(deps) {
    const d = deps || {};
    this.places = d.places || CLOUDFLARE_PLACES;
    this.exists = d.exists || ((file) => { try { return fs.existsSync(file); } catch (_) { return false; } });
    this.spawn = d.spawn || spawn;
    this.log = d.log || (() => {});
    this.proc = null;
    this.url = null;
  }

  find() {
    return this.places.find((place) => this.exists(place)) || null;
  }

  get running() {
    return !!this.proc;
  }

  /**
   * Start a quick tunnel and wait for it to say where it is.
   *
   * @returns {Promise<{ok: true, host: string, url: string} | {ok: false, reason: string}>}
   */
  expose(port, options) {
    const timeout = (options && options.timeoutMs) || 25000;
    if (this.proc) return Promise.resolve({ ok: true, host: hostOf(this.url), url: this.url });
    const binary = this.find();
    if (!binary) {
      return Promise.resolve({
        ok: false,
        reason: 'cloudflared is not installed. Tailscale is the better path if you can use it; ' +
          'otherwise install cloudflared and try again.'
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };

      const proc = this.spawn(binary, [
        'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;

      // cloudflared announces the hostname it was given on its way up, and the
      // only way to know it is to read it: a quick tunnel has no other record.
      const watch = (chunk) => {
        const text = String(chunk);
        const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
        if (found && !this.url) {
          this.url = found[0] + '/';
          this.log('public tunnel at ' + this.url);
          done({ ok: true, host: hostOf(this.url), url: this.url });
        }
      };
      if (proc.stdout) proc.stdout.on('data', watch);
      if (proc.stderr) proc.stderr.on('data', watch);

      proc.on('error', (err) => {
        this.proc = null;
        done({ ok: false, reason: (err && err.message) || 'cloudflared would not start' });
      });
      proc.on('exit', (code) => {
        this.proc = null;
        this.url = null;
        done({ ok: false, reason: 'cloudflared stopped' + (code == null ? '' : ' with code ' + code) });
      });

      const timer = setTimeout(() => {
        done({ ok: false, reason: 'cloudflared did not say where it was within ' + Math.round(timeout / 1000) + 's' });
      }, timeout);
      if (timer.unref) timer.unref();
    });
  }

  hide() {
    if (!this.proc) return Promise.resolve({ ok: true });
    const proc = this.proc;
    this.proc = null;
    this.url = null;
    try { proc.kill(); } catch (_) { /* already gone */ }
    this.log('public tunnel closed');
    return Promise.resolve({ ok: true });
  }
}

const CLOUDFLARE_PLACES = [
  '/usr/local/bin/cloudflared',
  '/opt/homebrew/bin/cloudflared',
  '/usr/bin/cloudflared'
];

const hostOf = (url) => { try { return new URL(url).host; } catch (_) { return null; } };

module.exports = { Tailscale, Cloudflared, PLACES, CLOUDFLARE_PLACES, matchesDomain };

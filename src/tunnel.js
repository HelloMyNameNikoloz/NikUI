'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

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
    return { ok: true, host: state.name, url: `https://${state.name}/` };
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

module.exports = { Tailscale, PLACES, matchesDomain };

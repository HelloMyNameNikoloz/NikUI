'use strict';

// What is left of each ChatGPT account's Codex limits, for /status.
//
// One machine can be signed in to more than one account, each in its own
// Codex folder: ~/.codex, ~/.codex-work and so on (the folder is CODEX_HOME).
// Each is asked on its own — a short-lived `codex app-server` with that folder
// as its home answers `account/read` and `account/rateLimits/read` — and the
// answers are kept, so /status draws at once and never waits on a process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const FRESH_MS = 3 * 60 * 1000;
const ASK_TIMEOUT_MS = 15000;

const PLANS = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team',
  business: 'Business', enterprise: 'Enterprise', edu: 'Edu'
};

/** Every Codex folder in the home folder that is signed in. */
function codexHomes(home) {
  const base = home || os.homedir();
  let names = [];
  try { names = fs.readdirSync(base); } catch (_) { return []; }
  return names
    .filter((n) => /^\.codex(-[\w.-]+)?$/.test(n))
    .map((n) => path.join(base, n))
    .filter((dir) => { try { return fs.statSync(path.join(dir, 'auth.json')).isFile(); } catch (_) { return false; } });
}

/**
 * What an account is called on screen. ~/.codex-work is "Work"; ~/.codex is
 * the one everything else uses by default, so beside a named one it is
 * "Personal", and on its own simply the account.
 */
function nameOf(dir, all) {
  const m = /^\.codex-(.+)$/.exec(path.basename(dir));
  if (m) return m[1].replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return all.length > 1 ? 'Personal' : 'ChatGPT';
}

function windowName(mins) {
  if (!mins) return 'Window';
  if (mins === 300) return 'Five-hour';
  if (mins === 10080) return 'This week';
  if (mins % 1440 === 0) return (mins / 1440) + '-day';
  if (mins % 60 === 0) return (mins / 60) + '-hour';
  return mins + '-minute';
}

/** Codex's answers, as /status draws them. */
function shape(dir, all, account, limits) {
  const acct = (account && account.account) || {};
  const rl = (limits && limits.rateLimits) || {};
  const windows = [rl.primary, rl.secondary].filter(Boolean)
    .map((w) => ({
      name: windowName(w.windowDurationMins),
      mins: w.windowDurationMins || 0,
      used: Math.max(0, Math.min(1, (Number(w.usedPercent) || 0) / 100)),
      resetsAt: w.resetsAt ? w.resetsAt * 1000 : null
    }))
    .sort((a, b) => a.mins - b.mins);
  const resets = ((limits && limits.rateLimitResetCredits && limits.rateLimitResetCredits.credits) || [])
    .filter((c) => c.status === 'available').length;
  const plan = acct.planType || rl.planType || '';
  return {
    id: path.basename(dir),
    name: nameOf(dir, all),
    home: dir,
    email: acct.email || null,
    plan: PLANS[plan] || (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null),
    windows,
    reached: rl.rateLimitReachedType || (limits && limits.ordinaryUsageAllowed === false ? 'limit' : null),
    resets,
    at: Date.now(),
    error: null
  };
}

class CodexLimits extends EventEmitter {
  constructor({ codexPath, home, homesFn, askFn, freshMs } = {}) {
    super();
    this.codexPath = codexPath || null;
    this.homesFn = homesFn || (() => codexHomes(home));
    this.askFn = askFn || ((dir) => this._ask(dir));
    this.freshMs = freshMs || FRESH_MS;
    this.accounts = [];
    this.at = 0;
    this._asking = null;
  }

  /** What is known now, and a fresh reading started if it is old. Never waits. */
  current() {
    if (Date.now() - this.at > this.freshMs) this.refresh();
    return this.accounts.length ? this.accounts : null;
  }

  /** Ask every account again; resolves with what they said. */
  refresh() {
    if (this._asking) return this._asking;
    this.at = Date.now();
    const dirs = this.homesFn();
    this._asking = Promise.all(dirs.map((dir) => this.askFn(dir)
      .then(({ account, limits }) => shape(dir, dirs, account, limits))
      .catch((err) => {
        const before = this.accounts.find((a) => a.home === dir);
        return Object.assign({}, before || { id: path.basename(dir), name: nameOf(dir, dirs), home: dir, windows: [] },
          { error: (err && err.message) || 'no answer' });
      })))
      .then((accounts) => {
        // Named accounts (~/.codex-work) first, the default folder last.
        this.accounts = accounts.sort((a, b) => (a.id === '.codex') - (b.id === '.codex'));
        this._asking = null;
        this.emit('changed', accounts);
        return accounts;
      });
    return this._asking;
  }

  /** One account's answers, from a Codex of its own with that folder as home. */
  async _ask(dir) {
    const { CodexClient } = require('./codex');
    const client = new CodexClient({
      codexPath: this.codexPath,
      daemonFn: null,
      spawnFn: (cmd, args, opts) => spawn(cmd, args, Object.assign({}, opts, {
        env: Object.assign({}, process.env, { CODEX_HOME: dir })
      }))
    });
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codex did not answer')), ASK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([late, (async () => {
        await client.start();
        const [account, limits] = await Promise.all([
          client.request('account/read', {}),
          client.request('account/rateLimits/read', {})
        ]);
        return { account, limits };
      })()]);
    } finally {
      clearTimeout(timer);
      client.dispose();
    }
  }
}

let shared = null;

/** The window's one reader, made on first use. */
function codexLimits(opts) {
  if (!shared) shared = new CodexLimits(opts);
  return shared;
}

module.exports = { CodexLimits, codexLimits, codexHomes, nameOf, shape, windowName };

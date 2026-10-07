'use strict';

// Which PR an instance is about, so its title can open it. The prompt may have
// said (a pull URL), the CI watch may have found it, and otherwise GitHub is
// asked once: the ticket's PR in the instance's folder, or the branch's PR.
const { execFile } = require('child_process');

const PULL_URL = /https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d{1,7})\b/gi;
const RETRY_MS = 5 * 60000;  // no PR yet, or no gh: ask again after this

const defaultRun = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, Object.assign({ timeout: 20000 }, options), (err, stdout) => {
    resolve({ ok: !err, stdout: String(stdout || '') });
  });
});

/** The pull URL in a prompt for this ticket, if it gave one. */
function prUrlIn(text, ticket) {
  if (!text || !ticket) return null;
  for (const m of String(text).matchAll(PULL_URL)) {
    if (m[1] === String(ticket)) return m[0].replace(/^(.*\/pull\/\d+).*$/, '$1');
  }
  return null;
}

/** Whether a URL is the PR this ticket names; any PR when there is no ticket. */
function fits(url, ticket) {
  if (!url) return false;
  return !ticket || new RegExp('/pull/' + ticket + '$').test(url);
}

class PrLinks {
  constructor(opts) {
    opts = opts || {};
    this.run = opts.run || defaultRun;
    this.now = opts.now || Date.now;
    this.known = new Map();  // cwd#ticket → { url, at }
    this.asking = new Set();
  }

  attach(manager) {
    const look = (session) => { if (session) this.link(session); };
    manager.on('session-changed', look);
    for (const s of manager.list || []) look(s);
    return () => manager.removeListener('session-changed', look);
  }

  /** Sets session.prUrl, now if it is known, later if GitHub has to be asked. */
  link(session) {
    // Picked by hand: nothing found in the conversation overrides that.
    if (session.prPinned) return;
    const ticket = session.ticket || null;
    if (fits(session.prUrl, ticket)) return;
    const ci = session.ci && session.ci.pr;
    if (ci && fits(ci.url, ticket)) return this.set(session, ci.url);
    if (!session.cwd) return this.set(session, null);
    const key = session.cwd + '#' + (ticket || '');
    const seen = this.known.get(key);
    if (seen && (seen.url || this.now() - seen.at < RETRY_MS)) return this.set(session, seen.url);
    if (this.asking.has(key)) return;
    this.asking.add(key);
    const args = ['pr', 'view'].concat(ticket ? [String(ticket)] : [], ['--json', 'url']);
    return this.run('gh', args, { cwd: session.cwd }).then((r) => {
      let url = null;
      try { url = r.ok ? JSON.parse(r.stdout).url || null : null; } catch (e) { url = null; }
      this.known.set(key, { url, at: this.now() });
      this.asking.delete(key);
      // The ticket may have moved on while GitHub answered.
      if ((session.ticket || null) === ticket) this.set(session, url);
    });
  }

  /** A PR chosen by hand, or null to go back to finding it. */
  pin(session, url) {
    session.prPinned = !!url;
    if (url) return this.set(session, url);
    this.set(session, null);
    return this.link(session);
  }

  set(session, url) {
    if ((session.prUrl || null) === (url || null)) return;
    session.prUrl = url || null;
    session.emit('meta');
  }
}

module.exports = { PrLinks, prUrlIn, fits };

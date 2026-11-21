'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TOOLS = Object.freeze(['node', 'claude', 'codex', 'gh', 'git', 'trust-dir', 'tailscale', 'cloudflared']);
const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
function executable(file) {
  try { return path.isAbsolute(file) && fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); }
  catch (_) { return false; }
}

function loginLookup({ home, env, names }) {
  // whence -p bypasses zsh functions (claude/codex are wrappers on this Mac).
  // One command at startup supplies both binary paths and the children's PATH.
  // Names are a fixed allowlist, never interpolated owner/request payloads.
  if (!names.every((name) => TOOLS.includes(name))) throw new Error('Unknown tool lookup');
  const marker = '__NIKD_TOOL_LOOKUP_V1__';
  const script = "print -r -- '" + marker + "'; print -r -- \"$PATH\"; for t in " + names.join(' ') + '; do print -r -- "$(whence -p -- $t)"; done';
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lic', script], { env: { ...env, HOME: home, ZDOTDIR: home, PATH: MINIMAL_PATH },
      cwd: home, timeout: 3000, maxBuffer: 65536, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve({ path: MINIMAL_PATH, tools: {}, available: false });
      const output = String(stdout).trimEnd().split(/\r?\n/);
      const start = output.lastIndexOf(marker);
      if (start === -1) return resolve({ path: MINIMAL_PATH, tools: {}, available: false });
      const lines = output.slice(start + 1);
      const tools = {};
      names.forEach((name, i) => { tools[name] = lines[i + 1] || ''; });
      resolve({ path: lines[0] || MINIMAL_PATH, tools, available: true });
    });
  });
}

function createToolResolver({ home, configured = {}, knownDirs, env = {}, lookup = loginLookup, isExecutable = executable } = {}) {
  if (!home || !path.isAbsolute(home)) throw new Error('Tool resolver requires a private absolute home');
  const dirs = knownDirs || [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  if (dirs.some((dir) => !path.isAbsolute(dir))) throw new Error('Known tool directories must be absolute');
  let cached = null;
  function resolveAll() {
    if (!cached) cached = (async () => {
      let login;
      try { login = await lookup({ home, env, names: TOOLS }); }
      catch (_) { login = { path: MINIMAL_PATH, tools: {}, available: false }; }
      const result = {};
      for (const name of TOOLS) {
        const override = configured[name];
        const known = !override && dirs.map((dir) => path.join(dir, name)).find(isExecutable);
        const shell = login.tools && login.tools[name];
        const selected = override ? (typeof override === 'string' && path.isAbsolute(override) && isExecutable(override) ? override : null)
          : known || (typeof shell === 'string' && path.isAbsolute(shell) && isExecutable(shell) ? shell : null);
        result[name] = { status: selected ? 'resolved' : 'missing', path: selected,
          source: override ? 'configured' : known ? 'known-directory' : selected ? 'login-shell-binary' : 'missing',
          hint: selected ? null : `Install ${name} in a known directory or configure an absolute executable path in the private root.` };
      }
      const loginDirs = String(login.path || '').split(':').filter((dir) => path.isAbsolute(dir));
      const configuredDirs = Object.values(result).filter((tool) => tool.source === 'configured' && tool.path).map((tool) => path.dirname(tool.path));
      const childPath = [...new Set([...configuredDirs, ...loginDirs, ...dirs, ...MINIMAL_PATH.split(':')])].join(':');
      return Object.freeze({ tools: result, childEnv: Object.freeze({ HOME: home, USERPROFILE: home, ZDOTDIR: home,
        PATH: childPath, TMPDIR: path.join(home, 'tmp'), CODEX_HOME: path.join(home, '.codex-work'),
        ...(env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}) }),
        loginShell: login.available === false ? 'unavailable' : 'cached',
        wrappers: 'claude/codex shell functions are bypassed; CODEX_HOME is explicit; folder trust must be checked before provider launch' });
    })();
    return cached;
  }
  return { resolveAll, refresh() { cached = null; return resolveAll(); } };
}

module.exports = { createToolResolver, loginLookup, executable, TOOLS, MINIMAL_PATH };

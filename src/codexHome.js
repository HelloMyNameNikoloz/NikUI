'use strict';

// Which ChatGPT account NikUI's Codex runs on, and what it can reach there.
//
// Each account is its own Codex folder (CODEX_HOME): ~/.codex is the one the
// ChatGPT app, its daemon and `codexp` use; ~/.codex-work is `codex` in the
// terminal. NikUI runs on Work unless told otherwise.
//
// Computer use comes with the ChatGPT app as a plugin installed into ~/.codex
// only. Another folder gets the same MCP server handed to it on the command
// line, pointed at that folder, so Codex on Work can see and drive the Mac too.
// Where Xcode is installed, XcodeBuildMCP comes along as well: it builds, boots
// the Simulator, installs, taps and screenshots, so a change can be looked at.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The folder for an account: 'work', 'personal', or a path of its own. */
function accountHome(account, home) {
  const base = home || os.homedir();
  const personal = path.join(base, '.codex');
  const which = String(account || 'work').trim();
  if (!which || which === 'personal') return personal;
  if (which === 'work') {
    const work = path.join(base, '.codex-work');
    return fs.existsSync(work) ? work : personal;
  }
  if (which.startsWith('~/')) return path.join(base, which.slice(2));
  return path.isAbsolute(which) ? which : path.join(base, which);
}

/** Whether a folder is the one the ChatGPT app and its daemon run on. */
function isAppHome(dir, home) {
  return path.resolve(dir) === path.join(home || os.homedir(), '.codex');
}

/** The computer-use server as the ChatGPT app installed it, newest version first; or null. */
function computerUseServer(home) {
  const root = path.join(home || os.homedir(), '.codex', 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
  let versions = [];
  try { versions = fs.readdirSync(root).sort().reverse(); } catch (_) { return null; }
  for (const v of versions) {
    try {
      const server = JSON.parse(fs.readFileSync(path.join(root, v, '.mcp.json'), 'utf8')).mcpServers.cua_repl;
      if (server && server.command && fs.existsSync(server.command)) return server;
    } catch (_) { /* the next one */ }
  }
  return null;
}

// Pinned: what runs on this Mac changes when NikUI does, not when npm does.
const XCODEBUILD_MCP = 'xcodebuildmcp@2.7.0';
const NPX = ['/opt/homebrew/bin/npx', '/usr/local/bin/npx'];

/** XcodeBuildMCP, if Xcode and npx are both here; or null. */
function xcodeServer() {
  if (process.platform !== 'darwin' || !fs.existsSync('/Applications/Xcode.app')) return null;
  const npx = NPX.find((p) => fs.existsSync(p));
  if (!npx) return null;
  return {
    command: npx,
    args: ['-y', XCODEBUILD_MCP, 'mcp'],
    startup_timeout_sec: 120,
    env: { PATH: path.dirname(npx) + ':/usr/bin:/bin:/usr/sbin:/sbin' }
  };
}

/** A value as TOML, for `-c key=value`. JSON strings are valid TOML strings. */
function toml(v) {
  if (Array.isArray(v)) return '[' + v.map(toml).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ' = ' + toml(v[k])).join(', ') + '}';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(String(v == null ? '' : v));
}

/**
 * What `codex app-server` is given on top for a folder: computer use, unless
 * the folder has it already (the app's own) or it is turned off; and Xcode's
 * tools, unless turned off.
 */
function homeArgs(dir, { computerUse = true, xcode = true, home, xcodeFn = xcodeServer } = {}) {
  const args = [];
  const server = computerUse && !isAppHome(dir, home) ? computerUseServer(home) : null;
  if (server) {
    const env = Object.assign({}, server.env, { CODEX_HOME: dir });
    const trusted = server.env && server.env.NODE_REPL_TRUSTED_CODE_PATHS;
    env.NODE_REPL_TRUSTED_CODE_PATHS = trusted ? dir + ':' + trusted : dir;
    args.push('-c', 'mcp_servers.cua_repl=' + toml(Object.assign({}, server, { env })));
  }
  const xc = xcode ? xcodeFn() : null;
  if (xc) args.push('-c', 'mcp_servers.xcodebuild=' + toml(xc));
  return args;
}

module.exports = { accountHome, isAppHome, computerUseServer, xcodeServer, homeArgs, toml };

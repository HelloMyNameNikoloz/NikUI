'use strict';

// The account NikUI's Codex runs on, and computer use brought along to it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { accountHome, isAppHome, homeArgs, toml } = require('../src/codexHome.js');
const { CodexClient, CodexWorkspace } = require('../src/codex.js');

module.exports = async function () {
  suite('Codex runs on the chosen ChatGPT account');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nikhome-'));
  checkEqual('no work folder yet: the app account', accountHome('work', home), path.join(home, '.codex'));
  fs.mkdirSync(path.join(home, '.codex-work'));
  checkEqual('Work is ~/.codex-work', accountHome('work', home), path.join(home, '.codex-work'));
  checkEqual('Personal is ~/.codex', accountHome('personal', home), path.join(home, '.codex'));
  checkEqual('a folder of its own', accountHome('~/.codex-x', home), path.join(home, '.codex-x'));
  check('~/.codex is the app account', isAppHome(path.join(home, '.codex'), home));
  check('~/.codex-work is not', !isAppHome(path.join(home, '.codex-work'), home));

  checkEqual('TOML inline table', toml({ a: ['x', 'y"z'], 'b c': { n: 1, on: true } }),
    '{"a" = ["x", "y\\"z"], "b c" = {"n" = 1, "on" = true}}');

  // The ChatGPT app's computer-use plugin, as it lays it out.
  const work = path.join(home, '.codex-work');
  checkEqual('no plugin: nothing added', homeArgs(work, { home, xcode: false }), []);
  const dir = path.join(home, '.codex/plugins/cache/openai-bundled/unified-computer-use/1.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
    command: process.execPath, args: ['repl.mjs'], enabled_tools: ['js'],
    env: { CODEX_HOME: path.join(home, '.codex'), NODE_REPL_TRUSTED_CODE_PATHS: path.join(home, '.codex') + ':/mods', SKY: 'app' }
  } } }));
  const args = homeArgs(work, { home, xcode: false });
  checkEqual('one -c override', args.length, 2);
  check('it defines cua_repl', /^mcp_servers\.cua_repl=\{/.test(args[1]));
  check('pointed at the work folder', args[1].includes('"CODEX_HOME" = ' + JSON.stringify(work)));
  check('trusting the work folder first', args[1].includes('"NODE_REPL_TRUSTED_CODE_PATHS" = ' + JSON.stringify(work + ':' + path.join(home, '.codex') + ':/mods')));
  check('the rest as the app set it', args[1].includes('"SKY" = "app"'));
  checkEqual('the app account has it already', homeArgs(path.join(home, '.codex'), { home, xcode: false }), []);
  checkEqual('turned off', homeArgs(work, { home, computerUse: false, xcode: false }), []);

  const xc = homeArgs(path.join(home, '.codex'), { home, xcodeFn: () => ({ command: '/npx', args: ['-y', 'x@1', 'mcp'] }) });
  checkEqual('Xcode tools on any account', xc, ['-c', 'mcp_servers.xcodebuild={"command" = "/npx", "args" = ["-y", "x@1", "mcp"]}']);

  // Off the app account: a Codex of its own, with that folder as its home.
  let spawned = null;
  const spawnFn = (cmd, argv, opts) => {
    spawned = { argv, home: opts.env.CODEX_HOME };
    const { EventEmitter } = require('events');
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.stdin = { write() {}, end() {} };
    p.kill = () => {};
    return p;
  };
  const c = new CodexClient({ codexPath: '/fake/codex', home: work, args: ['-c', 'x=1'], spawnFn });
  c.start().catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  checkEqual('app-server with the extra arguments', spawned && spawned.argv, ['app-server', '-c', 'x=1']);
  checkEqual('CODEX_HOME is the account', spawned && spawned.home, work);
  c.dispose();
  checkEqual('no daemon off the app account', new CodexClient({ codexPath: '/fake/codex', home: work }).daemonFn, null);
  check('the daemon on it', typeof new CodexClient({ codexPath: '/fake/codex', home: path.join(os.homedir(), '.codex') }).daemonFn === 'function');
  const w = new CodexWorkspace({ codexPath: '/fake/codex', home: work, cacheDir: path.join(home, 'cache') });
  checkEqual('no ChatGPT-app hand-off off its account', w.ipc, null);
  w.dispose();
};

'use strict';
// The engine reads its settings from whatever it is given. In a window that is
// VS Code; in the engine service it is not, and there must be no way back to
// the editor hidden in the path.
const path = require('path');
const { execFileSync } = require('child_process');
const { readConfig, readSnippets } = require('../src/config.js');
const properties = require('../package.json').contributes.configuration.properties;

function source(values, shipped) {
  return {
    get: (key, fallback) => (key in values ? values[key] : fallback),
    inspect: (key) => (key === 'promptSnippets' ? { defaultValue: shipped || {} } : undefined)
  };
}

module.exports = async function () {
  suite('settings come from a source, not from the editor');

  const empty = readConfig(source({}));
  checkEqual('the defaults are the ones the window has always had',
    [empty.claudePath, empty.permissionMode, empty.outputStyle, empty.maxItems, empty.pauseOnLimit],
    ['claude', 'bypassPermissions', 'Concise', 400, true]);
  const set = readConfig(source({ claudePath: '/opt/claude', pauseWhenQuotaRuns: false, maxTranscriptItems: 50 }));
  checkEqual('and a value that is set wins, under the name the setting has',
    [set.claudePath, set.pauseOnLimit, set.maxItems], ['/opt/claude', false, 50]);
  checkEqual('your snippets go on top of the shipped ones',
    readSnippets(source({ promptSnippets: { a: 'mine' } }, { a: 'shipped', b: 'kept' })), { a: 'mine', b: 'kept' });
  const shipped = properties['nikui.promptSnippets'].default;
  const plain = { get: (key, fallback) => key === 'promptSnippets' ? { table: '', x: '1' } : fallback };
  checkEqual('a source with no inspect keeps shipped snippets and explicit disabling',
    readSnippets(plain), { ...shipped, table: '', x: '1' });
  checkEqual('an unavailable inspect falls back to manifest snippets',
    readSnippets({ get: (k, d) => d, inspect() { throw new Error('unavailable'); } }), shipped);
  checkEqual('inspect without a declared default falls back to the manifest',
    readSnippets({ get: (k, d) => d, inspect: () => ({}) }), shipped);
  checkEqual('a plain source gets the same status defaults as the editor',
    readConfig(plain).statusEmoji, properties['nikui.statusEmoji'].default);
  const changed = readConfig(plain);
  changed.statusEmoji.idle = 'changed'; changed.extraArgs.push('--changed'); changed.promptSnippets.table = 'changed';
  const fresh = readConfig({ get: (k, d) => d });
  checkEqual('reading and changing defaults cannot mutate the manifest or the next read',
    [fresh.statusEmoji, fresh.extraArgs, fresh.promptSnippets],
    [properties['nikui.statusEmoji'].default, [], shipped]);

  // In a fresh process where requiring the editor fails outright: the manager
  // given its own settings must never reach for VS Code.
  const root = path.join(__dirname, '..');
  const script = `
    const Module = require('module'); const orig = Module._load;
    Module._load = function (r) { if (r === 'vscode') throw new Error('vscode required'); return orig.apply(this, arguments); };
    const { SessionManager, readConfig } = require(${JSON.stringify(path.join(root, 'src/manager.js'))});
    const store = new Map();
    const context = { globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } } };
    let executable = '/x/claude';
    const settings = () => ({ get: (k, d) => (k === 'claudePath' ? executable : d) });
    const m = new SessionManager(context, { settings });
    const first = m.config.claudePath;
    executable = '/y/claude';
    const other = new SessionManager(context, { settings: () => ({ get: (k, d) => d }) });
    process.stdout.write(JSON.stringify({ first, changed: m.config.claudePath, other: other.config.claudePath,
      explicit: readConfig(settings()).claudePath, snippets: Object.keys(m.config.promptSnippets) }));`;
  let out = null;
  try { out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 })); }
  catch (err) { out = { error: String(err.stderr || err.message).split('\n').find((l) => /Error/.test(l)) }; }
  checkEqual('injected managers and explicit reads stay independent and fresh without VS Code', out,
    { first: '/x/claude', changed: '/y/claude', other: 'claude', explicit: '/y/claude', snippets: Object.keys(shipped) });

  suite('the test runner cannot inherit a live keeper');
  const runnerProbe = `
    const fs = require('fs'), path = require('path'), os = require('os');
    const read = fs.readdirSync;
    fs.readdirSync = function (dir) {
      if (dir === ${JSON.stringify(path.join(root, 'test'))}) {
        const { defaultDir, KeeperLink } = require(${JSON.stringify(path.join(root, 'src/keeperLink.js'))});
        const dir = defaultDir();
        process.stdout.write(JSON.stringify({ isolated: dir !== 'inherited-live-sentinel',
          exists: fs.statSync(dir).isDirectory(), mode: fs.statSync(dir).mode & 0o777,
          link: new KeeperLink().dir === dir }));
        fs.rmdirSync(dir);
        return [];
      }
      return read.apply(this, arguments);
    };
    require(${JSON.stringify(path.join(root, 'test/run.js'))});`;
  const probe = execFileSync(process.execPath, ['-e', runnerProbe], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, NIKUI_KEEPER_DIR: 'inherited-live-sentinel' }
  });
  checkEqual('even an inherited directory is replaced before test modules load',
    JSON.parse(probe.split('\n')[0]), { isolated: true, exists: true, mode: 0o700, link: true });
};

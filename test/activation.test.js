'use strict';
const path = require('path');
const { install, fakeContext } = require('./helpers/vscode-stub.js');

const stub = install();
const extension = require('../src/extension.js');
const pkg = require('../package.json');

module.exports = async function () {
  suite('activation');

  const context = fakeContext({ extensionUri: { fsPath: path.join(__dirname, '..') } });
  extension.activate(context);

  const { commands, views, serializers } = stub.__registered;
  checkEqual('every view is registered',
    [...new Set(views)].filter((id) => !/focus-test/.test(id)),
    ['nikui.sessions', 'nikui.history', 'nikui.devices']);
  check('panels can be restored after a reload', serializers.includes('nikui.session'));

  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  const implemented = Object.keys(commands).sort();
  checkEqual('every declared command is implemented', declared.filter((c) => !implemented.includes(c)), []);
  checkEqual('every implemented command is declared', implemented.filter((c) => !declared.includes(c)), []);

  // Row actions must not leak onto folder or project rows.
  const rowActions = pkg.contributes.menus['view/item/context']
    .filter((m) => ['nikui.rename', 'nikui.restart', 'nikui.stop', 'nikui.moveToFolder'].includes(m.command));
  check('instance actions are scoped to instances', rowActions.every((m) => /viewItem == running/.test(m.when)));
  const folderActions = pkg.contributes.menus['view/item/context']
    .filter((m) => ['nikui.renameFolder', 'nikui.deleteFolder'].includes(m.command));
  check('folder actions are scoped to folders', folderActions.every((m) => /viewItem == nikuiFolder/.test(m.when)));

  suite('defaults');

  const props = pkg.contributes.configuration.properties;
  checkEqual('permissions bypass by default', props['nikui.permissionMode'].default, 'bypassPermissions');
  checkEqual('effort is left to Claude Code by default', props['nikui.effort'].default, '');
  checkEqual('the shipped snippets are /table, /decisions and /lean',
    Object.keys(props['nikui.promptSnippets'].default).join(' '), 'table decisions lean');
  checkEqual('output style is Concise by default', props['nikui.outputStyle'].default, 'Concise');
  checkEqual('instances group automatically', props['nikui.groupByProject'].default, 'auto');

  suite('the keyboard reaches the extension');

  const keys = pkg.contributes.keybindings || [];
  check('there are keybindings at all', keys.length > 0);
  checkEqual('every one points at a real command', keys.filter((k) => !declared.includes(k.command)), []);
  check('every one has a mac binding too', keys.every((k) => k.key && k.mac));
  check('nothing steals a bare letter', keys.every((k) => /(ctrl|alt|shift|cmd)\+/.test(k.key)));
  const panelOnly = keys.filter((k) => k.command === 'nikui.status');
  check('the panel binding only fires inside a panel',
    panelOnly.every((k) => /activeWebviewPanelId/.test(k.when || '')));

  suite('an empty view still says something');

  const welcome = pkg.contributes.viewsWelcome || [];
  const welcomed = welcome.map((w) => w.view);
  check('the instances view has welcome text', welcomed.includes('nikui.sessions'));
  check('the history view has welcome text', welcomed.includes('nikui.history'));

  // A welcome button that points at a command nobody registered is a dead end.
  const linked = welcome.flatMap((w) => [...String(w.contents).matchAll(/command:([\w.]+)/g)].map((m) => m[1]));
  check('every welcome button links somewhere', linked.length > 0);
  checkEqual('and every link is a real command', linked.filter((c) => !declared.includes(c)), []);

  // The two kinds of empty History have to be told apart, which needs the key.
  const scoped = welcome.filter((w) => w.view === 'nikui.history');
  checkEqual('history says which scope it searched', scoped.length, 2);
  check('and does so through a context key',
    scoped.every((w) => /nikui\.historyScope/.test(w.when || '')));

  suite('restarting an instance means restarting it the way things are set now');

  // The model an instance runs is fixed when its process starts, so changing
  // the setting and restarting is the only way to move one. That did nothing:
  // the model, the effort and the rest were captured when the instance was
  // first created and never looked at again, so the obvious way to apply a
  // setting was also the way to discover it had not been applied.
  {
    const vscode = require('vscode');
    const manager = extension.__manager || null;
    // The command picks a session; without a manager to pick from, this drives
    // the same path the command does by handing it one directly.
    const session = {
      id: 's1', label: 'an instance', hasHistory: false, everStarted: true,
      claudePath: 'old-path', model: 'claude-opus-5', permissionMode: 'ask',
      effort: 'low', outputStyle: '', extraArgs: [],
      restarted: null,
      restart(opts) { this.restarted = opts; }
    };
    void manager;

    vscode.__config['model'] = 'claude-opus-5-5[1m]';
    vscode.__config['effort'] = 'max';
    vscode.__answers.push('Restart and keep context');
    await commands['nikui.restart'](session);

    checkEqual('the instance comes back on the model that is set now',
      session.model, 'claude-opus-5-5[1m]');
    checkEqual('and with everything else the process is started with',
      session.effort, 'max');
    check('and it really did restart', !!session.restarted);
    checkEqual('keeping the conversation it was having', session.restarted.keepContext, true);

    delete vscode.__config['model'];
    delete vscode.__config['effort'];
  }

  suite('a window that was serving comes back serving');

  // Reloading the editor used to drop every phone: the server did not restart
  // unless autoStart was on, and disposing tore down the tunnel in front of it.
  // Neither is a decision somebody made — they are what a reload did to them.
  {
    const { serveLocally } = extension;
    const manager = { list: [], get: () => null, on() {}, off() {}, activeId: null };

    const remembered = fakeContext({ extensionUri: { fsPath: path.join(__dirname, '..') } });
    remembered.workspaceState.update('nikui.remote.wasServing', true);
    const resumed = serveLocally(remembered, manager, { state: () => null }, null);
    check('a window that was serving starts its server again', !!resumed);
    await new Promise((r) => setTimeout(r, 120));
    check('and is listening without anybody asking twice', resumed.listening === true);
    await resumed.dispose();

    // A window nobody has asked for anything now serves by default, because the
    // alternative is a phone that can only reach a laptop somebody remembered
    // to arm. The server still binds to loopback and nothing else; a device
    // still has to be paired to say a word to it.
    const vscode = require('vscode');
    const fresh = fakeContext({ extensionUri: { fsPath: path.join(__dirname, '..') } });
    const eager = serveLocally(fresh, manager, { state: () => null }, null);
    await new Promise((r) => setTimeout(r, 120));
    check('a fresh window serves by default, so a phone can find it', eager.listening === true);
    checkEqual('on loopback and nowhere else', eager.server.address().address, '127.0.0.1');
    await eager.dispose();

    // And the setting still means what it says.
    vscode.__config['remote.autoStart'] = false;
    const off = fakeContext({ extensionUri: { fsPath: path.join(__dirname, '..') } });
    const quiet = serveLocally(off, manager, { state: () => null }, null);
    await new Promise((r) => setTimeout(r, 120));
    check('a window told not to start stays quiet', quiet.listening === false);
    delete vscode.__config['remote.autoStart'];
    await quiet.dispose();
  }

  suite('only one window at a time holds the tailnet');

  // `tailscale serve` is one setting for the whole machine. Two windows both
  // claiming it would mean the second quietly takes every phone from the first:
  // the address does not change, so nothing looks wrong — the phone is simply
  // showing a different window's instances. That is the failure this prevents,
  // and it cannot be found by looking at one window.
  {
    const { serveLocally } = extension;
    const manager = { list: [], get: () => null, on() {}, off() {}, activeId: null };
    const fake = (held) => {
      const it = {
        held,
        exposed: [],
        forwardedPort: async () => it.held,
        status: async () => ({ installed: true, running: true, https: true, name: 'laptop.example.ts.net' }),
        expose: async (port) => {
          it.exposed.push(port);
          it.held = port;
          return { ok: true, host: 'laptop.example.ts.net', url: 'https://laptop.example.ts.net/' };
        },
        hide: async () => { it.held = null; return { ok: true }; }
      };
      return it;
    };
    const open = (tailscale) => serveLocally(
      fakeContext({ extensionUri: { fsPath: path.join(__dirname, '..') } }),
      manager, { state: () => null }, null, { tailscale });
    const settle = () => new Promise((r) => setTimeout(r, 400));

    const nobodys = fake(null);
    const first = open(nobodys);
    await settle();
    checkEqual('a free tailnet is claimed by the window that starts', nobodys.exposed.length, 1);
    checkEqual('and it forwards to that window', nobodys.exposed[0], first.port);
    check('which is then reachable', first.exposed === true);

    // The same machine-wide state, seen by a second window, while the first is
    // still answering on it.
    const taken = fake(first.port);
    const second = open(taken);
    await settle();
    checkEqual('a second window does not take it away', taken.exposed.length, 0);
    check('it still serves, on loopback', second.listening === true);
    check('but it does not claim to be reachable', second.exposed === false);
    check('and the first still holds the address', first.exposed === true);
    await second.dispose();

    // A window that was closed leaves the machine-wide setting pointing at a
    // port where nothing answers. That is not somebody else's tunnel; it is
    // litter, and the next window should pick it up.
    const stale = fake(first.port);
    await first.stop();
    const third = open(stale);
    await settle();
    checkEqual('a tunnel pointing at a dead port is claimed', stale.exposed.length, 1);
    checkEqual('by the window that is alive', stale.exposed[0], third.port);
    await third.dispose();
  }

  check('the flag is per window rather than shared between them',
    /workspaceState/.test(require('fs').readFileSync(
      path.join(__dirname, '..', 'src', 'extension.js'), 'utf8')));
};
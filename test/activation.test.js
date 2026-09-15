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
  checkEqual('both views are registered', views, ['nikui.sessions', 'nikui.history']);
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
  checkEqual('effort is max by default', props['nikui.effort'].default, 'max');
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
};

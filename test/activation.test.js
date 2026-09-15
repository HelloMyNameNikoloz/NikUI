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
};

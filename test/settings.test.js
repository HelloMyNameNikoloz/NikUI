'use strict';

// One place for everything NikUI can be told.
//
// The menu is built from the extension's own contributed configuration rather
// than from a second list, so the thing worth testing is exactly that: every
// setting appears, nothing that is not a setting appears, and each one is shown
// in a form somebody can act on.

const { install } = require('./helpers/vscode-stub.js');
install();

const menu = require('../src/settingsMenu.js');
const manifest = require('../package.json');

module.exports = async function () {
  suite('every setting is in the menu, because the menu is the settings');

  const schema = menu.schemaFrom(require('path').join(__dirname, '..'));
  const declared = Object.keys(schema);
  const rows = menu.settingRows(schema);

  checkEqual('the menu is built from what package.json declares',
    rows.length, declared.length);
  checkEqual('and nothing is missed',
    declared.filter((k) => !rows.some((r) => r.key === k)), []);
  check('there is more than a handful, so this is worth having', declared.length > 20);

  // The drift this exists to prevent: a setting added and forgotten.
  const contributed = Object.keys(
    ((manifest.contributes || {}).configuration || {}).properties || {});
  checkEqual('the extension contributes exactly these', contributed.sort(), declared.slice().sort());

  suite('each one reads as something a person can decide');

  check('every row has a name rather than a key',
    rows.every((r) => r.label && r.label !== r.key && !/^nikui\./.test(r.label) &&
      !/[a-z][A-Z]/.test(r.label)));
  check('and none of them is empty', rows.every((r) => r.label.trim().length > 2));
  check('every row says what it is set to now',
    rows.every((r) => typeof r.description === 'string' && r.description.length > 0));
  check('and what it is for', rows.every((r) => r.detail && r.detail.length > 10));
  check('with the explanation trimmed to one line',
    rows.every((r) => !/\n/.test(r.detail) && r.detail.length <= 150));

  checkEqual('a boolean reads as on or off',
    menu.shown(true, { type: 'boolean' }) + '/' + menu.shown(false, { type: 'boolean' }), 'On/Off');
  checkEqual('an empty string says so rather than showing nothing',
    menu.shown('', { type: 'string' }), 'not set');
  checkEqual('a list is counted', menu.shown([1, 2, 3], { type: 'array' }), '3 items');
  checkEqual('and one item is not called items', menu.shown([1], { type: 'array' }), '1 item');
  checkEqual('an object is counted too',
    menu.shown({ a: 1, b: 2 }, { type: 'object' }), '2 entries');
  check('and something long is cut rather than wrapped',
    menu.shown('x'.repeat(200), { type: 'string' }).length <= 44);

  suite('and is filed where somebody would look for it');

  const groups = new Set(rows.map((r) => r.group));
  check('there are groups, rather than one list of thirty', groups.size >= 3);
  check('and every row is in one', rows.every((r) => r.group && r.group.length > 3));

  checkEqual('the server and the phone are together',
    menu.groupFor('nikui.remote.appOnly'), menu.groupFor('nikui.notifyDevices'));
  checkEqual('Apple has its own, because it is the one that needs an account',
    menu.groupFor('nikui.apns.keyId'), menu.groupFor('nikui.apns.production'));
  check('and the longest prefix wins, so remote.* is not filed under the fallback',
    menu.groupFor('nikui.remote.port') !== menu.OTHER);

  checkEqual('a name nobody wrote is derived from the key',
    menu.nameFor('nikui.some.newThingHere'), 'New thing here');
  checkEqual('and a name somebody wrote is used instead',
    menu.nameFor('nikui.remote.appOnly'), 'Serve the app only, no browser page');

  suite('the menu itself');

  const items = await menu.buildItems({
    schema,
    actions: [{ label: '$(broadcast) Start the local server', run: () => {} }]
  });
  const pickable = items.filter((i) => !i.kind);
  check('what you can do comes before what you can set',
    pickable.findIndex((i) => i.action) < pickable.findIndex((i) => i.row));
  check('every setting is still there once the list is built',
    rows.every((r) => pickable.some((i) => i.row && i.row.key === r.key)));
  check('and there is a way out to the real settings editor',
    pickable.some((i) => i.openEditor));
  check('anything changed from its default is marked',
    pickable.filter((i) => i.row).every((i) =>
      i.label.startsWith(i.row.changed ? '$(circle-filled)' : '$(blank)')));

  suite('it is reachable from everywhere it should be');

  const commands = (manifest.contributes.commands || []).map((c) => c.command);
  check('the palette has it', commands.includes('nikui.settings'));
  const titles = (manifest.contributes.menus['view/title'] || [])
    .filter((m) => m.command === 'nikui.settings').map((m) => m.when);
  for (const view of ['nikui.sessions', 'nikui.history', 'nikui.devices']) {
    check('and so does the ' + view.split('.').pop() + ' view',
      titles.includes('view == ' + view));
  }
  check('under the overflow rather than as another icon in the row',
    (manifest.contributes.menus['view/title'] || [])
      .filter((m) => m.command === 'nikui.settings')
      .every((m) => !/^navigation/.test(m.group || '')));
};

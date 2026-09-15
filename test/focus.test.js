'use strict';
const { EventEmitter } = require('events');
const { install, fakeContext } = require('./helpers/vscode-stub.js');

const stub = install();
const { followFocus } = require('../src/extension.js');
const { SessionManager } = require('../src/manager.js');
const { SessionPanel } = require('../src/panel.js');
const { Session } = require('../src/session.js');

module.exports = async function () {
  suite('the sidebar follows the open tab');

  // ---- the panel tells the manager which instance is in front -------------

  const context = fakeContext();
  const manager = new SessionManager(context);
  const one = new Session({ cwd: '/Users/nikoloz/Codes/Peuka' });
  const two = new Session({ cwd: '/Users/nikoloz/Codes/NikUI' });
  manager.sessions.set(one.id, one);
  manager.sessions.set(two.id, two);

  const focused = [];
  manager.on('focused', (s) => focused.push(s.id));

  const panelOne = SessionPanel.show(one, context, manager);
  checkEqual('opening a panel makes its instance the active one', manager.active && manager.active.id, one.id);

  const panelTwo = SessionPanel.show(two, context, manager);
  checkEqual('opening a second panel moves the active one', manager.active && manager.active.id, two.id);

  // Clicking back onto the first tab is a view-state change, not a new panel.
  panelOne.panel.__onViewState({ webviewPanel: Object.assign(panelOne.panel, { active: true }) });
  checkEqual('bringing a tab forward focuses its instance again', manager.active.id, one.id);
  checkEqual('each switch is announced once', focused, [one.id, two.id, one.id]);

  // A tab losing focus must not announce anything.
  panelOne.panel.__onViewState({ webviewPanel: Object.assign(panelOne.panel, { active: false }) });
  checkEqual('losing focus changes nothing', focused.length, 3);

  panelOne.dispose();
  panelTwo.dispose();

  // ---- the sidebar reveals whatever the manager says is in front ----------

  const view = stub.window.createTreeView('nikui.sessions.focus-test');
  const fake = new EventEmitter();
  followFocus(view, fake);

  fake.emit('focused', one);
  checkEqual('the focused instance is revealed', view.revealed.length, 1);
  checkEqual('the revealed row is the one in front', view.revealed[0].element.id, one.id);
  check('it is selected without stealing focus from the editor',
    view.revealed[0].options.select === true && view.revealed[0].options.focus === false);
  check('a collapsed group is expanded to show it', view.revealed[0].options.expand === true);

  // A hidden sidebar must not be forced open behind the user's back.
  view.visible = false;
  fake.emit('focused', two);
  checkEqual('a hidden sidebar is left alone', view.revealed.length, 1);
  view.visible = true;

  // reveal() rejects for a row the tree does not know yet; that must not throw.
  view.reveal = () => Promise.reject(new Error('element not found'));
  let threw = false;
  try { fake.emit('focused', two); } catch (_) { threw = true; }
  check('an unknown row is survived quietly', !threw);
};

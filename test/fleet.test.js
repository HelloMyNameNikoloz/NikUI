'use strict';

// How a phone files the window.
//
// The editor's sidebar puts instances into folders somebody made and projects
// their directories belong to. A phone that shows a flat list is showing the
// same instances and a different window — so the rule for grouping them is
// here, where it can be argued with, rather than only in a screenshot.

global.window = global.window || {};
window.nikTransport = () => ({ postMessage() {}, getState: () => null, setState() {} });
window.localStorage = { getItem: () => null, setItem() {} };
global.document = global.document || {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
  body: { classList: { add() {}, remove() {}, contains: () => false } },
  addEventListener() {}
};
global.window.addEventListener = global.window.addEventListener || (() => {});
global.window.location = global.window.location || { href: 'https://localhost/index.html' };

const { group } = require('../media/home.js');

const at = (id, extra) => Object.assign({ id, label: id, status: 'idle', cwd: '/x', cost: 0 }, extra);

module.exports = async function () {
  suite('the window, filed the way the editor files it');

  const folder = { id: 'f1', name: 'Phone epic' };
  const project = { path: '/Users/me/Codes/thing', name: 'thing' };
  const other = { path: '/Users/me/Codes/web', name: 'web' };

  const groups = group([
    at('a', { folder }),
    at('b', { folder }),
    at('c', { project }),
    at('d', { project: other }),
    at('e', {})
  ], [folder, { id: 'f2', name: 'Someday' }]);

  checkEqual('a folder somebody made comes first',
    groups[0].name + '/' + groups[0].kind, 'Phone epic/folder');
  checkEqual('then the folder they emptied, because it is still theirs',
    groups[1].name, 'Someday');
  check('folders before projects', groups.findIndex((g) => g.kind === 'project') > 1);
  checkEqual('and anything belonging to neither goes last',
    groups[groups.length - 1].kind, 'loose');

  checkEqual('everything is filed exactly once',
    groups.reduce((n, g) => n + g.instances.length, 0), 5);
  checkEqual('a folder holds what was put in it',
    groups[0].instances.map((i) => i.id), ['a', 'b']);
  checkEqual('a project holds what its directory implies',
    groups.find((g) => g.name === 'thing').instances.map((i) => i.id), ['c']);
  checkEqual('an empty folder is shown, and is empty',
    groups[1].instances.length, 0);

  // A folder wins over a project: somebody said where this belongs, and a path
  // did not.
  const both = group([at('a', { folder, project })], []);
  checkEqual('being told beats being worked out', both[0].kind, 'folder');
  checkEqual('and it is filed once, not twice', both.length, 1);

  suite('and not filed at all when there is nothing to tell apart');

  const one = group([at('a', { project }), at('b', { project })], []);
  checkEqual('one project is one group', one.length, 1);
  checkEqual('with everything in it', one[0].instances.length, 2);

  const none = group([at('a', {}), at('b', {})], []);
  checkEqual('and a window with no projects at all is one group too', none.length, 1);
  checkEqual('called something rather than nothing', none[0].name, 'Everything else');

  suite('projects are sorted so the list does not move about');

  const shuffled = group([
    at('a', { project: { path: '/z', name: 'zeta' } }),
    at('b', { project: { path: '/a', name: 'alpha' } }),
    at('c', { project: { path: '/m', name: 'mid' } })
  ], []);
  checkEqual('in name order', shuffled.map((g) => g.name), ['alpha', 'mid', 'zeta']);
};

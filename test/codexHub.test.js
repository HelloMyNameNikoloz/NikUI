'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { SessionHub } = require('../src/hub.js');

// Codex's ways of working, as every screen watching a conversation sees them;
// and a task handed from a Claude conversation to Codex.

function viewer(id, device) {
  const got = [];
  return { id, device, got, post: (m) => got.push(m), last: (type) => got.filter((m) => m.type === type).pop() };
}

function quietSession(opts) {
  const s = new Session(Object.assign({ cwd: '/repo' }, opts || {}));
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

const host = (extra) => Object.assign({
  config: () => ({ promptSnippets: {} }),
  home: '/home',
  knownCommands: () => ['status', 'effort'],
  fleet: () => [],
  env: () => ({})
}, extra || {});

module.exports = async function () {
  suite('a Codex conversation offers Codex’s own commands');

  const cx = quietSession();
  Object.defineProperty(cx, 'provider', { value: 'codex' });
  cx.modelChoices = () => [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', detail: 'default' }];
  const switched = [];
  const hub = new SessionHub(cx, host({ switchTo: (id) => switched.push(id) }));
  const laptop = viewer('laptop');
  hub.attach(laptop);
  await hub.receive('laptop', { type: 'ready' });
  const init = laptop.last('init');
  for (const c of ['plan', 'goal', 'review', 'fork', 'undo', 'model', 'effort', 'steer']) {
    check('/' + c + ' is listed', init.slashCommands.includes(c));
  }
  check('Claude’s are not', !init.slashCommands.includes('compact'));
  checkEqual('models come from Codex', init.commandArgs.model.map((m) => m.value), ['gpt-6.1-sol']);
  check('efforts reach ultra', init.commandArgs.effort.some((e) => e.value === 'ultra'));

  cx.meta.mode = 'plan';
  cx.meta.goal = { objective: 'Ship it', status: 'active' };
  cx.meta.usingMac = { since: 1, title: 'Take a screenshot' };
  cx.emit('meta');
  const meta = laptop.last('meta').meta;
  checkEqual('plan mode is told', meta.mode, 'plan');
  checkEqual('the goal is told', meta.goal.objective, 'Ship it');
  checkEqual('driving the Mac is told', meta.usingMac.title, 'Take a screenshot');

  suite('a fork takes whoever asked to it');
  await hub.receive('laptop', { type: 'send', text: '/fork', attachments: [] });
  cx.emit('open', 'cx-new');
  checkEqual('the editor switches tab', switched, ['cx-new']);
  const phone = viewer('phone', { id: 'p1', control: true });
  hub.attach(phone);
  await hub.receive('phone', { type: 'ready' });
  await hub.receive('phone', { type: 'send', text: '/fork', attachments: [] });
  cx.emit('open', 'cx-two');
  checkEqual('the phone navigates', phone.last('@navigate') && phone.last('@navigate').session, 'cx-two');
  checkEqual('and the laptop stays', switched, ['cx-new']);

  suite('/codex hands a task from Claude to Codex');
  const claude = quietSession();
  claude._upsert({ id: 'u1', kind: 'user', text: 'Make the header blue' });
  claude._upsert({ id: 't1', kind: 'text', text: 'Done; the header is blue now.' });
  const given = [];
  const went = [];
  const chub = new SessionHub(claude, host({
    handOffToCodex: async (req) => { given.push(req); return 'cx-9'; },
    switchTo: (id) => went.push(id)
  }));
  const ed = viewer('ed');
  chub.attach(ed);
  await chub.receive('ed', { type: 'ready' });
  check('/codex is offered', ed.last('init').slashCommands.includes('codex'));
  const sent = [];
  claude.submit = (t) => sent.push(t);
  await chub.receive('ed', { type: 'send', text: '/codex test it in the Simulator', attachments: [] });
  checkEqual('Claude is not sent it', sent, []);
  checkEqual('in the same folder', given[0] && given[0].cwd, '/repo');
  check('with the task', /Your task: test it in the Simulator/.test(given[0].text));
  check('and what was last said', /Make the header blue/.test(given[0].text) && /header is blue now/.test(given[0].text));
  checkEqual('and the editor goes there', went, ['cx-9']);
  await chub.receive('ed', { type: 'send', text: '/codexy', attachments: [] });
  checkEqual('a longer word is not it', sent, ['/codexy']);
  const failing = new SessionHub(claude, host({ handOffToCodex: async () => { throw new Error('no Codex'); } }));
  failing.attach(viewer('x'));
  await failing.receive('x', { type: 'send', text: '/codex go', attachments: [] });
  check('a failure is said in the conversation', claude.items.some((i) => i.kind === 'notice' && /no Codex/.test(i.text)));
};

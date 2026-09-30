'use strict';

// /settings: the handful of settings people change, as switches.
//
// Two things are checked here. That each row says what is true — the value,
// and for the laptop's two switches what the machine is actually doing — and
// that a change is only ever one the list allows: a phone may flip a switch on
// this list and nothing else, however the message is written.

const { install } = require('./helpers/vscode-stub.js');
install();
const prefs = require('../src/prefs.js');
const { Session } = require('../src/session.js');
const { SessionHub } = require('../src/hub.js');

function quietSession() {
  const s = new Session({ cwd: '/tmp' });
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

/** Settings as a plain object, the way VS Code would hand them back. */
function store(values) {
  const now = Object.assign({
    model: '', effort: 'max', permissionMode: 'bypassPermissions', showThinking: true,
    pauseWhenQuotaRuns: true, keepAwake: false, lidClosed: false,
    notifyDevices: { needsYou: true, quota: true, failed: true, turnFinished: false },
    fontSize: 13, interruptOnSingleEscape: false, notifyOnAttention: true, autoTitleFromTicket: true
  }, values || {});
  const writes = [];
  return {
    now, writes,
    get: (key) => now[key],
    set: async (key, value) => { writes.push([key, value]); now[key] = value; }
  };
}

const row = (read, id) => read.rows.find((r) => r.id === id);

module.exports = async function () {
  suite('what the sheet shows');

  {
    const s = store();
    const read = prefs.read(s.get, { models: [
      { value: 'claude-opus-5-5', label: 'Opus 5.5' },
      { value: 'claude-opus-5-5[1m]', label: 'Opus 5.5', detail: '1M context' }
    ] });
    checkEqual('five groups, in the order somebody reads them', read.groups,
      ['Claude', 'Your laptop', 'Notifications on your laptop', 'Notifications on your phone', 'In the editor']);
    check('every row belongs to one of them', read.rows.every((r) => read.groups.includes(r.group)));
    check('and is said in words, not keys', read.rows.every((r) => !/nikui\.|[A-Z][a-z]+[A-Z]/.test(r.label)));

    checkEqual('a switch holds its value', row(read, 'thinking').value, true);
    checkEqual('a choice holds its value', row(read, 'effort').value, 'max');
    check('and offers every choice by name', row(read, 'effort').choices.some((c) => c.label === 'Extra high'));
    checkEqual('permissions are said as what they do',
      row(read, 'permissions').choices.find((c) => c.value === 'bypassPermissions').label,
      'Never ask');

    const models = row(read, 'model').choices;
    checkEqual('the model list starts with the default', models[0], { value: '', label: 'Claude Code default' });
    checkEqual('then the models this CLI knows, by name', models[1].label, 'Opus 5.5');
    check('and the wide one says what is wide about it', /1M context/.test(models[2].label));

    const kept = prefs.read(store({ model: 'claude-some-old-one' }).get, { models: [] });
    check('a model this CLI has forgotten is still shown when it is the one set',
      row(kept, 'model').choices.some((c) => c.value === 'claude-some-old-one'));

    checkEqual('a phone notification is one key of an object, read as a switch',
      row(read, 'notify.turnFinished').value, false);
    const partial = prefs.read(store({ notifyDevices: { turnFinished: true } }).get, {});
    checkEqual('a key the object does not have falls back to what the notifier does',
      row(partial, 'notify.needsYou').value, true);
  }

  suite('the laptop switches say what the laptop is doing');

  {
    const s = store({ lidClosed: true });
    const unapproved = prefs.read(s.get, {
      awake: { on: true, held: true, reason: 'listening for your phone', supported: true,
        lid: { on: true, supported: true, approved: false } }
    });
    check('keep awake says it is holding, and why', /Awake now · listening/.test(row(unapproved, 'awake').note));
    check('the lid says it still needs the password', /password once/.test(row(unapproved, 'lid').note));
    check('and is marked as wanting attention', row(unapproved, 'lid').warn === true);

    const holding = prefs.read(s.get, {
      awake: { on: false, supported: true, lid: { on: true, supported: true, approved: true, held: true, reason: '1327 is working' } }
    });
    check('working with the lid closed says so', /lid closed · 1327 is working/.test(row(holding, 'lid').note));

    const desktop = prefs.read(s.get, { awake: { supported: true, lid: { supported: false } } });
    check('a Mac without a lid says so rather than offering it', !!row(desktop, 'lid').unavailable);

    const none = prefs.read(s.get, {});
    check('a window that offers no switch says so', !!row(none, 'lid').unavailable);
  }

  suite('what a change may be');

  {
    const refuses = (id, value) => { try { prefs.validate(id, value); return false; } catch (_) { return true; } };
    check('a switch is on or off, not a word', refuses('thinking', 'yes'));
    check('a choice is one of its choices', refuses('effort', 'ludicrous'));
    check('a number stays in its range', refuses('fontSize', 99) && refuses('fontSize', 9.5));
    check('a model is a name, not a sentence', refuses('model', 'opus; rm -rf ~'));
    checkEqual('and the default is a model like any other', prefs.validate('model', ''), '');
    checkEqual('a real one passes', prefs.validate('model', 'claude-opus-5-5[1m]'), 'claude-opus-5-5[1m]');

    // The point of a list: not everything is on it.
    check('the path to the executable cannot be reached from here', refuses('claudePath', '/tmp/evil'));
    check('nor can the extra arguments', refuses('extraArgs', ['--dangerously']));
    check('nor whether connections must be sealed', refuses('remote.requireEncryption', false));
  }

  suite('and how it is written');

  {
    const s = store();
    await prefs.write('effort', 'high', s);
    checkEqual('a plain setting is written as itself', s.writes[0], ['effort', 'high']);

    await prefs.write('notify.turnFinished', true, s);
    checkEqual('a phone notification is merged into its object, keeping the rest',
      s.now.notifyDevices, { needsYou: true, quota: true, failed: true, turnFinished: true });

    const switched = [];
    await prefs.write('lid', true, Object.assign({}, s, { special: { lid: async (v) => switched.push(v) } }));
    checkEqual('the laptop switches go through the switch, not the file', switched, [true]);
    check('and are not written behind its back', !s.writes.some(([k]) => k === 'lidClosed'));

    let threw = false;
    await prefs.write('claudePath', '/tmp/evil', s).catch(() => { threw = true; });
    check('something not on the list is refused on the way in', threw);
    check('and nothing was written', !s.writes.some(([k]) => k === 'claudePath'));
  }

  suite('over the hub, the same rules as a prompt');

  {
    const session = quietSession();
    const s = store();
    const asked = [];
    const trail = [];
    const hub = new SessionHub(session, {
      config: () => ({ showThinking: true, promptSnippets: {} }),
      home: '/home',
      audit: (entry) => trail.push(entry),
      settings: () => prefs.read(s.get, {}),
      setSetting: (id, value, from) => { asked.push([id, value, from]); return prefs.write(id, value, s); }
    });
    const heard = [];
    const phone = { id: 'phone', device: { id: 'd1', name: 'A phone', kind: 'device', control: false },
      post: (m) => heard.push(['phone', m]) };
    const editor = { id: 'editor', post: (m) => heard.push(['editor', m]) };
    hub.attach(phone);
    hub.attach(editor);
    // A client is answered once it has said it is ready, as every real one does.
    await hub.receive('phone', { type: 'ready' });
    await hub.receive('editor', { type: 'ready' });
    const last = (who, type) => heard.filter(([w, m]) => w === who && m.type === type).map(([, m]) => m).pop();

    await hub.receive('phone', { type: 'settings' });
    const shown = last('phone', 'settings');
    check('a watching phone may look', !!shown && !!shown.settings);
    checkEqual('and is told it may not change anything', shown.mayChange, false);
    checkEqual('nor offered the editor’s full list', shown.local, false);

    await hub.receive('phone', { type: 'setSetting', id: 'thinking', value: false });
    check('a watching phone changing one is refused', !!last('phone', '@refused'));
    checkEqual('and nothing was written', s.writes.length, 0);

    phone.device.control = true;
    hub.setDevice('phone', phone.device);
    await hub.receive('phone', { type: 'setSetting', id: 'thinking', value: false });
    checkEqual('with control, it is written', s.now.showThinking, false);
    checkEqual('and the trail says which setting, and to what',
      trail.filter((e) => e.allowed).map((e) => e.detail).pop(), 'thinking → false');
    check('as it does for the one that was refused',
      trail.some((e) => e.allowed === false && e.detail === 'thinking → false'));
    checkEqual('marked as coming from a phone, not the editor', asked[0][2], { local: false });
    checkEqual('and answered with what is true now', row(last('phone', 'settings').settings, 'thinking').value, false);

    await hub.receive('phone', { type: 'setSetting', id: 'claudePath', value: '/tmp/evil' });
    check('something off the list is refused with a reason', /not a setting that can be changed from here/.test(last('phone', 'settings').refused || ''));

    await hub.receive('editor', { type: 'settings' });
    checkEqual('the editor may change anything on the list', last('editor', 'settings').mayChange, true);
    checkEqual('and is offered the full list', last('editor', 'settings').local, true);
    await hub.receive('editor', { type: 'setSetting', id: 'fontSize', value: 15 });
    checkEqual('and is marked as the editor', asked[asked.length - 1][2], { local: true });

    const before = heard.length;
    await hub.receive('editor', { type: 'settingsOpen', open: false });
    hub.broadcastSettings();
    const after = heard.slice(before).filter(([, m]) => m.type === 'settings').map(([w]) => w);
    checkEqual('a change is told to whoever still has the sheet open, and only them', after, ['phone']);
    hub.dispose && hub.dispose();
    session.dispose();
  }
};

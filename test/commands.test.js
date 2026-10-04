'use strict';

// /commands: NikUI's own commands, described, and your prompt snippets, which
// the page reads, rewrites, switches off, puts back and adds to.

const { install } = require('./helpers/vscode-stub.js');
install();
const commands = require('../src/commands.js');
const sheet = require('../media/commands.js');
const { Session } = require('../src/session.js');
const { SessionHub, STEERING, OWN_COMMANDS } = require('../src/hub.js');

const SHIPPED = { table: 'Give me a table. Then more.', lean: 'Work lean.' };
const SAID = { table: 'The plan as a table.', lean: 'Fewer steps.' };

function quietSession() {
  const s = new Session({ cwd: '/tmp' });
  s.start = function () { this.everStarted = true; };
  s._write = function () {};
  Object.defineProperty(s, 'isRunning', { get: () => true });
  return s;
}

function refusal(fn) {
  try { fn(); return null; } catch (err) { return err.message; }
}

module.exports = async function () {
  suite('what the commands page lists');

  {
    const list = commands.list({ shipped: SHIPPED, mine: { Mine: 'My own. Second.', lean: '' }, shippedSaid: SAID, mineSaid: {} });
    checkEqual('NikUI\'s own first, then the shipped, then yours',
      list.map((c) => c.name), ['status', 'settings', 'commands', 'watch', 'table', 'lean', 'mine']);
    check('every own command says what it does', list.filter((c) => c.kind === 'own').every((c) => c.description && c.usage));
    checkEqual('the hub offers exactly those as its own', OWN_COMMANDS, commands.OWN_NAMES);
    const table = list.find((c) => c.name === 'table');
    checkEqual('a shipped snippet carries its prompt', table.prompt, SHIPPED.table);
    checkEqual('and its description', table.description, SAID.table);
    check('and is not marked as edited', table.shipped && !table.edited && !table.off);
    const lean = list.find((c) => c.name === 'lean');
    check('a shipped one emptied is listed as off, so it can come back', lean.off && lean.edited);
    const mine = list.find((c) => c.name === 'mine');
    check('yours is not shipped', !mine.shipped && !mine.edited);
    checkEqual('one with no description is summed up by its first sentence', mine.summary, 'My own.');
    const noise = commands.list({ shipped: SHIPPED, mine: { ghost: '' } });
    check('emptying a word nobody ships lists nothing', !noise.some((c) => c.name === 'ghost'));
    const clash = commands.list({ shipped: {}, mine: { status: 'hijack' } });
    checkEqual('a snippet cannot shadow one of NikUI\'s own', clash.filter((c) => c.name === 'status').length, 1);
    checkEqual('a long first sentence is cut', commands.summarise('x'.repeat(300)).length, 158);
  }

  suite('saving a snippet from the page');

  {
    const held = { shipped: SHIPPED, mine: {}, shippedSaid: SAID, mineSaid: {} };
    const added = commands.save(held, { name: '/Checklist', prompt: '  End with a checklist.  ', description: 'A checklist  at the end' });
    checkEqual('a new one is written under its lower-case name', added.mine, { checklist: 'End with a checklist.' });
    checkEqual('with its description, tidied', added.mineSaid, { checklist: 'A checklist at the end' });
    checkEqual('and says which name it saved', added.name, 'checklist');

    const same = commands.save(held, { was: 'table', name: 'table', prompt: SHIPPED.table, description: SAID.table });
    checkEqual('saving a shipped one unchanged writes nothing', same.mine, {});
    checkEqual('nor a description', same.mineSaid, {});

    const edited = commands.save(held, { was: 'table', name: 'table', prompt: 'A shorter table.', description: SAID.table });
    checkEqual('rewriting a shipped one keeps only the change', edited.mine, { table: 'A shorter table.' });
    checkEqual('and leaves its description to ship', edited.mineSaid, {});

    const renamed = commands.save({ shipped: SHIPPED, mine: { old: 'Old.' }, mineSaid: { old: 'was' } },
      { was: 'old', name: 'new', prompt: 'Old.', description: 'was' });
    checkEqual('a rename moves yours', renamed.mine, { new: 'Old.' });
    checkEqual('description and all', renamed.mineSaid, { new: 'was' });

    const movedShipped = commands.save(held, { was: 'lean', name: 'thin', prompt: 'Work lean.' });
    checkEqual('renaming a shipped one switches the old word off', movedShipped.mine, { lean: '', thin: 'Work lean.' });

    const revived = commands.save({ shipped: SHIPPED, mine: { lean: '' } }, { was: 'lean', name: 'lean', prompt: 'Work lean.' });
    checkEqual('saving one that was off with the shipped text puts it back', revived.mine, {});

    check('a name is needed', /Give it a name/.test(refusal(() => commands.save(held, { name: ' ', prompt: 'x' }))));
    check('and must be a word', /starts with a letter/.test(refusal(() => commands.save(held, { name: '9 lives', prompt: 'x' }))));
    check('not too long', /longer than 40/.test(refusal(() => commands.save(held, { name: 'a'.repeat(41), prompt: 'x' }))));
    check('nor one of NikUI\'s own', /NikUI's own/.test(refusal(() => commands.save(held, { name: 'watch', prompt: 'x' }))));
    check('nor one already there', /already a \/table/.test(refusal(() => commands.save(held, { name: 'table', prompt: 'x' }))));
    check('an empty prompt is turned away with the right way to do it', /switch it off instead/.test(refusal(() => commands.save(held, { name: 'x', prompt: '   ' }))));
    check('a prompt too long is refused', /longer than/.test(refusal(() => commands.save(held, { name: 'x', prompt: 'p'.repeat(commands.MAX_PROMPT + 1) }))));
    check('a description too long is refused', /under 300/.test(refusal(() => commands.save(held, { name: 'x', prompt: 'p', description: 'd'.repeat(301) }))));
    check('editing one that has gone says so', /not there any more/.test(refusal(() => commands.save(held, { was: 'gone', name: 'gone', prompt: 'x' }))));
    check('a name of an off one is free to take', !!commands.save({ shipped: SHIPPED, mine: { lean: '' } }, { name: 'lean', prompt: 'Mine now.' }));
    const mixed = commands.save({ shipped: {}, mine: { Old: 'x' } }, { was: 'old', name: 'old', prompt: 'y' });
    checkEqual('keys in any case are found and settled in lower case', mixed.mine, { old: 'y' });
  }

  suite('removing and restoring');

  {
    const held = { shipped: SHIPPED, mine: { table: 'Changed.', mine: 'Mine.' }, shippedSaid: SAID, mineSaid: { table: 'x', mine: 'y' } };
    const gone = commands.remove(held, '/mine');
    checkEqual('yours is deleted outright', gone.mine, { table: 'Changed.' });
    checkEqual('description too', gone.mineSaid, { table: 'x' });
    const off = commands.remove(held, 'lean');
    checkEqual('a shipped one is switched off, not deleted', off.mine.lean, '');
    const back = commands.restore(held, 'table');
    checkEqual('restoring drops your version', back.mine, { mine: 'Mine.' });
    checkEqual('and your description', back.mineSaid, { mine: 'y' });
    check('only a shipped one can be restored', /nothing to put back/.test(refusal(() => commands.restore(held, 'mine'))));
    check('NikUI\'s own cannot be removed', /NikUI's own/.test(refusal(() => commands.remove(held, 'status'))));
    check('nor something that is not there', /not there any more/.test(refusal(() => commands.remove(held, 'nope'))));
  }

  suite('over the hub, changing a snippet is steering');

  {
    check('save, remove and restore need control',
      ['saveCommand', 'removeCommand', 'restoreCommand'].every((t) => STEERING.has(t)));
    check('looking does not', !STEERING.has('commands') && !STEERING.has('commandsOpen'));

    let held = { shipped: SHIPPED, mine: {}, shippedSaid: SAID, mineSaid: {} };
    const apply = (how) => (arg) => {
      const next = commands[how](held, arg);
      held = Object.assign({}, held, { mine: next.mine, mineSaid: next.mineSaid });
      return next.name;
    };
    const trail = [];
    const hub = new SessionHub(quietSession(), {
      config: () => ({ showThinking: true, promptSnippets: {} }),
      home: '/home',
      audit: (entry) => trail.push(entry),
      commands: () => commands.list(held),
      saveCommand: apply('save'),
      removeCommand: apply('remove'),
      restoreCommand: apply('restore')
    });
    const heard = [];
    const phone = { id: 'phone', device: { id: 'd1', name: 'A phone', kind: 'device', control: false },
      post: (m) => heard.push(['phone', m]) };
    const editor = { id: 'editor', post: (m) => heard.push(['editor', m]) };
    hub.attach(phone);
    hub.attach(editor);
    await hub.receive('phone', { type: 'ready' });
    await hub.receive('editor', { type: 'ready' });
    const last = (who, type) => heard.filter(([w, m]) => w === who && m.type === type).map(([, m]) => m).pop();

    await hub.receive('phone', { type: 'commands' });
    const shown = last('phone', 'commands');
    check('a watching phone may read the list', !!shown && shown.commands.some((c) => c.name === 'table'));
    checkEqual('and is told it may not change it', shown.mayChange, false);

    await hub.receive('phone', { type: 'saveCommand', name: 'sneak', prompt: 'rm -rf' });
    check('a watching phone saving one is refused', !!last('phone', '@refused'));
    checkEqual('and nothing was written', held.mine, {});
    check('the refusal is written down, with which command',
      trail.some((t) => t.allowed === false && /\/sneak/.test(t.detail || t.what || JSON.stringify(t))));

    await hub.receive('editor', { type: 'commands' });
    checkEqual('the editor may change it', last('editor', 'commands').mayChange, true);
    await hub.receive('editor', { type: 'saveCommand', was: '', name: 'Checklist', prompt: 'End with a checklist.', description: '' });
    const saved = last('editor', 'commands');
    checkEqual('a save is answered with the name it went under', [saved.done, saved.name], ['saveCommand', 'checklist']);
    check('and the list it is in now', saved.commands.some((c) => c.name === 'checklist'));

    await hub.receive('editor', { type: 'saveCommand', was: '', name: 'table', prompt: 'x' });
    const refused = last('editor', 'commands');
    check('a clash is refused with the reason', /already a \/table/.test(refused.refused || ''));
    check('and is not marked done', !refused.done);

    await hub.receive('editor', { type: 'removeCommand', name: 'lean' });
    checkEqual('removing a shipped one switches it off', held.mine.lean, '');
    await hub.receive('editor', { type: 'restoreCommand', name: 'lean' });
    check('and restoring brings it back', !('lean' in held.mine));

    const before = heard.length;
    hub.broadcastCommands();
    const told = heard.slice(before).filter(([, m]) => m.type === 'commands').map(([w]) => w).sort();
    checkEqual('a change elsewhere reaches every page that is open', told, ['editor', 'phone']);
    await hub.receive('phone', { type: 'commandsOpen', open: false });
    const after = heard.length;
    hub.broadcastCommands();
    checkEqual('and not one that was closed', heard.slice(after).map(([w]) => w), ['editor']);

    const bare = new SessionHub(quietSession(), { config: () => ({ promptSnippets: {} }), home: '/home' });
    const said = [];
    bare.attach({ id: 'e', post: (m) => said.push(m) });
    await bare.receive('e', { type: 'ready' });
    await bare.receive('e', { type: 'commands' });
    checkEqual('a host without commands says it has none', said.filter((m) => m.type === 'commands').pop().commands, null);
    await bare.receive('e', { type: 'saveCommand', name: 'x', prompt: 'y' });
    check('and refuses a change in words', /does not offer its commands/.test(said.filter((m) => m.type === 'commands').pop().refused || ''));
  }

  suite('the page, drawn');

  {
    const list = commands.list({ shipped: SHIPPED, mine: { lean: '', mine: 'Mine <b>bold</b>.' }, shippedSaid: SAID, mineSaid: {} });
    const html = sheet.render({ commands: list, mayChange: true }, { active: 'table' });
    check('it is /status\'s layout: a rail and a page', /class="sheet-nav cmd-nav"/.test(html) && /class="sheet-content cmd-content"/.test(html));
    check('every command is in the rail', list.every((c) => html.includes('data-command="' + c.name + '"')));
    check('with a way to add one', html.includes('data-command="+new"'));
    check('the open one is marked', /nav-item cmd-item on" data-command="table"/.test(html));
    check('its prompt is previewed', html.includes('class="cmd-prompt">Give me a table. Then more.'));
    check('and it can be edited', html.includes('data-act="edit"'));
    check('an off one is marked off', /data-command="lean"[^>]*>[^]*?cmd-tag">off/.test(html));
    const yours = sheet.render({ commands: list, mayChange: true }, { active: 'mine' });
    check('a prompt is escaped, not drawn', yours.includes('Mine &lt;b&gt;bold&lt;/b&gt;.') && !yours.includes('<b>bold</b>'));
    check('yours can be deleted', yours.includes('data-act="ask-remove">Delete'));
    const confirm = sheet.render({ commands: list, mayChange: true }, { active: 'mine', confirm: 'mine' });
    check('deleting asks once more', confirm.includes('data-act="remove">Delete /mine?') && confirm.includes('data-act="keep"'));
    const own = sheet.render({ commands: list, mayChange: true }, { active: 'watch' });
    check('NikUI\'s own are described and not editable', /Watches the CI/.test(own) && !own.includes('data-act="edit"'));
    const edited = commands.list({ shipped: SHIPPED, mine: { table: 'Changed.' }, shippedSaid: SAID });
    check('a changed shipped one can be put back',
      sheet.render({ commands: edited, mayChange: true }, { active: 'table' }).includes('data-act="restore"'));
    const form = sheet.render({ commands: list, mayChange: true },
      { active: 'table', editing: { was: 'table', name: 'table', description: 'd"x', prompt: '</textarea><script>' }, refused: 'No.' });
    check('the form holds the draft, escaped', form.includes('value="d&quot;x"') && form.includes('&lt;/textarea&gt;&lt;script&gt;'));
    check('and says why the last save was refused', form.includes('role="alert">No.'));
    const watching = sheet.render({ commands: list, mayChange: false }, { active: 'table' });
    check('a watching device reads but cannot change', !watching.includes('data-act="edit"') && !watching.includes('data-command="+new"'));
    check('and is told why', /can watch but not change commands/.test(watching));
    check('a window without commands says so', /does not offer its commands/.test(sheet.render({ commands: null }, {})));
    checkEqual('a name no longer there falls back to the first', sheet.pick(list, 'gone').name, 'status');
  }
};

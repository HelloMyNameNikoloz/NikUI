/* The /commands page: every command NikUI answers itself, and your prompt
   snippets, each with what it is for and what it sends.

   Laid out like /status — a rail of names on the left, the one you picked on
   the right — because it is the same kind of thing to read: a list you move
   through, with a page for each. What is in the list comes from the laptop
   (src/commands.js); this draws it, and the form that changes a snippet. */
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const icon = (name, size) => (root.icon ? root.icon(name, size) : '');

  // The page's own name for the entry that is not a command yet.
  const NEW = '+new';

  function card(title, body, klass) {
    return '<section class="card wide' + (klass ? ' ' + klass : '') + '">' +
      (title ? '<h3>' + esc(title) + '</h3>' : '') + body + '</section>';
  }

  /** Which entry is open: the one asked for if it is still there, else the first. */
  function pick(list, active) {
    if (active === NEW) return null;
    return list.find((c) => c.name === active) || list[0] || null;
  }

  function navItem(c, on) {
    const tag = c.off ? '<span class="cmd-tag">off</span>'
      : c.kind === 'snippet' && !c.shipped ? '<span class="cmd-tag">yours</span>'
        : c.edited ? '<span class="cmd-tag">edited</span>' : '';
    return '<button class="nav-item cmd-item' + (on ? ' on' : '') + (c.off ? ' off' : '') +
      '" data-command="' + esc(c.name) + '" title="' + esc(c.summary || c.description || '') + '">' +
      '<span class="cmd-name">/' + esc(c.name) + '</span>' + tag + '</button>';
  }

  function renderNav(list, active, mayChange) {
    const own = list.filter((c) => c.kind === 'own');
    const snippets = list.filter((c) => c.kind === 'snippet');
    return '<div class="cmd-group">NikUI</div>' +
      own.map((c) => navItem(c, c.name === active)).join('') +
      '<div class="cmd-group">Prompt snippets</div>' +
      snippets.map((c) => navItem(c, c.name === active)).join('') +
      (mayChange ? '<button class="nav-item cmd-item cmd-new' + (active === NEW ? ' on' : '') +
        '" data-command="' + NEW + '">' + icon('plus', 14) + '<span>New snippet</span></button>' : '');
  }

  /** What typing the snippet does, with the prompt it adds. */
  function preview(c) {
    return card('Prompt', '<pre class="cmd-prompt">' + esc(c.prompt) + '</pre>', 'cmd-preview') +
      card('How to use it',
        '<p class="cmd-usage"><code>fix the rollback /' + esc(c.name) + '</code> or ' +
        '<code>/' + esc(c.name) + ' fix the rollback</code></p>' +
        '<p class="dim">Sends your words with this prompt after them. The panel shows only your words, ' +
        'with /' + esc(c.name) + ' under them. Several snippets stack, in the order you typed them.</p>');
  }

  function viewSnippet(c, o) {
    const actions = o.mayChange ? '<div class="cmd-actions">' +
      '<button data-act="edit">Edit</button>' +
      (c.shipped && c.edited ? '<button class="ghost" data-act="restore">Restore default</button>' : '') +
      (c.off ? '' : o.confirm === c.name
        ? '<button class="danger" data-act="remove">' + (c.shipped ? 'Switch off' : 'Delete') + ' /' + esc(c.name) + '?</button>' +
          '<button class="ghost" data-act="keep">Keep it</button>'
        : '<button class="ghost" data-act="ask-remove">' + (c.shipped ? 'Switch off' : 'Delete') + '</button>') +
      '</div>' : '';
    const said = c.description
      ? '<p class="cmd-description">' + esc(c.description) + '</p>'
      : '<p class="cmd-description dim">' + esc(c.summary || 'No description yet.') + '</p>';
    const where = c.off ? 'Switched off. Edit it or restore the default to use it again.'
      : c.shipped ? (c.edited ? 'Ships with NikUI, and you have changed it.' : 'Ships with NikUI.')
        : 'Yours.';
    return card('/' + c.name, said + '<p class="cmd-where dim">' + esc(where) + '</p>' + actions, 'cmd-head-card') +
      (c.off ? '' : preview(c));
  }

  function viewOwn(c) {
    return card('/' + c.name,
      '<p class="cmd-description">' + esc(c.description) + '</p>' +
      '<p class="cmd-usage"><code>' + esc(c.usage) + '</code></p>' +
      '<p class="cmd-where dim">Built into NikUI and answered here, so it never reaches Claude Code. ' +
      'It cannot be edited.</p>', 'cmd-head-card');
  }

  /** The form, for a new snippet or one being changed. Draft values win. */
  function form(draft, o) {
    const d = draft || {};
    const isNew = !d.was;
    return card(isNew ? 'New snippet' : 'Edit /' + d.was,
      (o.refused ? '<p class="prefs-refused" role="alert">' + esc(o.refused) + '</p>' : '') +
      '<label class="cmd-field"><span>Name</span>' +
      '<span class="cmd-slash"><b>/</b><input id="cmd-name" data-field="name" autocomplete="off" autocapitalize="off" ' +
        'spellcheck="false" maxlength="40" placeholder="checklist" value="' + esc(d.name) + '"></span></label>' +
      '<label class="cmd-field"><span>What it is for</span>' +
      '<input id="cmd-description" data-field="description" maxlength="300" ' +
        'placeholder="One line, shown in this list" value="' + esc(d.description) + '"></label>' +
      '<label class="cmd-field"><span>Prompt</span>' +
      '<textarea id="cmd-prompt" data-field="prompt" rows="12" ' +
        'placeholder="The instruction added after what you type">' + esc(d.prompt) + '</textarea></label>' +
      '<div class="cmd-actions">' +
      '<button data-act="save"' + (o.saving ? ' disabled' : '') + '>' + (o.saving ? 'Saving…' : 'Save') + '</button>' +
      '<button class="ghost" data-act="cancel">Cancel</button>' +
      '</div>', 'cmd-form');
  }

  /**
   * The sheet's whole inner HTML.
   *
   * @param {object} message  what the laptop sent: `commands`, `mayChange`
   * @param {object} view     what this page is doing: `active` (a name, or
   *                          '+new'), `editing` (the draft, while the form is
   *                          up), `confirm`, `refused`, `saving`
   */
  function render(message, view) {
    const m = message || {};
    const v = view || {};
    const list = m.commands || [];
    const mayChange = m.mayChange !== false;
    const o = { mayChange, confirm: v.confirm, refused: v.refused, saving: v.saving };
    const open = pick(list, v.active);
    const active = v.active === NEW ? NEW : open && open.name;
    const count = list.filter((c) => c.kind === 'snippet' && !c.off).length;

    const head = '<div class="sheet-head prefs-head">' +
      '<div class="sheet-title">' + icon('slash', 15) + '<b>Commands</b>' +
      '<span class="dim">' + esc(count + (count === 1 ? ' snippet' : ' snippets') + ' · type / in the box to use one') +
      '</span></div>' +
      '<div class="sheet-actions">' +
      '<button class="ghost" data-act="settings" title="Back to settings">Settings</button>' +
      '<button class="icon-only" data-act="close" title="Close" aria-label="Close">' + icon('x', 15) + '</button>' +
      '</div></div>';

    let content;
    if (!m.commands) content = card('', '<p class="prefs-lede">This window does not offer its commands here.</p>');
    else if (v.editing) content = form(v.editing, o);
    else if (active === NEW) content = form({ was: '', name: '', description: '', prompt: '' }, o);
    else if (!open) content = card('', '<p class="prefs-lede">Nothing here yet.</p>');
    else content = (v.refused ? '<p class="prefs-refused" role="alert">' + esc(v.refused) + '</p>' : '') +
      (open.kind === 'own' ? viewOwn(open) : viewSnippet(open, o));

    const lede = mayChange ? '' : '<p class="prefs-lede cmd-locked">This device can watch but not change commands. ' +
      'Grant it control in the editor.</p>';

    const foot = '<div class="sheet-foot">' +
      esc('Snippets are saved in nikui.promptSnippets, for every instance · Esc to close') + '</div>';

    return '<h2 class="sr-only" id="sheet-title">Commands</h2>' + head +
      '<div class="sheet-body cmd-body">' +
      '<nav class="sheet-nav cmd-nav">' + renderNav(list, active, mayChange) + '</nav>' +
      '<div class="sheet-content cmd-content" tabindex="0">' + lede + content + '</div>' +
      '</div>' + foot;
  }

  /** The entry by name, from the laptop's own list. */
  function find(message, name) {
    const list = (message && message.commands) || [];
    return list.find((c) => c.name === name) || null;
  }

  const api = { render, find, pick, NEW };
  root.commandsSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

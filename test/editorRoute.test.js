'use strict';

const { selectEditor } = require('../src/editorRoute');

function provider(id, workspaces, focused, extra) {
  return Object.assign({ id, workspaces: workspaces || [], focused: !!focused,
    openFile() {}, openUrl() {}, runInTerminal() {}, switchTo() {}, openAllSettings() {} }, extra);
}

function result(options) {
  const choice = selectEditor(Object.assign({ method: 'openFile' }, options));
  return choice.status === 'selected' ? [choice.status, choice.provider.id, choice.via]
    : choice.status === 'system' ? [choice.status, choice.via]
      : [choice.status, choice.code, choice.reason, choice.editor];
}

module.exports = function () {
  suite('editor routing: origin, URI roots, focus, explicit refusal');
  const a = provider('window-A', ['file:///work'], true);
  const b = provider('window-B', ['file:///work/nested']);
  const c = provider('window-C', ['vscode-remote://ssh-remote+host/work']);
  const providers = [a, b, c];
  const cases = [
    ['origin wins over a longer workspace and focus',
      { providers, requester: { editor: 'window-C' }, request: { path: 'a.js', cwd: '/work/nested' } },
      ['selected', 'window-C', 'origin']],
    ['an action payload cannot override the trusted origin',
      { providers, requester: { editor: 'window-C' }, request: { editor: 'window-A', cwd: '/work/nested' } },
      ['selected', 'window-C', 'origin']],
    ['a saved explicit selection wins over an origin',
      { providers, selected: 'window-B', requester: { editor: 'window-A' } }, ['selected', 'window-B', 'origin']],
    ['a vanished origin refuses instead of selecting the focused window',
      { providers, requester: { editor: 'closed-window' }, request: { cwd: '/work' } },
      ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_DISCONNECTED', 'closed-window']],
    ['a vanished saved selection also refuses',
      { providers, selected: 'closed-window' },
      ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_DISCONNECTED', 'closed-window']],
    ['a disconnected selected provider refuses',
      { providers: [a, provider('gone', ['/work'], true, { connected: false })], requester: { editor: 'gone' } },
      ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_DISCONNECTED', 'gone']],
    ['an origin without the method refuses instead of falling through',
      { providers: [a, provider('limited', [], false, { methods: ['openUrl'] })], requester: { editor: 'limited' } },
      ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_UNSUPPORTED', 'limited']],
    ['the longest matching workspace wins over focus',
      { providers, request: { cwd: '/work/nested', path: 'src/a.js', line: 19 } }, ['selected', 'window-B', 'workspace']],
    ['a root itself matches',
      { providers, request: { uri: 'file:///work/nested' } }, ['selected', 'window-B', 'workspace']],
    ['workspace matching is on segment boundaries',
      { providers, request: { uri: 'file:///work/nested-other/a.js' } }, ['selected', 'window-A', 'workspace']],
    ['a similarly prefixed folder is not a match',
      { providers: [provider('prefix', ['file:///workspace'], false), a], request: { cwd: '/workspace-other' } },
      ['selected', 'window-A', 'focus']],
    ['an absolute file path can match without a cwd',
      { providers, request: { path: '/work/nested/a.js' } }, ['selected', 'window-B', 'workspace']],
    ['relative dot segments resolve against cwd',
      { providers, request: { cwd: 'file:///work/nested/sub', path: '../a.js' } }, ['selected', 'window-B', 'workspace']],
    ['home-relative paths use an explicit home instead of a process global',
      { providers, home: '/work', request: { cwd: '/elsewhere', path: '~/nested/a.js' } }, ['selected', 'window-B', 'workspace']],
    ['a bare home path can match a workspace',
      { providers, home: '/work/nested', request: { path: '~' } }, ['selected', 'window-B', 'workspace']],
    ['home-relative paths without a supplied home fall back to focus',
      { providers, request: { cwd: '/work/nested', path: '~/other/a.js' } }, ['selected', 'window-A', 'focus']],
    ['a quoted empty path falls back to the cwd',
      { providers, request: { cwd: '/work/nested', path: '""' } }, ['selected', 'window-B', 'workspace']],
    ['an unresolved relative path falls back to focus',
      { providers, request: { path: 'a.js' } }, ['selected', 'window-A', 'focus']],
    ['file URI queries and fragments do not change coverage',
      { providers, request: { resource: 'file:///work/nested/a.js?view=1#L5' } }, ['selected', 'window-B', 'workspace']],
    ['a remote resource keeps its scheme and authority',
      { providers, request: { uri: 'vscode-remote://ssh-remote+host/work/a.js' } }, ['selected', 'window-C', 'workspace']],
    ['remote cwd plus a relative path keeps the authority',
      { providers, request: { cwd: 'vscode-remote://ssh-remote+host/work', path: 'src/a.js' } },
      ['selected', 'window-C', 'workspace']],
    ['a remote cwd query or fragment does not displace its directory',
      { providers, request: { cwd: 'vscode-remote://ssh-remote+host/work?view=1#selection', path: 'src/a.js' } },
      ['selected', 'window-C', 'workspace']],
    ['an opaque cwd cannot resolve a relative resource',
      { providers, request: { cwd: 'untitled:buffer', path: 'a.js' } }, ['selected', 'window-A', 'focus']],
    ['a nonlocal file cwd cannot be converted to a local path',
      { providers, request: { cwd: 'file://server/work', path: 'a.js' } }, ['selected', 'window-A', 'focus']],
    ['an absolute path under a remote cwd is still remote',
      { providers, request: { cwd: 'vscode-remote://ssh-remote+host/work/other', path: '/work/a.js' } },
      ['selected', 'window-C', 'workspace']],
    ['two remote authorities are distinct',
      { providers, request: { uri: 'vscode-remote://ssh-remote+other/work/a.js' } }, ['selected', 'window-A', 'focus']],
    ['a local path cannot match a remote root',
      { providers: [c], request: { cwd: '/work' } }, ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_UNAVAILABLE', null]],
    ['URI objects preserve authority instead of using their fsPath',
      { providers, request: { uri: { fsPath: '/work/a.js', toString: () => 'vscode-remote://ssh-remote+host/work/a.js' } } },
      ['selected', 'window-C', 'workspace']],
    ['plain local URI stubs can supply fsPath',
      { providers, request: { uri: { fsPath: '/work/nested/a.js' } } }, ['selected', 'window-B', 'workspace']],
    ['a URI with another scheme cannot match',
      { providers, request: { uri: 'custom://ssh-remote+host/work/a.js' } }, ['selected', 'window-A', 'focus']],
    ['authority credentials cannot be discarded when comparing URIs',
      { providers: [provider('auth', ['custom://owner@host/work'])], request: { uri: 'custom://other@host/work/a.js' } },
      ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_UNAVAILABLE', null]],
    ['trailing slashes on a root are harmless',
      { providers: [provider('slash', ['file:///work/nested/'])], request: { path: '/work/nested/a.js' } },
      ['selected', 'slash', 'workspace']],
    ['the filesystem root covers descendants',
      { providers: [provider('root', ['file:///'])], request: { path: '/somewhere/a.js' } }, ['selected', 'root', 'workspace']],
    ['spaces in local paths match encoded URI roots',
      { providers: [provider('spaces', ['file:///work/a%20b'])], request: { cwd: '/work/a b', path: 'a.js' } },
      ['selected', 'spaces', 'workspace']],
    ['a hash in a local filename stays part of the filename',
      { providers: [provider('hash', ['file:///work/a%23b'])], request: { cwd: '/work', path: 'a#b/c.js' } },
      ['selected', 'hash', 'workspace']],
    ['encoded slashes do not become workspace boundaries',
      { providers: [provider('encoded', ['custom://host/work/a'])], request: { uri: 'custom://host/work/a%2Fb/file' } },
      ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_UNAVAILABLE', null]],
    ['every workspace announced by a provider participates',
      { providers: [provider('multi', ['file:///elsewhere', 'file:///work/nested'])], request: { cwd: '/work/nested' } },
      ['selected', 'multi', 'workspace']],
    ['equal roots keep registry order',
      { providers: [b, provider('tie', ['file:///work/nested'], true)], request: { cwd: '/work/nested' } },
      ['selected', 'window-B', 'workspace']],
    ['a disconnected match or focused window is ineligible',
      { providers: [provider('gone', ['file:///work/nested'], true, { connected: false }), a], request: { cwd: '/work/nested' } },
      ['selected', 'window-A', 'workspace']],
    ['declared methods filter matching providers',
      { providers: [provider('limited', ['file:///work/nested'], false, { methods: ['openUrl'] }), a], request: { cwd: '/work/nested' } },
      ['selected', 'window-A', 'workspace']],
    ['a missing implementation is ineligible even with a declaration',
      { providers: [provider('missing', ['file:///work'], true, { openFile: undefined, methods: ['openFile'] })] },
      ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_UNAVAILABLE', null]],
    ['a declared bridge method is eligible',
      { providers: [{ id: 'bridge', methods: ['openFile'], request() {}, focused: true }] }, ['selected', 'bridge', 'focus']],
    ['invalid roots and resources fall back to eligible focus',
      { providers: [provider('invalid', ['not a URI']), a], request: { uri: 'not a URI' } }, ['selected', 'window-A', 'focus']],
    ['an invalid URI object falls back to focus',
      { providers, request: { uri: { fsPath: 7 } } }, ['selected', 'window-A', 'focus']],
    ['no resource uses eligible focus', { providers }, ['selected', 'window-A', 'focus']],
    ['one unfocused, unmatched registry provider is not implicitly selected',
      { providers: [b] }, ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_UNAVAILABLE', null]],
    ['an empty registry returns an explicit unavailable result',
      { providers: [], method: 'runInTerminal' }, ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_UNAVAILABLE', null]],
    ['without an editor URLs request the system default browser',
      { providers: [], method: 'openUrl' }, ['system', 'defaultBrowser']],
    ['an unsupported URL method can use the system browser',
      { providers: [provider('limited', [], true, { methods: ['openFile'] })], method: 'openUrl' }, ['system', 'defaultBrowser']],
    ['a selected URL provider disappearing still refuses',
      { providers, method: 'openUrl', requester: { editor: 'closed-window' } },
      ['unavailable', 'EDITOR_UNAVAILABLE', 'EDITOR_DISCONNECTED', 'closed-window']]
  ];
  for (const [name, input, expected] of cases) checkEqual(name, result(input), expected);

  const missing = selectEditor({ providers, method: 'openFile', requester: { editor: 'closed-window' } });
  check('the unavailable reason names the selected window', missing.message.includes('closed-window'));
  const request = Object.freeze({ uri: 'vscode-remote://ssh-remote+host/work/a.js', cwd: '/work', line: 17 });
  const requester = Object.freeze({ editor: 'window-C', client: 'client-1', local: true });
  const frozen = Object.freeze(providers.map((p) => Object.freeze(p)));
  const before = JSON.stringify({ request, requester, frozen });
  const choice = selectEditor({ providers: frozen, method: 'openFile', request, requester });
  check('selection retains the exact provider', choice.provider === c);
  checkEqual('selection mutates neither requests nor provider state', JSON.stringify({ request, requester, frozen }), before);
};

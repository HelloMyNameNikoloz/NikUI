'use strict';

const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

/** A URI stays a URI: in particular, two remote authorities are not one cwd. */
function uri(value) {
  if (!value) return null;
  if (typeof value !== 'string') {
    const text = String(value);
    value = text !== '[object Object]' ? text : value.fsPath;
  }
  if (typeof value !== 'string') return null;
  try {
    if (path.isAbsolute(value)) return pathToFileURL(path.normalize(value));
    return new URL(value);
  } catch (_) { return null; }
}

function resourceUri(request, home) {
  const req = request || {};
  if (req.uri || req.resource) return uri(req.uri || req.resource);
  const cwd = uri(req.cwd);
  if (!req.path) return cwd;
  const raw = String(req.path).trim().replace(/^["'`]|["'`]$/g, '');
  if (!raw) return cwd;
  if (raw === '~' || raw.startsWith('~/')) return home ? uri(path.resolve(home, raw.slice(2))) : null;
  // A path under a remote cwd belongs to that authority, even when absolute.
  if (cwd && cwd.protocol !== 'file:' && !/^[a-z][a-z\d+.-]*:/i.test(raw)) {
    try {
      const directory = new URL(cwd);
      directory.pathname = directory.pathname.replace(/\/?$/, '/');
      directory.search = ''; directory.hash = '';
      return new URL(raw, directory);
    }
    catch (_) { return null; }
  }
  const absolute = uri(raw);
  if (absolute) return absolute;
  if (cwd && cwd.protocol === 'file:') {
    try { return pathToFileURL(path.resolve(fileURLToPath(cwd), raw)); }
    catch (_) { return null; }
  }
  return null;
}

function matchLength(root, resource) {
  const base = uri(root);
  if (!base || !resource || base.protocol !== resource.protocol || base.host !== resource.host ||
      base.username !== resource.username || base.password !== resource.password) return -1;
  const prefix = base.pathname.replace(/\/+$/, '') || '/';
  const at = resource.pathname;
  return at === prefix || at.startsWith(prefix === '/' ? '/' : prefix + '/') ? prefix.length : -1;
}

function supports(provider, method) {
  return (!provider.methods || provider.methods.includes(method)) &&
    (typeof provider[method] === 'function' || typeof provider.request === 'function');
}

function unavailable(reason, editor, method) {
  const message = reason === 'EDITOR_DISCONNECTED' ? `Editor ${editor} is no longer connected.`
    : reason === 'EDITOR_UNSUPPORTED' ? `Editor ${editor} does not support ${method}.`
      : `No editor is available for ${method}.`;
  return { status: 'unavailable', code: 'EDITOR_UNAVAILABLE', reason, editor: editor || null, message };
}

/**
 * Pure selection over a connection's provider snapshot. Requester/selected IDs
 * must come from the trusted host, never an action payload. Equal root matches
 * keep registration order. Once selected, a missing/unsupported editor refuses
 * rather than sending the action to another window.
 *
 * Providers: { id, methods?, workspaces: URI[], focused, connected?, ...methods }
 * A bridge may implement request(method, request, requester) instead of methods.
 * URL providers must use the system default external browser; the system result
 * asks the machine's injected opener to do the same when no provider is eligible.
 */
function selectEditor({ providers = [], method, request, requester, selected, home } = {}) {
  const origin = selected || (requester && requester.editor);
  if (origin) {
    const provider = providers.find((p) => p.id === origin);
    if (!provider || provider.connected === false) return unavailable('EDITOR_DISCONNECTED', origin, method);
    if (!supports(provider, method)) return unavailable('EDITOR_UNSUPPORTED', origin, method);
    return { status: 'selected', provider, via: 'origin' };
  }
  const eligible = providers.filter((p) => p.connected !== false && supports(p, method));
  const resource = resourceUri(request, home);
  let best = null, longest = -1;
  for (const provider of eligible) {
    for (const root of provider.workspaces || []) {
      const length = matchLength(root, resource);
      if (length > longest) { best = provider; longest = length; }
    }
  }
  if (best) return { status: 'selected', provider: best, via: 'workspace' };
  const focused = eligible.find((p) => p.focused);
  if (focused) return { status: 'selected', provider: focused, via: 'focus' };
  if (method === 'openUrl') return { status: 'system', via: 'defaultBrowser' };
  return unavailable('EDITOR_UNAVAILABLE', null, method);
}

module.exports = { selectEditor };

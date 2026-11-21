'use strict';

const os = require('os');
const { readConfig } = require('./config');
const { transcriptPath } = require('./history');
const { selectEditor } = require('./editorRoute');
const { requireThat } = require('./protocolV2');

const EDITOR_TIMEOUT_MS = 15000;

// A bridge may lose its reply after doing the work. Bound the wait, retain
// that uncertainty and never retry in a different editor. Direct extension
// calls keep their existing return values and dialog lifetimes.
function boundedEditorResult(pending, provider, timeoutMs) {
  let timer;
  return Promise.race([pending, new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      status: 'unavailable', code: 'EDITOR_UNAVAILABLE', reason: 'EDITOR_TIMEOUT', editor: provider.id,
      outcome: 'unknown', message: `Editor ${provider.id} did not answer in time. The action may have completed.`
    }), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

/**
 * The host shared by every client of a manager. Settings are a get/inspect/update
 * source (or a fresh-source function); writeSetting uses fully qualified keys.
 * An editor is either one explicitly bound provider, or { providers: () => [] }
 * for routing a connection-bound registry (timeoutMs defaults to 15 seconds).
 * UI and environment facts belong to the caller; env.openUrl, when supplied,
 * opens URLs in the system default browser without an editor. No installed
 * host, editor imports or machine service singletons.
 */
function createMachineHost({ manager, settings, writeSetting, ledger, devices, awake, codex,
  prFeed, pickPr, setPr, editor, ui, env = {} } = {}) {
  const source = (cwd) => typeof settings === 'function' ? settings(cwd)
    : cwd && typeof settings.forProject === 'function' ? settings.forProject(cwd) : settings;
  const facts = () => (typeof env === 'function' ? env() : env) || {};
  const config = (cwd) => readConfig(source(cwd));
  const get = (key) => source().get(key);
  const set = (key, value) => writeSetting ? writeSetting('nikui.' + key, value) : source().update(key, value);
  const limits = () => facts().codexLimits || null;

  function route(method, request, requester, args) {
    const registry = editor && typeof editor.providers === 'function';
    const providers = registry ? Array.from(editor.providers()) : editor ? [editor] : [];
    const selected = !registry && editor && !(requester && requester.editor) ? editor.id : null;
    const choice = selectEditor({ providers, method, request, requester, selected, home });
    if (choice.status === 'selected') {
      const provider = choice.provider;
      const result = typeof provider[method] === 'function' ? provider[method](...args, requester)
        : provider.request(method, request, requester);
      if (!registry || !result || typeof result.then !== 'function') return result;
      const timeoutMs = Number.isFinite(editor.timeoutMs) && editor.timeoutMs > 0 ? editor.timeoutMs : EDITOR_TIMEOUT_MS;
      return boundedEditorResult(result, provider, timeoutMs);
    }
    if (choice.status === 'system') {
      const open = facts().openUrl;
      if (typeof open === 'function') return open(args[0], requester);
      return { status: 'unavailable', code: 'EDITOR_UNAVAILABLE', reason: 'SYSTEM_OPENER_UNAVAILABLE',
        editor: null, message: 'The system default browser is unavailable.' };
    }
    return choice;
  }

  // Freeze the provider at ingress, before receipt/disk/UI waits. A bridge
  // response cannot turn this action into a request to a newly focused editor.
  function prepareEditor(method, request, requester) {
    const registry = editor && typeof editor.providers === 'function';
    const providers = registry ? Array.from(editor.providers()) : editor ? [editor] : [];
    const choice = selectEditor({ providers, method, request, requester,
      selected: !registry && editor && !requester?.editor ? editor.id : null, home });
    const provider = choice.provider, opener = choice.status === 'system' && facts().openUrl;
    return {
      provider: provider?.id || (choice.status === 'system' ? 'system' : null),
      available: choice.status === 'selected' || choice.status === 'system' && typeof opener === 'function',
      async execute(revalidate = () => {}) {
        try {
          revalidate();
          requireThat(choice.status === 'selected' || choice.status === 'system' && typeof opener === 'function', 'EDITOR_UNAVAILABLE');
          if (provider) {
            const live = registry ? Array.from(editor.providers()) : [editor];
            requireThat(live.includes(provider) && provider.connected !== false && (!provider.methods || provider.methods.includes(method)), 'EDITOR_UNAVAILABLE');
          }
          revalidate();
        } catch (error) {
          error.delivery = 'not_written'; throw error;
        }
        const args = method === 'openUrl' ? [request.url] : method === 'switchTo' ? [request.id, request.from || null]
          : ['openAllSettings', 'openSlack', 'openSlackSettings'].includes(method) ? [] : [request];
        const pending = provider ? typeof provider[method] === 'function' ? provider[method](...args, { ...requester, revalidate })
          : provider.request(method, request, requester) : opener(request.url, requester);
        const response = registry && pending?.then ? await boundedEditorResult(pending, provider,
          Number.isFinite(editor.timeoutMs) && editor.timeoutMs > 0 ? editor.timeoutMs : EDITOR_TIMEOUT_MS) : await pending;
        revalidate();
        return response;
      }
    };
  }

  function heldAt(key) {
    const cfg = source();
    const held = (cfg.inspect && cfg.inspect(key)) || {};
    const mine = held.workspaceFolderValue !== undefined ? held.workspaceFolderValue
      : held.workspaceValue !== undefined ? held.workspaceValue : held.globalValue;
    return { shipped: held.defaultValue || {}, mine: mine || {} };
  }

  function readHeldCommands() {
    const prompts = heldAt('promptSnippets');
    const said = heldAt('promptSnippetDescriptions');
    return { shipped: prompts.shipped, mine: prompts.mine, shippedSaid: said.shipped, mineSaid: said.mine };
  }

  async function writeCommands(how, arg) {
    const commands = require('./commands');
    const held = readHeldCommands();
    const next = commands[how](held, arg);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(next.mine, held.mine)) await set('promptSnippets', next.mine);
    if (!same(next.mineSaid, held.mineSaid)) await set('promptSnippetDescriptions', next.mineSaid);
    return next.name;
  }

  const home = facts().home || os.homedir();
  return {
    manager,
    config,
    home,
    knownCommands: () => (manager ? manager.knownCommands() : []),
    fleet: () => {
      const workspace = codex && codex();
      return (manager ? manager.list : []).concat(workspace ? workspace.list.filter((s) => s.loaded || s.isBusy) : []);
    },
    lifetime: () => (ledger ? ledger.totals() : null),
    prFeed: prFeed || null,
    pickPr: pickPr || null,
    setPr: setPr || null,
    env: (session) => {
      const supplied = facts();
      return {
        awake: awake ? awake.state() : null,
        devices: devices ? devices.list().map((d) => ({
          name: d.name, control: !!d.control, lastSeenAt: d.lastSeenAt, pairedAt: d.pairedAt,
          protection: d.protection || 'software', biometric: !!d.biometric,
          reach: { push: !!d.push, apple: !!d.apns }
        })) : [],
        trail: devices ? devices.recent(20) : [],
        reach: supplied.reach || { sealed: true, appOnly: false },
        transcriptPath: (manager && manager.history ? manager.history.transcriptPath : transcriptPath)(session.cwd, session.claudeSessionId),
        limits: (manager && manager.limits) || session.limits || null,
        codexLimits: supplied.codexLimits ? supplied.codexLimits.current() : null,
        pause: (manager && manager.pause) || null,
        vscode: supplied.vscode || null,
        node: supplied.node || process.versions.node,
        electron: supplied.electron || process.versions.electron || null,
        platform: supplied.platform || `${os.platform()} ${os.release()}`,
        arch: supplied.arch || os.arch(),
        cpus: supplied.cpus === undefined ? os.cpus().length : supplied.cpus,
        memoryGb: supplied.memoryGb === undefined ? Math.round(os.totalmem() / 1073741824) : supplied.memoryGb,
        extension: supplied.extension == null ? null : supplied.extension,
        home,
        showThinking: config(session.cwd).showThinking,
        groupByProject: source().get('groupByProject', 'auto')
      };
    },
    get codexLimits() { return limits(); },
    openFile: (req, requester) => route('openFile', req, requester, [req]),
    prepareEditor,
    openUrl: (url, requester) => route('openUrl', { url }, requester, [url]),
    runInTerminal: (req, requester) => route('runInTerminal', req, requester, [req]),
    confirmPausedSend: async (session, requester) => {
      if (!manager || !session.isPaused || (requester && requester.local === false) || !ui || !ui.confirm) return false;
      const until = session.pausedUntil ? new Date(session.pausedUntil).toLocaleString() : 'later';
      const pick = await ui.confirm({
        message: `The usage data says the limit is spent until ${until}.`,
        detail: 'Send now if your usage has been reset: every instance resumes and its queue drains. Otherwise it waits in the queue.',
        choices: ['Send now', 'Queue it']
      }, requester);
      if (pick !== 'Send now') return false;
      manager.resumeFromLimit({ manual: true });
      if (session.isPaused) session.resume({});
      return true;
    },
    handOffToCodex: codex ? async ({ cwd, text, attachments }) => {
      const workspace = codex();
      if (!workspace) throw new Error('Codex is not available in this window');
      const session = await workspace.create({ cwd });
      session.submit(text, attachments || []);
      return session.id;
    } : undefined,
    switchTo: (id, from, requester) => route('switchTo', { id, from, cwd: from && from.cwd }, requester, [id, from]),
    audit: devices ? (entry) => devices.record(entry) : undefined,
    settings: () => {
      const catalog = manager && manager.commandCatalog ? manager.commandCatalog : require('./commandCatalog').defaultCommandCatalog;
      return require('./prefs').read(get, {
        awake: awake && awake.state ? awake.state() : null,
        models: (catalog.commandArgs().model || []).filter((m) => /^claude-/.test(m.value || m))
      });
    },
    setSetting: (id, value, from) => require('./prefs').write(id, value, {
      get, set,
      special: awake ? {
        awake: (on) => awake.set(on),
        lid: (on) => (from && from.local && awake.switchLid ? awake.switchLid(on) : awake.setLid(on))
      } : {}
    }),
    openAllSettings: (requester) => route('openAllSettings', {}, requester, []),
    commands: () => require('./commands').list(readHeldCommands()),
    saveCommand: (change) => writeCommands('save', change),
    removeCommand: (name) => writeCommands('remove', name),
    restoreCommand: (name) => writeCommands('restore', name)
  };
}

module.exports = { createMachineHost };

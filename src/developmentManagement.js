'use strict';

// Editor chrome for the additional local protocol. Dependency injection keeps
// this command mapping testable without loading or starting a window engine.
function createDevelopmentManagement({ vscode, call, fleet, show, selected, changed, reportGap }) {
  let historyCwd = null, historyFilter = '', historyLimit = 30;
  const choose = async (items, title) => vscode.window.showQuickPick(items, { placeHolder: title });
  async function target(arg, codex = true) {
    const id = arg?.id || arg?.session?.id;
    const sessions = [...fleet().instances, ...(codex ? fleet().codex : [])];
    if (id) return sessions.find((s) => s.id === id) || null;
    return choose(sessions.map((s) => ({ ...s, label: s.label || s.id })), 'Choose an instance');
  }
  const confirm = async (text) => await vscode.window.showWarningMessage(text, { modal: true }, 'Continue') === 'Continue';
  async function input(prompt, value = '') { return vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true }); }
  async function device(arg) {
    const id = arg?.device?.id || arg?.id;
    const result = await call('device.list', {}); if (!result.ok) return null;
    return id ? result.data.devices.find((d) => d.id === id) : choose(result.data.devices.map((d) => ({ ...d, label: d.name })), 'Choose a paired device');
  }
  async function folder(arg) {
    const id = arg?.folder?.id || arg?.id;
    return id ? (fleet().folders || []).find((f) => f.id === id) : choose((fleet().folders || []).map((f) => ({ ...f, label: f.name })), 'Choose a folder');
  }
  const actions = {
    async rename(arg) { const s = await target(arg); if (!s) return; const name = await input('Rename this conversation', s.label); if (name !== undefined) return call('session.rename', { id: s.id, name: name.trim() }); },
    async sleep(arg) { const s = await target(arg, false); if (s) return call('session.stop', { id: s.id }); },
    async stop(arg) { const s = await target(arg, false); if (s && await confirm('Remove this instance? Its transcript stays in History.')) return call('session.remove', { id: s.id }); },
    async restart(arg) {
      const s = await target(arg, false); if (!s) return;
      const mode = await choose([{ label: 'Restart and keep context', mode: 'context' }, { label: 'Restart fresh', mode: 'fresh' }], 'Restart this instance');
      if (mode && (mode.mode !== 'fresh' || await confirm('Start a new conversation? The previous transcript stays in History.')))
        return call('session.restart', { id: s.id, mode: mode.mode });
    },
    async restartAll() { if (await confirm('Restart all previously started instances with current settings and context?')) return call('session.restartAll', {}); },
    resumeNow: () => call('quota.resume', {}),
    async clearStopped() { if (await confirm('Remove stopped instances? Sleeping instances and transcripts are retained.')) return call('session.clearStopped', {}); },
    async nextInstance() { const r = await call('selection.cycle', { direction: 'next', currentId: selected() }); if (r.ok && r.data.selected) show(r.data.selected); return r; },
    async previousInstance() { const r = await call('selection.cycle', { direction: 'previous', currentId: selected() }); if (r.ok && r.data.selected) show(r.data.selected); return r; },
    async newFolder() { const name = await input('New folder name'); if (name?.trim()) return call('folder.create', { name: name.trim() }); },
    async renameFolder(arg) { const f = await folder(arg); if (!f) return; const name = await input('Folder name', f.name); if (name?.trim()) return call('folder.rename', { id: f.id, name: name.trim() }); },
    async deleteFolder(arg) { const f = await folder(arg); if (f && await confirm('Delete this folder? Its instances move to the top level.')) return call('folder.delete', { id: f.id }); },
    async moveToFolder(arg) { const s = await target(arg, false); if (!s) return;
      const f = await choose([{ label: 'Top level', id: null }, ...(fleet().folders || []).map((f) => ({ ...f, label: f.name }))], 'Move this instance');
      if (f) return call('folder.place', { id: s.id, folder: f.id }); },
    async renameDevice(arg) { const d = await device(arg); if (!d) return; const name = await input('Device name', d.name); if (name?.trim()) return call('device.rename', { id: d.id, name: name.trim() }); },
    async grantControl(arg) { const d = await device(arg); if (d && await confirm('Grant this paired device control of provider work?')) return call('device.grant', { id: d.id, control: true }); },
    async revokeControl(arg) { const d = await device(arg); if (d) return call('device.revoke', { id: d.id }); },
    async forgetDevice(arg) { const d = await device(arg); if (d && await confirm('Forget this paired device?')) return call('device.forget', { id: d.id }); },
    async pairDevice() { const r = await call('pairing.open', { seconds: 60 });
      if (r.ok) await vscode.window.showInformationMessage(`Pairing code: ${r.data.code} (60 seconds). ${r.data.link}`); return r; },
    async resumeHistory(arg) { const e = arg?.entry || arg; if (!e?.sessionId || !e.cwd) return;
      const r = await call('history.resume', { conversation: e.sessionId, cwd: e.cwd }); if (r.ok) show(r.data.id); return r; },
    async deleteHistory(arg) { const e = arg?.entry || arg; if (e?.sessionId && e.cwd && await confirm('Permanently delete this inactive transcript?'))
      return call('history.delete', { conversation: e.sessionId, cwd: e.cwd }); },
    async historyScope() { const c = await choose([{ label: 'All projects', path: null }, ...(fleet().projects || []).map((p) => ({ label: p.name, path: p.path }))], 'History scope');
      if (c) { historyCwd = c.path; historyLimit = 30; changed(); } },
    async historyFilter() { const value = await input('Filter History', historyFilter); if (value !== undefined) { historyFilter = value; historyLimit = 30; changed(); } },
    historyMore() { historyLimit = Math.min(10000, historyLimit + 30); changed(); }, refreshHistory() { changed(); },
    async settings() { return call('editor.request', { method: 'settings', target: selected() }); },
    async linkPr() { return call('editor.request', { method: 'prPicker', target: selected() }); },
    async remoteStart() { return call('network.start', { kind: 'tailnet' }); },
    async remoteStop() { return call('network.stop', { kind: 'tailnet' }); },
    async remoteOpen() { return call('network.open', {}); },
    async remoteMenu() { return call('network.status', {}); },
    async reachFromPhone() { return call('network.start', { kind: 'tailnet' }); },
    async stopReaching() { return call('network.stop', { kind: 'tailnet' }); },
    async reachPublicly() { return call('network.start', { kind: 'public' }); }
  };
  actions.renameCodex = actions.rename;
  return {
    has: (command) => Object.hasOwn(actions, command.replace(/^nikui\./, '')),
    async run(command, arg) {
      const action = actions[command.replace(/^nikui\./, '')]; if (!action) return reportGap(command);
      const r = await action(arg); changed(); return r;
    },
    async history() {
      const scope = historyCwd, filter = historyFilter, wanted = historyLimit, entries = [];
      let more = false, exhausted = true;
      for (let offset = 0; offset < wanted; offset += 200) {
        const r = await call('history.list', { cwd: scope, filter, offset, limit: Math.min(200, wanted - offset) });
        if (!r.ok) return [{ label: r.code }];
        entries.push(...r.data.entries); more = r.data.hasMore; exhausted = r.data.exhausted;
        if (!more) break;
      }
      const rows = entries.map((entry) => ({ entry, label: entry.label, description: entry.cwd || '',
        command: { command: 'nikui.resumeHistory', title: 'Resume', arguments: [{ entry }] }, contextValue: 'historyEntry' }));
      if (more && wanted < 10000) rows.push({ label: 'Load more', contextValue: 'historyMore', command: { command: 'nikui.historyMore', title: 'Load more' } });
      else if (more || !exhausted) rows.push({ label: 'Narrow the History scope or filter to see more results.' });
      return rows;
    },
    async devices() { const r = await call('device.list', {}); return r.ok ? r.data.devices.map((device) => ({ device,
      label: device.name, description: device.control ? 'Control' : 'Watch', contextValue: device.control ? 'nikui.device.control' : 'nikui.device.watching' })) : [{ label: r.code }]; }
  };
}

module.exports = { createDevelopmentManagement };

'use strict';
const { command, failureEvidence } = require('../scripts/native-command');
module.exports = async () => {
  suite('Private store rename durability');
  const fs = require('fs'), path = require('path'), os = require('os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nik-store-sync-'));
  const events = [], sync = fs.fsyncSync, rename = fs.renameSync;
  try {
    fs.fsyncSync = (fd) => { events.push(fs.fstatSync(fd).isDirectory() ? 'directory-fsync' : 'file-fsync'); return sync(fd); };
    fs.renameSync = (...args) => { events.push('rename'); return rename(...args); };
    const store = require('../src/daemonStore').createTestStore(path.join(directory, 'store.json'), { testOnly: true });
    events.length = 0; store.update('device', { id: 'durable' });
    checkEqual('device persistence fsyncs file, renames, then fsyncs directory', events, ['file-fsync', 'rename', 'directory-fsync']);
    store.dispose();
  } finally { fs.fsyncSync = sync; fs.renameSync = rename; fs.rmSync(directory, { recursive: true, force: true }); }
  suite('Receive-only legacy application sessions remain connected');
  let scheduled = 0, closed = false;
  const negotiation = require('../src/protocolV2').createNegotiation({ authenticated: true, helloRequired: false,
    context: { principal: 'device:main', role: 'fleet', target: 'fleet', seat: { id: 'main', control: true, local: false, editor: false } },
    timers: { setTimeout() { scheduled++; }, clearTimeout() {} }, post() {}, close() { closed = true; } });
  checkEqual('legacy without hello has no negotiation deadline or close', [scheduled, closed], [0, false]);
  negotiation.dispose();
  suite('Native controller failures retain exact evidence');
  for (const code of ['SERVICE_OWNER_MISMATCH', 'ENGINE_STOP_TIMEOUT']) {
    const stdout = JSON.stringify({ ok: false, code }) + '\n', stderr = 'controller diagnostic\n';
    let error;
    try { command('/fixture/NikUI', ['intentional-stop'], {}, () => ({ status: 1, signal: null, stdout, stderr })); }
    catch (e) { error = e; }
    const evidence = JSON.parse(JSON.stringify(failureEvidence(error)));
    checkEqual('both streams and controller code survive nested harness serialization ' + code,
      [evidence.status, evidence.stdout, evidence.stderr, evidence.controller.code, evidence.command],
      [1, stdout, stderr, code, ['/fixture/NikUI', 'intentional-stop']]);
  }
  suite('R13 native harness deadlines, final JSON and exact process cleanup');
  const native = require('../scripts/native-command'), nativePath = require.resolve('../scripts/native-command');
  for (const [name, body, expected] of [
    ['retained handles', 'setInterval(() => {}, 1000); void n.runNative(async () => ({ ok: true, evidence: "fixture" }));', true],
    ['preflight failure', 'void n.runNative(async () => { throw Object.assign(Error("preflight"), { code: "FIXTURE_PREFLIGHT" }); });', false],
    ['unresolved promise', 'void n.runNative(() => new Promise(() => {}), 50);', false]
  ]) {
    const start = Date.now();
    const result = require('child_process').spawnSync(process.execPath, ['-e', 'const n = require(' + JSON.stringify(nativePath) + ');' + body],
      { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
    let answer; try { answer = JSON.parse(result.stdout); } catch (_) {}
    check('native CLI always exits with JSON despite ' + name, result.status === (expected ? 0 : 1) && answer?.ok === expected && Date.now() - start < 2000);
  }
  let options;
  command('/fixture/command', [], {}, (_file, _args, value) => { options = value; return { status: 0, stdout: '' }; });
  check('synchronous native commands have a hard kill and finite default deadline', options.timeout > 0 && options.killSignal === 'SIGKILL');
  const userData = '/private/tmp/exact-editor/user-data', date = 'Mon Nov 23 12:34:56 2026';
  const rows = ['101 1 ' + date + ' Electron --user-data-dir ' + userData,
    '102 101 ' + date + ' Code Helper', '201 1 ' + date + ' Electron --user-data-dir ' + userData + '-other',
    '202 201 ' + date + ' Code Helper', '203 1 ' + date + ' Electron --user-data-dir /other/profile ' + userData].join('\n');
  const processes = native.editorProcesses(userData, [201], () => rows), signals = [];
  checkEqual('only exact disposable argv and descendants are selected, even if an old CLI PID was reused', processes.map((p) => p.pid), [101, 102]);
  native.signalExact(processes, 'SIGKILL', (_file, args) => args[args.indexOf('-p') + 1] === '101' ? processes[0].proof : date + ' reused PID',
    (pid, signal) => signals.push([pid, signal]));
  checkEqual('PID reuse prevents cleanup from signalling a different process', signals, [[101, 'SIGKILL']]);
  signals.length = 0;
  native.signalExact(processes, 'SIGTERM', (_file, args) => args[args.indexOf('-p') + 1] === '101' ? '  ' + date + '     Electron --user-data-dir ' + userData + '\n' : date + ' reused PID',
    (pid, signal) => signals.push([pid, signal]));
  checkEqual('macOS ps column padding cannot prevent SIGTERM of the exact verified main editor PID', signals, [[101, 'SIGTERM']]);
  let running = true, elapsed = 0;
  const verifiedSignals = [];
  const paddedPS = (_file, args) => args.includes('-axo') ? (running ? rows : '') :
    args[args.indexOf('-p') + 1] === '101' && running ? date + '     Electron --user-data-dir ' + userData : date + ' reused PID';
  const verifiedQuit = await native.quitDisposableEditor(userData, {
    scan: (folder) => native.editorProcesses(folder, [], paddedPS), alive: (records) => native.aliveExact(records, paddedPS),
    signal: (records, kind) => native.signalExact(records, kind, paddedPS, (pid, signal) => { verifiedSignals.push([pid, signal]); if (pid === 101) running = false; }),
    now: () => elapsed, pause: async (ms) => { elapsed += ms; }
  });
  check('verified main-pid SIGTERM exits the disposable tree and cleanup confirms two empty scans',
    verifiedQuit.absent && verifiedQuit.scans === 3 && JSON.stringify(verifiedSignals) === JSON.stringify([[101, 'SIGTERM']]) &&
    verifiedQuit.signals.length === 1 && verifiedQuit.signals[0].proof === processes[0].proof);
  const { editorCommand } = require('../scripts/acceptance-p2-editor'), realpath = fs.realpathSync;
  try {
    fs.realpathSync = () => '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    const cli = editorCommand({ code: '/fixture/code', directory: '/fixture/editor', cwd: '/fixture/project-2', development: false });
    check('the second shared-profile folder opens a new window without another extension-test runner', cli.args.includes('--new-window') &&
      cli.args.includes('/fixture/project-2') && !cli.args.includes('--extensionTestsPath') && !cli.args.includes('--extensionDevelopmentPath'));
  } finally { fs.realpathSync = realpath; }

  suite('R15 native reload cancellation and verified disposable-editor quit');
  const { ENTRY } = require('../scripts/test-mac-cutover');
  for (const expectedReload of [true, false]) {
    const files = new Map(), requested = [];
    const home = '/private/tmp/nik-mac/build/p3/disposable-fixture';
    const fakeFS = { existsSync(file) { return file.includes('source-seeded-') || file.endsWith('source-reload-2'); },
      writeFileSync(file, value) { files.set(file, value); }, renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); } };
    const cancelled = () => Promise.reject(Error('Canceled'));
    const vscode = { env: { appName: 'Visual Studio Code' }, version: 'fixture',
      workspace: { workspaceFolders: [{ uri: { fsPath: home + '/project-2' } }] },
      extensions: { getExtension: () => ({ extensionPath: '/fixture/extension', activate: expectedReload ? async () => {} : cancelled }) },
      commands: { executeCommand(name) { requested.push(name); return name.endsWith('reloadWindow') ? cancelled() : Promise.resolve(); } } };
    const entry = {};
    new Function('require', 'exports', 'process', 'setTimeout', ENTRY)((name) => name === 'fs' ? fakeFS : name === 'path' ? path
      : name === 'vscode' ? vscode : { cutoverRehearsalState: () => ({ mode: 'recovery' }) }, entry,
      { env: { HOME: home }, pid: 123 }, (callback) => callback());
    await entry.activate();
    check(expectedReload ? 'only an explicitly requested reload consumes its expected Canceled rejection'
      : 'a Canceled rejection outside the requested reload remains a rehearsal failure', expectedReload ?
      !files.has(home + '/profile/source-failure.json') && requested.includes('workbench.action.reloadWindow') && !requested.includes('workbench.action.closeWindow') :
      JSON.parse(files.get(home + '/profile/source-failure.json')).code === 'Canceled' && requested.includes('workbench.action.closeWindow'));
  }
  let tick = 0, rootsAlive = true, generation = 102;
  const ordered = [];
  const quit = await native.quitDisposableEditor(userData, { graceMs: 250, killMs: 500, now: () => tick,
    alive: () => [],
    pause: async (ms) => { tick += ms; }, scan: () => rootsAlive ? [{ pid: 101, parent: 1, proof: 'root' }, { pid: generation++, parent: 101, proof: 'replacement renderer' }] : [],
    signal(records, kind) { ordered.push([records.map((p) => p.pid), kind]); if (kind === 'SIGKILL' && records.some((p) => p.pid === 101)) rootsAlive = false; } });
  check('cleanup stops exact roots before dynamically replaced renderers and verifies two empty scans', quit.absent && quit.scans >= 5 && ordered[0][0][0] === 101 && ordered.some((r) => r[0][0] > 102));
  tick = 0; let failedQuit;
  try { await native.quitDisposableEditor(userData, { graceMs: 100, killMs: 100, now: () => tick, pause: async (ms) => { tick += ms; },
    alive: () => [],
    scan: () => [{ pid: 101, parent: 1, proof: 'unresponsive exact editor' }], signal() {} }); }
  catch (e) { failedQuit = e; }
  check('cleanup cannot report success while the exact editor remains alive', failedQuit?.code === 'EDITOR_CLEANUP_FAILED' && failedQuit.diagnostics.processes[0].pid === 101);
  tick = 0; let orphanAlive = true;
  const orphan = { pid: 301, parent: 1, proof: 'captured descendant without user-data argv' };
  const orphanQuit = await native.quitDisposableEditor(userData, { initial: [orphan], scan: () => [],
    alive: (known) => orphanAlive ? known : [], now: () => tick, pause: async (ms) => { tick += ms; },
    signal(records) { if (records.some((p) => p.pid === orphan.pid)) orphanAlive = false; } });
  check('cleanup verifies captured descendants even after the editor reparents them', orphanQuit.absent && !orphanAlive && orphanQuit.scans >= 3);

  suite('R15 private source deadlines follow actual progress');
  const socket = path.join(directory, 'progress.sock'); fs.mkdirSync(directory, { mode: 0o700 });
  const control = await require('../src/daemonControl').createControl({ paths: { socket }, async handle(request, { progress }) {
    for (let i = 0; i < 4; i++) { await new Promise((resolve) => setTimeout(resolve, 40)); if (request.op === 'advance') progress(); }
    return { ok: true, completed: true };
  } });
  try {
    let progressed = 0; const started = Date.now();
    const reply = await require('../src/daemonControl').controlRequest({ socket }, { op: 'advance' }, { timeoutMs: 100, onProgress: () => progressed++ });
    check('a source call can outlive its initial deadline while real steps advance', reply.completed && progressed === 4 && Date.now() - started > 100);
    let stalled;
    try { await require('../src/daemonControl').controlRequest({ socket }, { op: 'stall' }, { timeoutMs: 60 }); } catch (e) { stalled = e.code; }
    checkEqual('an idle source is still bounded and refused', stalled, 'CONTROL_UNAVAILABLE');
  } finally { await control.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
};

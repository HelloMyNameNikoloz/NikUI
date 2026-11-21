'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const net = require('net');
const http = require('http');
const { privateRoot } = require('../src/daemonPaths');
const { controlRequest } = require('../src/daemonControl');

const entry = path.resolve(__dirname, '../src/nikd.js');
const poison = path.join(__dirname, 'fixtures/engine/poison-vscode.js');

module.exports = async function () {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cli-'))), children = [];
  const env = { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' };
  function launch(args, extraEnv = {}) {
    const child = cp.spawn(process.execPath, ['--require', poison, entry, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', firstResolve, resolveDone;
    const first = new Promise((resolve) => { firstResolve = resolve; });
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const at = stdout.indexOf('\n');
      if (at !== -1) { try { firstResolve(JSON.parse(stdout.slice(0, at))); } catch (_) { firstResolve(null); } }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (code, signal) => { clearTimeout(timer); firstResolve(null); resolveDone({ code, signal, stdout, stderr }); });
    const fixture = { child, first, done, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); return done; } };
    children.push(fixture); return fixture;
  }
  const start = (root, extra = [], extraEnv) => launch(['--root', root, ...extra], extraEnv);
  const command = (root, cmd) => start(root, [cmd]);
  const stderrCode = (result) => { try { return JSON.parse(result.stderr.trim()).code; } catch (_) { return result.stderr.trim(); } };
  const snapshot = (dir) => fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name), st = fs.lstatSync(file);
    return [name, st.ino, st.isDirectory() ? snapshot(file) : st.isFile() ? fs.readFileSync(file).toString('base64') : 'socket'];
  });
  try {
    suite('T03/T08/T61/T62: real poisoned CLI children in launchd minimal environment');
    const root = path.join(home, 'a');
    const a = start(root), status = await a.first;
    check('a clean poisoned child starts the actual daemon', status && status.ok && status.mode === 'isolated-p1');
    if (!status) throw new Error('Daemon startup failed: ' + JSON.stringify(await a.done));
    checkEqual('fully composed isolated daemon enables protocol v2', status.protocol, 2);
    checkEqual('root, control socket, lock and test secret modes are private', [root, status.control.socket, path.join(root, 'owner.lock'), path.join(root, 'secrets.test.json')]
      .map((file) => fs.statSync(file).mode & 0o777), [0o700, 0o600, 0o600, 0o600]);
    check('minimal PATH produces named missing-tool diagnostics without starting a provider', status.blockers.some((blocker) => blocker.code === 'TOOL_MISSING' && /Install/.test(blocker.hint)));
    check('all provider and keeper roots are private, with no borrowed live connection', status.account.home.startsWith(fs.realpathSync(root) + path.sep) && status.account.borrowed === false);
    const before = snapshot(root), b = start(root);
    checkEqual('a second instance cannot take the same root', (await b.done).code, 1);
    checkEqual('second instance names the live owner', stderrCode(await b.done), 'OWNER_EXISTS');
    checkEqual('refused startup has no graph or source-state writes', snapshot(root), before);
    const statusClient = command(root, 'status'), fromCli = await statusClient.first;
    checkEqual('status command uses only the private control socket', [fromCli.generation, (await statusClient.done).code], [status.generation, 0]);
    const enrollment = command(root, 'enroll'), enrolled = await enrollment.first;
    checkEqual('only owner control enrolls a local key', [enrolled.ok, enrolled.kind, (await enrollment.done).code], [true, 'local', 0]);
    const doctor = command(root, 'doctor'), diag = await doctor.first;
    checkEqual('doctor reports each tool and wrapper policy', [Object.keys(diag.tools).length, /functions are bypassed/.test(diag.wrappers), (await doctor.done).code], [8, true, 0]);
    check('public status/startup/doctor contain no private keys or enrollment bearer', !JSON.stringify([status, fromCli, diag]).includes(enrolled.key) && diag.secrets === '[redacted]');
    const paths = privateRoot(root, { create: false });
    checkEqual('forged control operations cannot set arbitrary policy or capabilities', (await controlRequest(paths, { op: 'setSetting', key: 'claudePath', value: 'PRIVATE_CONTROL_INPUT', kind: 'editor', caps: ['all'] })).code, 'CONTROL_UNSUPPORTED');
    const other = start(path.join(home, 'b')), independent = await other.first;
    check('another private root can run independently', independent && independent.generation !== status.generation && independent.listener.port !== status.listener.port);
    checkEqual('stopping another root does not affect this owner', [(await other.stop()).code, (await controlRequest(paths, { op: 'status' })).generation], [0, status.generation]);

    suite('T58/S6: SIGTERM drains transport and owned factories, exit 0');
    const held = net.createConnection({ host: '127.0.0.1', port: status.listener.port });
    await new Promise((resolve, reject) => { held.once('connect', resolve); held.once('error', reject); });
    held.on('error', () => {}); held.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n'); // incomplete request
    const silentControl = net.createConnection({ path: paths.socket });
    await new Promise((resolve, reject) => { silentControl.once('connect', resolve); silentControl.once('error', reject); });
    silentControl.on('error', () => {});
    const stoppingAt = Date.now(), stopped = await a.stop();
    held.destroy(); silentControl.destroy();
    checkEqual('SIGTERM exits 0, without a forced signal', [stopped.code, stopped.signal], [0, null]);
    check('stalled HTTP/control clients cannot prevent bounded stop', Date.now() - stoppingAt < 3000);
    checkEqual('intentional stop removes only its own lock and socket', [fs.existsSync(paths.lock), fs.existsSync(paths.socket)], [false, false]);
    const identityBefore = JSON.parse(fs.readFileSync(paths.secrets)).values['nikui.identity'];
    const restarted = start(root), next = await restarted.first;
    check('restart uses a new generation', next && next.generation !== status.generation);
    const afterEnrollment = await controlRequest(paths, { op: 'enroll' });
    check('old enrollment key expires across generation replacement', afterEnrollment.key !== enrolled.key);
    checkEqual('synthetic selected identity persists across clean restart', JSON.parse(fs.readFileSync(paths.secrets)).values['nikui.identity'], identityBefore);
    await restarted.stop();

    suite('T58/T62: a hung owned drain exits nonzero with its exact redacted stage');
    const drainRoot = path.join(home, 'drain'), hanging = start(drainRoot, [], { NIKUI_DAEMON_DRAIN_FIXTURE: '1' });
    await hanging.first;
    const drainStarted = Date.now(), timeout = await hanging.stop(), drain = JSON.parse(timeout.stderr.trim());
    checkEqual('drain timeout is distinct from intentional stop and crash', [timeout.code, timeout.signal, drain.code], [1, null, 'DRAIN_TIMEOUT']);
    checkEqual('timeout diagnostic names the actual pending owned stage', [drain.lifecycle.phase, drain.lifecycle.stage, drain.lifecycle.completed], ['draining', 'engine-flush', ['control', 'local-management']]);
    check('timeout stays bounded and retains the fixture ownership fence', Date.now() - drainStarted < 5500 &&
      JSON.parse(fs.readFileSync(path.join(drainRoot, 'owner.lock'))).pid === hanging.child.pid);

    suite('T08: crash residue is recovered only from the dead fixture owner');
    const crashed = start(root); await crashed.first;
    const deadPid = crashed.child.pid;
    crashed.child.kill('SIGKILL');
    checkEqual('a crash is not mistaken for intentional stop', (await crashed.done).signal, 'SIGKILL');
    checkEqual('crashed lock retains exactly the spawned fixture pid', JSON.parse(fs.readFileSync(paths.lock)).pid, deadPid);
    const raceA = start(root), raceB = start(root);
    const firsts = await Promise.all([raceA.first, raceB.first]);
    checkEqual('two stale-recovery contenders admit exactly one writer', firsts.filter(Boolean).length, 1);
    const winner = firsts[0] ? raceA : raceB, loser = firsts[0] ? raceB : raceA;
    checkEqual('stale-recovery loser exits nonzero', (await loser.done).code, 1);
    await winner.stop();
    const reaper = paths.lock + '.reap';
    fs.writeFileSync(reaper, JSON.stringify({ version: 1, pid: deadPid, token: 'fixture-dead-reaper' }), { mode: 0o600 });
    const blockedStart = await start(root).done;
    checkEqual('R10: a dead recovery lock remains a conservative startup refusal', stderrCode(blockedStart), 'OWNER_UNPROVEN');
    const recoveryDoctor = command(root, 'doctor'), recovery = await recoveryDoctor.first;
    checkEqual('R10: offline CLI doctor prints the exact recovery command', [recovery.manualFix, (await recoveryDoctor.done).code], ["rm -- '" + reaper + "'", 1]);
    checkEqual('R10: offline doctor leaves the reaper in place', fs.existsSync(reaper), true);
    fs.unlinkSync(reaper);
    for (const mode of ['exception', 'rejection']) {
      const fault = start(path.join(home, mode === 'exception' ? 'ce' : 'cr'), [], { NIKUI_DAEMON_CRASH_FIXTURE: mode });
      await fault.first;
      const result = await fault.done;
      checkEqual(mode + ' exits nonzero for KeepAlive semantics', result.code, 1);
      check(mode + ' diagnostic redacts the raw failure payload', !result.stderr.includes('PRIVATE_CRASH_PAYLOAD') && stderrCode(result) === 'DAEMON_CRASH');
    }

    suite('T11/T20: actual CLI refuses unsafe startup before source-state effects');
    const noRoot = launch([]);
    checkEqual('missing explicit root is a named refusal', [stderrCode(await noRoot.done), (await noRoot.done).code], ['ROOT_REQUIRED', 1]);
    const useHome = start(home);
    checkEqual('root equal to the temporary HOME refuses', stderrCode(await useHome.done), 'FORBIDDEN_ROOT');
    const codeRoot = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'fixture');
    checkEqual('editor source path refuses even under temporary HOME', stderrCode(await start(codeRoot).done), 'FORBIDDEN_ROOT');
    checkEqual('refused source path remains absent', fs.existsSync(path.join(home, 'Library')), false);
    const long = start(path.join(home, 'x'.repeat(100)));
    checkEqual('overlong control path has a named diagnostic', stderrCode(await long.done), 'SOCKET_PATH_TOO_LONG');
    const sourceState = path.join(home, 'source.json'); fs.writeFileSync(sourceState, 'UNCHANGED', { mode: 0o600 });
    const unsafe = path.join(home, 'u'); fs.mkdirSync(unsafe, { mode: 0o700 });
    fs.symlinkSync(sourceState, path.join(unsafe, 'secrets.test.json'));
    checkEqual('nested source redirects refuse before composing any service', stderrCode(await start(unsafe).done), 'UNSAFE_PATH');
    checkEqual('the source sentinel bytes survive startup refusal', fs.readFileSync(sourceState, 'utf8'), 'UNCHANGED');
    const corrupt = path.join(home, 'c'); fs.mkdirSync(corrupt, { mode: 0o700 });
    const secret = path.join(corrupt, 'secrets.test.json'); fs.writeFileSync(secret, 'PRIVATE_CORRUPT_SECRET', { mode: 0o600 });
    const failed = await start(corrupt).done;
    checkEqual('corrupt test secret does not silently reset', fs.readFileSync(secret, 'utf8'), 'PRIVATE_CORRUPT_SECRET');
    check('corrupt secret diagnostics contain no credential bytes', !failed.stderr.includes('PRIVATE_CORRUPT_SECRET') && failed.code === 1);
    checkEqual('startup failure releases its own root lock', fs.existsSync(path.join(corrupt, 'owner.lock')), false);
    const authorityRoot = path.join(home, 'j'), seeded = start(authorityRoot); await seeded.first; await seeded.stop();
    const authorityFile = path.join(authorityRoot, 'state', 'authority.jsonl');
    fs.appendFileSync(authorityFile, 'PRIVATE_TORN_AUTHORITY_TAIL');
    const originalAuthority = fs.readFileSync(authorityFile);
    checkEqual('corrupt JSONL authority refuses daemon mutation startup by name', stderrCode(await start(authorityRoot).done), 'AUTHORITY_UNAVAILABLE');
    const authorityDoctor = command(authorityRoot, 'doctor'), issue = await authorityDoctor.first;
    checkEqual('offline doctor identifies a torn authority without resetting it', [issue.code, (await authorityDoctor.done).code], ['AUTHORITY_TORN_TAIL', 1]);
    checkEqual('authority diagnostics preserve torn bytes', fs.readFileSync(authorityFile).equals(originalAuthority), true);
    check('authority diagnostics never echo partial private records', !JSON.stringify(issue).includes('PRIVATE_TORN_AUTHORITY_TAIL'));

    suite('T08: exact loopback port refusal leaves the original fixture listener alone');
    const occupied = http.createServer((_req, res) => res.end('fixture'));
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    try {
      const portRoot = path.join(home, 'p'), refused = await start(portRoot, ['--port', String(occupied.address().port)]).done;
      checkEqual('taken explicit port refuses without selecting a different port', refused.code, 1);
      check('startup refusal preserves the existing listener', occupied.listening);
      checkEqual('port failure leaves no daemon ownership residue', [fs.existsSync(path.join(portRoot, 'owner.lock')), fs.existsSync(path.join(portRoot, 'c.sock'))], [false, false]);
    } finally { await new Promise((resolve) => occupied.close(resolve)); }
  } finally {
    for (const fixture of children) await fixture.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
};

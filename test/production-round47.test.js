'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const repo = path.resolve(__dirname, '..'), baseline = process.env.NIKUI_R47_BASELINE || repo;
const sup = require(path.join(baseline, 'src/keeperSupervisor'));
const atomic = require('../src/engineOwner').atomicJson;
const temp = (prefix = '/tmp/r47-gc-') => fs.realpathSync(fs.mkdtempSync(prefix));
const alias = file => file.replace(/^\/private(?=\/(?:tmp|var)\/)/, '');
const unused = file => file === '/bin/ps' ? '123 /usr/bin/unrelated\n' : '';
function sealed(directory, kind, bytes) {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const file = path.join(directory, (kind === 'node' ? 'custody-node-' : 'custody-') + hash.slice(0, 24) + (kind === 'node' ? '' : '.js'));
  fs.writeFileSync(file, bytes, { mode: kind === 'node' ? 0o700 : 0o600 }); return file;
}
async function caseOf(name, fn) {
  try { await fn(); check(name, true); } catch (error) { checkEqual(name, error.stack || error.message, 'PASS'); }
}
module.exports = async () => {
  suite('R47 native inventory excludes its own scanner while retaining disposable descendants');
  await caseOf('a verifier report path cannot classify its transient ps child as a leaked engine', async () => {
    const root = '/private/tmp/nik-mac/build/p3/acceptance-fixture', date = 'Mon Nov 23 05:17:25 2026';
    const scan = [process.pid + ' 1 ' + date + ' node verify-native-processes.js ' + root + '/result.json',
      '8123 ' + process.pid + ' ' + date + ' /bin/ps -ww -axo pid=,ppid=,lstart=,command=',
      '8124 1 ' + date + ' ' + root + '/relocated/NikUI Dev.app/Contents/MacOS/nikd',
      '8125 8124 ' + date + ' real disposable child'].join('\n');
    const rows = require(path.join(baseline, 'scripts/native-command')).ownedProcesses([root], () => scan);
    assert.deepEqual(rows.map(row => row.pid), [8124, 8125]);
  });
  suite('R47 GC preserves canonical custody references and running programs');
  for (const reference of ['record', 'caller keep', 'loaded argv']) await caseOf(reference + ' through /tmp retains both program files and still collects an obsolete copy', async () => {
    const directory = temp();
    try {
      const program = { node: sealed(directory, 'node', 'held runtime'), script: sealed(directory, 'script', 'held closure') };
      const retained = Object.fromEntries(Object.entries(program).map(([k, v]) => [k, alias(v)]));
      const obsolete = sealed(directory, 'script', 'obsolete closure');
      const jobFile = sup.jobFor(directory).file; fs.writeFileSync(jobFile, 'fixture plist', { mode: 0o600 });
      let loadedJob = null, keep = [];
      if (reference === 'record') atomic(path.join(directory, 'r1-program.json'), retained);
      if (reference === 'caller keep') keep = [retained];
      if (reference === 'loaded argv') loadedJob = 'job = {\n\tpath = ' + jobFile + '\n\targuments = {\n\t\t' + retained.node + '\n\t\t' + retained.script + '\n\t}\n}\n';
      const result = sup.collectPrograms(directory, { keep, loadedJob, processRun: unused });
      assert(Object.values(program).every(file => fs.existsSync(file)), JSON.stringify(result));
      assert(result.removed.includes(obsolete), 'Proved-unreferenced copies must still be collected');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('/var argv protects a running closure after its read handle is closed', async () => {
    const directory = temp(path.join(os.tmpdir(), 'r47-gc-'));
    try {
      const file = sealed(directory, 'script', 'running closure under private var');
      const result = sup.collectPrograms(directory, { loadedJob: null, processRun: executable => executable === '/bin/ps' ? '123 /node ' + alias(file) + '\n' : '' });
      assert(fs.existsSync(file), JSON.stringify(result)); assert(result.skipped.includes(file));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('a ready live Node process with hidden argv protects its open closure through real lsof, then permits collection after exit', async () => {
    if (process.platform !== 'darwin') return;
    const directory = temp(); let child;
    try {
      const script = sealed(directory, 'script', "const fs=require('fs');const held=fs.openSync(__filename,'r');process.title='custody-gc-fixture';process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>{fs.closeSync(held);process.exit(0);});\n");
      child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let ready = '', stderr = ''; child.stdout.on('data', bytes => { ready += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('No fixture readiness: ' + stderr)), 5000);
        child.stdout.on('data', () => { if (ready === 'ready\n') { clearTimeout(timer); resolve(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); reject(Error('Fixture exited before GC: ' + code + '/' + signal)); });
      });
      const processRun = (file, args, options) => {
        if (file === '/bin/ps') return unused(file); // Require lsof, independently of argv.
        const result = spawnSync(file, args, options);
        assert(!result.error && !result.stderr && (result.status === 0 || result.status === 1 && !result.stdout));
        return result.stdout;
      };
      const held = sup.collectPrograms(directory, { loadedJob: null, processRun });
      assert(fs.existsSync(script), JSON.stringify(held)); assert(held.skipped.includes(script));
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); process.kill(child.pid, 0);
      await new Promise(resolve => { child.once('exit', resolve); child.stdin.end(); }); assert.equal(child.exitCode, 0);
      const retired = sup.collectPrograms(directory, { loadedJob: null, processRun });
      assert(retired.removed.includes(script)); assert(!fs.existsSync(script));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const fault of ['denied ps', 'denied lsof', 'malformed lsof']) await caseOf(fault + ' leaves every candidate untouched', async () => {
    const directory = temp();
    try {
      const file = sealed(directory, 'node', 'uncertain runtime');
      const result = sup.collectPrograms(directory, { loadedJob: null, processRun(executable) {
        if (fault === 'denied ps' && executable === '/bin/ps' || fault === 'denied lsof' && executable === '/usr/sbin/lsof') throw Error('EPERM');
        return executable === '/bin/ps' ? unused(executable) : 'unrecognized inventory\n';
      } });
      assert(fs.existsSync(file), JSON.stringify(result)); assert.equal(result.removed.length, 0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
};

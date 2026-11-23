'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto'), assert = require('assert/strict');
const { createRequire } = require('module');
const { spawn, spawnSync } = require('child_process');
const repo = path.resolve(__dirname, '..'), baseline = process.env.NIKUI_R49_BASELINE || repo;
const subject = name => require(path.join(baseline, name));
const atomic = require('../src/engineOwner').atomicJson;
const temp = () => fs.realpathSync(fs.mkdtempSync('/tmp/r49-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, timeout = 6500) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await pause(20); } while (Date.now() < end);
  throw Error('R49_WAIT_TIMEOUT');
}
async function caseOf(name, fn) {
  if (process.env.NIKUI_TEST_PROGRESS === '1') console.error(name);
  try { await fn(); check(name, true); } catch (error) { checkEqual(name, error.stack || error.message, 'PASS'); }
}
function reader(open) {
  const file = path.join(baseline, 'src/daemonPaths.js'), module = { exports: {} }, local = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, process, Buffer, __dirname: path.dirname(file),
    require: name => name === 'fs' ? { ...fs, openSync: open } : local(name) });
  return module.exports.readPrivateJson;
}
function sealed(directory, text) {
  const name = 'custody-' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 24) + '.js';
  const file = path.join(directory, name); fs.writeFileSync(file, text, { mode: 0o600 }); return file;
}
module.exports = async () => {
  suite('R49 private JSON atomic replacement and native failure evidence');
  for (const changes of [1, 2]) await caseOf(changes + ' legitimate atomic replacements between lstat and open are retried', async () => {
    const directory = temp(), file = path.join(directory, 'source-state-1.json'); let attempts = 0;
    try {
      atomic(file, { revision: 0 });
      const read = reader((name, ...args) => { if (name === file && ++attempts <= changes) atomic(file, { revision: attempts }); return fs.openSync(name, ...args); });
      assert.equal(read(file).revision, changes); assert.equal(attempts, changes + 1);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('atomic replacement after open retries the now-unlinked descriptor without reading it', async () => {
    const directory = temp(), file = path.join(directory, 'source-state-1.json'); let attempts = 0;
    try {
      atomic(file, { revision: 0 });
      const read = reader((name, ...args) => { const fd = fs.openSync(name, ...args); if (name === file && ++attempts === 1) atomic(file, { revision: 1 }); return fd; });
      assert.equal(read(file).revision, 1); assert.equal(attempts, 2);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  for (const unsafe of ['permissions', 'hardlink', 'symlink', 'invalid JSON']) await caseOf(unsafe + ' replacement refuses without reading or retrying unsafe bytes', async () => {
    const directory = temp(), file = path.join(directory, 'source-state.json'); let attempts = 0;
    try {
      atomic(file, { revision: 0 });
      const read = reader((name, ...args) => {
        if (name === file && ++attempts === 1) {
          const next = path.join(directory, 'replacement');
          fs.writeFileSync(next, unsafe === 'invalid JSON' ? '{' : '{"revision":1}', { mode: unsafe === 'permissions' ? 0o644 : 0o600 });
          if (unsafe === 'hardlink') fs.linkSync(next, next + '.link');
          fs.unlinkSync(file);
          if (unsafe === 'symlink') fs.symlinkSync(next, file); else fs.renameSync(next, file);
        }
        return fs.openSync(name, ...args);
      });
      assert.throws(() => read(file), error => unsafe === 'invalid JSON' ? error.name === 'SyntaxError' : ['UNSAFE_FILE', 'ELOOP'].includes(error.code));
      assert(attempts <= 2);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('persistent replacement is bounded and reports its exact private operation and path', async () => {
    const directory = temp(), file = path.join(directory, 'source-state-2.json'); let attempts = 0;
    try {
      atomic(file, {});
      const read = reader((name, ...args) => { if (name === file) atomic(file, { attempt: ++attempts }); return fs.openSync(name, ...args); });
      assert.throws(() => read(file), error => error.code === 'PATH_CHANGED' && error.path === file && error.operation === 'readPrivateJson' && !!error.stack);
      assert(attempts > 1 && attempts <= 5);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await caseOf('native evidence always contains a stack, operation and path, including a failed command', async () => {
    const native = subject('scripts/native-command');
    const plain = native.failureEvidence(Error('fixture'));
    assert(plain.stack.includes('fixture')); assert.equal(typeof plain.operation, 'string'); assert(Object.hasOwn(plain, 'path'));
    try { native.command('/fixture/tool', ['inspect'], {}, () => ({ status: 2, stdout: '', stderr: 'refused' })); assert.fail('must fail'); }
    catch (error) { const evidence = native.failureEvidence(error); assert(evidence.stack); assert.equal(evidence.path, '/fixture/tool'); assert.equal(evidence.operation, 'inspect'); }
  });

  suite('R49 returned keeper retains confirmed exit across custodian retirement');
  for (const retiredBeforeList of [false, true]) await caseOf((retiredBeforeList ? 'retiring endpoint' : 'natural retirement') + ': Stop/restart clears borrowed state and its durable artifacts', async () => {
    const f = await require('./production-round27.test').keeperFixture('d7129af02c46', 'never-exiting-claude.js'); let returned;
    try {
      const transfer = await require('../src/keeperContinuity').releaseKeeper(f.source, [f.original], { snapshot: f.snapshot }); await f.source.close();
      const source = { keeperFile: path.join(f.dir, 'returned.keepers'), keeperTransfer: { files: { keepers: [f.source.dir] }, keeper: transfer } };
      atomic(source.keeperFile, source.keeperTransfer);
      returned = subject('src/legacyExtensionSource').returnedKeeper(source, { ownDirectory: path.join(f.dir, 'current'),
        factory: options => options.legacy ? new (require('../src/legacyKeeper').LegacyKeeper)({ ...options, processSnapshot: f.snapshot }) : new (require('../src/daemonKeeper').DaemonKeeper)(options) });
      f.links.push(returned);
      const session = f.session(returned); assert.equal(await returned.attach(session), true); await returned.endAttach();
      const original = session.proc;
      if (retiredBeforeList) {
        const link = original.link, list = link._list.bind(link);
        link._list = () => original.exitCode !== null || original.signalCode !== null ? Promise.reject(Error('custodian retired after final exit')) : list();
      }
      session.restart();
      await wait(() => session.proc?.pid && session.proc.runId !== transfer.transferred[0].runId);
      f.pids.add(session.proc.pid); f.pids.add(session.proc.link.keeperPid);
      await wait(() => returned.borrowed === false, 1500);
      assert.equal(source.keeperTransfer, null); assert(!fs.existsSync(source.keeperFile));
      session.stop(); await wait(() => !session.proc && (session._stoppingProc?.exitCode !== null || !!session._stoppingProc?.signalCode));
      assert.equal(f.log().filter(row => row.event === 'start').length, 2);
      await returned.close(); assert(!fs.existsSync(source.keeperFile + '.store'));
    } finally { await f.close(); }
  });

  suite('R49 real lsof mixed open and unopened candidates');
  await caseOf('rc=1 with stdout protects the open closure and collects the unused closure', async () => {
    if (process.platform !== 'darwin') return;
    const directory = temp(); let child;
    try {
      const held = sealed(directory, 'held'), unused = sealed(directory, 'unused');
      child = spawn(process.execPath, ['-e', "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('ready');process.stdin.resume();", held], { stdio: ['pipe', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
      const native = spawnSync('/usr/sbin/lsof', ['-w', '-nP', '-Fpn', '--', held, unused], { encoding: 'utf8' });
      assert.equal(native.status, 1); assert.equal(native.stderr, ''); assert(native.stdout.includes('n' + held));
      // The child deliberately hides its argv. The production collector must
      // use its real processOutput/lsof path, not an injected parser.
      child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); child = null;
      child = spawn(process.execPath, ['-e', "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');process.title='r49-open-file';process.stdout.write('ready');process.stdin.resume();", held], { stdio: ['pipe', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
      // Sandbox ps denial is unrelated to the lsof regression. Trap only ps;
      // keep processOutput's real spawnSync/status handling and real lsof.
      const file = path.join(baseline, 'src/keeperSupervisor.js'), local = createRequire(file), module = { exports: {} };
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, process, Buffer, __dirname: path.dirname(file), setTimeout, clearTimeout,
        require: name => name === 'child_process' ? { ...require('child_process'), spawnSync(file, args, options) {
          return file === '/bin/ps' ? { status: 0, stdout: '123 /unrelated\n', stderr: '' } : spawnSync(file, args, options);
        } } : local(name) });
      const result = module.exports.collectPrograms(directory, { loadedJob: null });
      assert(fs.existsSync(held)); assert(result.skipped.includes(held)); assert(result.removed.includes(unused), JSON.stringify(result));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  suite('R49 inter-process custody program admission');
  await caseOf('GC and another supervisor cannot enter between sealed staging and bootstrap', async () => {
    const directory = temp(), children = [], reports = [];
    const runtime = '/private/tmp/nik-mac/build/p3/final/NikUI Dev.app/Contents/Resources/engine/node';
    const marker = path.join(directory, 'resume'), jobFile = path.join(directory, 'job.fixture');
    const script = path.join(directory, 'actor.cjs');
    fs.writeFileSync(script, `
      const fs=require('fs'),cp=require('child_process'),path=require('path');
      const dir=process.argv[2],who=process.argv[3],original=cp.execFileSync;
      cp.execFileSync=(file,args,...options)=>{
        const result=original(file,args,...options);
        if(who==='first'&&args[0]==='--version'){
          fs.writeSync(1,JSON.stringify({who,event:'staged'})+'\\n');
          const end=Date.now()+12000;
          while(!fs.existsSync(${JSON.stringify(marker)})){
            if(Date.now()>=end)throw Error('STAGE_BARRIER_TIMEOUT');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
          }
        }
        return result;
      };
      const sup=require(${JSON.stringify(path.join(baseline, 'src/keeperSupervisor'))});
      const run=async args=>{
        fs.writeSync(1,JSON.stringify({who,event:args[0]})+'\\n');
        if(args[0]==='print'){
          if(fs.existsSync(${JSON.stringify(jobFile)}))return fs.readFileSync(${JSON.stringify(jobFile)},'utf8');
          throw Object.assign(Error('absent'),{code:113,stderr:'Could not find service "'+sup.jobFor(dir).label+'"'});
        }
        if(args[0]==='bootstrap'){
          const p=sup.savedProgram(dir);
          fs.writeFileSync(${JSON.stringify(jobFile)},'job = {\\n\\tpath = '+sup.jobFor(dir).file+'\\n\\tprogram = /bin/sh\\n\\targuments = {\\n'+sup.argumentsFor(dir,p).map(a=>'\\t\\t'+a).join('\\n')+'\\n\\t}\\n}\\n');
        }
        return '';
      };
      sup.supervise(dir,{interpreter:${JSON.stringify(runtime)},sourceDirectory:${JSON.stringify(path.join(repo, 'src'))},run,ready:async()=>{},processRun:file=>file==='/bin/ps'?'123 /unrelated\\n':''})
        .then(()=>fs.writeSync(1,JSON.stringify({who,event:'done'})+'\\n'),e=>{console.error(e.stack);process.exitCode=1});
    `, { mode: 0o600 });
    function start(who) {
      const child = spawn(process.execPath, [script, directory, who], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
      let output = '', stderr = '';
      child.stdout.on('data', bytes => { output += bytes; const lines = output.split('\n'); output = lines.pop(); for (const line of lines.filter(Boolean)) reports.push(JSON.parse(line)); });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const exit = new Promise((resolve, reject) => { child.once('exit', code => {
        if (code === 0) resolve(); else { reports.push({ who, event: 'failed', stderr }); reject(Error('Actor ' + who + ': ' + stderr)); }
      }); child.once('error', reject); });
      exit.catch(() => {}); return exit;
    }
    try {
      const a = start('first'); await wait(() => {
        const failed = reports.find(row => row.event === 'failed'); if (failed) throw Error(failed.stderr);
        return reports.some(row => row.event === 'staged');
      });
      const candidates = fs.readdirSync(directory).filter(name => /^custody-(?:node-)?[a-f0-9]{24}(?:\.js)?$/.test(name)); assert.equal(candidates.length, 2);
      let inventory = 0;
      const gc = subject('src/keeperSupervisor').collectPrograms(directory, { loadedJob: null, processRun: file => { inventory++; return file === '/bin/ps' ? '123 /unrelated\n' : ''; } });
      assert.equal(inventory, 0, 'GC must acquire the same lock before inventory'); assert.equal(gc.removed.length, 0);
      assert(candidates.every(name => fs.existsSync(path.join(directory, name))));
      const b = start('second'); await pause(250);
      assert(!reports.some(row => row.who === 'second'), 'Second supervisor must wait before inspect/stage');
      fs.writeFileSync(marker, ''); await Promise.all([a, b]);
      assert.equal(reports.filter(row => row.event === 'bootstrap').length, 1);
      const saved = subject('src/keeperSupervisor').savedProgram(directory);
      assert(fs.existsSync(saved.node) && fs.existsSync(saved.script));
    } finally {
      fs.writeFileSync(marker, '');
      for (const child of children) if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await caseOf('a kernel lock survives aliases and process death releases it without replacing r1.lock', async () => {
    if (process.platform !== 'darwin') return;
    const directory = temp(); let child;
    const lockFile = path.join(directory, 'r1.lock');
    try {
      // Python's flock is an independent implementation of the same lock.
      child = spawn('/opt/homebrew/bin/python3', ['-c', 'import sys,fcntl,os; f=open(sys.argv[1],"w");os.chmod(sys.argv[1],0o600);fcntl.flock(f,fcntl.LOCK_EX);print("ready",flush=True);sys.stdin.read()', lockFile], { stdio: ['pipe', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
      const ino = fs.statSync(lockFile).ino;
      const protectedFile = sealed(directory, 'not available to GC while another process holds flock');
      const sup = subject('src/keeperSupervisor'); let calls = 0;
      sup.collectPrograms(directory.replace(/^\/private\/tmp\//, '/tmp/'), { loadedJob: null, processRun: () => { calls++; return ''; } });
      assert.equal(calls, 0); assert(fs.existsSync(protectedFile)); assert.equal(fs.statSync(lockFile).ino, ino);
      await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); }); child = null;
      const unused = sealed(directory, 'collect after crashed holder');
      assert(sup.collectPrograms(directory, { loadedJob: null, processRun: file => file === '/bin/ps' ? '123 /unrelated\n' : '' }).removed.includes(unused));
      assert.equal(fs.statSync(lockFile).ino, ino);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
};

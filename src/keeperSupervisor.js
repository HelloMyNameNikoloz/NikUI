'use strict';

// launchd watches crashes, not an app/window timer. Every restart uses sealed
// bytes, including Node: removing either the app or its extension is harmless.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFile, execFileSync, spawnSync } = require('child_process');
const { privateDirectory, privateFile, readPrivateJson, fail } = require('./daemonPaths');
const custodyLock = require('./custodyLock');
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const jobFor = (directory) => ({
  label: 'com.nikui.legacy-custody.' + sha(directory).slice(0, 24),
  file: path.join(directory, 'r1-agent.plist')
});
const programFor = (directory) => path.join(directory, 'r1-program.json');
const failureFor = (directory) => path.join(directory, 'r1-failure.json');
function writeFailure(directory, code) {
  try { privateDirectory(directory, false); require('./engineOwner').atomicJson(failureFor(directory), { version: 1, code, terminal: true }); } catch (_) { /* Unsafe/missing directory: callers see its own named refusal. */ }
}
function startupFailure(directory) {
  return privateFile(failureFor(directory), { optional: true }) ? readPrivateJson(failureFor(directory)) : null;
}
// All relative requires are resolved at staging time. The generated loader
// permits built-ins only outside this closed map; it never reads source files.
function bundle(sourceDirectory = __dirname) {
  const files = new Map();
  function visit(name) {
    if (files.has(name)) return;
    const code = fs.readFileSync(path.join(sourceDirectory, name), 'utf8'); files.set(name, code);
    if (name.endsWith('.json')) return;
    for (const match of code.matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      visit(dep + (path.extname(dep) ? '' : '.js'));
    }
  }
  visit('keeperRescue.js');
  const modules = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, code]) =>
    JSON.stringify(name) + ': function(require,module,exports,__filename,__dirname) {\n' +
    (name.endsWith('.json') ? 'module.exports = ' + JSON.stringify(JSON.parse(code)) + ';' : code) + '\n}').join(',\n');
  return "'use strict';\nconst nativeRequire=require, path=require('path'), builtins=new Set(require('module').builtinModules), cache={};\n" +
    'const modules={\n' + modules + '\n};\n' +
    `function load(name) {
      if (cache[name]) return cache[name].exports;
      if (!modules[name]) throw Error('Unsealed custody dependency: ' + name);
      const item = cache[name] = { exports: {} };
      const local = (id) => {
        if (!id.startsWith('.')) {
          if (!builtins.has(id) && !builtins.has(id.replace(/^node:/, ''))) throw Error('Non-builtin custody dependency');
          return nativeRequire(id);
        }
        const dep = path.posix.normalize(path.posix.join(path.posix.dirname(name), id));
        return load(dep + (path.extname(dep) ? '' : '.js'));
      };
      modules[name](local,item,item.exports,path.join(__dirname,name),__dirname);
      return item.exports;
    }
    void load('keeperRescue.js').startRescue(process.argv[2]);\n`;
}
function sealedFile(directory, prefix, bytes, mode) {
  const hash = sha(bytes), file = path.join(directory, prefix + hash.slice(0, 24) + (mode === 0o600 ? '.js' : ''));
  if (!fs.existsSync(file)) {
    const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    const fd = fs.openSync(temp, 'wx', mode);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { fs.unlinkSync(temp); }
  }
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o777) !== mode || sha(fs.readFileSync(file)) !== hash)
    throw fail('KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED', 'Sealed custody program changed');
  return file;
}
function savedProgram(directory) {
  const saved = readPrivateJson(programFor(directory));
  for (const [key, prefix, mode] of [['script', 'custody-', 0o600], ['node', 'custody-node-', 0o700]]) {
    const file = saved[key], hash = saved[key + 'Hash'];
    if (saved.version !== 1 || typeof file !== 'string' || !/^[a-f0-9]{64}$/.test(hash) ||
        file !== path.join(directory, prefix + hash.slice(0, 24) + (key === 'script' ? '.js' : '')))
      throw fail('KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED', 'Invalid custody program provenance');
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o777) !== mode || sha(fs.readFileSync(file)) !== hash)
      throw fail('KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED', 'Custody program is missing or changed');
  }
  // R37/R39 did not record the launcher. Their exact, frozen launcher is the
  // only permitted migration; never learn trusted text from a loaded job.
  if (saved.launcher === undefined && saved.launcherHash === undefined) {
    saved.launcher = legacyLauncher; saved.launcherHash = sha(legacyLauncher);
  }
  if (![launcher, legacyLauncher].includes(saved.launcher) || sha(saved.launcher) !== saved.launcherHash)
    throw fail('KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED', 'Custody launcher is changed');
  verifyRuntime(saved.node);
  return saved;
}
function verifyRuntime(file) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R',
      '=anchor apple generic and certificate leaf[subject.OU] = "KBA6653B4V"', file],
    { encoding: 'utf8', timeout: 8000, env: { PATH: '/usr/bin:/bin' } });
  } catch (_) { throw fail('KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED', 'Custody Node is not signed by the NikUI team'); }
}
function stage(directory, options = {}) {
  const lock = custodyLock.held(options.lock, directory) ? null : custodyLock.acquire(directory);
  try { return stageLocked(directory, options); } finally { lock?.release(); }
}
function stageLocked(directory, { interpreter = process.execPath, sourceDirectory = __dirname, publish = true } = {}) {
  privateDirectory(directory, false);
  // Electron's helper is not standalone. Move's app coordinator stages its
  // signed standalone Node before the editor releases any run. Reloads reuse it.
  if (process.versions.electron && interpreter === process.execPath) {
    try { return savedProgram(directory); }
    catch (_) { throw fail('KEEPER_RESCUE_SUPERVISION_RUNTIME_REQUIRED', 'Open NikUI and retry Move to stage the custody runtime'); }
  }
  // A Homebrew Node stub depends on replaceable Cellar/opt dylibs. Only the
  // standalone app distribution (or equivalent system-only closure) can move.
  if (process.platform === 'darwin') {
    const libraries = execFileSync('/usr/bin/otool', ['-L', interpreter], { encoding: 'utf8', timeout: 8000 }).split('\n').slice(1).filter((s) => s.trim());
    if (libraries.some((s) => !/^\s*\/(?:usr\/lib|System\/Library)\//.test(s)))
      throw fail('KEEPER_RESCUE_SUPERVISION_RUNTIME_REQUIRED', 'Use NikUI’s bundled standalone Node runtime');
  }
  const scriptBytes = bundle(sourceDirectory), nodeBytes = fs.readFileSync(interpreter);
  const saved = { version: 1, script: sealedFile(directory, 'custody-', scriptBytes, 0o600), scriptHash: sha(scriptBytes),
    node: sealedFile(directory, 'custody-node-', nodeBytes, 0o700), nodeHash: sha(nodeBytes), launcher, launcherHash: sha(launcher) };
  verifyRuntime(saved.node);
  try {
    const version = execFileSync(saved.node, ['--version'], { encoding: 'utf8', timeout: 8000, cwd: directory, env: { PATH: '/usr/bin:/bin' } });
    if (!/^v\d+\.\d+\.\d+\s*$/.test(version)) throw Error('Not Node');
  } catch (_) { throw fail('KEEPER_RESCUE_SUPERVISION_RUNTIME_REQUIRED', 'The sealed Node runtime cannot start'); }
  if (publish) require('./engineOwner').atomicJson(programFor(directory), saved);
  return saved;
}
// An OS-shell preflight survives deletion of Node/JS. Known configuration
// failures get one attempt, then boot out this exact job while retaining proof
// and diagnostics. Unexpected exits (including SIGKILL) remain supervised.
const legacyLauncher = `umask 077
if [ "$(/usr/bin/stat -f '%u:%Lp' "$3" 2>/dev/null)" != "$5:700" ] || [ ! -x "$1" ] || [ ! -r "$2" ]; then
  if [ "$(/usr/bin/stat -f '%u:%Lp' "$3" 2>/dev/null)" = "$5:700" ]; then
    (set -C; printf '%s\\n' '{"version":1,"code":"KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING","terminal":true}' > "$3/r1-failure.json") 2>/dev/null
  fi
  /bin/launchctl bootout "gui/$5/$4"
  # If launchd cannot remove its own job, park this failed attempt. No retry
  # loop or successful retirement with unverified proofs is allowed.
  while :; do /bin/sleep 86400; done
fi
exec /usr/bin/env -i PATH=/usr/bin:/bin NIKUI_CUSTODY_JOB_LABEL="$4" "$1" "$2" "$3"`;
const launcher = legacyLauncher;
function argumentsFor(directory, program) { return ['/bin/sh', '-c', program.launcher ?? launcher, 'nikui-custody', program.node, program.script, directory, jobFor(directory).label, String(process.getuid())]; }
function matchesProgram(job, directory, program) {
  if ([...job.matchAll(/^\s*program = (.+)$/gm)].map(m => m[1]).join('\n') !== '/bin/sh') return false;
  // launchctl preserves embedded newlines in the shell argument. Compare the
  // complete argument block, not a set of lines that ignores the launcher.
  const blocks = [...job.matchAll(/^([\t ]*)arguments = \{\n/gm)];
  if (blocks.length !== 1) return false;
  const at = blocks[0].index + blocks[0][0].length, indent = blocks[0][1];
  const end = job.indexOf('\n' + indent + '}', at);
  if (end < 0) return false;
  const actual = job.slice(at, end), padding = /^[\t ]*/.exec(actual)[0];
  return actual === argumentsFor(directory, program).map(arg => padding + arg).join('\n');
}
function processOutput(file, args, options) {
  const result = spawnSync(file, args, options);
  if (!result.error && file === '/bin/launchctl' && result.status === 113 &&
      String(result.stderr).includes('Could not find service "' + args[1].split('/').at(-1) + '"')) return null;
  if (result.error || String(result.stderr || '').trim() || result.status !== 0 && !(file === '/usr/sbin/lsof' && result.status === 1))
    throw Error('Incomplete custody process inventory');
  return result.stdout;
}
function collectPrograms(directory, options = {}) {
  let lock;
  try {
    if (!custodyLock.held(options.lock, directory)) lock = custodyLock.acquire(directory);
    return collectProgramsLocked(directory, options);
  } catch (_) { return { removed: [], skipped: [] }; }
  finally { lock?.release(); }
}
function collectProgramsLocked(directory, { keep = [], processRun = processOutput, loadedJob } = {}) {
  const removed = [], skipped = [];
  try {
    privateDirectory(directory, false);
    const canonical = file => { try { return fs.realpathSync(file); } catch (error) { if (error.code === 'ENOENT') return file; throw error; } };
    const aliases = file => {
      const resolved = canonical(file);
      return [...new Set([file, resolved, resolved.replace(/^\/private(?=\/(?:tmp|var)\/)/, '')])];
    };
    const retained = new Set(keep.flatMap(program => [program.node, program.script]).filter(file => typeof file === 'string').map(canonical));
    // Retention cannot authorize execution or deletion. Even an obsolete
    // record safely protects only these directory-local candidate names.
    if (privateFile(programFor(directory), { optional: true })) {
      const recorded = readPrivateJson(programFor(directory));
      for (const key of ['node', 'script']) if (typeof recorded[key] === 'string') retained.add(canonical(recorded[key]));
    }
    const options = { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } };
    if (loadedJob === undefined) loadedJob = processRun('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + jobFor(directory).label], options);
    if (loadedJob !== null) {
      const paths = typeof loadedJob === 'string' && [...loadedJob.matchAll(/^\s*path = (.+)$/gm)];
      if (!paths || paths.length !== 1 || canonical(paths[0][1]) !== canonical(jobFor(directory).file)) return { removed, skipped };
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        if (aliases(file).some(alias => loadedJob.includes(alias))) retained.add(canonical(file));
      }
    }
    const candidates = fs.readdirSync(directory).filter(name => /^(?:custody-[a-f0-9]{24}\.js|custody-node-[a-f0-9]{24})$/.test(name))
      .map(name => path.join(directory, name)).filter(file => !retained.has(canonical(file)));
    if (!candidates.length) return { removed, skipped };
    // argv catches a JS closure after Node has closed it. lsof also catches
    // mapped executables, open files and a process that changed its argv.
    // Incomplete/denied OS evidence is never proof that a file is unused.
    const processes = processRun('/bin/ps', ['-axww', '-o', 'pid=,command='], options);
    if (!String(processes).trim() || String(processes).trim().split('\n').some(line => !/^\s*[1-9][0-9]*\s+\S/.test(line)))
      return { removed, skipped: candidates };
    let open;
    try { open = processRun('/usr/sbin/lsof', ['-w', '-nP', '-Fpn', '--', ...candidates], options); }
    catch (error) {
      if (error.status !== 1 || String(error.stderr || '').trim()) return { removed, skipped: candidates };
      open = error.stdout || '';
    }
    if (String(open).trim().split('\n').filter(Boolean).some(line => !/^(?:p[1-9][0-9]*|f\S+|n\/.*)$/.test(line)))
      return { removed, skipped: candidates };
    const used = new Set(String(open).split('\n').filter(line => line.startsWith('n')).map(line => canonical(line.slice(1))));
    for (const file of candidates) {
      const resolved = canonical(file);
      // launchd uses /private/tmp; an engine/editor may have entered via /tmp.
      // argv is not shell-quoted, so compare both spellings without splitting
      // filenames containing spaces. lsof's names are canonicalized above.
      if (aliases(file).some(name => String(processes).includes(name)) || used.has(resolved)) { skipped.push(file); continue; }
      const st = fs.lstatSync(file), mode = file.endsWith('.js') ? 0o600 : 0o700;
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o777) !== mode) { skipped.push(file); continue; }
      fs.unlinkSync(file); removed.push(file);
    }
  } catch (_) { /* Collection is optional; leave uncertain files for a later Move. */ }
  return { removed, skipped };
}
function jobPlist(directory, program = stage(directory)) {
  const { label } = jobFor(directory), args = argumentsFor(directory, program);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n' +
    '<key>Label</key><string>' + label + '</string>\n' +
    '<key>ProgramArguments</key><array>' + args.map((s) => '<string>' + xml(s) + '</string>').join('') + '</array>\n' +
    '<key>WorkingDirectory</key><string>/</string>\n' +
    '<key>EnvironmentVariables</key><dict><key>NIKUI_CUSTODY_JOB_LABEL</key><string>' + label + '</string></dict>\n' +
    '<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n' +
    '<key>ThrottleInterval</key><integer>10</integer>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n';
}
function command(args) {
  return new Promise((resolve, reject) => execFile('/bin/launchctl', args,
    { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
}
async function inspect(directory, run) {
  const { label, file } = jobFor(directory);
  try {
    const job = await run(['print', 'gui/' + process.getuid() + '/' + label]);
    const paths = [...job.matchAll(/^\s*path = (.+)$/gm)];
    if (paths.length !== 1 || paths[0][1] !== file) throw fail('KEEPER_RESCUE_SUPERVISION_UNPROVEN', 'Custody job belongs to a different file');
    return job;
  } catch (error) {
    if (error.code === 113 && String(error.stderr).includes('Could not find service "' + label + '"')) return null;
    throw error;
  }
}
async function removeJob(directory, options = {}) {
  const lock = custodyLock.held(options.lock, directory) ? options.lock : await custodyLock.wait(directory);
  try { return await removeJobLocked(directory, { ...options, lock }); }
  finally { if (lock !== options.lock) lock.release(); }
}
async function removeJobLocked(directory, { run = command, emptyProven = false, keep = [], processRun, lock } = {}) {
  const { label, file } = jobFor(directory), target = 'gui/' + process.getuid() + '/' + label;
  const before = await inspect(directory, run);
  if (!emptyProven) {
    let status;
    try { status = await require('./daemonControl').controlRequest({ socket: path.join(directory, 'r1.sock') }, { op: 'retire' }); }
    catch (_) { /* Only a stopped job with empty durable proofs can be retired. */ }
    if (status?.ok && !status.runs?.length && !status.unverified?.length && !status.adopting?.length) emptyProven = true;
    else {
      let saved;
      try { saved = readPrivateJson(path.join(directory, 'r1-state.json')); } catch (_) { return { retained: true }; }
      if (status || before && /^\s*pid = /m.test(before) || saved.version !== 1 || saved.proofs?.length !== 0) return { retained: true };
      emptyProven = true;
    }
  }
  if (privateFile(file, { optional: true })) fs.unlinkSync(file);
  if (before !== null) {
    try { await run(['bootout', target]); } catch (error) { if (await inspect(directory, run) !== null) throw error; }
    const end = Date.now() + 8000;
    while (await inspect(directory, run) !== null) {
      if (Date.now() >= end) throw fail('KEEPER_RESCUE_SUPERVISION_CLEANUP', 'Custody job did not retire');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // A new custodian may have appeared after the retirement loop (including
  // when `before` was absent). Do not unlink its newly published record.
  if (await inspect(directory, run) !== null) return { label, retained: true };
  if (privateFile(programFor(directory), { optional: true })) fs.unlinkSync(programFor(directory));
  return { label, removed: true, collection: collectPrograms(directory, { keep, processRun, loadedJob: null, lock }) };
}
async function waitForReady(directory, run = command, repair = false, reusing = false) {
  const end = Date.now() + 5000;
  do {
    const job = await inspect(directory, run);
    const pids = job && [...job.matchAll(/^\s*pid = ([1-9][0-9]*)$/gm)];
    let status;
    try { status = await require('./daemonControl').controlRequest({ socket: path.join(directory, 'r1.sock') }, { op: 'status' }, { timeoutMs: 1000 }); }
    catch (_) { /* The exact launchd job may still be starting. */ }
    if (status?.ok && status.custodyVersion === 1 && pids?.length === 1) {
      if (status.pid !== Number(pids[0][1])) throw fail('KEEPER_RESCUE_SUPERVISION_ENDPOINT_BUSY', 'The custody endpoint is held by another process');
      if (repair && status.blocker === 'KEEPER_RESCUE_SUPERVISION_STATE_UNAVAILABLE' &&
          Array.isArray(status.unverified) && !status.unverified.length && Array.isArray(status.adopting) && !status.adopting.length) {
        const repaired = await require('./daemonControl').controlRequest({ socket: path.join(directory, 'r1.sock') },
          { op: 'add', proofs: [] }, { timeoutMs: 30000 });
        if (!repaired.ok || repaired.custodyVersion !== 1 || repaired.pid !== status.pid)
          throw fail(repaired.code || 'KEEPER_RESCUE_SUPERVISION_UNAVAILABLE', 'Custody persistence is still blocked');
        status = repaired;
      }
      if (status.blocker) throw fail(status.blocker, 'Custody startup is degraded');
      return;
    }
    const failure = startupFailure(directory);
    if (failure?.terminal && !reusing) throw fail(failure.code, 'Custody startup is blocked');
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < end);
  throw fail(startupFailure(directory)?.code || 'KEEPER_RESCUE_SUPERVISION_UNAVAILABLE', 'The expected custody job did not become ready');
}
async function supervise(directory, options = {}) {
  try { privateDirectory(directory, false); }
  catch (_) { throw fail('KEEPER_RESCUE_SUPERVISION_DIRECTORY_UNAVAILABLE', 'The private custody directory is missing or unsafe'); }
  const lock = await custodyLock.wait(directory);
  try { return await superviseLocked(directory, { ...options, lock }); } finally { lock.release(); }
}
async function superviseLocked(directory, { run = command, ready = waitForReady, ...options } = {}) {
  // An editor helper can only reuse the recorded runtime. It cannot identify
  // the current app's staged program, so leave collection to that app.
  const reuseOnly = process.versions.electron && (!options.interpreter || options.interpreter === process.execPath);
  const processRun = reuseOnly ? () => { throw Error('App runtime required for collection'); } : options.processRun;
  const { label, file } = jobFor(directory), domain = 'gui/' + process.getuid(), target = domain + '/' + label;
  const job = await inspect(directory, run);
  let recorded;
  if (job !== null) {
    try { recorded = savedProgram(directory); }
    catch (_) { throw fail('KEEPER_RESCUE_SUPERVISION_PROGRAM_CHANGED', 'The loaded custody program is missing or changed'); }
    if (matchesProgram(job, directory, recorded)) {
      if (options.repair && privateFile(failureFor(directory), { optional: true })) fs.unlinkSync(failureFor(directory));
      await run(['kickstart', target]); await ready(directory, run, options.repair === true, true);
      let next;
      try { next = stage(directory, { ...options, publish: false }); } catch (_) { /* Verified custody remains usable even with ENOSPC or a failed update. */ }
      try { require('./engineOwner').atomicJson(programFor(directory), recorded); } catch (_) { /* Its existing verified record is sufficient. */ }
      collectPrograms(directory, { keep: [recorded, ...(next ? [next] : [])], processRun, loadedJob: job, lock: options.lock });
      return { label, file };
    }
  }
  const failure = startupFailure(directory);
  if (failure?.terminal && !options.repair) throw fail(failure.code, 'Custody startup is blocked; repair and retry Move');
  let program;
  try { program = stage(directory, { ...options, publish: false }); }
  catch (error) {
    const code = error.code?.startsWith('KEEPER_RESCUE_SUPERVISION_') ? error.code : 'KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING';
    writeFailure(directory, code); throw fail(code, 'The sealed custody program could not be prepared');
  }
  const wanted = jobPlist(directory, program);
  if (job !== null && (await removeJob(directory, { run, keep: [program], processRun, lock: options.lock })).retained)
    throw fail('KEEPER_RESCUE_SUPERVISION_UPGRADE_BLOCKED', 'Existing custody job has unproved program provenance');
  const socket = path.join(directory, 'r1.sock');
  if (privateFile(socket, { socket: true, optional: true }) && await require('./daemonLock').probeSocket(socket) !== 'absent') {
    writeFailure(directory, 'KEEPER_RESCUE_SUPERVISION_ENDPOINT_BUSY');
    throw fail('KEEPER_RESCUE_SUPERVISION_ENDPOINT_BUSY', 'An existing endpoint has no matching immutable custody job');
  }
  privateFile(file, { optional: true });
  require('./engineOwner').atomicJson(programFor(directory), program);
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  fs.writeFileSync(temp, wanted, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
  // A corrected explicit Move/attach is the only retry of a terminal startup.
  if (privateFile(failureFor(directory), { optional: true })) fs.unlinkSync(failureFor(directory));
  try { await run(['bootstrap', domain, file]); } catch (error) { if (await inspect(directory, run) === null) throw error; }
  if (await inspect(directory, run) === null) throw fail('KEEPER_RESCUE_SUPERVISION_UNAVAILABLE', 'Custody job was not registered');
  await run(['kickstart', target]); // No -k: never kill an existing custodian.
  await ready(directory, run, options.repair === true);
  collectPrograms(directory, { keep: [program], processRun, loadedJob: await inspect(directory, run), lock: options.lock });
  return { label, file };
}
module.exports = { supervise, jobFor, jobPlist, stage, savedProgram, bundle, removeJob, argumentsFor, launcher, matchesProgram, collectPrograms,
  failureFor, startupFailure, writeFailure, command, waitForReady };

'use strict';

// Talking to the phone, heard by the laptop.
//
// The transcriber itself is a Swift program that needs a Mac, VoiceInk's model
// and half a minute the first time, so almost everything here runs against a
// stand-in for it: what is under test is when it is built (once), when it is
// run (only when asked), what it is handed (a WAV this accepts, in a folder
// nobody else can read, removed afterwards) and who may ask (a device that may
// send prompts). The real one is run at the end if it happens to be built.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const { Voice, readWav, writeHeader, MAX_BYTES } = require('../src/voice.js');
const { Session } = require('../src/session.js');
const { RemoteServer } = require('../src/remote.js');
const { LocalKey } = require('../src/auth.js');
const { DeviceStore } = require('../src/devices.js');
const { PairingWindow } = require('../src/pairing.js');
const { loadIdentity } = require('../src/identity.js');
const { buildReport } = require('../src/report.js');
const ws = require('./helpers/ws.js');
const { makeDevice } = require('./helpers/device.js');

const ROOT = path.join(__dirname, '..');

const wav = (seconds, patch) => {
  const bytes = Math.round(seconds * 16000) * 2;
  const buffer = writeHeader(Buffer.alloc(44 + bytes), bytes);
  if (patch) patch(buffer);
  return buffer;
};

/** A transcriber that is never there: it says what it was asked and answers as told. */
function fakeRun(home) {
  const calls = [];
  const answers = { check: { ok: true, model: 'parakeet-tdt-0.6b-v3' }, text: 'hello from the phone' };
  const run = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    if (file === '/usr/bin/nice') {
      if (answers.buildFails) return { ok: false, code: 1, stdout: '', stderr: 'error: no toolchain' };
      if (answers.buildWait) await answers.buildWait;
      return { ok: true, code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('--show-bin-path')) {
      const bin = path.join(home, 'made');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'nikui-voice'), '#!/bin/sh\n');
      return { ok: true, code: 0, stdout: bin + '\n', stderr: '' };
    }
    if (args[0] === 'check') return { ok: true, code: 0, stdout: JSON.stringify(answers.check) + '\n', stderr: '' };
    if (args[0] === 'transcribe') {
      call.existed = fs.existsSync(args[1]);
      call.mode = call.existed ? fs.statSync(args[1]).mode & 0o777 : null;
      call.size = call.existed ? fs.statSync(args[1]).size : 0;
      if (answers.hang) return { ok: false, code: 1, killed: true, stdout: '', stderr: '' };
      if (answers.say) return { ok: true, code: 0, stdout: JSON.stringify(answers.say) + '\n', stderr: '' };
      if (answers.slow) await answers.slow;
      return { ok: true, code: 0, stdout: JSON.stringify({ ok: true, text: answers.text, seconds: 1.5, ms: 412 }) + '\n', stderr: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls, answers };
}

const rejects = async (promise) => {
  try { await promise; return null; } catch (err) { return err; }
};

module.exports = async function () {
  // ---- the file format ------------------------------------------------------

  suite('a recording is read for what it says it is');

  const second = readWav(wav(1));
  checkEqual('16 kHz', second.rate, 16000);
  checkEqual('mono', second.channels, 1);
  checkEqual('16-bit PCM', second.bits === 16 && second.encoding === 1, true);
  checkEqual('and a second long', second.seconds, 1);
  checkEqual('not a WAV is nothing', readWav(Buffer.from('not a recording at all, not even close to one, no')), null);
  checkEqual('nor is something too short to be one', readWav(Buffer.alloc(10)), null);
  checkEqual('nor something that is not a buffer', readWav('RIFF'), null);

  // ---- nothing runs until it is needed ---------------------------------------

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-voice-test-'));
  const home = path.join(dir, 'voice');
  const fake = fakeRun(home);
  let on = true;
  const voice = new Voice({ dir, run: fake.run, platform: 'darwin', arch: 'arm64', enabled: () => on });

  suite('nothing is built or run by being made');

  checkEqual('making it runs nothing', fake.calls.length, 0);
  check('it is possible on a Mac with Apple silicon', voice.possible);
  check('and not built yet', !voice.isBuilt());
  const before = await voice.state();
  check('asking says it needs building', before.available && before.needsBuild);
  checkEqual('and asking still runs nothing', fake.calls.length, 0);

  suite('elsewhere it says so rather than trying');

  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'x64'], ['win32', 'arm64']]) {
    const away = new Voice({ dir, run: fake.run, platform, arch });
    const said = await away.state();
    checkEqual(`${platform}/${arch} is unsupported`, said.code, 'UNSUPPORTED');
    checkEqual('and building there does nothing', await away.ensure(), false);
  }
  checkEqual('without running anything', fake.calls.length, 0);

  suite('turned off, it is off');

  on = false;
  checkEqual('the state says off', (await voice.state()).code, 'OFF');
  checkEqual('and a recording is refused as off', (await rejects(voice.transcribe(wav(1)))).code, 'OFF');
  checkEqual('without anything being run', fake.calls.length, 0);
  on = true;

  // ---- built once ----------------------------------------------------------

  suite('it is built once, however many ask');

  let release;
  fake.answers.buildWait = new Promise((r) => { release = r; });
  const first = voice.ensure();
  const again = voice.ensure();
  check('a second ask while building is the same build', first === again);
  checkEqual('the state says building', (await voice.state()).building, true);
  release();
  checkEqual('the build succeeds', await first, true);
  delete fake.answers.buildWait;
  const builds = fake.calls.filter((c) => c.file === '/usr/bin/nice');
  checkEqual('swift build ran once', builds.length, 1);
  check('at low priority, in release', builds[0].args.includes('-n') && builds[0].args.includes('release'));
  check('from a copy of the package in its own storage',
    builds[0].args.includes(path.join(home, 'package')) && fs.existsSync(path.join(home, 'package', 'Package.swift')));
  check('the lock is gone afterwards', !fs.existsSync(path.join(home, 'building')));
  check('it is stamped as built', voice.isBuilt());
  const warmed = fake.calls.filter((c) => c.args[0] === 'transcribe');
  checkEqual('and warmed once on silence, so the first word does not wait', warmed.length, 1);
  checkEqual('built again, nothing runs', (await voice.ensure(), fake.calls.filter((c) => c.file === '/usr/bin/nice').length), 1);

  suite('a changed transcriber is rebuilt');

  fs.writeFileSync(path.join(home, 'stamp'), 'something-older');
  check('an old stamp is not built', !voice.isBuilt());
  await voice.ensure();
  checkEqual('so it builds again', fake.calls.filter((c) => c.file === '/usr/bin/nice').length, 2);

  suite('another window building is waited for, not raced');

  {
    const other = fakeRun(home);
    const second = new Voice({ dir, run: other.run, platform: 'darwin', arch: 'arm64' });
    fs.writeFileSync(path.join(home, 'stamp'), 'stale');
    fs.mkdirSync(path.join(home, 'building'));
    const waiting = second.ensure();
    await new Promise((r) => setTimeout(r, 200));
    checkEqual('it does not build while the lock is held', other.calls.length, 0);
    fs.writeFileSync(path.join(home, 'stamp'), second.stamp());
    fs.rmSync(path.join(home, 'building'), { recursive: true, force: true });
    checkEqual('and sees the other window’s build', await waiting, true);
    checkEqual('without building itself', other.calls.filter((c) => c.file === '/usr/bin/nice').length, 0);
  }

  suite('a build that fails says why, once');

  {
    const failing = fakeRun(path.join(dir, 'b', 'voice'));
    failing.answers.buildFails = true;
    const broken = new Voice({ dir: path.join(dir, 'b'), run: failing.run, platform: 'darwin', arch: 'arm64' });
    checkEqual('the build is false', await broken.ensure(), false);
    const said = await broken.state();
    checkEqual('the state is broken', said.code, 'BROKEN');
    check('with the compiler’s words and what to do', /no toolchain/.test(said.reason) && /xcode-select/.test(said.reason));
    await broken.ensure();
    checkEqual('and it is not tried again every time', failing.calls.length, 1);
  }

  // ---- one recording ---------------------------------------------------------

  suite('the model is asked about once, and only a yes is kept');

  fake.calls.length = 0;
  const ready = await voice.state();
  check('it is available', ready.available && !ready.needsBuild && !ready.building);
  checkEqual('naming the model', ready.model, 'parakeet-tdt-0.6b-v3');
  await voice.state();
  checkEqual('checked once', fake.calls.filter((c) => c.args[0] === 'check').length, 1);
  {
    const noModel = fakeRun(home);
    noModel.answers.check = { ok: false, code: 'NO_MODEL', error: 'VoiceInk’s model is not downloaded.' };
    const v = new Voice({ dir, run: noModel.run, platform: 'darwin', arch: 'arm64' });
    checkEqual('no model is said as no model', (await v.state()).code, 'NO_MODEL');
    await v.state();
    checkEqual('and asked again next time', noModel.calls.length, 2);
  }

  suite('a recording becomes words');

  fake.calls.length = 0;
  const heard = await voice.transcribe(wav(1.5));
  checkEqual('the words', heard.text, 'hello from the phone');
  checkEqual('how long it was', heard.seconds, 1.5);
  checkEqual('and how long it took', heard.ms, 412);
  const ran = fake.calls.find((c) => c.args[0] === 'transcribe');
  check('the recording was there for the transcriber', ran.existed);
  checkEqual('readable by nobody else', ran.mode, 0o600);
  checkEqual('every byte of it', ran.size, wav(1.5).length);
  check('and gone afterwards', !fs.existsSync(path.dirname(ran.args[1])));
  check('with a timeout in proportion', ran.options.timeout >= 90000 && ran.options.timeout < 100000);

  suite('what is not a recording is refused before anything runs');

  fake.calls.length = 0;
  checkEqual('nothing', (await rejects(voice.transcribe(Buffer.alloc(0)))).code, 'NO_AUDIO');
  checkEqual('not a buffer', (await rejects(voice.transcribe('hello'))).code, 'NO_AUDIO');
  checkEqual('not a WAV', (await rejects(voice.transcribe(Buffer.alloc(100, 1)))).code, 'BAD_AUDIO');
  checkEqual('stereo', (await rejects(voice.transcribe(wav(1, (b) => b.writeUInt16LE(2, 22))))).code, 'BAD_AUDIO');
  checkEqual('8-bit', (await rejects(voice.transcribe(wav(1, (b) => b.writeUInt16LE(8, 34))))).code, 'BAD_AUDIO');
  checkEqual('floating point', (await rejects(voice.transcribe(wav(1, (b) => b.writeUInt16LE(3, 20))))).code, 'BAD_AUDIO');
  checkEqual('a silly rate', (await rejects(voice.transcribe(wav(1, (b) => b.writeUInt32LE(96000, 24))))).code, 'BAD_AUDIO');
  checkEqual('longer than five minutes', (await rejects(voice.transcribe(Buffer.alloc(MAX_BYTES + 2)))).code, 'TOO_LONG');
  checkEqual('or saying it is, at a lower rate',
    (await rejects(voice.transcribe(wav(200, (b) => { b.writeUInt32LE(8000, 24); })))).code, 'TOO_LONG');
  checkEqual('none of which ran anything', fake.calls.length, 0);

  suite('a transcriber that fails or hangs is said as such, and still cleaned up');

  fake.answers.hang = true;
  fake.calls.length = 0;
  checkEqual('a hang is a timeout', (await rejects(voice.transcribe(wav(1)))).code, 'TIMEOUT');
  check('and the recording is gone', !fs.existsSync(path.dirname(fake.calls[0].args[1])));
  delete fake.answers.hang;
  fake.answers.say = { ok: false, code: 'FAILED', error: 'the model could not read it' };
  const failed = await rejects(voice.transcribe(wav(1)));
  check('a failure carries the transcriber’s words', failed.code === 'FAILED' && /could not read/.test(failed.message));
  fake.answers.say = { ok: false, code: 'NO_MODEL', error: 'gone' };
  await rejects(voice.transcribe(wav(1)));
  checkEqual('a model that went away is asked about again', voice.model, null);
  delete fake.answers.say;

  suite('two recordings at once are taken in turn');

  fake.calls.length = 0;
  let finish;
  fake.answers.slow = new Promise((r) => { finish = r; });
  const one = voice.transcribe(wav(1));
  const two = voice.transcribe(wav(1));
  await new Promise((r) => setTimeout(r, 50));
  checkEqual('only one is running', fake.calls.filter((c) => c.args[0] === 'transcribe').length, 1);
  finish();
  await Promise.all([one, two]);
  checkEqual('then the other', fake.calls.filter((c) => c.args[0] === 'transcribe').length, 2);
  delete fake.answers.slow;
  const after = await rejects(voice.transcribe(Buffer.alloc(0)));
  check('one failing does not stop the next', after && (await voice.transcribe(wav(1))).text === 'hello from the phone');

  // ---- over the socket -----------------------------------------------------

  suite('a phone asks, over the socket it already holds');

  const only = new Session({ cwd: ROOT });
  only.start = function () { this.everStarted = true; };
  only._write = function () {};
  Object.defineProperty(only, 'isRunning', { get: () => true });
  const sessions = { list: () => [only], get: (id) => (id === only.id ? only : null) };
  const host = {
    config: () => ({ showThinking: true, promptSnippets: {} }),
    home: '/home', knownCommands: () => ['status'],
    fleet: () => [only], env: () => ({ vscode: 'test' })
  };
  const devices = new DeviceStore(memoryState());
  host.audit = (entry) => devices.record(entry);

  // The server's half is what is under test; the transcriber is a script.
  const stage = { state: { available: true, model: 'parakeet-tdt-0.6b-v3' }, ensured: 0, heard: [] };
  const standIn = {
    state: async () => stage.state,
    ensure: () => { stage.ensured++; return Promise.resolve(true); },
    transcribe: async (audio) => {
      stage.heard.push(audio);
      if (stage.fail) throw Object.assign(new Error(stage.fail.message), { code: stage.fail.code });
      return { text: 'words from the laptop', seconds: 1, ms: 300 };
    }
  };
  const server = new RemoteServer({
    root: ROOT, host, sessions, devices, voice: standIn,
    identity: loadIdentity(memoryState()),
    pairing: new PairingWindow(), localKey: new LocalKey('test-key-not-a-secret'),
    report: () => buildReport({ session: only, fleet: [only], env: { vscode: 'test' } })
  });
  await server.start(0);
  const socket = () => `ws://127.0.0.1:${server.port}/socket`;
  const signIn = async (client, device) => {
    const challenge = await client.waitFor('@challenge');
    client.send(await device.answer(challenge, device.id));
    if (device.box) client.seal(device.box);
    return client.waitFor('@welcome');
  };
  // `waitWhere` would hand back an answer that already arrived, so a state is
  // the next one and a recording's answer is the one carrying its id.
  const ask = (client, message, type) => {
    const id = typeof message.id === 'string' ? message.id : '';
    const reply = type === 'voice:state' ? client.next(type, 4000)
      : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer to ' + id)), 4000);
        const hear = (m) => {
          if (!m || (m.type !== type && m.type !== 'voice:no') || m.id !== id) return;
          clearTimeout(timer);
          client.removeListener('message', hear);
          resolve(m);
        };
        client.on('message', hear);
      });
    client.send(message);
    return reply;
  };
  const audio = wav(1).toString('base64');

  const watcher = await makeDevice('A watching phone');
  watcher.id = devices.add({ name: watcher.name, publicKey: watcher.publicKey }).id;
  const watching = await ws.connect(socket());
  await signIn(watching, watcher);

  suite('a device that only watches cannot dictate');

  const watchState = await ask(watching, { type: 'voice:state' }, 'voice:state');
  checkEqual('it is told it only watches', watchState.code, 'WATCH_ONLY');
  checkEqual('and voice is not available to it', watchState.available, false);
  const watchNo = await ask(watching, { type: 'voice', id: 'w1', audio }, 'voice:text');
  checkEqual('a recording from it is refused', watchNo.type, 'voice:no');
  checkEqual('naming the recording', watchNo.id, 'w1');
  checkEqual('as watch only', watchNo.code, 'WATCH_ONLY');
  checkEqual('and nothing is transcribed', stage.heard.length, 0);
  check('the attempt is written down',
    devices.recent(5).some((e) => e.allowed === false && /voice/.test(JSON.stringify(e))));
  watching.close();

  const holder = await makeDevice('A phone with control');
  holder.id = devices.add({ name: holder.name, publicKey: holder.publicKey }).id;
  devices.setControl(holder.id, true);
  const phone = await ws.connect(socket());
  await signIn(phone, holder);

  suite('a device that may send prompts can');

  const state = await ask(phone, { type: 'voice:state' }, 'voice:state');
  check('it is told voice is available', state.type === 'voice:state' && state.available === true);
  checkEqual('with which model', state.model, 'parakeet-tdt-0.6b-v3');
  const text = await ask(phone, { type: 'voice', id: 'r1', audio }, 'voice:text');
  checkEqual('the words come back', text.type, 'voice:text');
  checkEqual('as said', text.text, 'words from the laptop');
  checkEqual('for the recording that asked', text.id, 'r1');
  check('and the laptop heard exactly what was sent', stage.heard[0].equals(wav(1)));
  check('nothing was sent to an instance', !(only.items || []).some((i) => i.kind === 'user'));

  suite('the first time, it builds and says so');

  stage.state = { available: true, building: false, needsBuild: true, model: 'parakeet-tdt-0.6b-v3' };
  const fresh = await ask(phone, { type: 'voice:state' }, 'voice:state');
  check('asking about it says it needs setting up', fresh.needsBuild === true);
  checkEqual('and starts that now', stage.ensured, 1);
  const building = await ask(phone, { type: 'voice', id: 'r2', audio }, 'voice:text');
  checkEqual('a recording meanwhile is told to wait', building.code, 'BUILDING');
  check('and that it is kept', /kept/.test(building.reason));
  checkEqual('naming the recording', building.id, 'r2');
  checkEqual('without being transcribed', stage.heard.length, 1);
  stage.state = { available: false, code: 'NO_MODEL', reason: 'VoiceInk’s model is not downloaded.' };
  const noModel = await ask(phone, { type: 'voice', id: 'r3', audio }, 'voice:text');
  checkEqual('no model is said as no model', noModel.code, 'NO_MODEL');
  stage.state = { available: true, model: 'parakeet-tdt-0.6b-v3' };

  suite('what goes wrong comes back as a reason, not silence');

  stage.fail = { code: 'TIMEOUT', message: 'The laptop took too long to transcribe that.' };
  const slow = await ask(phone, { type: 'voice', id: 'r4', audio }, 'voice:text');
  check('a timeout is said', slow.code === 'TIMEOUT' && /too long/.test(slow.reason));
  delete stage.fail;
  const empty = await ask(phone, { type: 'voice', id: 'r5' }, 'voice:text');
  checkEqual('no audio is said', empty.code, 'NO_AUDIO');
  const huge = await ask(phone, { type: 'voice', id: 'r6', audio: 'A'.repeat(Math.ceil(MAX_BYTES / 3) * 4 + 100) }, 'voice:text');
  checkEqual('too much is refused before it is decoded', huge.code, 'TOO_LONG');
  const odd = await ask(phone, { type: 'voice', id: { not: 'a string' }, audio }, 'voice:text');
  checkEqual('an id that is not a string is dropped, not echoed', odd.id, '');

  suite('and over the conversation’s own socket, which is the one the phone holds when it talks');

  {
    const inside = await ws.connect(socket() + '?session=' + encodeURIComponent(only.id));
    await signIn(inside, holder);
    const s = await ask(inside, { type: 'voice:state' }, 'voice:state');
    checkEqual('the state is answered there too', s.available, true);
    const t = await ask(inside, { type: 'voice', id: 'c1', audio }, 'voice:text');
    checkEqual('and so is a recording', t.text, 'words from the laptop');
    check('without reaching the instance', !(only.items || []).some((i) => i.kind === 'user'));
    stage.state = null;
    const broke = await ask(inside, { type: 'voice', id: 'c2', audio }, 'voice:text');
    check('a laptop that throws still answers', broke.type === 'voice:no' && broke.code === 'FAILED' && broke.id === 'c2');
    stage.state = { available: true, model: 'parakeet-tdt-0.6b-v3' };
    inside.close();
  }

  phone.close();
  await server.stop();

  suite('a window without voice says so');

  {
    const bare = new RemoteServer({
      root: ROOT, host, sessions, devices,
      identity: loadIdentity(memoryState()),
      pairing: new PairingWindow(), localKey: new LocalKey('test-key-not-a-secret'),
      report: () => buildReport({ session: only, fleet: [only], env: { vscode: 'test' } })
    });
    await bare.start(0);
    const c = await ws.connect(`ws://127.0.0.1:${bare.port}/socket`);
    await signIn(c, holder);
    const s = await ask(c, { type: 'voice:state' }, 'voice:state');
    checkEqual('voice is off', s.code, 'OFF');
    const n = await ask(c, { type: 'voice', id: 'x', audio }, 'voice:text');
    checkEqual('and a recording is refused as off', n.code, 'OFF');
    c.close();
    await bare.stop();
  }

  // ---- the real thing, if it is here -----------------------------------------

  suite('the real transcriber, when it has been built on this Mac');

  const real = path.join(ROOT, 'voice', '.build', 'release', 'nikui-voice');
  if (!fs.existsSync(real) || !new Voice({ dir }).modelPresent()) {
    check('skipped: not built here, or no model', true);
  } else {
    const live = new Voice({ binary: real, platform: process.platform, arch: process.arch });
    const s = await live.state();
    check('it says it is ready', s.available === true);
    const quiet = await live.transcribe(wav(1));
    checkEqual('a second of silence is no words', quiet.text.trim(), '');
  }

  fs.rmSync(dir, { recursive: true, force: true });
};

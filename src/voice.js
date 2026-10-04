'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/**
 * Talking to the phone, heard by the laptop.
 *
 * A phone records; the words are worked out here, with the model VoiceInk
 * already keeps on this Mac (Parakeet, run by FluidAudio on the Neural Engine),
 * and go back to the phone's composer for somebody to read before sending.
 * A phone could not do this as well: the model wants memory a phone does not
 * have to spare.
 *
 * Nothing here runs unless it is asked to. The transcriber is a small program,
 * built from voice/ once and kept in NikUI's storage, that is started for one
 * recording and exits when the words are out — the same way VoiceInk does it.
 * The recording is written to a private temporary folder for exactly as long
 * as that takes and removed whatever happened.
 *
 * Nothing here knows about VS Code: where to build and how to run are handed in.
 */

const ROOT = path.join(__dirname, '..');
const PACKAGE = path.join(ROOT, 'voice');
const SOURCES = ['Package.swift', 'Package.resolved', path.join('Sources', 'nikui-voice', 'main.swift')];
const EXECUTABLE = 'nikui-voice';

// Five minutes of 16 kHz mono 16-bit audio, with room for a header. Longer is
// not a message any more, and the socket carries at most 24 MB anyway.
const MAX_SECONDS = 300;
const MAX_BYTES = 44 + MAX_SECONDS * 16000 * 2;

const defaultRun = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, Object.assign({ timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, options),
    (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        killed: !!(err && err.killed),
        stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
});

/**
 * What a WAV file says about itself, or null if it is not one this accepts:
 * 16-bit PCM, mono, which is what the phone records.
 */
function readWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let format = null;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = {
        encoding: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      if (!format) return null;
      const bytes = Math.min(size, buffer.length - body);
      const frame = format.channels * (format.bits / 8);
      return Object.assign(format, { bytes, seconds: frame ? bytes / frame / format.rate : 0 });
    }
    at = body + size + (size % 2);
  }
  return null;
}

class Voice {
  /**
   * @param {object} deps
   * @param {string} deps.dir          where the transcriber is built and kept
   * @param {Function} [deps.run]      (file, args, options) => Promise<{ok, code, stdout, stderr}>
   * @param {string} [deps.platform]
   * @param {string} [deps.arch]
   * @param {() => boolean} [deps.enabled]
   * @param {(line: string) => void} [deps.log]
   * @param {string} [deps.package]    the Swift package to build (tests point elsewhere)
   * @param {string} [deps.binary]     use this program rather than building one
   */
  constructor(deps) {
    const d = deps || {};
    this.dir = d.dir || null;
    this.run = d.run || defaultRun;
    this.platform = d.platform || process.platform;
    this.arch = d.arch || process.arch;
    this.enabled = d.enabled || (() => true);
    this.log = d.log || (() => {});
    this.package = d.package || PACKAGE;
    this.fixed = d.binary || null;
    this.home = this.dir ? path.join(this.dir, 'voice') : null;
    this.building = null;
    this.broken = null;   // why it cannot be built, once that is known
    this.model = null;    // what `check` last said, so it is asked once
    this.queue = Promise.resolve();
  }

  get binary() { return this.fixed || (this.home ? path.join(this.home, EXECUTABLE) : null); }

  /** VoiceInk's Parakeet model is on this Mac — a file check, nothing run. */
  modelPresent() {
    const base = path.join(os.homedir(), 'Library', 'Application Support', 'FluidAudio', 'Models');
    return ['parakeet-tdt-0.6b-v3', 'parakeet-tdt-0.6b-v3-coreml'].some((name) =>
      fs.existsSync(path.join(base, name, 'Encoder.mlmodelc')));
  }

  /** Whether this machine could ever do it — a Mac with Apple silicon. */
  get possible() {
    return this.platform === 'darwin' && this.arch === 'arm64' && (!!this.fixed || !!this.home);
  }

  stamp() {
    const hash = crypto.createHash('sha256');
    for (const file of SOURCES) {
      try { hash.update(fs.readFileSync(path.join(this.package, file))); } catch (_) { hash.update(file); }
    }
    return hash.digest('hex').slice(0, 16);
  }

  isBuilt() {
    if (this.fixed) return fs.existsSync(this.fixed);
    try {
      return fs.readFileSync(path.join(this.home, 'stamp'), 'utf8') === this.stamp() &&
        fs.existsSync(this.binary);
    } catch (_) { return false; }
  }

  /** Build it if it is not built. One build at a time, however many ask. */
  ensure() {
    if (!this.possible || this.broken) return Promise.resolve(false);
    if (this.isBuilt()) return Promise.resolve(true);
    if (!this.building) {
      this.building = this.build()
        .catch((err) => { this.broken = 'could not build the transcriber: ' + (err && err.message); return false; })
        .then((ok) => { this.building = null; return ok; });
    }
    return this.building;
  }

  /**
   * Compiled here, from voice/, rather than shipped as a binary nobody can
   * read. A copy of the package is built so nothing is written into the
   * extension's own folder, and the first build fetches FluidAudio, which
   * takes a few minutes; after that it is only rebuilt when voice/ changes.
   */
  async build() {
    // Every window of the editor has its own copy of this, and they share one
    // place to build in. Whoever takes the lock builds; the rest wait for it.
    fs.mkdirSync(this.home, { recursive: true });
    const lock = path.join(this.home, 'building');
    try {
      fs.mkdirSync(lock);
    } catch (_) {
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch (__) { age = Infinity; }
      if (age < 25 * 60 * 1000) return this.waitForOther(lock);
      fs.rmSync(lock, { recursive: true, force: true });
      return this.build();
    }
    try { return await this.compile(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  }

  async waitForOther(lock) {
    const until = Date.now() + 25 * 60 * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      if (this.isBuilt()) return true;
      if (!fs.existsSync(lock)) return this.isBuilt() || this.build();
    }
    return false;
  }

  async compile() {
    const source = path.join(this.home, 'package');
    const scratch = path.join(this.home, 'build');
    fs.mkdirSync(this.home, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
    for (const file of SOURCES) {
      const from = path.join(this.package, file);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      fs.copyFileSync(from, path.join(source, file));
    }
    this.log('voice: building the transcriber (the first time takes a few minutes)');
    const built = await this.run('/usr/bin/nice', ['-n', '10', '/usr/bin/xcrun', 'swift', 'build',
      '-c', 'release', '--package-path', source, '--scratch-path', scratch], { timeout: 20 * 60 * 1000 });
    if (!built.ok) {
      const said = (built.stderr || built.stdout || '').trim().split('\n').filter((l) => /error/i.test(l)).pop();
      this.broken = 'the transcriber did not build' + (said ? ': ' + said.trim() : '') +
        '. It needs Apple’s command line tools (xcode-select --install) and, the first time, the internet.';
      this.log('voice: ' + this.broken);
      return false;
    }
    const bin = await this.run('/usr/bin/xcrun', ['swift', 'build', '-c', 'release', '--package-path', source,
      '--scratch-path', scratch, '--show-bin-path']);
    const made = path.join(bin.stdout.trim(), EXECUTABLE);
    if (!bin.ok || !fs.existsSync(made)) {
      this.broken = 'the transcriber built but could not be found';
      return false;
    }
    fs.copyFileSync(made, this.binary);
    fs.chmodSync(this.binary, 0o755);
    fs.writeFileSync(path.join(this.home, 'stamp'), this.stamp());
    this.log('voice: built ' + this.binary);
    await this.warm();
    return true;
  }

  /**
   * The first run of a newly built program has the Mac prepare the model for
   * the Neural Engine, which takes half a minute. Done now, with a second of
   * silence, so the first thing somebody says is not the thing that waits.
   */
  async warm() {
    const quiet = Buffer.alloc(44 + 16000 * 2);
    writeHeader(quiet, 16000 * 2);
    try { await this.transcribe(quiet, { warming: true }); } catch (_) { /* best effort */ }
  }

  /**
   * Can it be used, and if not, why. Cheap: builds nothing and starts nothing
   * but the program's own one-line check, once.
   */
  async state() {
    if (!this.enabled()) return { available: false, code: 'OFF', reason: 'Voice is turned off on the laptop.' };
    if (!this.possible) {
      return { available: false, code: 'UNSUPPORTED', reason: 'The laptop needs to be a Mac with Apple silicon.' };
    }
    if (this.broken) return { available: false, code: 'BROKEN', reason: this.broken };
    if (this.building) return { available: true, building: true, model: 'parakeet-tdt-0.6b-v3' };
    if (!this.isBuilt()) return { available: true, building: false, needsBuild: true, model: 'parakeet-tdt-0.6b-v3' };
    if (!this.model) {
      const checked = await this.run(this.binary, ['check'], { timeout: 15000 });
      const said = parse(checked.stdout);
      if (!said) return { available: false, code: 'BROKEN', reason: 'The transcriber did not answer.' };
      // Only a yes is remembered: a model downloaded in VoiceInk later should
      // be noticed without restarting anything.
      if (said.ok) this.model = said;
      else return { available: false, code: said.code || 'NO_MODEL', reason: said.error };
    }
    return { available: true, model: this.model.model };
  }

  /**
   * One recording in, its words out. Recordings are taken one at a time — the
   * Neural Engine does not go faster for being asked twice at once.
   *
   * @param {Buffer} audio  a 16-bit mono WAV
   * @returns {Promise<{text: string, seconds: number, ms: number}>}
   */
  transcribe(audio, options) {
    const job = this.queue.then(() => this.once(audio, options || {}));
    this.queue = job.catch(() => {});
    return job;
  }

  async once(audio, options) {
    if (!options.warming && !this.enabled()) throw voiceError('OFF', 'Voice is turned off on the laptop.');
    if (!Buffer.isBuffer(audio) || !audio.length) throw voiceError('NO_AUDIO', 'Nothing was recorded.');
    if (audio.length > MAX_BYTES) throw voiceError('TOO_LONG', 'That recording is longer than five minutes.');
    const wav = readWav(audio);
    if (!wav || wav.encoding !== 1 || wav.bits !== 16 || wav.channels !== 1 || wav.rate < 8000 || wav.rate > 48000) {
      throw voiceError('BAD_AUDIO', 'That recording is not in a form the laptop can read.');
    }
    if (wav.seconds > MAX_SECONDS + 1) throw voiceError('TOO_LONG', 'That recording is longer than five minutes.');
    if (!options.warming && !(await this.ensure())) {
      throw voiceError('BROKEN', this.broken || 'The transcriber is not available on this Mac.');
    }

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-voice-'));
    const file = path.join(folder, 'said.wav');
    try {
      fs.writeFileSync(file, audio, { mode: 0o600 });
      // Long enough for the slowest first run, and in proportion to the
      // recording after that; never left to hang.
      const timeout = 90000 + Math.ceil(wav.seconds) * 1000;
      const ran = await this.run(this.binary, ['transcribe', file], { timeout });
      const said = parse(ran.stdout);
      if (ran.killed) throw voiceError('TIMEOUT', 'The laptop took too long to transcribe that.');
      if (!said) throw voiceError('FAILED', 'The transcriber did not answer.' + (ran.stderr ? ' ' + ran.stderr.trim().split('\n').pop() : ''));
      if (!said.ok) {
        if (said.code === 'NO_MODEL') this.model = null;
        throw voiceError(said.code || 'FAILED', said.error || 'That could not be transcribed.');
      }
      return { text: String(said.text || ''), seconds: Number(said.seconds) || wav.seconds, ms: Number(said.ms) || 0 };
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
}

function writeHeader(buffer, dataBytes) {
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function parse(text) {
  const line = String(text || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch (_) { return null; }
}

function voiceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { Voice, readWav, writeHeader, MAX_SECONDS, MAX_BYTES };

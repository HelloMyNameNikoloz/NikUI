'use strict';

// The lifetime ledger: what every instance has ever cost, kept on disk so it
// survives the window that recorded it. Real fs and a temp directory for the
// persistence checks, a tiny in-memory fake for the throttling and corruption
// ones where exact timing and a broken file matter more than a real disk.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger } = require('../src/ledger.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-ledger-'));
}

function session(id, extra) {
  return Object.assign({
    id, totalCost: 1, turns: 1, cwd: '/repo/a', label: 'a',
    claudeSessionId: 'sess-' + id,
    usage: { input: 100, output: 200, cacheRead: 300, cacheCreate: 0 }
  }, extra || {});
}

/** An in-memory fs, so the throttle and corruption checks do not depend on real disk timing. */
function fakeFs(initial) {
  const files = new Map(initial || []);
  return {
    files,
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(from, to) {
      if (!files.has(from)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files.set(to, files.get(from));
      files.delete(from);
    },
    mkdirSync() { /* nothing to create in memory */ }
  };
}

module.exports = async function () {
  suite('the ledger merges by the highest seen');

  let now = 1000000;
  const f1 = fakeFs();
  const ledger = new Ledger({ dir: '/fake', fs: f1, now: () => now });

  ledger.record([session('a', { totalCost: 1, turns: 1 })]);
  ledger.record([session('a', { totalCost: 3, turns: 4 })]);
  checkEqual('cost only ever grows', ledger.totals().cost, 3);
  checkEqual('turns only ever grow', ledger.totals().turns, 4);

  ledger.record([session('a', { totalCost: 2, turns: 1 })]);
  checkEqual('a stale window cannot lower the total', ledger.totals().cost, 3);

  suite('zero-cost, zero-turn instances are skipped');

  const f2 = fakeFs();
  const ledger2 = new Ledger({ dir: '/fake', fs: f2, now: () => now });
  ledger2.record([session('empty', { totalCost: 0, turns: 0 })]);
  checkEqual('an instance with nothing to show does not appear', ledger2.totals().instances, 0);

  suite('totals');

  const f3 = fakeFs();
  const ledger3 = new Ledger({ dir: '/fake', fs: f3, now: () => now });
  ledger3.record([
    session('a', { totalCost: 1, turns: 2, cwd: '/repo/one' }),
    session('b', { totalCost: 2, turns: 3, cwd: '/repo/two' }),
    session('c', { totalCost: 0.5, turns: 1, cwd: '/repo/one' })
  ]);
  const totals = ledger3.totals();
  checkEqual('cost sums every instance', totals.cost, 3.5);
  checkEqual('turns sum every instance', totals.turns, 6);
  checkEqual('instances are counted', totals.instances, 3);
  checkEqual('projects are counted distinct by cwd', totals.projects, 2);
  checkEqual('since is the earliest firstAt', totals.since, now);

  suite('throttling disk writes');

  const f4 = fakeFs();
  let clock = 0;
  const ledger4 = new Ledger({ dir: '/fake', fs: f4, now: () => clock });
  ledger4.record([session('a', { totalCost: 1 })]);
  check('the first record writes immediately', f4.files.has('/fake/ledger.json'));

  const afterFirstWrite = f4.files.get('/fake/ledger.json');
  clock = 1000; // under five seconds later
  ledger4.record([session('a', { totalCost: 2 })]);
  checkEqual('a second write inside the window is held back', f4.files.get('/fake/ledger.json'), afterFirstWrite);
  checkEqual('but the in-memory totals already reflect it', ledger4.totals().cost, 2);

  clock = 6000; // past the five-second throttle
  ledger4.record([session('a', { totalCost: 4 })]);
  check('a write past the throttle window lands on disk',
    JSON.parse(f4.files.get('/fake/ledger.json')).instances.a.cost === 4);

  const f5 = fakeFs();
  let clock5 = 0;
  const ledger5 = new Ledger({ dir: '/fake', fs: f5, now: () => clock5 });
  ledger5.record([session('a', { totalCost: 1 })]);
  clock5 = 1000; // still inside the throttle window
  ledger5.record([session('a', { totalCost: 9 })]);
  check('the raised cost has not reached disk yet',
    JSON.parse(f5.files.get('/fake/ledger.json')).instances.a.cost === 1);
  ledger5.flush();
  check('flush forces the pending write out regardless of the throttle',
    JSON.parse(f5.files.get('/fake/ledger.json')).instances.a.cost === 9);

  suite('a corrupt ledger is quarantined, not lost');

  const f6 = fakeFs([['/fake/ledger.json', 'not json at all']]);
  const ledger6 = new Ledger({ dir: '/fake', fs: f6, now: () => now });
  checkEqual('a corrupt file is read as empty', ledger6.totals().instances, 0);
  check('the broken file is kept alongside rather than overwritten blind',
    f6.files.has('/fake/ledger.json.bad'));
  ledger6.record([session('a')]);
  check('a fresh ledger can still be written after quarantining the old one',
    f6.files.has('/fake/ledger.json'));

  suite('persistence across instances of Ledger on the same dir');

  const dir = tmpDir();
  const left = new Ledger({ dir });
  left.record([session('a', { totalCost: 2.5, turns: 3 })]);
  left.flush();

  const right = new Ledger({ dir });
  checkEqual('a second Ledger on the same directory sees what the first wrote', right.totals().cost, 2.5);

  right.record([session('a', { totalCost: 4, turns: 5 })]);
  right.flush();
  const third = new Ledger({ dir });
  checkEqual('the merge by max survives a real reload', third.totals().cost, 4);

  suite('seed');

  const f7 = fakeFs();
  const ledger7 = new Ledger({ dir: '/fake', fs: f7, now: () => now });
  ledger7.seed([session('old', { totalCost: 7, turns: 9 })]);
  checkEqual('seed merges like record and writes immediately', ledger7.totals().cost, 7);
  check('seed flushes without waiting for the throttle', f7.files.has('/fake/ledger.json'));

  suite('record never throws');

  const brokenFs = Object.assign(fakeFs(), {
    readFileSync() { throw new Error('disk is gone'); },
    writeFileSync() { throw new Error('disk is gone'); },
    renameSync() { throw new Error('disk is gone'); },
    mkdirSync() { throw new Error('disk is gone'); }
  });
  const brokenLedger = new Ledger({ dir: '/fake', fs: brokenFs, now: () => now });
  let threw = false;
  try { brokenLedger.record([session('a', { totalCost: 1, turns: 1 })]); } catch (_) { threw = true; }
  check('a broken disk does not throw out of record()', !threw);
};

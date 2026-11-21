'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { disk, faultFs, receipt, intent, stamp, mid, errorCode, deferred } = require('./helpers/engine-disk');

module.exports = async function () {
  suite('T16: serialized append/fsync commits couple state, receipts and full input');
  const d = disk();
  try {
    const reached = deferred(), release = deferred(); let hold = false;
    const store = await d.open({ hook: async (step) => { if (hold && step === 'append:written') { reached.resolve(); await release.promise; } } });
    checkEqual('new authority and writer are private files', [d.file, d.file + '.writer'].map((file) => fs.statSync(file).mode & 0o777), [0o600, 0o600]);
    checkEqual('new authority directory is private', fs.statSync(d.dir).mode & 0o777, 0o700);
    const initial = store.snapshot(), header = JSON.parse(fs.readFileSync(d.file, 'utf8').trim());
    checkEqual('versioned header has a stable engine, scope and sequence', [header.type, header.v, header.state.v, header.seq, header.state.scope], ['header', 1, 1, 0, initial.scope]);
    check('every frame has newline termination and a checksum', fs.readFileSync(d.file).at(-1) === 10 && /^[0-9a-f]{64}$/.test(header.hash));
    const payload = { text: '🧪'.repeat(10000), sent: 'expanded '.repeat(4096), snippets: Array.from({ length: 12 }, (_, i) => ({ name: 's' + i, prompt: 'snippet ' + i })),
      attachments: [{ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }] };
    hold = true; let acknowledged = false, lookedUp = false, secondDone = false;
    const first = store.commit((next) => {
      next.values.counter = 1; next.entries.push(receipt(next, 1, { requestRef: 'outbox:1' })); next.outbox.push(intent(next, 1, payload));
    }).then(() => { acknowledged = true; });
    await reached.promise;
    const lookup = store.lookup({ principal: 'device:fixture', scope: initial.scope, mid: mid(1) }).then((entry) => { lookedUp = true; return entry; });
    const second = store.commit((next) => { next.values.counter++; }).then(() => { secondDone = true; });
    await Promise.resolve(); await Promise.resolve();
    checkEqual('no durable acknowledgment, lookup miss or later commit crosses held fsync', [acknowledged, lookedUp, secondDone, store.snapshot().values.counter], [false, false, false, undefined]);
    hold = false; release.resolve(); await Promise.all([first, second]);
    checkEqual('lookup joins the pending commit instead of returning missing', (await lookup).mid, mid(1));
    checkEqual('the second transition reads the first committed state', store.snapshot().values.counter, 2);
    const coupled = store.snapshot(); await store.close();
    const reopened = await d.open();
    checkEqual('actual disk reopen retains state, receipt and all prompt/image bytes together', reopened.snapshot(), coupled);
    checkEqual('reopen keeps the same authoritative scope', reopened.snapshot().scope, initial.scope);
    const other = await d.open();
    checkEqual('a second writer is diagnostic only', [other.status().writable, other.status().issue.code], [false, 'WRITER_EXISTS']);
    checkEqual('unavailable writer cannot report authoritative missing', await errorCode(() => other.lookup({ principal: 'device:fixture', scope: initial.scope, mid: mid(2) })), 'STORAGE_UNAVAILABLE');
    await other.close();
    let alias;
    await reopened.commit((next) => { alias = next; next.values.counter = 3; }); alias.values.counter = 999;
    checkEqual('transition callbacks retain no mutable alias to committed authority', reopened.snapshot().values.counter, 3);
  } finally { await d.dispose(); }

  suite('T18: bounded physical log automatically compacts and reopens');
  const bounded = disk();
  try {
    const store = await bounded.open({ limits: { maxLogBytes: 2048 } });
    for (let i = 1; i <= 25; i++) await store.commit((next) => { next.values.count = i; });
    check('physical append growth stays within its hard bound', fs.statSync(bounded.file).size <= 2048);
    const final = store.snapshot(); await store.close();
    const reopened = await bounded.open({ limits: { maxLogBytes: 2048 } });
    checkEqual('automatic compaction preserves the latest state and sequence', [reopened.snapshot(), reopened.status().seq], [final, 25]);
  } finally { await bounded.dispose(); }

  suite('T16/T18/T20: scoped append and sync faults never invent success or missing');
  for (const code of ['ENOSPC', 'EROFS', 'EACCES']) {
    const broken = disk(), io = faultFs();
    try {
      const store = await broken.open({ fs: io }), before = fs.readFileSync(broken.file);
      io.arm('writeSync', () => { throw Object.assign(new Error('PRIVATE_SYSCALL_DETAIL'), { code }); });
      checkEqual(code + ' write fault is visible as unavailable', await errorCode(() => store.commit((next) => { next.values.effect = 'new'; })), 'STORAGE_UNAVAILABLE');
      checkEqual(code + ' failure preserves the prior bytes', fs.readFileSync(broken.file).equals(before), true);
      checkEqual(code + ' never publishes the failed transition', store.inspect().state.values.effect, undefined);
      checkEqual(code + ' prevents authoritative missing', await errorCode(() => store.lookup({ principal: 'device:fixture', scope: store.inspect().state.scope, mid: mid(99) })), 'STORAGE_UNAVAILABLE');
      check(code + ' diagnostics redact syscall payloads', !JSON.stringify(store.status()).includes('PRIVATE_SYSCALL_DETAIL'));
      await store.close(); const reopened = await broken.open();
      checkEqual(code + ' retained valid disk prefix reopens conservatively', reopened.snapshot().values.effect, undefined);
    } finally { await broken.dispose(); }
  }
  const sync = disk(), syncIo = faultFs();
  try {
    const store = await sync.open({ fs: syncIo });
    syncIo.arm('fsyncSync', () => { throw Object.assign(new Error('sync denied'), { code: 'EIO' }); });
    checkEqual('fsync failure never acknowledges a complete append', await errorCode(() => store.commit((next) => { next.entries.push(receipt(next, 1)); next.values.effect = 1; })), 'STORAGE_UNAVAILABLE');
    checkEqual('failed fsync leaves in-memory committed state at the previous boundary', store.inspect().state.values.effect, undefined);
    await store.close(); const reopened = await sync.open();
    checkEqual('a possibly durable complete frame is retained on reopen rather than treated as absent', [reopened.snapshot().values.effect, reopened.snapshot().entries.length], [1, 1]);
  } finally { await sync.dispose(); }

  const partial = disk(), partialIo = faultFs();
  try {
    const store = await partial.open({ fs: partialIo });
    await store.commit((next) => { next.values.safe = 1; });
    partialIo.arm('writeSync', (args) => {
      const written = fs.writeSync(args[0], args[1], args[2], 13, args[4]);
      partialIo.arm('writeSync', () => { throw Object.assign(new Error('partial disk full'), { code: 'ENOSPC' }); }); return written;
    });
    checkEqual('a short write followed by ENOSPC fails the whole commit', await errorCode(() => store.commit((next) => { next.values.unsafe = 2; })), 'STORAGE_UNAVAILABLE');
    const torn = fs.readFileSync(partial.file); await store.close();
    const reopened = await partial.open();
    checkEqual('torn tail exposes only a diagnostic committed prefix', [reopened.status().issue.code, reopened.inspect().state.values], ['AUTHORITY_TORN_TAIL', { safe: 1 }]);
    checkEqual('torn-tail lookup cannot authorize resubmission from a missing receipt', await errorCode(() => reopened.lookup({ principal: 'device:fixture', scope: reopened.inspect().state.scope, mid: mid(1) })), 'STORAGE_UNAVAILABLE');
    checkEqual('torn tail is preserved for explicit recovery', fs.readFileSync(partial.file).equals(torn), true);
    checkEqual('torn tail cannot silently commit a replacement', await errorCode(() => reopened.commit((next) => { next.values.unsafe = 3; })), 'STORAGE_UNAVAILABLE');
  } finally { await partial.dispose(); }

  suite('T18/T20: complete corruption, invalid framing and newer schemas refuse without reset');
  for (const kind of ['interior', 'tail', 'newer', 'state-newer', 'sequence', 'empty', 'unframed', 'utf8', 'blank']) {
    const corrupt = disk();
    try {
      const store = await corrupt.open();
      await store.commit((next) => { next.values.a = 1; }); await store.commit((next) => { next.values.a = 2; }); await store.close();
      const lines = fs.readFileSync(corrupt.file, 'utf8').trimEnd().split('\n');
      if (kind === 'interior') lines[1] = lines[1].replace('"a":1', '"a":9');
      if (kind === 'tail') lines[2] = '{bad complete frame}';
      if (kind === 'newer' || kind === 'state-newer' || kind === 'sequence') {
        const row = JSON.parse(lines[kind === 'sequence' ? 1 : 0]);
        if (kind === 'newer') row.v = 2;
        if (kind === 'state-newer') row.state.v = 2;
        if (kind === 'sequence') row.seq += 2;
        delete row.hash; row.hash = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
        lines[kind === 'sequence' ? 1 : 0] = JSON.stringify(row);
      }
      let data = Buffer.from(kind === 'empty' ? '' : lines.join('\n') + (kind === 'unframed' ? '' : '\n'));
      if (kind === 'utf8') data = Buffer.concat([data, Buffer.from([0xff, 0x0a])]);
      if (kind === 'blank') data = Buffer.concat([data, Buffer.from('\n')]);
      fs.writeFileSync(corrupt.file, data);
      const reopened = await corrupt.open();
      checkEqual(kind + ' authority is read-only with a named diagnostic', [reopened.status().writable, !!reopened.status().issue.code], [false, true]);
      checkEqual(kind + ' original bytes remain untouched', fs.readFileSync(corrupt.file).equals(data), true);
      checkEqual(kind + ' cannot become an empty same-scope authority', await errorCode(() => reopened.lookup({ principal: 'device:fixture', scope: '0'.repeat(32), mid: mid(9) })), 'STORAGE_UNAVAILABLE');
    } finally { await corrupt.dispose(); }
  }

  suite('T18: real worker crashes at each atomic compaction boundary');
  for (const step of ['compact:written', 'compact:file-synced', 'compact:renamed', 'compact:directory-synced']) {
    const crashed = disk();
    try {
      const store = await crashed.open();
      await store.commit((next) => {
        next.values.local = { saved: 'coupled' };
        next.entries.push(receipt(next, 1, { phase: 'dispatching', outcome: 'pending', result: null, reservedResultBytes: 16384, requestRef: 'outbox:1' }));
        next.outbox.push(intent(next, 1, { text: 'unresolved input 🧪'.repeat(2000) }, { state: 'unknown' }));
      });
      const before = store.snapshot(); await store.close();
      const worker = cp.spawnSync(process.execPath, [path.join(__dirname, 'fixtures/engine/authority-crash.js'), crashed.file, step],
        { env: { HOME: crashed.dir, TMPDIR: crashed.dir, PATH: '/usr/bin:/bin' }, timeout: 10000, encoding: 'utf8' });
      checkEqual(step + ' worker exits itself at the requested boundary', [worker.status, worker.signal], [73, null]);
      const reopened = await crashed.open();
      checkEqual(step + ' old or new complete authority retains scope, reservation and unresolved payload', reopened.snapshot(), before);
      checkEqual(step + ' stale compaction files cannot accumulate physical log growth', fs.readdirSync(crashed.dir).filter((name) => name.endsWith('.tmp')), []);
      await reopened.commit((next) => { next.values.afterCrash = true; });
      checkEqual(step + ' recovery admits one serialized writer', reopened.snapshot().values.afterCrash, true);
    } finally { await crashed.dispose(); }
  }

  suite('T16/T17 storage boundary: real append crashes retain coupled input and reservation');
  for (const step of ['append:before', 'append:written', 'append:synced']) {
    const crashed = disk();
    try {
      const store = await crashed.open(); const scope = store.snapshot().scope; await store.close();
      const worker = cp.spawnSync(process.execPath, [path.join(__dirname, 'fixtures/engine/authority-crash.js'), crashed.file, step],
        { env: { HOME: crashed.dir, TMPDIR: crashed.dir, PATH: '/usr/bin:/bin' }, timeout: 10000 });
      checkEqual(step + ' append worker exits itself before acknowledgment', worker.status, 73);
      const reopened = await crashed.open(), state = reopened.snapshot();
      checkEqual(step + ' preserves the original scope', state.scope, scope);
      if (step === 'append:before') checkEqual('crash before append retains the prior image', [state.entries.length, state.outbox.length, state.values], [0, 0, {}]);
      else checkEqual(step + ' retains full input, coupled state and reservation instead of an authoritative miss',
        [state.values.unacknowledged, state.entries[0].reservedResultBytes, state.outbox[0].payload],
        [true, 16384, { text: 'full unacknowledged input', sent: 'expanded input', attachments: ['fixture image'] }]);
    } finally { await crashed.dispose(); }
  }

  suite('T20: private paths, read-only files and injected metadata failures');
  for (const kind of ['symlink', 'hardlink', 'permissions', 'foreign', 'stat', 'readonly']) {
    const unsafe = disk(), io = faultFs();
    try {
      const store = await unsafe.open(); await store.close();
      const sentinel = unsafe.dir + '/sentinel'; fs.writeFileSync(sentinel, 'UNCHANGED', { mode: 0o600 });
      if (kind === 'symlink') { fs.unlinkSync(unsafe.file); fs.symlinkSync(sentinel, unsafe.file); }
      if (kind === 'hardlink') { fs.unlinkSync(unsafe.file); fs.linkSync(sentinel, unsafe.file); }
      if (kind === 'permissions') fs.chmodSync(unsafe.file, 0o644);
      if (kind === 'readonly') fs.chmodSync(unsafe.file, 0o400);
      if (kind === 'foreign') io.lstatSync = (file) => { const st = fs.lstatSync(file); if (file === unsafe.file) st.uid++; return st; };
      if (kind === 'stat') io.arm('lstatSync', () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); });
      const reopened = await unsafe.open({ fs: io });
      checkEqual(kind + ' path refuses authoritative writes', reopened.status().writable, false);
      checkEqual(kind + ' refusal preserves the source sentinel', fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED');
    } finally { await unsafe.dispose(); }
  }

  suite('T18: compaction syscall failures preserve a valid old or new authority');
  for (const op of ['writeSync', 'fsyncSync', 'renameSync']) {
    const compact = disk(), io = faultFs();
    try {
      const store = await compact.open({ fs: io }); await store.commit((next) => { next.values.kept = true; });
      const before = store.snapshot();
      io.arm(op, () => { throw Object.assign(new Error('fixture compaction failure'), { code: 'EIO' }); });
      checkEqual(op + ' failure is never reported as successful compaction', await errorCode(() => store.compact()), 'STORAGE_UNAVAILABLE');
      await store.close(); const reopened = await compact.open();
      checkEqual(op + ' failed compaction retains the entire committed image', reopened.snapshot(), before);
    } finally { await compact.dispose(); }
  }
  const directorySync = disk(), directoryIo = faultFs();
  try {
    const store = await directorySync.open({ fs: directoryIo, hook: async (step) => {
      if (step === 'compact:renamed') directoryIo.arm('fsyncSync', () => { throw Object.assign(new Error('directory sync failed'), { code: 'EIO' }); });
    } });
    await store.commit((next) => { next.values.kept = 'after rename'; }); const before = store.snapshot();
    checkEqual('directory fsync failure after rename is still an unacknowledged compaction', await errorCode(() => store.compact()), 'STORAGE_UNAVAILABLE');
    await store.close(); const reopened = await directorySync.open();
    checkEqual('renamed but unacknowledged compaction still retains the complete image on reopen', reopened.snapshot(), before);
  } finally { await directorySync.dispose(); }

  suite('T16/T20: short writes, writer drain and live path failures');
  const drain = disk(), shortIo = faultFs();
  try {
    const store = await drain.open({ fs: shortIo });
    shortIo.arm('writeSync', (args) => fs.writeSync(args[0], args[1], args[2], 7, args[4]));
    const commits = Array.from({ length: 5 }, () => store.commit((next) => { next.values.count = (next.values.count || 0) + 1; }));
    const closed = store.close(); await Promise.all([...commits, closed]);
    checkEqual('close awaits all already admitted commits, including positive short writes', store.inspect().state.values.count, 5);
    checkEqual('a closed writer refuses later work', await errorCode(() => store.commit(() => {})), 'STORAGE_UNAVAILABLE');
    const reopened = await drain.open();
    checkEqual('drained serialized work survives actual reopen', reopened.snapshot().values.count, 5);
    fs.chmodSync(drain.file, 0o400);
    checkEqual('an unavailable live path cannot answer authoritative missing from a cached map', await errorCode(() => reopened.lookup({ principal: 'device:fixture', scope: reopened.inspect().state.scope, mid: mid(9) })), 'STORAGE_UNAVAILABLE');
  } finally { await drain.dispose(); }

  suite('T20: diagnostics never create, lock or repair an authority');
  const diagnostic = disk();
  try {
    const absent = await diagnostic.open({ readOnly: true });
    checkEqual('read-only inspection of a missing log is a named diagnostic', absent.status().issue.code, 'AUTHORITY_MISSING');
    checkEqual('read-only inspection cannot create files or a writer lock', fs.readdirSync(diagnostic.dir), []);
    const store = await diagnostic.open(); await store.commit((next) => { next.values.saved = 'fixture'; });
    const before = fs.readdirSync(diagnostic.dir).sort().map((name) => [name, fs.readFileSync(diagnostic.dir + '/' + name, 'utf8')]);
    const inspector = await diagnostic.open({ readOnly: true });
    checkEqual('read-only diagnostics can inspect a live writer without claiming authority', [inspector.inspect().authoritative, inspector.inspect().state.values], [false, { saved: 'fixture' }]);
    checkEqual('diagnostics cannot acknowledge an authoritative missing result', await errorCode(() => inspector.lookup({ principal: 'device:fixture', scope: inspector.inspect().state.scope, mid: mid(9) })), 'STORAGE_UNAVAILABLE');
    await inspector.close();
    checkEqual('diagnostic inspection preserves every existing byte and writer lock', fs.readdirSync(diagnostic.dir).sort().map((name) => [name, fs.readFileSync(diagnostic.dir + '/' + name, 'utf8')]), before);
  } finally { await diagnostic.dispose(); }

  suite('T18/T20: invalid transitions cannot produce unreopenable JSON frames');
  const invalid = disk();
  try {
    const store = await invalid.open(), before = fs.readFileSync(invalid.file);
    const invalidValues = [undefined, NaN, () => {}, Buffer.from('not JSON'), new Array(2), 1n];
    const cyclic = {}; cyclic.self = cyclic; invalidValues.push(cyclic);
    for (let n = 0; n < invalidValues.length; n++) {
      checkEqual('non-JSON state ' + n + ' is rejected before append', await errorCode(() => store.commit((next) => { next.values.invalid = invalidValues[n]; })), 'AUTHORITY_INVALID');
    }
    checkEqual('invalid transitions neither append bytes nor poison a healthy writer', [fs.readFileSync(invalid.file).equals(before), store.status().writable], [true, true]);
    checkEqual('invalid lookup keys never turn into authoritative missing', await errorCode(() => store.lookup({ principal: '', scope: store.snapshot().scope, mid: 'bad' })), 'AUTHORITY_INVALID');
    await store.commit((next) => { next.values.saved = true; }); await store.close();
    const reopened = await invalid.open(); checkEqual('valid work after validation failures still reopens', reopened.snapshot().values.saved, true);
  } finally { await invalid.dispose(); }
};

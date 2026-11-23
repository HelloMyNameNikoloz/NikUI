'use strict';
require('../../../src/keeperRescue').supervise = require('../../helpers/custody-supervisor').supervise;
// A disposable editor/engine client, killed by the parent at a handoff boundary.
const fs = require('fs'), path = require('path');
const { createProductionKeeper } = require('../../../src/productionKeeper');
const { LegacyKeeper } = require('../../../src/legacyKeeper');
const { DaemonKeeper } = require('../../../src/daemonKeeper');
const { Session } = require('../../../src/session');
const { releaseKeeper } = require('../../../src/keeperContinuity');
const dir = process.argv[2], state = JSON.parse(fs.readFileSync(path.join(dir, 'actor-transfer.json')));
const snapshot = async (pids) => new Map(pids.map((pid) => [pid, JSON.parse(fs.readFileSync(path.join(dir, 'birth-' + pid + '.json')))]));
const values = new Map(), keeper = createProductionKeeper({ root: path.join(dir, 'actor-engine'),
  store: { get: (key, fallback) => values.get(key) || fallback, update: (key, value) => values.set(key, value) },
  factory: (options) => options.legacy ? new LegacyKeeper({ ...options, processSnapshot: snapshot }) : new DaemonKeeper(options),
  sources: [{ files: { keepers: [state.transferred[0].directory] }, keeper: state }] });
const session = new Session({ id: state.transferred[0].key, cwd: state.transferred[0].meta.cwd, maxItems: 0 });
const info = () => ({ pid: session.proc?.pid, runId: session.proc?.runId, text: session.items.filter((i) => ['assistant', 'text'].includes(i.kind)).map((i) => i.text).join('') });
process.on('message', async (command) => {
  if (command === 'release') {
    const next = await releaseKeeper(keeper, [session]);
    fs.writeFileSync(path.join(dir, 'actor-transfer.json'), JSON.stringify(next), { mode: 0o600 });
    await keeper.close(); process.send({ released: true });
  } else if (command === 'state') process.send(info());
  else if (command === 'crash') process.exit(77);
});
keeper.attach(session).then((attached) => { if (attached !== true) throw Error(session.keeperRefusal); process.send({ attached, ...info() }); })
  .catch((error) => { process.stderr.write(error.stack); process.exit(78); });

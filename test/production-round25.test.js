'use strict';
const { portHolders, reviewPort } = require('../src/cutoverPort');
const { chooseFixedPort } = require('../scripts/test-mac-cutover');
const { productionFixture } = require('./helpers/production-cutover');
const { inventory } = require('../src/legacySource');

module.exports = async () => {
  suite('R25 bounded holder discovery and conservative review');
  for (const first of [{ error: { code: 'ETIMEDOUT' }, status: null }, { status: 2 }, { status: 1, stdout: '' }]) {
    let calls = 0, options;
    const holders = portHolders(54321, (_file, _args, config) => {
      options = config;
      return ++calls === 1 ? first : { status: 0, stdout: 'p123\ncCode Helper (Plugin)\n' };
    });
    check('one retry recovers the selected holder after ' + (first.error?.code || 'exit ' + first.status),
      calls === 2 && holders[0]?.pid === 123 && holders[0]?.command === 'Code Helper (Plugin)' && options.timeout === 2000 && options.killSignal === 'SIGKILL');
  }
  let calls = 0;
  checkEqual('two failed lookups retain an unknown holder without inventing a process', portHolders(54321, () => {
    calls++; return { error: { code: 'ETIMEDOUT' }, status: null };
  }), []);
  checkEqual('holder lookup stops after its single retry', calls, 2);
  const unknown = await reviewPort([{ pid: 123, review: { listener: { configuredPort: 54321, port: 54321, listening: true } } }],
    async port => ({ port, available: false, code: 'PORT_IN_USE', holders: [] }));
  check('an unidentified occupied port still blocks Move even when a selected source reports listening', !unknown.ready && !unknown.takeover);

  suite('R25 disposable fixed port selection');
  const candidates = [4517, 0, 65536, 54321, 54322], probes = [];
  const port = await chooseFixedPort(async port => { probes.push(port); return { available: port === 54322 }; }, () => candidates.shift());
  checkEqual('selection skips 4517 and occupied ports without touching their holders', { port, probes }, { port: 54322, probes: [54321, 54322] });
  let attempts = 0, failure;
  try { await chooseFixedPort(async () => { attempts++; return { available: false }; }, () => 54321); } catch (e) { failure = e; }
  check('port selection is bounded and refuses when every candidate is held', attempts === 64 && failure?.message === 'DISPOSABLE_FIXED_PORT_UNAVAILABLE');

  suite('R25 effective source listener configuration');
  const f = await productionFixture();
  try {
    const slot = f.slots[0]; await f.close(slot);
    slot.original.subscriptions = [];
    f.user['remote.port'] = 54321; slot.workspace['remote.port'] = 54322;
    await f.open(slot, { productionAdapters: true });
    const sources = await inventory(f.directory);
    checkEqual('the actual source review uses the workspace override that the extension listener reads', sources[0]?.review.listener.configuredPort, 54322);
    delete slot.workspace['remote.port'];
    checkEqual('review falls back to the global configured value when the override is removed', (await inventory(f.directory))[0]?.review.listener.configuredPort, 54321);
    f.user['remote.port'] = 0;
    checkEqual('effective port zero is preserved instead of replaced with the default', (await inventory(f.directory))[0]?.review.listener.configuredPort, 0);
  } finally { await f.cleanup(); }
};

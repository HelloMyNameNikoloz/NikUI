'use strict';
const fs = require('fs'), path = require('path');
const identity = require('./macBuildIdentity');
const { validatePackage } = require('./macFlavour');
const { fail } = require('./daemonPaths');

async function command(request) {
  const engine = path.resolve(__dirname, '..'), contents = path.resolve(engine, '../..');
  const config = JSON.parse(fs.readFileSync(path.join(engine, 'mac-engine.json'), 'utf8'));
  const accountHome = require('os').userInfo().homedir;
  const root = identity.flavour === 'prod' ? path.join(accountHome, 'Library/Application Support/NikUI/engine') : config.root;
  const selection = validatePackage(identity, config, { accountHome, envHome: process.env.HOME,
    args: ['--root', root], execPath: fs.realpathSync(process.execPath), engine });
  if (selection.flavour !== 'prod' && config.acceptanceCutover !== true) throw fail('DEVELOPMENT_PROFILE_ONLY', 'Only the sealed development rehearsal can drive a test cutover');
  if (!request || !['review', 'forget-return', 'move', 'finish', 'handback-review', 'handback', 'restore', 'cancel'].includes(request.action)) throw fail('CUTOVER_REQUEST_INVALID', 'Unsupported cutover operation');
  let secretAdapter;
  if (!['review', 'forget-return'].includes(request.action)) secretAdapter = require('./keychainStore').createSecItemAdapter({
    helper: path.join(contents, 'Helpers/NikKeychain.app/Contents/MacOS/NikKeychain'),
    home: selection.home, service: config.keychainService });
  const checkpoint = config.acceptanceCutover === true ? async (stage) => {
    const pause = path.join(selection.root, 'mac-cutover-reload-request.json');
    if (stage !== 'barrier' || !fs.existsSync(pause) || fs.existsSync(pause + '.consumed')) return;
    const { atomicJson } = require('./engineOwner'), { readPrivateJson, fail } = require('./daemonPaths');
    const { nonce } = readPrivateJson(pause);
    atomicJson(pause + '.consumed', { nonce }); atomicJson(path.join(selection.root, 'mac-cutover-barrier.json'), { nonce, stage });
    const deadline = Date.now() + 60000, next = path.join(selection.root, 'mac-cutover-continue.json');
    while (Date.now() < deadline) {
      if (fs.existsSync(next) && readPrivateJson(next).nonce === nonce) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw fail('CUTOVER_REHEARSAL_TIMEOUT', 'The disposable editor did not reload at the barrier');
  } : undefined;
  const coordinator = require('./productionCutover').createProductionCutover({ selection, secretAdapter, checkpoint,
    helper: path.join(contents, 'Helpers/NikKeychain.app') });
  return request.action === 'cancel' ? coordinator.canCancelRegistration() : request.action === 'review' ? { ok: true, ...await coordinator.review(request.profile) }
    : request.action === 'forget-return' ? coordinator.forgetReturn(request)
      : request.action === 'move' ? coordinator.move(request) : ['handback', 'restore'].includes(request.action) ? coordinator.restore()
      : request.action === 'handback-review' ? coordinator.handbackReview() : coordinator.finish();
}
if (require.main === module) {
  let bytes = 0, input = '', finished = false, stopWatch = () => {};
  const parent = Number(process.env.NIKUI_CUTOVER_PARENT_PID);
  const end = (value) => {
    if (finished) return; finished = true;
    stopWatch();
    const status = value.ok ? 0 : 1;
    setTimeout(() => process.exit(status), 500).unref();
    process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(status));
  };
  stopWatch = require('./cutoverProgress').monitor({ parent, end });
  process.once('SIGTERM', () => end({ ok: false, code: 'CUTOVER_CANCELLED' }));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => { bytes += Buffer.byteLength(data); if (bytes > 65536) return end({ ok: false, code: 'CUTOVER_REQUEST_INVALID' }); input += data; });
  process.stdin.on('end', async () => {
    try { end(await command(JSON.parse(input))); }
    catch (e) { end({ ok: false, code: /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code || '') ? e.code : 'CUTOVER_UNAVAILABLE',
      ...(e.diagnostics ? { diagnostics: e.diagnostics } : {}) }); }
  });
}
module.exports = { command };

'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { options, IDS, PENDING } = require('../scripts/acceptance-p2');
const { toolArgs, profile, reply, capture } = require('../src/acceptanceTools');
const { createAcceptanceFixture } = require('../src/acceptanceFixture');
const { routeSnapshot } = require('../scripts/acceptance-p2-native');
const { parseLogin, readOnlyCodexLogin } = require('../scripts/acceptance-p2-tools');
module.exports = async () => {
  suite('P2 R5: native/editor/real-tool gates refuse before effects');
  checkEqual('portable is the unconditional default', options([]), { native: false, editor: false, realTools: false, help: false });
  for (const args of [['--editor'], ['--real-tools'], ['--native', '--root', '/Users/live'], ['--native', '--native']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/acceptance-p2.js'), ...args], { encoding: 'utf8' });
    checkEqual(args.join(' ') + ' refuses before native startup', result.status, 1);
    check('refusal has a named gate error', /NATIVE_OPT_IN_REQUIRED|ARGUMENT_INVALID/.test(result.stderr));
  }
  checkEqual('native flags are independent explicit selections', options(['--native', '--editor', '--real-tools']), { native: true, editor: true, realTools: true, help: false });
  assert.throws(() => createAcceptanceFixture({ root: '/unused' }), { code: 'PRODUCTION_CUTOVER_DISABLED' });
  check('fixtures cannot silently enable a production owner', true);
  suite('P2 R5: real-tool plans retain fresh read-only login boundaries');
  for (const provider of ['claude', 'codex']) {
    const args = toolArgs(provider, '/private/test/project');
    check(provider + ' has no resume, continue, attach or login argument', !args.some((a) => /^(?:--resume|--continue|resume|attach|login|logout|--dangerously)/.test(a)));
    check(provider + ' uses the one tiny response prompt', args.some((a) => a.includes('NIK_P2_OK')));
    check(provider + ' disables persisted conversation state', args.includes(provider === 'claude' ? '--no-session-persistence' : '--ephemeral'));
  }
  const policy = profile('/private/test/scratch', '/Users/test-account');
  check('outer sandbox protects both credential snapshots from refresh writes', policy.includes('codex-home/auth.json') && policy.includes('claude-token') && policy.includes('(deny file-write*'));
  check('live provider homes and Unix daemon endpoints are excluded', ['.claude', '.codex', '.codex-work', 'remote unix-socket'].every((s) => policy.includes(s)));
  checkEqual('an echoed prompt cannot count as a real Claude response', reply('claude', JSON.stringify({ type: 'result', is_error: true, prompt: 'NIK_P2_OK' })), false);
  checkEqual('Claude requires a successful typed final result', reply('claude', JSON.stringify({ type: 'result', is_error: false, result: 'NIK_P2_OK' })), true);
  checkEqual('Codex requires a completed agent item and completed turn', reply('codex', '{"type":"item.completed","item":{"type":"agent_message","text":"NIK_P2_OK"}}\n{"type":"turn.completed"}'), true);
  checkEqual('Codex prompt echo without completed agent/turn cannot pass', reply('codex', '{"type":"thread.started","prompt":"NIK_P2_OK"}'), false);
  try { parseLogin('synthetic-private-token-bad-json'); check('corrupt login must refuse', false); }
  catch (error) { check('corrupt login diagnostics never reflect credential bytes', error.code === 'EXISTING_LOGIN_CORRUPT' && !error.message.includes('synthetic-private-token')); }
  const credential = readOnlyCodexLogin(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'current-access', id_token: 'current-id', refresh_token: 'live-rotation-secret', account_id: 'test' }, unexpected: 'not-copied' }));
  check('read-only login strips refresh authority and unknown fields before a CLI can run',
    credential.tokens.access_token === 'current-access' && credential.tokens.refresh_token === '' && !JSON.stringify(credential).includes('live-rotation-secret') && !Object.hasOwn(credential, 'unexpected'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-cancel-test-')), abort = new AbortController();
  try {
    const pending = capture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { HOME: temporary, PATH: '/usr/bin:/bin' }, temporary, 5000, abort.signal);
    const timer = setTimeout(() => abort.abort(), 80);
    const cancelled = await pending; clearTimeout(timer);
    check('cancellation reaps only the newly created fixture process group', cancelled.cancelled && cancelled.signal === 'SIGTERM');
    await assert.rejects(capture('/must-not-launch', [], {}, temporary, 100, abort.signal), { code: 'REAL_TOOLS_CANCELLED' });
    check('a pre-cancelled probe cannot spawn a process', true);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  let command;
  const route = routeSnapshot('/fixture/tailscale', (file, args) => { command = [file, args]; return { status: 0, stdout: '{"Web":{},"TCP":{}}' }; });
  checkEqual('native route probe has only a status operation', command, ['/fixture/tailscale', ['serve', 'status', '--json']]);
  check('route evidence contains a digest and no network configuration', route.status === 'observed' && /^[a-f0-9]{64}$/.test(route.sha256) && !JSON.stringify(route).includes('TCP'));
  suite('P2 R5: complete portable rehearsal, real sockets and disk, no native effects');
  const output = execFileSync(process.execPath, [path.join(__dirname, '../scripts/acceptance-p2.js')], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NIKUI_NATIVE_TESTS: '0' } });
  const summary = JSON.parse(output.trim()), report = JSON.parse(fs.readFileSync(summary.evidence, 'utf8'));
  checkEqual('portable script succeeds without attempting native gates', [summary.ok, summary.native], [true, PENDING]);
  checkEqual('all 22 A/T rows have explicit evidence/manual/native status', Object.keys(report.items), IDS);
  check('every protocol scenario passed including a fresh disk restart', report.scenarios.checks.length >= 10 && report.scenarios.checks.every((c) => c.status === 'passed'));
  const proof = (name) => report.scenarios.checks.find((c) => c.name === name).proof;
  checkEqual('lost ack recovers the original receipt with one provider effect', [proof('lost-ack-reconnect-one-effect').effects, proof('lost-ack-reconnect-one-effect').receipt], [1, 'duplicate']);
  checkEqual('pre-write disconnect produces one identical-mid resend and no old-channel write', [proof('disconnect-before-write-identical-mid-resend').effects, proof('disconnect-before-write-identical-mid-resend').oldChannelWrites], [1, 0]);
  const resend = proof('disconnect-before-write-identical-mid-resend');
  checkEqual('portable uses a separate daemon and the package selected-store interface',
    [proof('same-run-menu-and-two-phones').separateDaemonProcess, proof('same-run-menu-and-two-phones').selectedSecretBackend], [true, 'portable-selected-store']);
  checkEqual('sealed-before-welcome ordering is exercised and refuses a premature send',
    [resend.preNegotiationRefused, resend.readinessWaitBlocked, resend.preNegotiation.sealed, resend.preNegotiation.proto, resend.preNegotiation.ready,
      resend.preNegotiation.allowed, resend.preNegotiation.seat.control, resend.preNegotiation.outbox.state], [true, true, true, null, false, false, true, 'absent']);
  checkEqual('persisted send waits for v2 and a controlling seat on a fresh wrapped box',
    [resend.beforeDisconnect.proto, resend.beforeDisconnect.ready, resend.beforeDisconnect.allowed, resend.beforeDisconnect.seat.control,
      resend.beforeDisconnect.outbox.state, resend.beforeDisconnect.trace.factories, resend.beforeDisconnect.trace.boxes], [2, true, true, true, 'pending', 1, 1]);
  checkEqual('portable and package advertise and negotiate the same v2 protocol',
    [resend.beforeDisconnect.trace.advertisement.proto, resend.beforeDisconnect.trace.welcome.proto], [{ min: 1, max: 2 }, 2]);
  check('failure diagnostics retain record metadata without plaintext or cryptographic material',
    !/P2 synthetic|expanded resend|privateKey|signature|ciphertext/.test(JSON.stringify(resend.beforeDisconnect)));
  checkEqual('fresh handback carries new work and fences the old writer', [proof('fresh-current-handback-with-post-cutover-work').generations,
    proof('fresh-current-handback-with-post-cutover-work').postCutoverCost, proof('fresh-current-handback-with-post-cutover-work').oldWriterCode], [[0, 1, 2], 3, 'WRITER_FENCED']);
  checkEqual('transfer accounts and every scenario client are cleaned', [proof('fresh-current-handback-with-post-cutover-work').cleanup, report.scenarios.cleanup.clientsClosed], [true, true]);
  check('portable selected-store transfer is never mislabeled native', proof('fresh-current-handback-with-post-cutover-work').mode.startsWith('portable /'));
  check('APNs and push are explicitly unconfigured rather than green', report.scenarios.delivery.apns === 'unconfigured/unrun' && report.scenarios.delivery.webPush === 'unconfigured/unrun');
  checkEqual('reboot/login/power remain pending independent acceptance', [report.items.A11.native, report.items.T71.native, report.items.T72.native], [PENDING, PENDING, PENDING]);
  suite('P2 R10b: resend failure preserves its actual cause and outbox diagnostics');
  const refusal = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers/acceptance-resend-failure.js')], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, NIKUI_NATIVE_TESTS: '0', NIKUI_SIGNED_TEST_ROOT: '' }
  }));
  checkEqual('a refused send fails immediately with a named cause',
    [refusal.error.code, refusal.error.diagnostics.cause, refusal.error.diagnostics.stage], ['RESEND_SEND_REFUSED', 'SEND_REFUSED', 'persist-and-hold-send']);
  checkEqual('diagnostics distinguish refusal from protocol, control, persistence or wrapper failure',
    [refusal.error.diagnostics.proto, refusal.error.diagnostics.seat.control, refusal.error.diagnostics.allowed,
      refusal.error.diagnostics.postResult, refusal.error.diagnostics.outbox.state, refusal.error.diagnostics.trace.factories], [2, true, true, false, 'absent', 1]);
  check('human-readable failure identifies the protocol, seat and absent outbox record',
    /cause=SEND_REFUSED.*proto=2.*seat.control=true.*outbox=absent/.test(refusal.error.message));
  checkEqual('scenario and top-level evidence retain the same failure diagnostics',
    [refusal.failure, refusal.check.code, refusal.check.diagnostics], [refusal.error, refusal.error.code, refusal.error.diagnostics]);
  checkEqual('failed resend closes its clients and reaps the separate daemon', refusal.cleanup, { clientsClosed: true, failures: [] });
};

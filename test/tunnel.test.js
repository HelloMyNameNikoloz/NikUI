'use strict';
const { EventEmitter } = require('events');
const { Tailscale, Cloudflared, matchesDomain } = require('../src/tunnel.js');

/** A tailnet made of canned answers, so none of this needs one. */
function fake(answers, options) {
  const calls = [];
  const tailscale = new Tailscale(Object.assign({
    places: ['/fake/tailscale'],
    exists: (file) => file === '/fake/tailscale',
    // No tailnet here, so nothing is knocked on.
    probe: () => Promise.resolve(true),
    run: (argv) => {
      calls.push(argv.slice(1).join(' '));
      const key = Object.keys(answers).find((prefix) => argv.slice(1).join(' ').startsWith(prefix));
      return Promise.resolve(answers[key] || { code: 1, stdout: '', stderr: 'unexpected: ' + argv.join(' ') });
    }
  }, options || {}));
  return { tailscale, calls };
}

const running = (extra) => ({
  code: 0,
  stdout: JSON.stringify(Object.assign({
    BackendState: 'Running',
    MagicDNSSuffix: 'tail1234.ts.net',
    CertDomains: ['laptop.tail1234.ts.net'],
    Self: { DNSName: 'laptop.tail1234.ts.net.', HostName: 'laptop', Online: true }
  }, extra || {})),
  stderr: ''
});

module.exports = async function () {
  suite('finding it');

  const missing = new Tailscale({ places: ['/nowhere/tailscale'], exists: () => false });
  checkEqual('a machine without it says so', (await missing.status()).installed, false);
  check('and says what to do about it', /not installed/.test((await missing.status()).reason));
  checkEqual('exposing anything is refused', (await missing.expose(4517)).ok, false);

  const found = new Tailscale({
    places: ['/no', '/yes'],
    exists: (file) => file === '/yes',
    run: () => Promise.resolve({ code: 0, stdout: '{}', stderr: '' })
  });
  checkEqual('the first one that exists is the one used', found.find(), '/yes');

  suite('what the mesh says');

  const live = fake({ 'status --json': running() });
  const state = await live.tailscale.status();
  checkEqual('a machine on the tailnet is running', state.running, true);
  checkEqual('with a name to be reached by', state.name, 'laptop.tail1234.ts.net');
  checkEqual('the trailing dot is not part of it', state.name.endsWith('.'), false);
  checkEqual('the tailnet is named too', state.tailnet, 'tail1234.ts.net');
  checkEqual('and it can get a certificate', state.https, true);
  checkEqual('so there is nothing to explain', state.reason, null);
  checkEqual('it asked the question in JSON', live.calls[0], 'status --json');

  const wildcard = fake({ 'status --json': running({ CertDomains: ['*.tail1234.ts.net'] }) });
  checkEqual('a wildcard certificate counts', (await wildcard.tailscale.status()).https, true);

  const noCerts = fake({ 'status --json': running({ CertDomains: [] }) });
  const bare = await noCerts.tailscale.status();
  checkEqual('without one, https is off', bare.https, false);
  check('and the reason names the setting', /HTTPS certificates/i.test(bare.reason));

  const loggedOut = fake({ 'status --json': { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' } });
  const out = await loggedOut.tailscale.status();
  checkEqual('a machine that is not logged in is not running', out.running, false);
  check('and is told so plainly', /not logged in/.test(out.reason));

  const silent = fake({ 'status --json': { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' } });
  const quiet = await silent.tailscale.status();
  checkEqual('a daemon that will not answer is not running', quiet.running, false);
  checkEqual('and its own words are passed on', quiet.reason, 'failed to connect to local tailscaled');

  const garbled = fake({ 'status --json': { code: 0, stdout: 'not json at all', stderr: '' } });
  checkEqual('nonsense is survived', (await garbled.tailscale.status()).running, false);

  suite('putting the tailnet in front of it');

  const serving = fake({ 'status --json': running(), 'serve': { code: 0, stdout: '', stderr: '' } });
  const exposed = await serving.tailscale.expose(4517);
  checkEqual('it works', exposed.ok, true);
  checkEqual('on the name the mesh gave this machine', exposed.host, 'laptop.tail1234.ts.net');
  checkEqual('over https, which is the whole point', exposed.url, 'https://laptop.tail1234.ts.net/');
  checkEqual('and it forwards to loopback, not to anything else',
    serving.calls[1], 'serve --bg --https=443 http://127.0.0.1:4517');

  const noHttps = fake({ 'status --json': running({ CertDomains: [] }) });
  const refused = await noHttps.tailscale.expose(4517);
  checkEqual('without a certificate it will not pretend', refused.ok, false);
  check('and explains why that matters here',
    /device key|HTTPS certificates/i.test(refused.reason));
  checkEqual('nothing was asked of the daemon', noHttps.calls.length, 1);

  const grumpy = fake({
    'status --json': running(),
    'serve': { code: 1, stdout: '', stderr: 'serve: HTTPS is not enabled on your tailnet\nrun: tailscale cert' }
  });
  const failed = await grumpy.tailscale.expose(4517);
  checkEqual('a refusal from the daemon is a refusal here', failed.ok, false);
  checkEqual('with its own first line, not ours', failed.reason, 'serve: HTTPS is not enabled on your tailnet');

  suite('taking it down again');

  // Warming is part of exposing: the first request to a new name mints its
  // certificate, and paying for that inside the command is the difference
  // between a phone seeing a page and a phone seeing "cannot reach the laptop".
  const knocks = [];
  const warming = fake({ 'status --json': running(), 'serve': { code: 0, stdout: '', stderr: '' } },
    { probe: (url) => { knocks.push(url); return Promise.resolve(knocks.length > 1); } });
  await warming.tailscale.expose(4517);
  check('the door is knocked on before anyone is told it is open', knocks.length >= 1);
  checkEqual('at the address a client would use', knocks[0],
    'https://laptop.tail1234.ts.net/health');
  check('and more than once, since the first may be too early', knocks.length >= 2);

  const cold = fake({ 'status --json': running(), 'serve': { code: 0, stdout: '', stderr: '' } },
    { probe: () => Promise.resolve(false) });
  const anyway = await cold.tailscale.expose(4517);
  checkEqual('a name that never answers is still exposed, not called a failure', anyway.ok, true);

  const stopping = fake({ 'serve --https=443 off': { code: 0, stdout: '', stderr: '' } });
  checkEqual('it stops', (await stopping.tailscale.hide()).ok, true);
  checkEqual('by turning off exactly what was turned on',
    stopping.calls[0], 'serve --https=443 off');

  const stuck = fake({ 'serve --https=443 off': { code: 1, stdout: '', stderr: 'no such serve config' } });
  checkEqual('and says so when it cannot', (await stuck.tailscale.hide()).ok, false);

  const already = fake({ 'serve status --json': { code: 0, stdout: JSON.stringify({ Web: { 'laptop:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4517' } } } } }), stderr: '' } });
  checkEqual('a forward left over from a previous window is noticed',
    await already.tailscale.serving(4517), true);
  checkEqual('and one for another port is not', await already.tailscale.serving(9999), false);

  // The reason that question is worth asking: a window that does not ask
  // refuses its own tailnet name with a 403, and hands out a pairing code that
  // names 127.0.0.1 — which fails on a phone as "failed to fetch".
  const { RemoteServer } = require('../src/remote.js');
  const orphaned = new RemoteServer({
    root: require('path').join(__dirname, '..'),
    host: { config: () => ({ promptSnippets: {} }), home: '/tmp', knownCommands: () => [],
      fleet: () => [], env: () => ({}) },
    sessions: { list: () => [], get: () => null }
  });
  await orphaned.start(0);
  check('a window that has not been told its name answers to loopback only',
    orphaned.exposed === false &&
    orphaned.hosts().every((h) => /^(127\.0\.0\.1|localhost|\[?::1\]?)(:|$)/.test(h)));
  orphaned.publicHost = 'laptop.tailnet.ts.net';
  check('and once it has been, it answers to that too',
    orphaned.exposed === true && orphaned.hosts().includes('laptop.tailnet.ts.net'));
  await orphaned.dispose();

  suite('the other way out');

  // cloudflared is a process that talks rather than a command that answers, so
  // this is one of those: it says where it is on its way up, and that line is
  // the only record a quick tunnel leaves.
  function fakeCloudflared(script) {
    const started = [];
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { proc.killed = true; };
    const tunnel = new Cloudflared({
      places: ['/fake/cloudflared'],
      exists: (file) => file === '/fake/cloudflared',
      spawn: (binary, args) => { started.push([binary].concat(args).join(' ')); setTimeout(() => script(proc), 0); return proc; }
    });
    return { tunnel, started, proc };
  }

  const missingBinary = new Cloudflared({ places: ['/nowhere'], exists: () => false });
  const refusedOutright = await missingBinary.expose(4517);
  checkEqual('without cloudflared it says so', refusedOutright.ok, false);
  check('and points at the better path first', /Tailscale is the better path/.test(refusedOutright.reason));

  const quick = fakeCloudflared((proc) => {
    proc.stderr.emit('data', 'INF |  https://brave-mountain-1234.trycloudflare.com  |');
  });
  const open = await quick.tunnel.expose(4517);
  checkEqual('a quick tunnel reports where it is', open.ok, true);
  checkEqual('by the hostname it was given', open.host, 'brave-mountain-1234.trycloudflare.com');
  checkEqual('over https, since a device cannot hold a key without it',
    open.url, 'https://brave-mountain-1234.trycloudflare.com/');
  checkEqual('and it forwards to loopback, like everything else here',
    quick.started[0], '/fake/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4517');
  check('it is running', quick.tunnel.running);
  await quick.tunnel.hide();
  checkEqual('closing it kills the process', quick.proc.killed, true);
  checkEqual('and nothing is left claiming to be open', quick.tunnel.running, false);

  const dies = fakeCloudflared((proc) => proc.emit('exit', 1));
  const fellOver = await dies.tunnel.expose(4517);
  checkEqual('a tunnel that falls over is a refusal, not a hang', fellOver.ok, false);
  check('with the code it went out on', /code 1/.test(fellOver.reason));

  const mute = fakeCloudflared(() => { /* says nothing at all */ });
  const gaveUp = await mute.tunnel.expose(4517, { timeoutMs: 40 });
  checkEqual('one that never says where it is gives up', gaveUp.ok, false);
  check('rather than waiting forever', /did not say where it was/.test(gaveUp.reason));

  suite('which names a certificate covers');

  check('an exact match', matchesDomain('laptop.tail1.ts.net', 'laptop.tail1.ts.net'));
  check('a wildcard over the tailnet', matchesDomain('*.tail1.ts.net', 'laptop.tail1.ts.net'));
  check('but not over another one', !matchesDomain('*.tail2.ts.net', 'laptop.tail1.ts.net'));
  check('and nothing matches nothing', !matchesDomain('', 'laptop.tail1.ts.net'));
};

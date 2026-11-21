#!/usr/bin/env node
'use strict';

// Development-only P1 executable. Requiring this module starts nothing.
const { fail } = require('./daemonPaths');

function parseArgs(args) {
  const options = { port: 0, command: 'start' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root' && !options.root) options.root = args[++i];
    else if (arg === '--port') options.port = Number(args[++i]);
    else if (['start', 'status', 'doctor', 'enroll'].includes(arg) && options.command === 'start') options.command = arg;
    else throw fail('ARGUMENT_INVALID', 'Usage: node src/nikd.js --root /short/private/root [start|status|doctor|enroll] [--port 0]');
  }
  if (!options.root) throw fail('ROOT_REQUIRED', 'An explicit private --root is required; there is no HOME default');
  return options;
}

async function main(args = process.argv.slice(2), { adapters = {} } = {}) {
  const options = parseArgs(args);
  if (options.command !== 'start') {
    const { privateRoot } = require('./daemonPaths');
    const { controlRequest } = require('./daemonControl');
    const paths = privateRoot(options.root, { create: false });
    let reply;
    try { reply = await controlRequest(paths, { op: options.command, kind: 'local' }); }
    catch (err) {
      if (options.command !== 'doctor') throw err;
      reply = await require('./daemonLock').diagnoseRoot(paths);
    }
    process.stdout.write(JSON.stringify(reply) + '\n');
    if (!reply.ok) process.exitCode = 1;
    return;
  }
  process.umask(0o077);
  const { startDaemon } = require('./daemonRuntime');
  let daemon, stopping = false;
  const deadline = (code) => setTimeout(() => {
    process.stderr.write(JSON.stringify({ ok: false, code,
      lifecycle: daemon ? daemon.lifecycle() : { phase: 'starting', stage: 'composition' } }) + '\n');
    process.exit(1);
  }, 3000);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = deadline('DRAIN_TIMEOUT');
    try { if (daemon) await daemon.stop(); process.exitCode = 0; }
    catch (_) { process.stderr.write(JSON.stringify({ ok: false, code: 'DRAIN_FAILED' }) + '\n'); process.exitCode = 1; }
    finally { clearTimeout(timeout); }
  };
  // Install before asynchronous startup; a SIGTERM during tool lookup still
  // drains after construction rather than leaving a partially owned root.
  let requested = false;
  const terminated = () => { requested = true; if (daemon) void stop(); };
  process.on('SIGTERM', terminated);
  process.on('SIGINT', terminated);
  const crash = async () => {
    process.stderr.write(JSON.stringify({ ok: false, code: 'DAEMON_CRASH' }) + '\n');
    const timeout = deadline('CRASH_DRAIN_TIMEOUT');
    try { if (daemon) await daemon.stop(); } catch (_) { /* retain ownership fence */ }
    clearTimeout(timeout);
    process.exit(1);
  };
  process.once('uncaughtException', crash);
  process.once('unhandledRejection', crash);
  daemon = await startDaemon({ ...options, adapters });
  if (requested) return stop();
  process.stdout.write(JSON.stringify(daemon.status()) + '\n');
  return daemon;
}

if (require.main === module) main().catch((err) => {
  // Whitelist diagnostics: never reflect a secret-bearing path, config value,
  // shell output, incoming request, provider error or stack into logs.
  const codes = new Set(['ROOT_REQUIRED', 'FORBIDDEN_ROOT', 'SOCKET_PATH_TOO_LONG', 'UNSAFE_PATH', 'UNSAFE_DIRECTORY', 'UNSAFE_FILE',
    'OWNER_EXISTS', 'OWNER_UNAVAILABLE', 'OWNER_UNPROVEN', 'CONFIG_INVALID', 'CONFIG_SCOPE', 'CONFIG_PROVENANCE',
    'STORE_UNAVAILABLE', 'AUTHORITY_UNAVAILABLE', 'KEEPER_MANIFEST_INVALID', 'IDENTITY_UNAVAILABLE', 'PORT_INVALID', 'ARGUMENT_INVALID']);
  const code = codes.has(err.code) ? err.code : 'DAEMON_UNAVAILABLE';
  const hints = { ROOT_REQUIRED: 'Pass --root with a short absolute private fixture directory.',
    SOCKET_PATH_TOO_LONG: 'Control socket path must be under 104 bytes; choose a shorter --root.',
    OWNER_EXISTS: 'A daemon already owns this root; use its private control socket.',
    OWNER_UNAVAILABLE: 'The root owner is alive or unavailable; no takeover was attempted.',
    OWNER_UNPROVEN: 'Ownership could not be proved stale; inspect the private fixture lock and endpoint.' };
  process.stderr.write(JSON.stringify({ ok: false, code, hint: hints[code] || 'Check the private root permissions and configuration with doctor.' }) + '\n');
  process.exitCode = 1;
});

module.exports = { main, parseArgs };

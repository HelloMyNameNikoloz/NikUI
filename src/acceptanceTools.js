'use strict';

// Native-only, fresh CLI invocations. This is independent of the engine's
// provider graph: there is no attach/resume/daemon-discovery code path.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const { privateDirectory, readPrivateJson, noSymlinks, fail } = require('./daemonPaths');
const PROMPT = 'Reply with exactly NIK_P2_OK. Do not use any tools.';
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = (text) => '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function toolArgs(provider, project) {
  if (provider === 'claude') return ['-p', PROMPT, '--output-format', 'json', '--no-session-persistence', '--max-turns', '1',
    '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''];
  if (provider === 'codex') return ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
    '-c', 'cli_auth_credentials_store="file"', '--cd', project, PROMPT];
  throw fail('REAL_TOOL_INVALID', 'Unknown provider');
}
function profile(scratch, liveHome) {
  return ['(version 1)', '(deny default)', '(allow file-read* sysctl-read)',
    '(allow process-info* (target same-sandbox))', '(allow signal (target same-sandbox))',
    '(allow process-exec process-fork)', '(allow mach-lookup)',
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.secd"))',
    '(allow network-outbound (remote tcp "*:443") (remote udp "*:53") (remote tcp "*:53"))',
    '(deny network-outbound (remote ip "localhost:*"))',
    '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
    `(allow file-write* (subpath ${quote(scratch)}) (literal "/dev/null") (literal "/dev/urandom"))`,
    `(deny file-write* (literal ${quote(path.join(scratch, 'codex-home/auth.json'))}) (literal ${quote(path.join(scratch, 'claude-token'))}))`,
    ...['.claude', '.codex', '.codex-work'].map((p) => `(deny file-read* (subpath ${quote(path.join(liveHome, p))}))`),
    '(deny network-outbound (remote unix-socket))', ''].join('\n');
}
async function capture(file, args, env, cwd, timeout = 90000, signal) {
  if (signal?.aborted) throw fail('REAL_TOOLS_CANCELLED', 'Test CLI cancelled before launch');
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', expired = false, oversized = false, killTimer, stopping = false, cancelled = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { /* exact new group already gone */ }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }, 5000); killTimer.unref();
    };
    const abort = () => { cancelled = true; stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    const take = (which, chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 2 * 1024 * 1024) { oversized = true; stop(); return; }
      if (which === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', (c) => take('stdout', c)); child.stderr.on('data', (c) => take('stderr', c));
    const timer = setTimeout(() => { expired = true; stop(); }, timeout);
    child.once('error', (e) => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); reject(e); });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      resolve({ code, signal: exitSignal, stdout, stderr, expired, oversized, cancelled });
    });
  });
}
function reply(provider, stdout) {
  try {
    if (provider === 'claude') {
      const result = JSON.parse(stdout);
      return result.type === 'result' && result.is_error !== true && result.result?.trim() === 'NIK_P2_OK';
    }
    const events = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    return events.some((e) => e.type === 'turn.completed') && events.some((e) => e.type === 'item.completed' &&
      e.item?.type === 'agent_message' && e.item.text?.trim() === 'NIK_P2_OK');
  } catch (_) { return false; }
}
function refusal(result) {
  if (result.cancelled) return 'REAL_TOOLS_CANCELLED';
  if (result.expired) return 'TOOL_TIMEOUT';
  if (result.oversized) return 'TOOL_OUTPUT_LIMIT';
  const text = result.stderr + '\n' + result.stdout;
  if (/refresh.{0,40}(?:token|auth)|(?:token|auth).{0,40}refresh/i.test(text)) return 'AUTH_REFRESH_REFUSED';
  if (/log.?in|authenticat|unauthori[sz]ed|\b401\b|expired.{0,20}token/i.test(text)) return 'EXISTING_LOGIN_UNAVAILABLE';
  if (/untrusted|trust.{0,40}(?:project|directory|folder)/i.test(text)) return 'PROJECT_TRUST_REQUIRED';
  if (/TCC|permission denied|operation not permitted/i.test(text)) return 'PERMISSION_OR_SANDBOX_DENIED';
  if (result.code !== 0) return 'TOOL_EXECUTION_FAILED';
  return 'TOOL_RESPONSE_INVALID';
}
async function runTools({ root, tools, liveHome, signal }) {
  if (process.platform !== 'darwin') throw fail('NATIVE_REQUIRED', 'Native tool rehearsal only');
  const active = () => { if (signal?.aborted) throw fail('REAL_TOOLS_CANCELLED', 'Fresh test CLI rehearsal cancelled'); };
  active();
  const scratch = path.join(root, 'home/p2-real-tools'); privateDirectory(scratch, false);
  const request = readPrivateJson(path.join(scratch, 'request.json'));
  if (request.version !== 1 || request.optIn !== '--real-tools' || request.liveHome !== liveHome) throw fail('REAL_TOOL_OPT_IN_REQUIRED', 'Explicit test selection required');
  const project = path.join(scratch, 'project'); privateDirectory(project, false);
  const policy = path.join(scratch, 'sandbox.sb'); fs.writeFileSync(policy, profile(scratch, liveHome), { mode: 0o600 });
  const result = { version: 1, status: 'passed', project, identity: 'signed launchd child; sandboxed fresh CLI', providers: {}, prompts: 0 };
  // Verify the outer write boundary before either provider can run. The probe
  // attempts a fresh sibling path; it never writes an existing user file.
  const forbidden = path.join(root, 'p2-forbidden-write');
  const baseEnv = { HOME: scratch, USERPROFILE: scratch, ZDOTDIR: scratch, TMPDIR: path.join(scratch, 'tmp'),
    PATH: path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', CODEX_HOME: path.join(scratch, 'codex-home'),
    CLAUDE_CONFIG_DIR: path.join(scratch, 'claude-home'), LANG: 'en_US.UTF-8', CI: '1', NO_COLOR: '1' };
  const probe = await capture('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, '-e',
    'try{require("fs").writeFileSync(process.argv[1],"forbidden");process.exit(2)}catch(e){process.exit(e.code==="EPERM"||e.code==="EACCES"?0:3)}', forbidden], baseEnv, project, 10000, signal);
  active();
  if (probe.code !== 0 || fs.existsSync(forbidden)) throw fail('REAL_TOOL_SANDBOX_UNPROVEN', 'Write isolation not proved; no real prompt was sent');
  result.writeFence = 'passed';
  for (const provider of ['claude', 'codex']) {
    active();
    const tool = tools[provider]?.path;
    const login = path.join(scratch, provider === 'claude' ? 'claude-token' : 'codex-home/auth.json');
    noSymlinks(login);
    if (!tool || !fs.existsSync(login)) {
      result.providers[provider] = { status: 'unconfigured/unrun', code: !tool ? 'TOOL_MISSING' : 'READ_ONLY_LOGIN_UNAVAILABLE', prompts: 0 };
      if (result.status !== 'failed') result.status = 'unconfigured/unrun'; continue;
    }
    const before = fs.readFileSync(login), env = { ...baseEnv, PATH: path.dirname(tool) + ':' + baseEnv.PATH };
    if (provider === 'claude') env.CLAUDE_CODE_OAUTH_TOKEN = before.toString('utf8');
    const args = toolArgs(provider, project);
    const version = await capture('/usr/bin/sandbox-exec', ['-f', policy, tool, '--version'], env, project, 10000, signal);
    active();
    const toolVersion = version.code === 0 ? version.stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/)?.[0] || 'unreported' : 'unreported';
    // CLI switches change across releases. Refuse unsupported no-persistence
    // flags before sending any prompt; never substitute resume/attach flags.
    const help = await capture('/usr/bin/sandbox-exec', ['-f', policy, tool, ...(provider === 'codex' ? ['exec', '--help'] : ['--help'])], env, project, 10000, signal);
    active();
    const required = provider === 'claude' ? ['--no-session-persistence', '--strict-mcp-config', '--tools', '--setting-sources'] : ['--ephemeral', '--sandbox', '--json', '--cd'];
    if (help.code !== 0 || required.some((flag) => !help.stdout.includes(flag))) {
      result.providers[provider] = { status: 'unconfigured/unrun', code: 'CLI_FLAGS_UNSUPPORTED', prompts: 0, version: toolVersion };
      if (result.status !== 'failed') result.status = 'unconfigured/unrun'; continue;
    }
    const started = Date.now();
    const run = await capture('/usr/bin/sandbox-exec', ['-f', policy, tool, ...args], env, project, 90000, signal);
    active();
    if (digest(fs.readFileSync(login)) !== digest(before)) throw fail('TEST_LOGIN_CHANGED', 'Read-only test credential changed');
    result.prompts++;
    // No raw output/error or credential is retained. A minimal response and
    // process outcome are sufficient evidence for this single-prompt gate.
    const ok = run.code === 0 && !run.expired && !run.oversized && !run.cancelled && reply(provider, run.stdout);
    result.providers[provider] = { status: ok ? 'passed' : 'failed', executable: tool, version: toolVersion, prompts: 1, fresh: true,
      argv: args, exit: run.code, signal: run.signal, timedOut: run.expired, durationMs: Date.now() - started,
      responseMarker: ok, code: ok ? null : refusal(run) };
    if (!ok) result.status = 'failed';
  }
  return result;
}
module.exports = { toolArgs, profile, runTools, reply, refusal, capture, PROMPT };

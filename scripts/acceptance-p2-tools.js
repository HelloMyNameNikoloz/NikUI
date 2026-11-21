'use strict';

// --real-tools only. Read the existing login once; stage only the selected
// credential, never provider homes/configuration/history or an IPC endpoint.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { privateDirectory, noSymlinks, fail } = require('../src/daemonPaths');
const { controlRequest } = require('../src/daemonControl');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
function parseLogin(bytes) {
  try {
    const value = JSON.parse(bytes);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  }
  catch (_) { throw fail('EXISTING_LOGIN_CORRUPT', 'Existing login JSON is invalid; no prompt was sent'); }
}
function readOnlyCodexLogin(bytes) {
  const selected = parseLogin(bytes);
  if (typeof selected.OPENAI_API_KEY === 'string' && selected.OPENAI_API_KEY) {
    return { auth_mode: 'apikey', OPENAI_API_KEY: selected.OPENAI_API_KEY };
  }
  if (typeof selected.tokens?.access_token !== 'string' || !selected.tokens.access_token || typeof selected.tokens.id_token !== 'string') {
    throw fail('READ_ONLY_LOGIN_UNAVAILABLE', 'Existing login has no reusable access credential');
  }
  // Never give a throwaway CLI the live refresh token. OAuth rotation could
  // invalidate the user's login even if filesystem writes were denied.
  return { auth_mode: selected.auth_mode || 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: selected.tokens.access_token, id_token: selected.tokens.id_token, refresh_token: '',
      ...(selected.tokens.account_id ? { account_id: selected.tokens.account_id } : {}) },
    ...(selected.last_refresh ? { last_refresh: selected.last_refresh } : {}) };
}
async function runRealTools({ paths, status }) {
  const scratch = path.join(paths.home, 'p2-real-tools');
  if (fs.existsSync(scratch)) throw fail('REAL_TOOL_PROJECT_NOT_FRESH', 'Refuse to reuse a tool rehearsal project');
  privateDirectory(scratch);
  for (const name of ['project', 'tmp', 'claude-home', 'codex-home']) privateDirectory(path.join(scratch, name));
  const liveHome = os.userInfo().homedir, sources = [];
  const readLogin = (file) => {
    noSymlinks(file);
    if (!fs.existsSync(file)) return null;
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o022) || st.size > 1024 * 1024) throw fail('LIVE_LOGIN_UNSAFE', 'Selected login file is not private');
    const bytes = fs.readFileSync(file); sources.push({ file, hash: hash(bytes) }); return bytes;
  };
  const selectedCodex = process.env.CODEX_HOME || path.join(liveHome, '.codex-work');
  if (![path.join(liveHome, '.codex-work'), path.join(liveHome, '.codex')].includes(selectedCodex)) throw fail('REAL_LOGIN_SELECTION_INVALID', 'Select the existing work or personal login explicitly');
  let token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    const bytes = readLogin(path.join(liveHome, '.claude/.credentials.json'));
    if (bytes) token = parseLogin(bytes).claudeAiOauth?.accessToken;
  }
  const auth = readLogin(path.join(selectedCodex, 'auth.json'));
  const credentialFiles = [path.join(scratch, 'claude-token'), path.join(scratch, 'codex-home/auth.json')];
  let jobStarted = false, jobFinished = false;
  try {
    if (typeof token === 'string' && token) fs.writeFileSync(credentialFiles[0], token, { mode: 0o400, flag: 'wx' });
    if (auth) fs.writeFileSync(credentialFiles[1], JSON.stringify(readOnlyCodexLogin(auth)), { mode: 0o400, flag: 'wx' });
    fs.writeFileSync(path.join(scratch, 'request.json'), JSON.stringify({ version: 1, optIn: '--real-tools', liveHome }), { mode: 0o600 });
    jobStarted = true; // a lost start reply must still trigger exact-job cleanup
    const started = await controlRequest(paths, { op: 'acceptance-p2', action: 'real-tools' });
    if (!started.ok) throw fail(started.code || 'REAL_TOOLS_REFUSED', 'Signed service refused real-tool selection');
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const result = await controlRequest(paths, { op: 'acceptance-p2', action: 'real-tools-status' });
      if (result.state === 'finished') {
        jobFinished = true;
        if (result.result.status === 'failed') throw fail('REAL_TOOLS_FAILED', 'Inspect ' + path.join(scratch, 'result.json'));
        return { ...result.result, evidence: path.join(scratch, 'result.json'), servicePid: status.pid,
          liveLoginFilesUnchanged: sources.every((s) => hash(fs.readFileSync(s.file)) === s.hash) };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw fail('REAL_TOOLS_TIMEOUT', 'Tool result deadline expired');
  } finally {
    try {
      if (jobStarted && !jobFinished) {
        await controlRequest(paths, { op: 'acceptance-p2', action: 'real-tools-cancel' });
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          const ended = await controlRequest(paths, { op: 'acceptance-p2', action: 'real-tools-status' });
          if (ended.state === 'finished' || ended.state === 'unrun') { jobFinished = true; break; }
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!jobFinished) throw fail('REAL_TOOLS_CLEANUP_PENDING', 'Fresh test CLI group did not finish cancellation');
      }
    } finally {
      for (const file of credentialFiles) fs.rmSync(file, { force: true });
      for (const source of sources) if (hash(fs.readFileSync(source.file)) !== source.hash) {
        throw fail('LIVE_LOGIN_CHANGED', 'Live login changed during rehearsal; no restoration or config write was attempted');
      }
    }
  }
}
module.exports = { runRealTools, parseLogin, readOnlyCodexLogin };

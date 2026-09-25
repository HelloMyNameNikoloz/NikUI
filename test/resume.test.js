'use strict';

// When the usage limit resets, everything it cut off carries on.
//
// It did not, reliably: after a reset some instances carried on and some were
// left red. Three causes, each checked here as it happened:
//
//   - the CLI's words changed to "You've hit your session limit · resets
//     9:30am (Asia/Riyadh)", which NikUI did not recognise, so an instance that
//     failed that way before anything paused was never marked as cut off;
//   - who was cut off lived only in memory, so a reload during the pause
//     forgot, and every instance came back owing nothing;
//   - a window reloaded after another had already resumed had no pause and no
//     timer, and its cut-off instances waited for a reset that had been.

const { install, memoryState } = require('./helpers/vscode-stub.js');
install();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetFromText, looksRateLimited, endedOnLimit } = require('../src/session.js');
const { slugFor } = require('../src/history.js');
const { SessionManager, RESUME_GRACE_MS, BLIND_RETRY_MS } = require('../src/manager.js');

// The wording, verbatim from this machine's own transcripts.
const WORDS = "You've hit your session limit · resets 9:30am (Asia/Riyadh)";

function fake(manager, opts) {
  const s = manager.create(Object.assign({ cwd: '/tmp', autoStart: false }, opts || {}));
  s.sent = [];
  s._write = function (obj) {
    const content = (obj.message && obj.message.content) || [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (text) this.sent.push(text);
  };
  Object.defineProperty(s, 'isRunning', { get: () => true, configurable: true });
  return s;
}

/** The turn failing on the limit, the way the CLI ends it. */
const failOnLimit = (s, words) => s._handleResult({
  type: 'result', subtype: 'success', is_error: true, result: words || WORDS, usage: {}
});

/** The message the CLI marks as the limit, which arrives before the result. */
const markedMessage = (s, words) => s._handle({
  type: 'assistant', error: 'rate_limit',
  message: { id: 'm-' + Math.random(), role: 'assistant', content: [{ type: 'text', text: words || WORDS }] }
});

const rejected = (resetsAt) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt,
    unifiedWindows: { five_hour: { utilization: 1, resetsAt } } }
});

const nudged = (s) => s.sent.some((t) => /usage limit reset/.test(t));

module.exports = function () {
  suite('the CLI’s words today are recognised');

  check('"You’ve hit your session limit" is the limit', looksRateLimited(WORDS));
  check('and so is the weekly one', looksRateLimited("You've hit your weekly limit · resets Sep 30, 10am"));
  check('and the old wording still is', looksRateLimited('Claude AI usage limit reached|1758553200'));
  check('an overloaded server is not', !looksRateLimited('API Error: 529 overloaded'));

  {
    const now = Date.parse('2026-09-25T06:16:31Z');   // 9:16 in Riyadh
    checkEqual('"resets 9:30am (Asia/Riyadh)" is 9:30 in Riyadh',
      new Date(resetFromText(WORDS, now)).toISOString(), '2026-09-25T06:30:00.000Z');
    checkEqual('a time already gone today is tomorrow',
      new Date(resetFromText('resets 9:00am (Asia/Riyadh)', now)).toISOString(), '2026-09-26T06:00:00.000Z');
    checkEqual('a named day is that day, in that zone',
      new Date(resetFromText('resets Sep 30, 10am (Europe/Berlin)', now)).toISOString(), '2026-09-30T08:00:00.000Z');
    checkEqual('words without a time give no time, rather than a guess', resetFromText('resets soon', now), null);
  }

  suite('an instance that fails on the limit before anything pauses');

  {
    const context = { workspaceState: memoryState(), globalState: memoryState() };
    const manager = new SessionManager(context);
    const first = fake(manager);    // fails on the limit first, in words only
    const second = fake(manager);   // mid-turn when the pause begins
    const idle = fake(manager);     // doing nothing

    first.send('long job one');
    second.send('long job two');
    failOnLimit(first);

    check('its own failure pauses the window', !!manager.pause);
    check('knowing when, from the words', !!manager.pause && manager.pause.blind === false);
    checkEqual('and it is marked as cut off, not merely red', [first.status, first.cutByLimit], ['error', true]);
    check('the one still mid-turn is caught by the pause', second.interruptedByPause);
    check('and the idle one is only held', idle.isPaused && !idle.cutByLimit && !idle.interruptedByPause);

    const woken = manager.resumeFromLimit();
    check('at the reset, the one that failed first carries on', nudged(first));
    check('and so does the one the pause caught', nudged(second));
    check('both are working again, not red', first.status === 'working' && second.status === 'working');
    check('the idle one is released without being told to do anything', !idle.isPaused && !nudged(idle));
    checkEqual('three released', woken, 3);
    check('and nothing is owed any more', !first.cutByLimit && !second.interruptedByPause);
  }

  suite('the CLI’s own mark on the message is enough');

  {
    const context = { workspaceState: memoryState(), globalState: memoryState() };
    const manager = new SessionManager(context);
    const s = fake(manager);
    s.send('work');
    markedMessage(s, "You've hit your session limit · resets 11pm (Europe/Berlin)");
    check('the marked message pauses the window before the turn has even ended', !!manager.pause);
    // The result that follows may say anything at all; the mark decided it.
    s._handleResult({ type: 'result', is_error: true, result: 'Error', usage: {} });
    check('and the turn is owed a nudge', s.cutByLimit);
  }

  suite('a reload during the pause does not forget who was cut off');

  {
    const workspaceState = memoryState();
    const globalState = memoryState();
    const before = new SessionManager({ workspaceState, globalState });
    const cut = fake(before, { resume: 'claude-1' });
    const fine = fake(before, { resume: 'claude-2' });
    cut.claudeSessionId = 'claude-1';
    fine.claudeSessionId = 'claude-2';
    cut.send('the long job');
    cut._handle(rejected(Math.floor(Date.now() / 1000) + 3600));
    failOnLimit(cut);
    before.persist();

    // The window reloads: new manager, same storage, no processes.
    before.disposeAll();
    const after = new SessionManager({ workspaceState, globalState });
    after.restoreOpen();
    after.restorePause();
    const back = after.list.find((s) => s.claudeSessionId === 'claude-1');
    const other = after.list.find((s) => s.claudeSessionId === 'claude-2');
    back.sent = []; other.sent = [];
    back._write = cut._write; other._write = cut._write;
    Object.defineProperty(back, 'isRunning', { get: () => true, configurable: true });
    Object.defineProperty(other, 'isRunning', { get: () => true, configurable: true });

    // Closing a window stops every instance on the way out, so it comes back
    // stopped rather than red — which says nothing about the work it owes.
    check('it comes back doing nothing', back.status !== 'working');
    check('but remembering it was cut off', back.cutByLimit === true);
    check('and still paused', back.isPaused);
    after.resumeFromLimit();
    check('so at the reset it carries on, reload or not', nudged(back));
    check('and the one that was fine is not told to do anything', !nudged(other));
    after.disposeAll();
  }

  suite('a window reloaded after the reset was cleared elsewhere');

  {
    const workspaceState = memoryState();
    const globalState = memoryState();
    const first = new SessionManager({ workspaceState, globalState });
    const cut = fake(first, { resume: 'claude-9' });
    cut.claudeSessionId = 'claude-9';
    cut.send('job');
    failOnLimit(cut, "You've hit your session limit");
    first.persist();
    first.disposeAll();

    // Another window resumed and cleared the shared pause while this one was away.
    globalState.update('nikui.pause.v1', null);

    const again = new SessionManager({ workspaceState, globalState });
    again.restoreOpen();
    check('nothing is paused any more', !again.pause);
    const restored = again.list[0];
    check('but the instance is still owed its nudge', restored.cutByLimit);
    check('so the window gives it a pause of its own', again.restorePause() && !!again.pause);
    check('ending in seconds, not at some reset long gone', !!again.pause && again.pause.until - Date.now() <= 6000);
    restored.sent = [];
    restored._write = cut._write;
    Object.defineProperty(restored, 'isRunning', { get: () => true, configurable: true });
    again.resumeFromLimit();
    check('and it carries on', nudged(restored));
    again.disposeAll();
  }

  suite('the transcript remembers what the window forgot');

  {
    // The entry exactly as the CLI writes it, from this machine's own disk.
    const limitEntry = (at, resetsAt) => JSON.stringify({
      type: 'assistant', timestamp: new Date(at).toISOString(), error: 'rate_limit',
      isApiErrorMessage: true, apiErrorStatus: 429,
      quotaLimits: { status: 'rejected', resetsAt: Math.floor(resetsAt / 1000), rateLimitType: 'five_hour' },
      message: { role: 'assistant', content: [{ type: 'text', text: WORDS }] }
    });
    const said = (who, text, at) => JSON.stringify({
      type: who, timestamp: new Date(at).toISOString(),
      message: { role: who, content: [{ type: 'text', text }] }
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-transcripts-'));
    const write = (name, lines) => { const f = path.join(dir, name); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };
    const now = Date.now();

    const cut = write('cut.jsonl', [said('user', 'do the job', now - 3600000),
      limitEntry(now - 1800000, now - 900000), '{"type":"cost-state","totalCostUSD":1}']);
    const found = endedOnLimit(cut, now);
    check('a conversation that ends on the limit is found', !!found);
    checkEqual('with the reset the CLI wrote beside it', found && found.resetsAt, Math.floor((now - 900000) / 1000) * 1000);

    const answered = write('answered.jsonl', [limitEntry(now - 1800000, now - 900000), said('user', 'carry on', now - 600000)]);
    checkEqual('one somebody has spoken to since is not', endedOnLimit(answered, now), null);

    const old = write('old.jsonl', [limitEntry(now - 4 * 86400000, now - 4 * 86400000 + 3600000)]);
    checkEqual('one left on the limit for days was left on purpose', endedOnLimit(old, now), null);

    const wrong = write('wrong.jsonl', [JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(),
      error: 'model_not_found', isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'There is an issue with the selected model' }] } })]);
    checkEqual('another kind of failure is not the limit', endedOnLimit(wrong, now), null);

    // And the whole path: a window saved before any of this existed — no flag
    // at all — whose instance's transcript ends on the limit.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-home-'));
    const cwd = path.join(home, 'Codes', 'Peuka-backend');
    const id = 'aaaa1111-restore-from-disk';
    const projects = path.join(home, '.claude', 'projects', slugFor(cwd));
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, id + '.jsonl'),
      [said('user', 'build it', now - 3600000), limitEntry(now - 1800000, now - 900000)].join('\n') + '\n');

    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const workspaceState = memoryState();
      const globalState = memoryState();
      workspaceState.update('nikui.sessions.v1', [{ id: 'old-one', cwd, claudeSessionId: id, status: 'error' }]);
      const manager = new SessionManager({ workspaceState, globalState });
      manager.restoreOpen();
      const back = manager.list[0];
      check('an instance saved before the fix comes back owed, from its transcript', !!back && back.cutByLimit);
      check('and the window arms a resume for it', manager.restorePause() && !!manager.pause);
      back.sent = [];
      back._write = function (obj) {
        const content = (obj.message && obj.message.content) || [];
        this.sent.push(content.filter((c) => c.type === 'text').map((c) => c.text).join(''));
      };
      Object.defineProperty(back, 'isRunning', { get: () => true, configurable: true });
      manager.resumeFromLimit();
      check('which carries it on', nudged(back));
      manager.disposeAll();
    } finally {
      process.env.HOME = realHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  suite('what finished owes nothing');

  {
    const context = { workspaceState: memoryState(), globalState: memoryState() };
    const manager = new SessionManager(context);
    const lucky = fake(manager);
    lucky.send('nearly done');
    manager.pauseForLimit({ status: 'rejected', resetsAt: Date.now() + 3600000 });
    check('caught mid-turn by the pause', lucky.interruptedByPause);
    // Its last request had already been let through, and the turn finished.
    lucky._handleResult({ type: 'result', is_error: false, result: 'done', usage: {} });
    manager.resumeFromLimit();
    check('a turn that finished is not nudged to redo it', !nudged(lucky));
  }

  suite('a real reset time replaces a guessed one');

  {
    const context = { workspaceState: memoryState(), globalState: memoryState() };
    const manager = new SessionManager(context);
    manager.pauseForLimit({ status: 'rejected', resetsAt: null });
    check('with no time, it looks again in a while', !!manager.pause && manager.pause.blind &&
      Math.abs(manager.pause.until - (Date.now() + BLIND_RETRY_MS)) < 2000);
    const soon = Date.now() + 10 * 60000;
    manager.pauseForLimit({ status: 'rejected', resetsAt: soon });
    checkEqual('told the time, it waits for that instead', manager.pause && manager.pause.until, soon + RESUME_GRACE_MS);
    check('and knows it is not guessing', !!manager.pause && !manager.pause.blind);
    manager.disposeAll();
  }
};

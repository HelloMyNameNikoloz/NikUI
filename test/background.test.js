'use strict';
const { install } = require('./helpers/vscode-stub.js');
install();
const { Session } = require('../src/session.js');
const { shouldHold } = require('../src/awake.js');

// Shaped like what the CLI emitted when a turn put a runner agent in the
// background and was then asked something else while it worked. Every turn
// opens with an init, including the one the CLI starts by itself once the
// agent reports back, and the task list is sent whole each time it changes.
const init = { type: 'system', subtype: 'init', session_id: 'sess-bg', model: 'claude-haiku-4-5-20251001', cwd: '/tmp', tools: [], slash_commands: [] };
const requesting = { type: 'system', subtype: 'status', status: 'requesting' };
const agentTask = { task_id: 'ad2b5dbd141113a09', task_type: 'local_agent', description: 'Run background task' };
const shellTask = { task_id: 'bj9t2lf0m', task_type: 'local_bash', description: 'sleep 25 && echo finished' };
const tasks = (...list) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list });
const updated = (status) => ({ type: 'system', subtype: 'task_updated', task_id: agentTask.task_id, patch: { status, end_time: 1790739682932 } });
const notification = (status) => ({
  type: 'system', subtype: 'task_notification', task_id: agentTask.task_id, tool_use_id: 'toolu_01Vz5f', status,
  output_file: '/private/tmp/claude-501/-private-tmp/sess-bg/tasks/ad2b5dbd141113a09.output',
  summary: 'finished', usage: { total_tokens: 7468, tool_uses: 2, duration_ms: 7645 }
});

/** A process that takes what is written to it, and nothing else. */
function running(session) {
  const written = [];
  session.proc = {
    exitCode: null, killed: false, kill() { this.killed = true; },
    stdin: { writable: true, write: (line) => written.push(JSON.parse(line)), end() {} }
  };
  return written;
}

function launch(session) {
  session._handle({ type: 'assistant', uuid: 'u-launch', parent_tool_use_id: null, message: { id: 'msg_launch', content: [
    { type: 'tool_use', id: 'toolu_01Vz5f', name: 'Agent', input: { subagent_type: 'runner', run_in_background: true, description: agentTask.description, prompt: 'Run: sleep 25 && echo finished.' } }
  ] } });
  session._handle(tasks(agentTask));
  session._handle({
    type: 'system', subtype: 'task_started', task_id: agentTask.task_id, tool_use_id: 'toolu_01Vz5f',
    description: agentTask.description, subagent_type: 'runner', is_backgrounded: true, spawn_depth: 1,
    task_type: 'local_agent', prompt: 'Run: sleep 25 && echo finished.'
  });
  session._handle({ type: 'user', parent_tool_use_id: null, message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_01Vz5f', content: 'Async agent launched successfully.' }
  ] } });
}

function answer(session, msgId, text, extra) {
  session._handle({ type: 'assistant', uuid: 'u-' + msgId, parent_tool_use_id: null, message: { id: msgId, content: [{ type: 'text', text }] } });
  session._handle(Object.assign({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 900, num_turns: 1, result: text,
    total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }
  }, extra));
}

const lastNotice = (session) => (session.items.filter((i) => i.kind === 'notice').pop() || {}).text;

module.exports = async function () {
  suite('agents in the background keep an instance working');

  {
    const s = new Session({ cwd: '/tmp' });
    const written = running(s);
    s.send('delegate this');
    checkEqual('a prompt starts a turn', s.status, 'working');
    const began = s.turnStartedAt;
    s._handle(init);
    s._handle(requesting);
    checkEqual('the init that opens it is not a second turn', s.turnStartedAt, began);
    launch(s);
    check('inside the turn, the agent is counted', s.backgroundAgents === 1 && s.inTurn);
    answer(s, 'msg_launched', 'Launched.');
    checkEqual('the turn ending with its agent still out leaves it working, not done', s.status, 'working');
    check('busy, so closing it asks first', s.isBusy);
    checkEqual('and the machine is held awake for it',
      shouldHold({ enabled: true, sessions: [s], serving: false }).hold, true);
    check('but it is not in a turn', !s.inTurn);
    checkEqual('the panel is told how many agents are out', s.stats().background, 1);

    // The CLI answers a prompt while the agent works, so holding it back would
    // only make somebody wait for nothing.
    const before = written.length;
    checkEqual('a prompt sent meanwhile is not queued', s.submit('what is 2+2'), 'sent');
    check('it goes straight to the CLI', written.length === before + 1 && written[written.length - 1].type === 'user');
    check('as a turn of its own', s.inTurn);
    s._handle(init);
    answer(s, 'msg_four', '4');
    checkEqual('whose end goes back to working in the background', s.status, 'working');
    check('with no turn in flight', !s.inTurn);
    check('so a queue may drain meanwhile', s.isReadyForQueue());

    // The agent's own command outlives it, and the agent reports back.
    s._handle(tasks(agentTask, shellTask));
    s._handle({ type: 'system', subtype: 'task_started', task_id: shellTask.task_id, owned_by_subagent: true, tool_use_id: 'toolu_01Rq', description: shellTask.description, is_backgrounded: true, task_type: 'local_bash' });
    s._handle(tasks(shellTask));
    checkEqual('a command left behind is not an agent', s.backgroundAgents, 0);
    checkEqual('it is still working while the CLI gets ready to report', s.status, 'working');
    s._handle(updated('completed'));
    s._handle(notification('completed'));
    checkEqual('the transcript says which agent came back', lastNotice(s), 'The runner agent finished: Run background task.');
    s._handle(init);
    check('the turn the CLI starts by itself is a turn', s.inTurn);
    check('with its clock running', !!s.turnStartedAt);
    checkEqual('so a prompt sent now waits for it', s.submit('and then?'), 'queued');
    s._handle(requesting);
    answer(s, 'msg_report', 'The agent finished.', { origin: { kind: 'task-notification' }, result_index: 2 });
    checkEqual('with every agent back and reported, it is done', s.status, 'done');
    check('and nothing keeps it busy', !s.isBusy);
    check('and the queue can go', s.isReadyForQueue() && s.queue.length === 1);
    s._clearDrain();
  }

  suite('an agent in the foreground is part of its turn');

  {
    const s = new Session({ cwd: '/tmp' });
    running(s);
    s.send('ask an agent');
    s._handle(init);
    s._handle({ type: 'system', subtype: 'task_started', task_id: 'a-fg', tool_use_id: 'toolu_fg', description: 'echoer', subagent_type: 'runner', is_backgrounded: false, task_type: 'local_agent' });
    s._handle({ type: 'system', subtype: 'task_notification', task_id: 'a-fg', tool_use_id: 'toolu_fg', status: 'completed', summary: 'hi' });
    check('its report is in its tool call, so no line announces it', !s.items.some((i) => i.kind === 'notice'));
    answer(s, 'msg_fg', 'agent says hi');
    checkEqual('and its turn ends done', s.status, 'done');
  }

  {
    // Sent to the background after it started, the way Ctrl+B does it.
    const s = new Session({ cwd: '/tmp' });
    running(s);
    s.send('ask an agent');
    s._handle(init);
    s._handle({ type: 'system', subtype: 'task_started', task_id: 'a-later', tool_use_id: 'toolu_later', description: 'slow one', subagent_type: 'worker', is_backgrounded: false, task_type: 'local_agent' });
    s._handle(tasks({ task_id: 'a-later', task_type: 'local_agent', description: 'slow one' }));
    answer(s, 'msg_later', 'It is in the background now.');
    checkEqual('one sent to the background later keeps it working', s.status, 'working');
    s._handle(tasks());
    s._handle({ type: 'system', subtype: 'task_notification', task_id: 'a-later', tool_use_id: 'toolu_later', status: 'completed', summary: 'done' });
    checkEqual('and is announced when it reports back', lastNotice(s), 'The worker agent finished: slow one.');
    s._clearBackground();
  }

  suite('a command in the background is not work');

  {
    const s = new Session({ cwd: '/tmp' });
    running(s);
    s.send('start the dev server');
    s._handle(init);
    s._handle(tasks({ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }));
    answer(s, 'msg_dev', 'Started.');
    checkEqual('a dev server left running does not keep it working', s.status, 'done');
    check('or the machine awake', !s.isBusy);
  }

  {
    const s = new Session({ cwd: '/tmp' });
    running(s);
    s.send('run the checks, then push');
    s._handle(init);
    s._handle({ type: 'system', subtype: 'task_started', task_id: 'b2', tool_use_id: 'toolu_b2', description: 'pnpm run check', is_backgrounded: true, task_type: 'local_bash' });
    s._handle(tasks({ task_id: 'b2', task_type: 'local_bash', description: 'pnpm run check' }));
    answer(s, 'msg_wait', 'I will commit and push once they pass.');
    checkEqual('a check left running keeps it working', s.status, 'working');
    check('without holding the queue', !s.inTurn);
    checkEqual('and says what it is waiting on', s.stats().shells, 1);
    s._handle(tasks());
    s._handle(init);
    check('when it ends, the CLI picks the turn back up', s.inTurn);
    answer(s, 'msg_pushed', 'Pushed.', { origin: { kind: 'task-notification' } });
    checkEqual('and then it is done', s.status, 'done');
  }

  suite('which commands, since when, and stopping one');
  {
    const s = new Session({ cwd: '/tmp' });
    const written = running(s);
    s.send('run the checks');
    s._handle(init);
    const before = Date.now();
    s._handle({ type: 'system', subtype: 'task_started', task_id: 'b3', tool_use_id: 'toolu_b3', description: 'pnpm run check', is_backgrounded: true, task_type: 'local_bash' });
    s._handle(tasks({ task_id: 'b3', task_type: 'local_bash', description: 'pnpm run check' },
      { task_id: 'b4', task_type: 'local_bash', description: 'npm run dev' }));
    const list = s.stats().shellList;
    checkEqual('names the command it is waiting on, not the dev server', list.map((t) => t.command), ['pnpm run check']);
    check('and when it started', list[0].startedAt >= before && list[0].startedAt <= Date.now());
    check('a command not in the background is not stopped', !s.stopTask('nope'));
    const n = written.length;
    check('one that is, is', s.stopTask('b3'));
    checkEqual('by asking the CLI to stop that task', [written.length, written[n].type, written[n].request.subtype, written[n].request.task_id],
      [n + 1, 'control_request', 'stop_task', 'b3']);
    check('and the chip says it is stopping', s.stats().shellList[0].stopping);

    const t = new Session({ cwd: '/tmp' });
    running(t);
    t._handle(tasks({ task_id: 'b5', task_type: 'local_bash', description: 'pnpm test' }));
    check('one first seen in the list is timed from then', t.stats().shellList[0].startedAt > 0);
  }

  suite('stopping agents between turns');

  {
    const s = new Session({ cwd: '/tmp' });
    const written = running(s);
    s.send('delegate this');
    s._handle(init);
    launch(s);
    answer(s, 'msg_launched', 'Launched.');
    s.interrupt();
    checkEqual('stop still reaches the CLI, which ends the agents', written[written.length - 1].request.subtype, 'interrupt');
    s._handle(tasks());
    checkEqual('done at once, since no turn follows an interrupt', s.status, 'done');
    s._handle(updated('killed'));
    s._handle(notification('stopped'));
    checkEqual('and it says so', lastNotice(s), 'The runner agent was stopped: Run background task.');
    s.send('next');
    s._handle(init);
    answer(s, 'msg_next', 'ok');
    const result = s.items.filter((i) => i.kind === 'result').pop();
    check('the next turn is not taken for the one that was stopped', !!result && !result.interrupted);
  }

  suite('if the CLI never reports back');

  {
    const s = new Session({ cwd: '/tmp' });
    running(s);
    s.agentSettleMs = 20;
    s.send('delegate this');
    s._handle(init);
    launch(s);
    answer(s, 'msg_launched', 'Launched.');
    s._handle(tasks());
    checkEqual('the moment the last agent ends, it is still working', s.status, 'working');
    await new Promise((r) => setTimeout(r, 80));
    checkEqual('and when no turn comes, it settles as done', s.status, 'done');
  }

  suite('agents outlive a turn that failed, or a pause');

  {
    const s = new Session({ cwd: '/tmp' });
    running(s);
    s.send('delegate this');
    s._handle(init);
    launch(s);
    s._handle({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 500', total_cost_usd: 0.01, usage: {} });
    checkEqual('the failure is what it shows', s.status, 'error');
    check('but it stays busy while the agent runs', s.isBusy);
    s._handle(tasks());
    check('and stops being busy once the agent is done', !s.isBusy);
    checkEqual('still showing the failure', s.status, 'error');
  }

  {
    const s = new Session({ cwd: '/tmp' });
    running(s);
    s.send('delegate this');
    s._handle(init);
    launch(s);
    answer(s, 'msg_launched', 'Launched.');
    s.pause({ until: Date.now() + 60000, reason: 'limit' });
    checkEqual('a pause leaves agents that may be on another model to carry on', s.status, 'working');
    check('and owes no turn a nudge, since none was cut off', !s.interruptedByPause);
    s.stop();
    check('stopping the process takes its agents with it', s.backgroundAgents === 0 && !s.isBusy);
  }
};

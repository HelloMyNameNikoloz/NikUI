'use strict';
const { startDaemon } = require('../../../src/daemonRuntime');
const root = process.argv[2];
const crypto = require('crypto');
const waitFor = async (test) => {
  const until = Date.now() + 5000;
  while (!test()) { if (Date.now() > until) throw new Error('fixture deadline'); await new Promise((r) => setTimeout(r, 10)); }
};
(async () => {
  const daemon = await startDaemon({ root, adapters: {
    keeper: { nodePath: process.execPath, env: { NIKUI_KEEPER_GRACE_MS: '5000', NIKUI_KEEPER_IDLE_MS: '200' } },
    tools: { knownDirs: [], lookup: async () => ({ tools: {}, available: false }) }
  } });
  let session = daemon.engine.manager.get('daemon-owned');
  const restored = !!session;
  if (!session) {
    session = daemon.engine.manager.create({ id: 'daemon-owned', cwd: daemon.paths.home, autoStart: false });
    session.send('ASK fixture restart');
    await waitFor(() => session.status === 'waiting');
    await daemon.graph.currentState.flush();
    session.proc.checkpoint();
    await daemon.graph.keeper.request({ t: 'list' }, 1000);
  }
  const info = () => ({ restored, generation: daemon.generation, pid: session.proc && session.proc.pid, status: session.status,
    instance: session.id, conversation: session.claudeSessionId, requests: session.items.filter((item) => item.kind === 'permission' && !item.resolved).length,
    refusal: session.keeperRefusal || null, protocol: daemon.status().protocol, run: session._engineControls.run() });
  process.on('message', async (message) => {
    if (message === 'crash') process.exit(77);
    if (message === 'answer' || message?.type === 'stale-answer') {
      const permission = session.items.find((item) => item.kind === 'permission' && !item.resolved);
      const answer = await daemon.graph.currentState.dispatch({ authenticated: true, principal: 'local:legacy',
        role: 'conversation', target: 'session:' + session.id, seat: { id: 'fixture', local: true, control: true, editor: false } },
      { type: 'permission', mid: crypto.randomBytes(16).toString('hex'), scope: daemon.graph.authority.receiptInfo().scope,
        issuedAt: Date.now(), requestId: permission.requestId, run: message?.type === 'stale-answer' ? message.run : permission.run, allow: true });
      if (answer.outcome !== 'applied') { process.send({ ...info(), answer }); return; }
      await waitFor(() => session.status === 'done');
      process.send({ ...info(), turns: session.turns, cost: session.totalCost });
    }
    if (message === 'stop') { await daemon.stop(); process.exit(0); }
  });
  process.send(info());
})().catch((error) => { process.stderr.write(String(error.stack)); process.exit(78); });

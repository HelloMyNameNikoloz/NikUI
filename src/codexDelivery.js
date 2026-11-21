'use strict';

const { requireThat } = require('./protocolV2');
const { wireError } = require('./receiptDispatcher');

const providerFor = (engine, session, correlation) => ({ kind: 'codex', account: engine.account.id,
  threadId: session.threadId, clientUserMessageId: correlation, turnId: null,
  ownership: session.workspace.client.ownership || (session.workspace.client.viaDaemon ? 'borrowed' : 'owned'),
  writer: session.writerAuthority || (session.readOnly ? 'external' : 'engine') });
const inputOf = (text, files = []) => [{ type: 'text', text, text_elements: [] }, ...files.map((f) => ({ type: 'image', url: `data:${f.mediaType};base64,${f.data}` }))];

/** Only called for a durably claimed outbox item. Phase persistence precedes
 * each possible write. A failed request never feeds the legacy retry queue. */
async function deliverCodex({ engine, session, item, binding, phase, permitted = () => true }) {
  const m = item.payload.message, mode = item.payload.mode || 'send';
  let crossed = false, provider = providerFor(engine, session, item.correlation);
  const validate = () => {
    requireThat(permitted() && engine.codex.get(session.id) === session && session.cwd === item.payload.cwd &&
      session.threadId === item.payload.providerTarget.threadId && engine.account.home === item.payload.providerTarget.account, 'STALE_RESOURCE');
    if (binding) session._engineControls.validate(binding);
    if (mode === 'send') requireThat(!session.turnId && !session._engineControls.hasQuestion(), 'STALE_RUN');
  };
  try {
    validate();
    if (mode === 'question') {
      await phase('question-response', provider); validate(); crossed = true;
      const answer = await session._engineControls.execute(binding, m, null, permitted);
      if (answer.outcome === 'applied') provider.turnId = binding.run.turn;
      return { state: answer.outcome === 'applied' ? session._drawnTurns.has(binding.run.turn) ? 'completed' : 'accepted' : answer.outcome, provider,
        ...(answer.error ? { error: answer.error } : {}) };
    }
    const follower = session.readOnly;
    requireThat(session.loaded && session.workspace.client.proc, 'STALE_RUN');
    let owner = null;
    if (follower) {
      const ipc = session.workspace.ipc;
      requireThat(ipc, 'PROVIDER_REJECTED');
      await phase('follower-discovery', provider);
      owner = await ipc.ownerOf(session.threadId);
      validate(); requireThat(owner && session.readOnly, 'STALE_RUN');
      // Resolve connection setup before the durable write phase. request()
      // also revalidates immediately before its actual framed socket write.
      if (ipc.connect) await ipc.connect();
      validate();
    }
    const settings = item.payload.providerSettings || {};
    const outgoing = String(m.sent || m.text).trim().replace(mode === 'steer' ? /^\/steer\s+/i : /$^/, '');
    const params = { threadId: session.threadId, clientUserMessageId: item.correlation, input: inputOf(outgoing, m.attachments) };
    if (mode === 'steer') params.expectedTurnId = binding.run.turn;
    Object.assign(params, settings);
    const method = mode === 'steer' ? 'turn/steer' : 'turn/start';
    // Follower steering uses the same expected-turn CAS in the forwarded
    // request. It never becomes a fresh turn after discovery.
    await phase(follower ? 'follower-dispatching' : 'direct-dispatching', provider);
    validate(); crossed = true;
    const reply = follower ? await session.workspace.ipc.request('thread-follower-start-turn', {
      conversationId: session.threadId, turnStart: { request: params }
    }, { target: owner, timeoutMs: 30000, beforeWrite: validate }) : await session.workspace.client.request(method, params);
    provider.turnId = reply?.turn?.id || reply?.turnId || (mode === 'steer' ? binding.run.turn : null);
    requireThat(provider.turnId === null || typeof provider.turnId === 'string' && Buffer.byteLength(provider.turnId) <= 1024);
    if (mode === 'steer') requireThat(provider.turnId === binding.run.turn);
    const text = String(m.text).trim().replace(mode === 'steer' ? /^\/steer\s+/i : /$^/, '');
    if (engine.codex.get(session.id) === session && !session.disposed) {
      session._upsert({ id: 'u:' + item.correlation, kind: 'user', text, snippets: m.snippets || [], images: m.attachments || [], at: Date.now() });
      if (provider.turnId && !session.turnId && !session._drawnTurns.has(provider.turnId)) session.turnId = provider.turnId;
      if (!provider.turnId || !session._drawnTurns.has(provider.turnId)) session._setStatus('working');
    }
    return { state: ['completed', 'failed', 'interrupted'].includes(reply?.turn?.status) ? 'completed' : 'accepted', provider };
  } catch (error) {
    const definite = !crossed || error.delivery === 'not_written' || ['STALE_RUN', 'STALE_TURN', 'STALE_RESOURCE', 'FORBIDDEN'].includes(error.code);
    return { state: definite ? 'rejected' : 'unknown', provider,
      error: wireError(definite ? ['STALE_RUN', 'STALE_TURN', 'STALE_RESOURCE', 'FORBIDDEN'].includes(error.code) ? error.code : 'PROVIDER_REJECTED' : 'OUTCOME_UNKNOWN') };
  }
}

/** No text/time heuristics. The caller supplies an actual provider history
 * page/notification from the selected account and exact thread. */
function exactEvidence(item, { account, threadId, turns }) {
  const provider = item.provider;
  if (!provider || provider.account !== account || provider.threadId !== threadId || !Array.isArray(turns)) return null;
  for (const turn of turns) {
    if (!turn || typeof turn.id !== 'string' || !turn.id || Buffer.byteLength(turn.id) > 1024) continue;
    const correlated = (Array.isArray(turn.items) ? turn.items : []).some((message) => message?.type === 'userMessage' && message.clientId === item.correlation);
    const known = provider.turnId !== null && provider.turnId === turn.id;
    if (!correlated && !known) continue;
    // A known turn alone cannot prove a particular steer was accepted.
    if ((item.payload.mode === 'steer' || item.dispatchMode === 'steer') && !correlated && !item.acceptanceProved) continue;
    return { state: turn.status === 'inProgress' ? 'accepted' : ['completed', 'failed', 'interrupted'].includes(turn.status) ? 'completed' : 'accepted',
      provider: { ...provider, turnId: turn.id } };
  }
  return null;
}

module.exports = { deliverCodex, exactEvidence, providerFor };

'use strict';

const { createPolicyAuthority, createPolicyOwner, createFakePolicyAdapters } = require('../src/policyOwner');
const { settings, deferred, tick } = require('./fixtures/engine/fakes');

module.exports = async function () {
  suite('T04/T56 P1: one fake generation owns power, watchdog and local banners');
  const authority = createPolicyAuthority(), fakes = createFakePolicyAdapters(), source = settings();
  let claude = 0, codex = 0, serving = false, looking = false, valid = true, opened = 0, clicked;
  const opts = { authority, ...fakes, settings: source, claudeBusy: () => claude, codexBusy: () => codex,
    serving: () => serving, attended: (requester) => requester.attended,
    isLookingAt: () => looking, isCurrent: () => valid, open: (target) => { clicked = target.id; return ++opened; } };
  const a = createPolicyOwner({ ...opts, generation: 'a' }), b = createPolicyOwner({ ...opts, generation: 'b' });
  const start = a.start();
  let refusal;
  try { b.start(); } catch (err) { refusal = err.code; }
  checkEqual('ownership is fenced even while recovery is pending', refusal, 'POLICY_OWNED');
  await start;
  checkEqual('recovery precedes acquisition of even fake assertions', fakes.events[0], ['recover', 'a']);
  codex = 1; claude = 1; serving = true; a.reconsider();
  checkEqual('awake and lid remain off by default despite busy work and listener', fakes.owners.get('a'), { awake: false, lid: false });
  await source.update('keepAwake', true); await source.update('lidClosed', true);
  claude = 0; a.reconsider();
  checkEqual('explicit Codex busy counts for both assertions', fakes.owners.get('a'), { awake: true, lid: true });
  codex = 0; a.reconsider();
  checkEqual('a listener alone holds awake but never a closed lid', fakes.owners.get('a'), { awake: true, lid: false });
  serving = false; a.reconsider();
  checkEqual('idle/no listener releases the assertions', fakes.owners.get('a'), { awake: false, lid: false });
  const event = { id: 'turn1', target: { id: 'instance', provider: 'claude', run: 'r1' }, title: 'Done', body: 'Fixture' };
  checkEqual('completion banners default off', a.notify(event), false);
  checkEqual('disabled completion policy also stays silent', fakes.banners.length, 0);
  await source.update('notifyWhenDone', true);
  checkEqual('the next policy event posts once', [a.notify({ ...event, id: 'turn2' }), a.notify({ ...event, id: 'turn2' })], [true, false]);
  event.target.id = 'replacement';
  fakes.banners[0].click();
  checkEqual('a current click opens the captured instance/provider/run', opened, 1);
  checkEqual('caller mutation cannot retarget an already posted banner', clicked, 'instance');
  valid = false; fakes.banners[0].click();
  checkEqual('a stale target cannot hijack a replacement instance', opened, 1);
  valid = true; looking = true;
  checkEqual('visibility suppresses a banner but retains the configured chime', a.notify({ ...event, id: 'turn3' }), false);
  checkEqual('one chime per enabled event, including the attended viewer', fakes.events.filter((e) => e[0] === 'chime').length, 2);
  checkEqual('lid setup requires a local attended requester', [a.maySetUpLid({ local: false, attended: true }),
    a.maySetUpLid({ local: true, attended: false }), a.maySetUpLid({ local: true, attended: true })], [false, false, true]);
  await a.dispose(); await a.dispose();
  fakes.banners[0].click();
  checkEqual('retired-generation clicks cannot open anything', opened, 1);
  checkEqual('old-generation local banners are retired before handoff', fakes.banners[0].active, false);
  checkEqual('each owned adapter releases once', fakes.events.filter((e) => /release$/.test(e[0])),
    [['notifications-release', 'a'], ['power-release', 'a']]);
  await b.start();
  checkEqual('new recovery begins only after old power/watchdog release', fakes.events.filter((e) => e[0] === 'recover' || /release$/.test(e[0])),
    [['recover', 'a'], ['notifications-release', 'a'], ['power-release', 'a'], ['recover', 'b']]);
  checkEqual('disposing A never releases B', [...fakes.owners.keys()], ['b']);
  looking = false; b.notify({ ...event, id: 'ci1', kind: 'ci' });
  checkEqual('only the new generation can own active local banners', [...new Set(fakes.banners.filter((b) => b.active).map((b) => b.generation))], ['b']);
  fakes.owners.set('unrelated', { awake: true, lid: false });
  await b.dispose();
  checkEqual('release and recovery preserve unrelated preexisting power policy', fakes.owners.get('unrelated'), { awake: true, lid: false });
  fakes.owners.delete('unrelated');

  suite('T58 P1: recovery and drain retain the generation fence');
  const pending = deferred(), release = deferred(), calls = [];
  const c = createPolicyOwner({ ...opts, generation: 'c', power: { ...fakes.power,
    recover: () => pending.promise, release: async (id) => { calls.push(id); await release.promise; } } });
  const d = createPolicyOwner({ ...opts, generation: 'd' });
  const starting = c.start(), closing = c.dispose();
  await tick();
  checkEqual('dispose waits for in-flight recovery', calls, []);
  pending.resolve(); await starting; await tick();
  checkEqual('recovered disposed owner releases only its own generation', calls, ['c']);
  let during;
  try { d.start(); } catch (err) { during = err.code; }
  checkEqual('asynchronous release blocks the next owner', during, 'POLICY_OWNED');
  release.resolve(); await closing;
  await d.start(); await d.dispose();
  const failed = createPolicyOwner({ ...opts, generation: 'failed', power: { ...fakes.power, release() { throw new Error('fixture failure'); } } });
  await failed.start();
  await failed.dispose().catch(() => {});
  checkEqual('a failed release conservatively retains the fence', authority.generation, 'failed');
  check('Codex busy cannot be inferred or omitted', (() => { try { createPolicyOwner({ ...opts, generation: 'bad', codexBusy: undefined }); return false; } catch (_) { return true; } })());
};

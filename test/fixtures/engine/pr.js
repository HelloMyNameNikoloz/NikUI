'use strict';

const fs = require('fs');
const path = require('path');
const { createEngine } = require('../../../src/engine');
const { createMachineHost } = require('../../../src/machineHost');
const { QUERY } = require('../../../src/prView');
const { CI_DURATIONS } = require('../../../src/prRuntime');
const { context, settings, clock, deferred, tick } = require('./fakes');

const root = process.env.NIKUI_ENGINE_FIXTURE_ROOT;
const url = 'https://github.com/fixture/repo/pull/7';
const repo = 'https://github.com/fixture/repo';
const never = () => { throw new Error('No provider process belongs to this fixture'); };
const viewer = (id, device) => {
  const got = [];
  return { id, device, got, post: (message) => got.push(message), last: (type) => got.filter((m) => m.type === type).at(-1) };
};

module.exports = async function () {
  const engines = [], servers = [];
  function make(name, extra = {}) {
    const home = path.join(root, name); fs.mkdirSync(home);
    const ctx = context({ [CI_DURATIONS]: { [repo]: [40000, 60000] } });
    let now = 100000;
    const timers = clock(), source = settings();
    const engine = createEngine({ context: ctx, settings: source, now: () => now, timers, spawner: never,
      paths: { home, projects: path.join(home, 'projects') }, codex: { unavailableReason: 'Fixture disabled' } });
    engines.push(engine);
    const session = engine.manager.create({ id: 'same-id', cwd: home, ticket: '7', autoStart: false });
    session.start = () => {};
    const calls = [], notified = [], delivered = [];
    const world = { done: false, automatic: true };
    const runners = {
      links: async (file, args, options) => {
        calls.push({ family: 'links', file, args, options });
        return { ok: true, stdout: JSON.stringify({ url }) };
      },
      feed: async (file, args, options) => {
        calls.push({ family: 'feed', file, args, options });
        if (args[0] === 'pr' && args[1] === 'diff') return { ok: true, stdout: 'diff --git a/fixture b/fixture' };
        return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
          url, number: 7, title: name, state: 'OPEN', headRefOid: 'fixture-sha',
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] }
        } } } }) };
      },
      ci: async (file, args, options) => {
        calls.push({ family: 'ci', file, args, options });
        if (file === 'git') return { ok: true, stdout: 'fixture-sha\n' };
        if (args[0] === 'run') return { ok: true, stdout: '[]' };
        return { ok: true, stdout: JSON.stringify({ url, number: 7, title: name, state: 'OPEN', headRefOid: 'fixture-sha',
          statusCheckRollup: [{ name: 'fixture-check', status: world.done ? 'COMPLETED' : 'IN_PROGRESS', conclusion: world.done ? 'SUCCESS' : '' }] }) };
      }, ...extra.runners
    };
    const runtime = engine.createPrCi({ runners, autoWatch: () => world.automatic,
      notify: (session, state) => notified.push([session.id, state.phase]) });
    engine.manager.on('ci-result', (session, state) => delivered.push([session.id, state.phase]));
    const host = createMachineHost({ manager: engine.manager, settings: source, env: { home }, prFeed: runtime.feed, setPr: runtime.setPr });
    const server = engine.createRemote({ root: home, host, resources: {}, ownership: {} }); servers.push(server);
    return { engine, runtime, host, server, session, home, timers, ctx, calls, world, notified, delivered, advance(ms) { now += ms; } };
  }
  try {
    suite('P1-08/T03/T04: PR/CI composition is inert, per-engine and owned');
    const a = make('alpha'), b = make('beta');
    checkEqual('constructing PR/CI starts no query or subscription', [a.calls.length, b.calls.length,
      a.engine.manager.listenerCount('pushed'), a.engine.manager.listenerCount('session-changed')], [0, 0, 0, 0]);
    checkEqual('ownership records every composed PR/CI service', a.runtime.ownership, { ci: 'owned', links: 'owned', feed: 'owned' });
    await Promise.all([a.engine.start(), a.engine.start(), b.engine.start()]); a.runtime.start();
    await tick();
    checkEqual('starting twice installs one subscription per service', [a.engine.manager.listenerCount('pushed'), a.engine.manager.listenerCount('session-changed')], [1, 1]);
    checkEqual('the current link query is unchanged', a.calls.find((c) => c.family === 'links'),
      { family: 'links', file: 'gh', args: ['pr', 'view', '7', '--json', 'url'], options: { cwd: a.home } });
    checkEqual('same ticket and URL keep separate link caches', [a.session.prUrl, b.session.prUrl,
      a.runtime.links.known === b.runtime.links.known], [url, url, false]);

    suite('P1-08/T47: headless host and actual hub preserve PR queries/events/grants');
    const hubA = a.server.hubs.hubFor(a.session, a.host), hubB = b.server.hubs.hubFor(b.session, b.host);
    const laptop = viewer('laptop'), watch = viewer('watch', { kind: 'device', id: 'fixture-phone', control: false });
    hubA.attach(laptop); hubA.attach(watch); await hubA.receive(laptop.id, { type: 'ready' }); await hubA.receive(watch.id, { type: 'ready' });
    const other = viewer('other'); hubB.attach(other); await hubB.receive(other.id, { type: 'ready' });
    await tick();
    const feedQuery = a.calls.find((c) => c.family === 'feed');
    checkEqual('the full current GraphQL query and cwd reach the injected runner', feedQuery,
      { family: 'feed', file: 'gh', args: ['api', 'graphql', '-f', 'query=' + QUERY, '-F', 'owner=fixture', '-F', 'name=repo', '-F', 'number=7'], options: { cwd: a.home } });
    checkEqual('PR feed events reach both viewers with each engine own data',
      [laptop.last('pr:state').state.title, watch.last('pr:state').state.title, other.last('pr:state').state.title], ['alpha', 'alpha', 'beta']);
    await hubA.receive(laptop.id, { type: 'pr:pane', open: true, tab: 'checks' });
    checkEqual('opening the current pane activates polling', a.runtime.feed.activeCount(a.runtime.feed.entries.get(url)), 1);
    const mutationsBefore = a.calls.length;
    await hubA.receive(watch.id, { type: 'pr:comment', body: 'must refuse' });
    checkEqual('watch-only PR mutations never reach the runner', [watch.last('@refused').what, a.calls.length], ['pr:comment', mutationsBefore]);
    await hubA.receive(watch.id, { type: 'pr:diff' });
    checkEqual('the existing read-only diff still returns to its viewer', watch.last('pr:diff').diff, 'diff --git a/fixture b/fixture');
    const beforeOther = other.got.length;
    a.runtime.feed.emit('state', url, { state: { title: 'alpha update' }, loading: false });
    checkEqual('feed events cannot leak across same-ID engines', [laptop.last('pr:state').state.title, other.got.length], ['alpha update', beforeOther]);
    hubA.detach(laptop.id); hubA.detach(watch.id); a.server.hubs.closeHub(a.session.id);
    checkEqual('closing viewers releases their watch key, listener and timer without owning the feed',
      [a.runtime.feed.keyToUrl.size, a.runtime.feed.listenerCount('state'), a.runtime.feed.entries.get(url).timer, a.runtime.feed.disposed], [0, 0, null, false]);

    suite('P1-08/T04/T47: same CI queries, auto-watch policy, duration cache and result event');
    a.world.automatic = false; a.engine.manager.emit('pushed', a.session, a.home);
    checkEqual('disabled automatic CI watching runs no query', a.calls.filter((c) => c.family === 'ci').length, 0);
    a.world.automatic = true; a.engine.manager.emit('pushed', a.session, a.home); await tick();
    checkEqual('the current CI state reaches the instance', [a.session.ci.phase, a.session.ci.averageMs], ['running', 50000]);
    checkEqual('the current CI query sequence is preserved', a.calls.filter((c) => c.family === 'ci').map((c) => [c.file, c.args, c.options.cwd]), [
      ['gh', ['pr', 'view', '--json', 'number,url,title,state,headRefOid,statusCheckRollup'], a.home],
      ['git', ['rev-parse', 'HEAD'], a.home],
      ['gh', ['run', 'list', '--limit', '60', '--event', 'pull_request', '--json', 'headSha,createdAt,updatedAt,status,conclusion'], a.home],
      ['gh', ['run', 'list', '--limit', '60', '--json', 'headSha,createdAt,updatedAt,status,conclusion'], a.home]
    ]);
    check('the existing 15-second poll uses the injected timer', [...a.timers.tasks.values()].some((task) => task.ms === 15000));
    a.advance(15000); a.world.done = true; a.timers.fire(); await tick();
    checkEqual('one completed watch emits the same shared event and presentation callback', [a.session.ci.phase, a.delivered, a.notified],
      ['passed', [['same-id', 'passed']], [['same-id', 'passed']]]);
    checkEqual('duration storage keeps the existing key/shape, isolated from the other engine',
      [a.ctx.globalState.get(CI_DURATIONS)[repo], b.ctx.globalState.get(CI_DURATIONS)[repo]], [[15000, 40000, 60000], [40000, 60000]]);
    a.engine.manager.emit('removed', a.session);
    checkEqual('removing an instance releases its CI watch and strip timer', [a.runtime.ci.watches.size, a.runtime.ci.clearTimers.size, a.session.ci], [0, 0, null]);
    await a.engine.dispose(); await a.engine.dispose();
    checkEqual('engine disposal owns the three services and their subscriptions', [a.runtime.feed.disposed, a.runtime.links.disposed,
      a.runtime.ci.disposed, a.engine.manager.listenerCount('pushed'), a.engine.manager.listenerCount('session-changed'), a.timers.tasks.size], [true, true, true, 0, 0, 0]);
    checkEqual('closing one engine cannot dispose another feed or watch', [b.runtime.feed.disposed, b.runtime.ci.disposed, b.runtime.feed.keyToUrl.size], [false, false, 1]);

    suite('P1-08/T04/T07: late query replies cannot resurrect a retired graph');
    const link = deferred(), feed = deferred(), head = deferred(), headStarted = deferred();
    const late = make('late', { runners: { links: () => link.promise, feed: () => feed.promise,
      ci: async (file) => {
        if (file === 'git') { headStarted.resolve(); return head.promise; }
        return { ok: true, stdout: JSON.stringify({ url, number: 7, state: 'OPEN', headRefOid: 'sha', statusCheckRollup: [] }) };
      } } });
    await late.engine.start();
    let feedEvents = 0; late.runtime.feed.on('state', () => { feedEvents++; });
    const pendingFeed = late.runtime.feed.refresh(url);
    late.runtime.ci.watch(late.session); await headStarted.promise;
    await late.engine.dispose(); const eventsBefore = feedEvents;
    link.resolve({ ok: true, stdout: JSON.stringify({ url }) });
    feed.resolve({ ok: true, stdout: '{"data":{}}' }); head.resolve({ ok: true, stdout: 'sha' });
    await pendingFeed; await tick();
    checkEqual('late link/feed/CI answers retain no session, cache, event or timer', [late.session.prUrl || null, late.runtime.links.known.size,
      late.runtime.feed.entries.size, feedEvents, late.delivered, late.timers.tasks.size], [null, 0, 0, eventsBefore, [], 0]);
    checkEqual('a disposed feed refuses writes without reaching a runner', await late.runtime.feed.comment(url, 'must not run'), { ok: false, message: 'PR feed is closed.' });
    checkEqual('closed engine cannot construct a replacement graph implicitly', await (async () => {
      try { late.engine.createPrCi({}); return false; } catch (e) { return /closed/.test(e.message); }
    })(), true);
    const resultCloses = make('result-closes'); await resultCloses.engine.start();
    resultCloses.engine.manager.once('ci-result', () => resultCloses.runtime.dispose());
    resultCloses.runtime.ci.watch(resultCloses.session); await tick();
    resultCloses.world.done = true; resultCloses.advance(15000); resultCloses.timers.fire(); await tick();
    checkEqual('disposal from a result callback cannot install a new strip timer', [resultCloses.runtime.ci.clearTimers.size,
      [...resultCloses.timers.tasks.values()].some((t) => t.ms === 30 * 60000)], [0, false]);
  } finally {
    for (const server of servers.reverse()) await server.dispose();
    for (const engine of engines.reverse()) await engine.dispose();
  }
};

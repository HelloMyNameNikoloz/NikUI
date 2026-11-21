'use strict';

const { CiWatcher } = require('./ci');
const { PrLinks } = require('./prlink');
const { PrFeed } = require('./prView');

const CI_DURATIONS = 'nikui.ciDurations';

function ciHistory(store) {
  if (!store || typeof store.get !== 'function' || typeof store.update !== 'function') throw new Error('CI duration store is required');
  return {
    get: (repo) => (store.get(CI_DURATIONS) || {})[repo] || [],
    add(repo, ms) {
      const all = Object.assign({}, store.get(CI_DURATIONS) || {});
      all[repo] = [ms].concat(all[repo] || []).slice(0, 10);
      store.update(CI_DURATIONS, all);
    }
  };
}

/** The existing CI watch and cache format. The adapter chooses automatic
 * watching and local presentation. ci-result remains the shared delivery event.
 */
function createCi({ manager, store, run, autoWatch, notify = () => {}, now, timers = {} } = {}) {
  if (!manager || typeof run !== 'function' || typeof autoWatch !== 'function') {
    throw new Error('CI manager, runner and auto-watch policy are required');
  }
  return new CiWatcher({ run, history: ciHistory(store), autoWatch, now,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    notify(session, state) { manager.emit('ci-result', session, state); notify(session, state); }
  });
}

/** One engine's PR links/feed and CI watches. Constructing is inert; start()
 * attaches the manager once. Viewers borrow the feed and own only their watch
 * keys. All three services/caches are owned here and retired on engine disposal.
 * Runners are explicit so a headless caller cannot discover gh or credentials.
 */
function createPrCi({ manager, store, runners, autoWatch, notify, now, timers = {} } = {}) {
  if (!runners || typeof runners.links !== 'function' || typeof runners.feed !== 'function') {
    throw new Error('PR link and feed runners are required');
  }
  const ci = createCi({ manager, store, run: runners.ci, autoWatch, notify, now, timers });
  const links = new PrLinks({ run: runners.links, now });
  const feed = new PrFeed({ run: runners.feed, now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  let started = false, disposed = false, detachCi = null, detachLinks = null;
  return {
    ci, links, feed,
    ownership: Object.freeze({ ci: 'owned', links: 'owned', feed: 'owned' }),
    setPr: (session, url) => links.pin(session, url),
    start() {
      if (disposed || started) return;
      started = true;
      detachCi = ci.attach(manager);
      detachLinks = links.attach(manager);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (detachLinks) detachLinks();
      if (detachCi) detachCi();
      ci.dispose(); links.dispose(); feed.dispose();
    }
  };
}

module.exports = { createPrCi, createCi, ciHistory, CI_DURATIONS };

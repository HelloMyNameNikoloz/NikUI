'use strict';

const push = require('./push');
const { summary } = require('./done');

/**
 * What is worth waking a phone for.
 *
 * Three things, and by default nothing else: an instance is **waiting for an
 * answer** and cannot go on without you; the **quota ran out** and everything
 * is holding (and again when it comes back); an instance **failed**. A turn
 * finishing is available and off, because four agents finishing all night is a
 * phone buzzing all night, and a notification you learn to ignore is worse than
 * no notification.
 *
 * Nothing here knows about VS Code. It takes a manager-shaped thing that emits
 * events and a device store, so the rules can be tested without either.
 */
class Notifier {
  /**
   * @param {object} deps
   * @param {object} deps.devices   the paired devices and their subscriptions
   * @param {object} deps.vapid     this window's sending identity
   * @param {() => object} [deps.settings] which kinds are wanted
   * @param {Function} [deps.send]  push.send, injected for the tests
   * @param {(message: object) => number} [deps.toSockets] tell devices that are already here
   * @param {() => number} [deps.now]
   * @param {(line: string) => void} [deps.log]
   */
  constructor(deps) {
    this.devices = deps.devices;
    this.vapid = deps.vapid;
    this.settings = deps.settings || (() => ({}));
    this.sender = deps.send || push.send;
    this.now = deps.now || (() => Date.now());
    this.log = deps.log || (() => {});
    this.subject = deps.subject || 'mailto:nikui@localhost';
    // Whether a device could act on what it is told. Default yes, so nothing
    // that does not supply one goes quiet by accident.
    this.reachable = deps.reachable || (() => true);
    // A device with the app open is already connected. Telling it over the
    // socket it is holding is immediate, costs no push service, and works when
    // nothing outside this machine can reach it at all — which is most of the
    // time, because the tunnel is opt-in.
    this.toSockets = deps.toSockets || (() => 0);
    // The third door, and the only one that needs an account with anybody:
    // Apple's, for an iPhone that is not running. Inert until configured.
    this.apns = deps.apns || null;
    this.toApple = deps.sendApple || require('./apns').send;
    // Who should hear this, if anybody. Without one, everything is broadcast —
    // which is right for one phone and wrong for two: you send a prompt from
    // the phone in your hand and the tablet on the table buzzes about it.
    this.audience = deps.audience || null;
    // What each instance was last announced for, so the same state is not sent
    // twice as it flickers.
    this.told = new Map();
  }

  wants(kind) {
    const on = this.settings() || {};
    if (kind === 'turn-finished') return on.turnFinished === true;
    if (kind === 'needs-you') return on.needsYou !== false;
    if (kind === 'quota') return on.quota !== false;
    if (kind === 'failed') return on.failed !== false;
    if (kind === 'ci') return on.ci !== false;
    // Asked for in the Slack settings, which decide when it rings at all.
    if (kind === 'slack') return on.slack !== false;
    return false;
  }

  /**
   * Send one thing to every device that asked to be told.
   *
   * @returns {Promise<{sent: number, failed: number, attached: number, skipped: boolean}>}
   */
  async announce(kind, message) {
    if (!this.wants(kind)) return { sent: 0, failed: 0, attached: 0, skipped: true };

    // One phone, not all of them: whoever asked for this, else whoever was
    // holding one last. Nobody seen yet is everyone — never nobody, because
    // the phone that has not been touched is the one in a pocket out of the
    // house, and this is what it is for.
    const to = this.audience ? this.audience.who(message.session) : null;

    const body = Object.assign({ kind, at: this.now() }, message, to ? { to } : null);
    // Only the device this is for. Without an audience this is every device,
    // which is the old behaviour and what a window with no phones paired does.
    const mine = (device) => !to || device.id === to;

    // Down the sockets first, because that path needs nothing outside this
    // machine — no tunnel, no push service, no account anywhere.
    let attached = 0;
    try { attached = this.toSockets(body) || 0; }
    catch (err) { this.log(`could not tell attached devices: ${err && err.message}`); }

    if (!this.reachable()) {
      if (!attached) this.log(`"${message.title}" not sent: nothing can reach this window`);
      return { sent: 0, failed: 0, attached, skipped: !attached };
    }
    let sent = 0;
    let failed = 0;

    // An iPhone with the app closed is reachable only through Apple. Skipped
    // entirely, and silently, until somebody has set that up — there is nothing
    // to warn about in a door that was never fitted.
    if (this.apns && this.apns.state().configured) {
      for (const device of this.devices.appleSubscribers().filter(mine)) {
        const outcome = await this.toApple(device.apns.token, body,
          { apns: this.apns, now: this.now() });
        if (outcome.ok) { sent++; continue; }
        failed++;
        this.log(`${device.name} did not get "${message.title}" from Apple: ${outcome.reason || ''}`);
        if (outcome.gone) {
          this.devices.unsubscribeApple(device.id);
          this.devices.record({ device, action: 'notifications stopped', allowed: true,
            detail: 'Apple says this device is gone' });
        }
      }
    }

    const subscribers = this.devices.subscribers().filter(mine);
    if (!subscribers.length) {
      // Delivery over the socket alone is the ordinary case, not an edge: the
      // app is open, nothing is subscribed to a push service, and this used to
      // return here without recording that anything had been said.
      this.spent(to, message.session, attached || sent);
      return { sent, failed, attached, skipped: !attached && !sent && !failed };
    }

    for (const device of subscribers) {
      const outcome = await this.sender(device.push, body, {
        vapid: this.vapid,
        subject: this.subject,
        // Something needing an answer is worth waking a screen for; the rest
        // can wait for the phone to be picked up.
        urgency: kind === 'needs-you' || kind === 'slack' ? 'high' : 'normal',
        now: this.now()
      });
      if (outcome.ok) {
        sent++;
      } else {
        failed++;
        this.log(`${device.name} did not get "${message.title}": ${outcome.status} ${outcome.reason || ''}`);
        // The push service says this subscription no longer exists — the app
        // was removed, or the browser threw it away. Stop writing to it.
        if (outcome.gone) {
          this.devices.unsubscribe(device.id);
          this.devices.record({ device, action: 'notifications stopped', allowed: true,
            detail: 'the push service says this device is gone' });
        }
      }
    }
    this.log(`"${message.title}" → ${sent} device${sent === 1 ? '' : 's'}` +
      (attached ? `, ${attached} already here` : '') + (failed ? `, ${failed} failed` : ''));
    this.spent(to, message.session, sent || attached);
    return { sent, failed, attached, skipped: false };
  }

  /**
   * Said: the instance's news has reached the phone that asked for it. One
   * place, because there are two ways out of `announce`.
   */
  spent(to, instance, reached) {
    if (!this.audience || !to || !reached) return;
    this.audience.delivered(to, instance);
  }

  // ---- the three things ----------------------------------------------------

  needsYou(session) {
    if (this.told.get(session.id) === 'waiting') return Promise.resolve(null);
    this.told.set(session.id, 'waiting');
    const asking = (session.items || []).filter((i) => i.kind === 'permission' && !i.resolved).pop();
    return this.announce('needs-you', {
      title: `${label(session)} needs an answer`,
      body: asking ? `Allow ${asking.name}?` : 'It is waiting for you before it can go on.',
      tag: 'needs-you:' + session.id,
      session: session.id,
      url: '/s/' + session.id
    });
  }

  failed(session, message) {
    if (this.told.get(session.id) === 'failed') return Promise.resolve(null);
    this.told.set(session.id, 'failed');
    return this.announce('failed', {
      title: `${label(session)} failed`,
      body: String(message || 'It stopped without finishing.').slice(0, 160),
      tag: 'failed:' + session.id,
      session: session.id,
      url: '/s/' + session.id
    });
  }

  /** Said the way the laptop's banner says it: who, and the first line of the answer. */
  finished(session) {
    const said = (session.items || []).filter((i) => i.kind === 'text').pop();
    return this.announce('turn-finished', {
      title: `${label(session)} is done`,
      body: summary(said),
      tag: 'finished:' + session.id,
      session: session.id,
      url: '/s/' + session.id
    });
  }

  /**
   * CI on the PR an instance pushed to has come to an end: the laptop's banner,
   * word for word, so the phone and the laptop never disagree about a build.
   */
  ci(session, state) {
    const s = state || {};
    if (!['passed', 'failed', 'none', 'error'].includes(s.phase)) return Promise.resolve(null);
    const pr = s.pr ? `PR #${s.pr.number}` : 'CI';
    const title = s.phase === 'passed' ? `${pr} is green`
      : s.phase === 'failed' ? `${pr} failed` : s.phase === 'none' ? `${pr} has no CI` : 'Cannot watch CI';
    const body = s.phase === 'failed' ? `${(s.failing || []).join(', ')} · ${label(session)}`
      : s.phase === 'error' ? `${s.message} · ${label(session)}`
        : `${s.pr && s.pr.title ? s.pr.title + ' · ' : ''}${label(session)}`;
    return this.announce('ci', {
      title, body,
      tag: 'ci:' + session.id,
      renotify: true,
      session: session.id,
      url: '/s/' + session.id
    });
  }

  paused(pause) {
    const when = pause && pause.until ? new Date(pause.until) : null;
    return this.announce('quota', {
      title: 'The usage limit is spent',
      body: when
        ? `Everything is holding until ${when.toLocaleTimeString()}. Queues are untouched.`
        : 'Everything is holding until the quota resets. Queues are untouched.',
      tag: 'quota',
      renotify: true,
      url: '/'
    });
  }

  resumed({ woken, manual } = {}) {
    // A resume you asked for yourself is not news to the phone you asked from.
    if (manual) return Promise.resolve(null);
    return this.announce('quota', {
      title: 'The quota reset',
      body: woken ? `${woken} instance${woken === 1 ? '' : 's'} carrying on.` : 'Everything is running again.',
      tag: 'quota',
      renotify: true,
      url: '/'
    });
  }

  /**
   * The lid is shut, the battery has reached its floor, and work was running.
   *
   * Sent under "failed" — the work is about to stop without finishing, which is
   * what that switch is for — and before the laptop goes, since afterwards
   * nothing on it can say anything.
   */
  sleeping(why) {
    const w = why || {};
    return this.announce('failed', {
      title: 'Your laptop is going to sleep',
      body: `Battery at ${w.percent}% with the lid closed` +
        (w.reason ? ` — ${w.reason}, and stops until it wakes.` : '.'),
      tag: 'laptop-sleeping',
      renotify: true,
      url: '/'
    });
  }

  /**
   * An instance that has moved on can announce itself again later. Resting in
   * `done` is not moving on: clearing the note there meant every second
   * change to a finished instance — CI polled, the cost recounted — said "is
   * done" all over again, every half a minute until somebody opened it.
   */
  settled(session) {
    if (['waiting', 'error', 'done'].includes(session.status)) return;
    this.told.delete(session.id);
  }

  /** Follow a window: this is the whole wiring, in one readable place. */
  watch(manager) {
    const off = [];
    const on = (event, fn) => { manager.on(event, fn); off.push(() => manager.off(event, fn)); };

    on('session-changed', (session) => {
      if (!session) return;
      if (session.status === 'waiting') return void this.needsYou(session);
      // A turn that has just ended, once. `done` is a resting state and the
      // event fires again for anything else that changes while it rests, so
      // the note of having said it is what stops a second telling.
      const finishing = session.status === 'done' && this.told.get(session.id) !== 'done';
      this.settled(session);
      if (finishing) {
        this.told.set(session.id, 'done');
        // A turn you stopped yourself is not news, as on the laptop.
        const last = (session.items || []).filter((i) => i.kind === 'result').pop();
        if (!(last && last.interrupted)) this.finished(session);
      }
    });
    on('failed', (session, message) => this.failed(session, message));
    on('ci-result', (session, state) => { if (session) this.ci(session, state); });
    on('paused', (pause) => this.paused(pause));
    on('resumed', (what) => this.resumed(what || {}));

    return () => { for (const undo of off) undo(); };
  }
}

const label = (session) => session.customTitle || session.label || 'An instance';

module.exports = { Notifier };

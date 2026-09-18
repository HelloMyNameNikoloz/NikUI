'use strict';

const push = require('./push');

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
    return false;
  }

  /**
   * Send one thing to every device that asked to be told.
   *
   * @returns {Promise<{sent: number, failed: number, skipped: boolean}>}
   */
  async announce(kind, message) {
    if (!this.wants(kind)) return { sent: 0, failed: 0, skipped: true };
    if (!this.reachable()) {
      this.log(`"${message.title}" not sent: nothing can reach this window`);
      return { sent: 0, failed: 0, skipped: true };
    }
    const subscribers = this.devices.subscribers();
    if (!subscribers.length) return { sent: 0, failed: 0, skipped: true };

    let sent = 0;
    let failed = 0;
    for (const device of subscribers) {
      const outcome = await this.sender(device.push, Object.assign({ kind, at: this.now() }, message), {
        vapid: this.vapid,
        subject: this.subject,
        // Something needing an answer is worth waking a screen for; the rest
        // can wait for the phone to be picked up.
        urgency: kind === 'needs-you' ? 'high' : 'normal',
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
    this.log(`"${message.title}" → ${sent} device${sent === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
    return { sent, failed, skipped: false };
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
      url: '/s/' + session.id
    });
  }

  finished(session) {
    return this.announce('turn-finished', {
      title: `${label(session)} finished`,
      body: 'The turn is done.',
      tag: 'finished:' + session.id,
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

  /** An instance that is no longer waiting can announce itself again later. */
  settled(session) {
    if (session.status === 'waiting' || session.status === 'error') return;
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
        this.finished(session);
      }
    });
    on('failed', (session, message) => this.failed(session, message));
    on('paused', (pause) => this.paused(pause));
    on('resumed', (what) => this.resumed(what || {}));

    return () => { for (const undo of off) undo(); };
  }
}

const label = (session) => session.customTitle || session.label || 'An instance';

module.exports = { Notifier };

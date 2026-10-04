'use strict';

// Which phone is told, and when a phone stops being told.
//
// The rules read oddly until you picture the case they are written for: you
// send something from the phone in your hand, put the phone down, and ninety
// minutes later it finishes. The hour is not there to silence that — it is the
// whole reason you sent it from a phone. It is there to stop a phone in a
// drawer being buzzed about work nobody is waiting for.
//
// The clock is injected, so ninety minutes takes no time at all.

const { Audience } = require('../src/audience.js');
const { Notifier } = require('../src/notify.js');

const MINUTE = 60 * 1000;

function clock(start) {
  let at = start || 1_000_000;
  return { now: () => at, tick: (ms) => { at += ms; return at; } };
}

module.exports = async function () {
  suite('the phone that asked is the phone that is told');

  {
    const time = clock();
    const who = new Audience({ now: time.now });

    checkEqual('nobody seen yet is nobody in particular: everyone', who.who('alpha'), null);

    who.steered('alpha', 'phone');
    checkEqual('the phone that sent the prompt owns what comes of it', who.who('alpha'), 'phone');
    checkEqual('and owns the news that belongs to no instance', who.who(null), 'phone');

    who.steered('alpha', 'tablet');
    checkEqual('the last one to steer takes it over', who.who('alpha'), 'tablet');

    who.steered('beta', 'phone');
    checkEqual('each instance is owned separately', who.who('alpha'), 'tablet');
    checkEqual('by whoever steered it', who.who('beta'), 'phone');
    checkEqual('and the newest prompt anywhere owns the rest', who.who(null), 'phone');
  }

  suite('a phone nobody has touched for hours is still told');

  // The phone in a pocket out of the house is the one this is for.
  {
    const time = clock();
    const who = new Audience({ now: time.now });
    who.steered('alpha', 'phone');
    who.steered('beta', 'phone');

    time.tick(5 * 60 * MINUTE);
    checkEqual('what it asked for arrives', who.who('alpha'), 'phone');
    who.delivered('phone', 'alpha');
    checkEqual('and so does what comes after', who.who('beta'), 'phone');
    checkEqual('and news that belongs to no instance', who.who(null), 'phone');
  }

  suite('two phones, and only one of them buzzes');

  {
    const time = clock();
    const who = new Audience({ now: time.now });
    who.steered('alpha', 'in-my-hand');
    who.active('on-the-table');

    checkEqual('the one that sent the prompt is told', who.who('alpha'), 'in-my-hand');

    time.tick(90 * MINUTE);
    who.active('on-the-table');
    checkEqual('an awake phone that did not ask is still not told about it',
      who.who('alpha'), 'in-my-hand');

    // And the other way round: the tablet asks for something of its own.
    who.steered('beta', 'on-the-table');
    checkEqual('what it did ask for goes to it', who.who('beta'), 'on-the-table');
    checkEqual('without taking the first instance away', who.who('alpha'), 'in-my-hand');
  }

  suite('work started at the laptop still reaches a phone in a hand');

  // Most instances are started at the laptop. Without this a phone would only
  // ever hear about work it had sent itself, which is silence for nearly
  // everything worth being told about.
  {
    const time = clock();
    const who = new Audience({ now: time.now });

    who.active('in-my-hand');
    checkEqual('nobody steered it, so the phone being used is told', who.who('alpha'), 'in-my-hand');

    time.tick(10 * MINUTE);
    who.active('the-other-one');
    checkEqual('and it is the one most recently held', who.who('alpha'), 'the-other-one');

    // A phone that asked for something still beats one merely being held.
    who.steered('alpha', 'in-my-hand');
    time.tick(MINUTE);
    who.active('the-other-one');
    checkEqual('asking still beats holding', who.who('alpha'), 'in-my-hand');

    // A phone put down hours ago is still the one somebody took out.
    const cold = new Audience({ now: time.now });
    cold.active('put-down');
    time.tick(5 * 60 * MINUTE);
    checkEqual('a phone put down hours ago is still told', cold.who('alpha'), 'put-down');
  }

  suite('a device that is gone owns nothing');

  {
    const time = clock();
    const who = new Audience({ now: time.now });
    who.steered('alpha', 'phone');
    who.forget('phone');
    checkEqual('its instances are nobody’s', who.who('alpha'), null);
    checkEqual('and it is not the latest either', who.who(null), null);
  }

  suite('the notifier says it to one phone, not to the room');

  {
    const time = clock();
    const who = new Audience({ now: time.now });

    const devices = {
      list: () => [],
      subscribers: () => [
        { id: 'phone', name: 'A phone', push: { endpoint: 'https://push/1', keys: {} } },
        { id: 'tablet', name: 'A tablet', push: { endpoint: 'https://push/2', keys: {} } }
      ],
      appleSubscribers: () => [],
      unsubscribe: () => {},
      record: () => {}
    };

    const sentTo = [];
    const toldOverSocket = [];
    const notifier = new Notifier({
      devices,
      vapid: {},
      audience: who,
      now: time.now,
      settings: () => ({ turnFinished: true }),
      send: async (subscription) => { sentTo.push(subscription.endpoint); return { ok: true }; },
      toSockets: (body) => { toldOverSocket.push(body.to || 'everyone'); return 1; }
    });

    who.steered('alpha', 'tablet');
    await notifier.announce('turn-finished', { title: 'done', session: 'alpha' });
    checkEqual('one push, to the phone that asked', sentTo, ['https://push/2']);
    checkEqual('and the socket message names it too', toldOverSocket, ['tablet']);

    // Nobody has steered this one, so there is nobody it belongs to.
    sentTo.length = 0;
    toldOverSocket.length = 0;
    const quiet = await notifier.announce('turn-finished', { title: 'done', session: 'gamma' });
    checkEqual('an instance nobody steered goes to whoever steered last',
      sentTo, ['https://push/2']);
    void quiet;

    // Nobody seen at all, as after a reload: every device, not none.
    const fresh = new Notifier({
      devices,
      vapid: {},
      audience: new Audience({ now: time.now }),
      now: time.now,
      settings: () => ({ turnFinished: true }),
      send: async (subscription) => { sentTo.push(subscription.endpoint); return { ok: true }; },
      toSockets: (body) => { toldOverSocket.push(body.to || 'everyone'); return 1; }
    });
    sentTo.length = 0;
    toldOverSocket.length = 0;
    await fresh.announce('needs-you', { title: 'waiting', session: 'epsilon' });
    checkEqual('with nobody seen yet, every phone is told', sentTo, ['https://push/1', 'https://push/2']);
    checkEqual('and the socket message names nobody', toldOverSocket, ['everyone']);

    // Hours later the phone that asked is still told, and so is the next thing.
    sentTo.length = 0;
    who.steered('delta', 'tablet');
    time.tick(5 * 60 * MINUTE);
    await notifier.announce('turn-finished', { title: 'late', session: 'delta' });
    await notifier.announce('turn-finished', { title: 'later still', session: 'delta' });
    checkEqual('nothing is dropped for a phone left alone', sentTo, ['https://push/2', 'https://push/2']);
  }
};

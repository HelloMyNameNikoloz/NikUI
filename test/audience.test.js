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

    checkEqual('nobody has asked for anything, so nobody is told', who.who('alpha'), null);

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

  suite('forty minutes is a phone somebody is still holding');

  {
    const time = clock();
    const who = new Audience({ now: time.now });
    who.steered('alpha', 'phone');

    time.tick(40 * MINUTE);
    check('it is still awake', who.awake('phone'));
    checkEqual('so it is told', who.who('alpha'), 'phone');
    checkEqual('and being told costs it nothing', who.delivered('phone', 'alpha'), false);
    check('it is awake afterwards', who.awake('phone'));
  }

  suite('ninety minutes is still yours, and then it is not');

  {
    const time = clock();
    const who = new Audience({ now: time.now });
    who.steered('alpha', 'phone');

    time.tick(90 * MINUTE);
    check('the phone has gone quiet', !who.awake('phone'));
    // The point of the whole feature: you asked for this, and the answer is
    // what you went away to wait for.
    checkEqual('but it asked for this, so it is told', who.who('alpha'), 'phone');
    checkEqual('and that is the last thing it hears', who.delivered('phone', 'alpha'), true);
    check('it is dormant now', who.dormant('phone'));

    who.steered('beta', 'phone');
    // Steering is using the app, so that wakes it — the case below is the one
    // where nothing has been touched at all.
    check('using it again wakes it', !who.dormant('phone'));
  }

  suite('a dormant phone hears nothing at all');

  {
    const time = clock();
    const who = new Audience({ now: time.now });
    who.steered('alpha', 'phone');
    who.steered('beta', 'phone');

    time.tick(90 * MINUTE);
    checkEqual('the first thing it is owed still arrives', who.who('alpha'), 'phone');
    who.delivered('phone', 'alpha');

    checkEqual('and then nothing does, even for work it also asked for',
      who.who('beta'), null);
    checkEqual('nor anything that belongs to no instance', who.who(null), null);

    who.active('phone');
    checkEqual('picking the phone up brings it back', who.who('beta'), 'phone');
    check('and it is awake again', who.awake('phone'));
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

    // And a phone nobody has touched for an hour is not a phone in a hand.
    const cold = new Audience({ now: time.now });
    cold.active('put-down');
    time.tick(90 * MINUTE);
    checkEqual('a phone put down an hour ago is not the one to tell',
      cold.who('alpha'), null);
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

    // And once that phone has been quiet an hour, the thing it asked for
    // arrives and nothing after it does.
    sentTo.length = 0;
    who.steered('delta', 'tablet');
    time.tick(90 * MINUTE);
    await notifier.announce('turn-finished', { title: 'late', session: 'delta' });
    checkEqual('the late answer arrives', sentTo, ['https://push/2']);

    sentTo.length = 0;
    const after = await notifier.announce('turn-finished', { title: 'later still', session: 'delta' });
    checkEqual('and nothing after it', sentTo, []);
    checkEqual('which is said rather than counted as sent', after.skipped, true);
  }
};

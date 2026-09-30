'use strict';
const fs = require('fs');
const { EventEmitter } = require('events');
const { DoneNotifier, summary, SOUND } = require('../src/done.js');

function rig(settings, looking) {
  const heard = { banners: [], chimes: 0 };
  const n = new DoneNotifier({
    settings: () => settings,
    isLookingAt: () => !!looking,
    banner: (title, body) => heard.banners.push({ title, body }),
    chime: () => { heard.chimes++; }
  });
  const manager = new EventEmitter();
  const off = n.watch(manager);
  const session = { id: 's1', label: 'NikUI', status: 'idle', items: [] };
  const go = (status, items) => {
    session.status = status;
    if (items) session.items = items;
    manager.emit('session-changed', session);
  };
  return { heard, go, session, manager, off };
}

const said = (text) => ({ kind: 'text', text });
const ended = (interrupted) => ({ kind: 'result', interrupted: !!interrupted, text: '' });

module.exports = function () {
  suite('telling the laptop an instance is done');

  {
    const r = rig({ popup: false, sound: true });
    r.go('working');
    r.go('done', [said('All green.'), ended()]);
    checkEqual('off by default, so nothing', r.heard, { banners: [], chimes: 0 });
  }

  {
    const r = rig({ popup: true, sound: true });
    r.go('working');
    r.go('done', [said('## Fixed\nThe **tests** pass now.'), ended()]);
    checkEqual('on, a turn ending pops up once, with what it said first', r.heard.banners,
      [{ title: 'NikUI is done', body: 'Fixed' }]);
    checkEqual('and chimes', r.heard.chimes, 1);
    r.go('done');
    r.go('done');
    check('resting at done says nothing more', r.heard.banners.length === 1 && r.heard.chimes === 1);
    r.go('working');
    r.go('waiting');
    r.go('done', [said('Second.'), ended()]);
    checkEqual('the next turn is told again', r.heard.banners.length, 2);
    r.off();
    r.go('working');
    r.go('done');
    checkEqual('and nothing once it is no longer watching', r.heard.banners.length, 2);
  }

  {
    const r = rig({ popup: true, sound: false });
    r.go('working');
    r.go('done', [said('ok'), ended()]);
    check('the chime is optional', r.heard.banners.length === 1 && r.heard.chimes === 0);
  }

  {
    const r = rig({ popup: true, sound: true });
    r.go('working');
    r.go('done', [ended(true)]);
    checkEqual('a turn you stopped yourself is not news', r.heard, { banners: [], chimes: 0 });
    r.go('idle');
    r.go('done');
    checkEqual('nor is arriving at done from anything but work', r.heard.banners.length, 0);
  }

  {
    const r = rig({ popup: true, sound: true }, true);
    r.go('working');
    r.go('done', [said('ok'), ended()]);
    check('looking at it, the chime still plays but nothing pops up',
      r.heard.banners.length === 0 && r.heard.chimes === 1);
  }

  {
    const r = rig({ popup: true, sound: true });
    r.go('working');
    r.manager.emit('removed', r.session);
    r.session.status = 'idle';
    r.go('done');
    checkEqual('a closed instance is forgotten', r.heard.banners.length, 0);
  }

  checkEqual('nothing said, it says it finished', summary(null), 'Finished its turn.');
  checkEqual('a long answer is cut short', summary(said('x'.repeat(300))).length, 140);

  const wav = fs.readFileSync(SOUND);
  check('the chime ships as a wav', wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE');
  check('and lasts about two seconds', Math.abs((wav.length - 44) / 2 / 44100 - 2.2) < 0.01);
};

'use strict';
const { createEscalator } = require('../src/slack/escalate.js');

module.exports = async function () {
  suite('the waiting clock');

  {
    const esc = createEscalator({ popupAfterMs: 60000, alarmAfterMs: 180000 });
    const item = { key: 'C1', conversationId: 'C1', ts: '100.1', from: 'U2', kind: 'vip', text: 'hi' };
    esc.arrive(item, 0);

    checkEqual('nothing is due before the minute is up', esc.due(59999).length, 0);
    const popup = esc.due(60000);
    checkEqual('popup fires right at sixty seconds', popup.length, 1);
    checkEqual('as a popup action', popup[0].action, 'popup');
    checkEqual('not fired twice', esc.due(60001).length, 0);

    checkEqual('nothing new before three minutes', esc.due(179999).length, 0);
    const alarm = esc.due(180000);
    checkEqual('alarm fires at three minutes', alarm.length, 1);
    checkEqual('as an alarm action', alarm[0].action, 'alarm');
    checkEqual('and not again later', esc.due(200000).length, 0);
  }

  {
    const esc = createEscalator({ popupAfterMs: 60000, alarmAfterMs: 180000 });
    esc.arrive({ key: 'C2', conversationId: 'C2', ts: '10', from: 'U2', kind: 'vip', text: 'first' }, 0);
    // A second message in the same conversation 30s later keeps the original clock.
    esc.arrive({ key: 'C2', conversationId: 'C2', ts: '40', from: 'U2', kind: 'vip', text: 'second' }, 30000);
    const popup = esc.due(60000);
    checkEqual('popup still fires at sixty seconds from the first message, not the second', popup.length, 1);
    checkEqual('with the newest text', esc.pending()[0].item.text, 'second');
    checkEqual('and the newest ts', esc.pending()[0].item.ts, '40');
  }

  {
    const esc = createEscalator({ popupAfterMs: 60000, alarmAfterMs: 180000 });
    esc.arrive({ key: 'C3', conversationId: 'C3', ts: '1', from: 'U2', kind: 'mention', text: 'hey' }, 0);
    checkEqual('due before resolving', esc.nextAt(), 60000);
    esc.resolve('C3');
    checkEqual('resolved: nothing due', esc.due(1000000).length, 0);
    checkEqual('and nothing pending', esc.pending().length, 0);
    checkEqual('nextAt is null once everything is resolved', esc.nextAt(), null);
  }

  {
    // Resolving by the item's own key, for a threaded mention distinct from its channel.
    const esc = createEscalator({ popupAfterMs: 60000, alarmAfterMs: 180000 });
    esc.arrive({ key: 'C4:999', conversationId: 'C4', ts: '999', threadTs: '999', from: 'U2', kind: 'mention', text: 'x' }, 0);
    esc.arrive({ key: 'C4', conversationId: 'C4', ts: '5', from: 'U3', kind: 'mention', text: 'y' }, 0);
    checkEqual('two independent waits in the same conversation', esc.pending().length, 2);
    esc.resolve('C4:999');
    checkEqual('resolving one by key leaves the other', esc.pending().length, 1);
    checkEqual('leaving the right one', esc.pending()[0].item.key, 'C4');
  }

  {
    const esc = createEscalator({ popupAfterMs: 60000, alarmAfterMs: 180000 });
    checkEqual('nothing waiting, nothing due', esc.nextAt(), null);
  }
};

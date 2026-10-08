'use strict';

// When an instance was last used, for the phone's Recent list.
//
// A reload restores every instance and rebuilds its transcript, stamping each
// rebuilt item with the moment it was rebuilt. Read naively, that makes every
// instance "just now" after every reload — so the time is taken from the
// transcript's own timestamps instead.

const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function () {
  suite('when an instance was last used');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-activity-'));
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const { Session } = require('../src/session.js');
    const id = 'activity-' + Date.now();
    const dir = path.join(home, '.claude', 'projects', 'somewhere');
    fs.mkdirSync(dir, { recursive: true });
    const lastUsed = Date.parse('2026-09-01T10:00:00Z');
    fs.writeFileSync(path.join(dir, id + '.jsonl'), [
      { type: 'user', timestamp: '2026-09-01T09:00:00Z', message: { content: 'hello' } },
      { type: 'assistant', timestamp: new Date(lastUsed).toISOString(),
        message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } }
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');

    const session = new Session({ cwd: '/nowhere/at/all', claudeSessionId: id });
    checkEqual('an instance nobody has used yet has no time', session.activeAt, 0);
    await session.replayTranscript();
    checkEqual('a restored one takes the transcript\'s last timestamp, not the restore\'s',
      session.activeAt, lastUsed);
    session.dispose();
  } finally {
    process.env.HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
};

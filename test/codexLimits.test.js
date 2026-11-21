'use strict';

// Each ChatGPT account signed in on this machine, and what is left of its limits.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexLimits, codexHomes, nameOf, shape } = require('../src/codexLimits.js');

module.exports = async function () {
  suite('ChatGPT accounts and their Codex limits');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nikacct-'));
  for (const d of ['.codex', '.codex-work', '.codex-old', '.codexfoo']) fs.mkdirSync(path.join(home, d));
  for (const d of ['.codex', '.codex-work', '.codexfoo']) fs.writeFileSync(path.join(home, d, 'auth.json'), '{}');
  const found = codexHomes(home).map((d) => path.basename(d)).sort();
  checkEqual('only signed-in Codex folders count', found, ['.codex', '.codex-work']);
  checkEqual('~/.codex-work is Work', nameOf(path.join(home, '.codex-work'), [1, 2]), 'Work');
  checkEqual('~/.codex beside it is Personal', nameOf(path.join(home, '.codex'), [1, 2]), 'Personal');
  checkEqual('alone it is just ChatGPT', nameOf(path.join(home, '.codex'), [1]), 'ChatGPT');

  const plus = shape('/h/.codex', [1, 2],
    { account: { email: 'me@x', planType: 'plus' } },
    { rateLimits: { primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 200 } },
    rateLimitResetCredits: { credits: [{ status: 'available' }, { status: 'used' }] } });
  checkEqual('the plan by its name', plus.plan, 'Plus');
  checkEqual('both windows, shortest first', plus.windows.map((w) => w.name), ['Five-hour', 'This week']);
  checkEqual('used as a fraction', plus.windows[1].used, 0.43);
  checkEqual('resets in milliseconds', plus.windows[0].resetsAt, 100000);
  checkEqual('only free resets still available', plus.resets, 1);
  const lite = shape('/h/.codex-work', [1, 2], { account: { planType: 'prolite' } },
    { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 10080 }, secondary: null } });
  checkEqual('Pro Lite has only a week', lite.windows.map((w) => w.name), ['This week']);
  checkEqual('and is called so', lite.plan, 'Pro Lite');

  let asked = 0;
  const limits = new CodexLimits({
    homesFn: () => ['/h/.codex', '/h/.codex-work'],
    askFn: (dir) => { asked++; return dir.endsWith('work') ? Promise.reject(new Error('signed out'))
      : Promise.resolve({ account: { account: { planType: 'plus' } }, limits: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } } }); }
  });
  checkEqual('nothing known yet is null, not a wait', limits.current(), null);
  const accounts = await limits.refresh();
  checkEqual('both asked, once', asked, 2);
  checkEqual('the named account first', accounts.map((a) => a.name), ['Work', 'Personal']);
  check('one that could not answer says why', accounts[0].error === 'signed out');
  check('the other has its numbers', accounts[1].windows[0].used === 0.1);
  limits.current();
  checkEqual('fresh numbers are not asked for again', asked, 2);
  fs.rmSync(home, { recursive: true, force: true });
};

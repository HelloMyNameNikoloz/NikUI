'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MacNotifier, BUNDLE_ID } = require('../src/notifier.js');

/** Runs nothing, remembers everything, and makes the compiler's output appear. */
function fakeRun(compiles) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'swiftc') {
      if (!compiles) return { ok: false, code: 1, stdout: '', stderr: 'error: no such tool\n' };
      fs.writeFileSync(args[args.indexOf('-o') + 1], '');
    }
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

module.exports = async function () {
  suite('the clickable banner on a Mac');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-notifier-'));
  try {
    const { run, calls } = fakeRun(true);
    const n = new MacNotifier({ dir, run, platform: 'darwin' });
    check('not built to begin with', !n.isBuilt());
    const [a, b] = await Promise.all([n.ensure(), n.ensure()]);
    check('asked twice at once, it is built once', a && b && calls.filter((c) => c[1] === 'swiftc').length === 1);
    const plist = fs.readFileSync(path.join(n.app, 'Contents', 'Info.plist'), 'utf8');
    check('as an app of its own, named NikUI, with no Dock icon',
      plist.includes(BUNDLE_ID) && plist.includes('<string>NikUI</string>') && /LSUIElement<\/key><true\/>/.test(plist));
    check('signed, so macOS lets it ask to notify', calls.some((c) => /codesign$/.test(c[0]) && c.includes('-')));
    check('with NikUI’s icon', calls.some((c) => /iconutil$/.test(c[0])));
    calls.length = 0;
    await n.ensure();
    checkEqual('once built, it is not built again', calls.length, 0);

    await n.post({ id: 'done-s1', title: 'PR 12 is done', subtitle: 'Peuka', body: 'Tests pass.',
      inbox: '/s/clicks/ab', session: 's1', app: '/Applications/Visual Studio Code.app', folder: '/p' });
    checkEqual('posting runs it as an app, with the words as arguments', calls.pop(),
      ['/usr/bin/open', '-n', '-g', '-W', n.app, '--args', '--post', 'done-s1', 'PR 12 is done', 'Peuka',
        'Tests pass.', '/s/clicks/ab', 's1', '/Applications/Visual Studio Code.app', '/p']);

    fs.writeFileSync(path.join(n.app, 'Contents', 'stamp'), 'older');
    check('a change to its source means a rebuild', !n.isBuilt());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nikui-notifier-'));
    const { run } = fakeRun(false);
    const n = new MacNotifier({ dir: dir2, run, platform: 'darwin' });
    checkEqual('without a compiler it cannot post, so the plain banner is used', await n.post({ id: 'x', title: 't' }), false);
    check('and it says what fixes it', /xcode-select --install/.test(n.broken) && !n.available);
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  check('only on a Mac', !new MacNotifier({ dir: '/tmp', platform: 'linux' }).available);
  check('and only with somewhere to build it', !new MacNotifier({ dir: null, platform: 'darwin' }).available);
};

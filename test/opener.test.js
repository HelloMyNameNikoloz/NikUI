'use strict';

// A file named in a transcript opens where it is meant to be seen.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePath, howToOpen } = require('../src/opener.js');

module.exports = async function () {
  suite('opening a file named in a transcript');

  const home = os.homedir();
  checkEqual('~/ is the home folder, not a folder inside the session', resolvePath('~/Codes/a.pdf', '/work'), path.join(home, 'Codes/a.pdf'));
  checkEqual('an absolute path stays as it is', resolvePath('/Users/x/a.html', '/work'), '/Users/x/a.html');
  checkEqual('a relative path is inside the session', resolvePath('src/a.js', '/work'), '/work/src/a.js');
  checkEqual('a file:// link is its path', resolvePath('file:///tmp/my%20page.html', '/work'), '/tmp/my page.html');
  checkEqual('quotes around it are dropped', resolvePath('`out.pdf`', '/work'), '/work/out.pdf');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikopen-'));
  const make = (name) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); return f; };
  checkEqual('a PDF goes to the browser', howToOpen(make('a.pdf')), 'browser');
  checkEqual('a page goes to the browser', howToOpen(make('index.HTML')), 'browser');
  checkEqual('a picture to the picture viewer', howToOpen(make('shot.png')), 'picture');
  checkEqual('a Word file to the system', howToOpen(make('brief.docx')), 'system');
  checkEqual('code to the editor', howToOpen(make('main.js')), 'editor');
  checkEqual('a folder is shown, not opened as text', howToOpen(dir), 'folder');
  checkEqual('a file that is not there says so', howToOpen(path.join(dir, 'gone.pdf')), 'missing');
  fs.rmSync(dir, { recursive: true, force: true });
};

'use strict';
const fs = require('fs');
const path = require('path');

// Pull the regex and guard out of the shipped file so the test cannot drift
// from what actually runs in the webview.
const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
const reSrc = src.slice(src.indexOf('const PATH_RE = new RegExp('), src.indexOf("'g');") + 5);
const guardSrc = src.slice(src.indexOf('function insideUrl'), src.indexOf('function linkifyPaths'));
const box = {};
new Function('exports', reSrc + '\n' + guardSrc + '\nexports.PATH_RE = PATH_RE; exports.insideUrl = insideUrl;')(box);

function firstMatch(text) {
  box.PATH_RE.lastIndex = 0;
  let m;
  while ((m = box.PATH_RE.exec(text)) !== null) {
    if (box.insideUrl(text, m.index)) continue;
    return { path: m[1], line: m[2] };
  }
  return null;
}

module.exports = function () {
  suite('file references');

  checkEqual('path with a line number', firstMatch('see src/session.js:214 for details'), { path: 'src/session.js', line: '214' });
  checkEqual('bare filename', firstMatch('edited package.json'), { path: 'package.json', line: undefined });
  checkEqual('nested path', firstMatch('open media/panel.css now'), { path: 'media/panel.css', line: undefined });
  checkEqual('dotfile directory', firstMatch('.github/workflows/build.yml:224 fails'), { path: '.github/workflows/build.yml', line: '224' });
  checkEqual('line and column', firstMatch('src/a/b/c.tsx:12:5 column too'), { path: 'src/a/b/c.tsx', line: '12' });
  checkEqual('URLs are left alone', firstMatch('visit https://github.com/peuka/backend/pull/1338'), null);
  checkEqual('URLs ending in a file are left alone', firstMatch('read https://example.com/a/b.json please'), null);
  checkEqual('email addresses are left alone', firstMatch('contact me at name@example.com'), null);
  checkEqual('prose stays prose', firstMatch('plain prose with no paths at all'), null);
  // "js" must not win inside "json".
  checkEqual('longest extension wins', firstMatch('tweak tsconfig.json').path, 'tsconfig.json');
};

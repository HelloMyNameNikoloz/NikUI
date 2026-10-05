'use strict';
const { replies } = require('../media/suggest.js');

module.exports = function () {
  suite('replies a finished turn is waiting for');

  checkEqual('"tell me once it\'s pushed" is answered pushed',
    replies('The comment won\'t mention anyone. Tell me once it\'s pushed.\n\n**Changed files**: a, b.'), ['pushed']);
  checkEqual('"after you push" too', replies('After you push, I\'ll update the description.'), ['pushed']);
  checkEqual('"let me know when you\'ve merged it" is merged',
    replies('Let me know when you\'ve merged it and I will rebase.'), ['merged']);
  checkEqual('asked to reload the window: reloaded', replies('Done. Reload the VS Code window to pick it up.'), ['reloaded']);
  checkEqual('a yes-or-no question: yes and no', replies('Tests pass. Shall I open the PR?'), ['yes', 'no']);
  checkEqual('"want me to" is one as well', replies('Want me to also bump the version?'), ['yes', 'no']);
  checkEqual('a choice offers each option',
    replies('I\'ll wait. Do you want the signed release, the automatic workflow, or just the debug APK for now?'),
    ['the signed release', 'the automatic workflow', 'the debug APK']);
  checkEqual('a version number does not end the sentence',
    replies('Do you want A or the debug APK as v0.2.10?'), ['A', 'the debug APK as v0.2.10']);
  checkEqual('waiting for a go-ahead: go ahead', replies('Publishing is public, so I\'ll wait for your go-ahead.'), ['go ahead']);
  checkEqual('an open question offers nothing', replies('What does the error say?'), []);
  checkEqual('a plain report offers nothing', replies('Fixed the bug. All tests pass.'), []);
  checkEqual('a question in the middle does not count',
    replies('Should I open the PR? I did it anyway. It is up.'), []);
  checkEqual('words inside code do not count',
    replies('Run this:\n```\n# tell me once it\'s pushed\n```\nThat is all.'), []);
  checkEqual('nothing at all offers nothing', replies(''), []);
  check('never more than three',
    replies('Tell me once it\'s pushed. Reload the window. Do you want A, B, or C?').length <= 3);
};

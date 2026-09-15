'use strict';
const { labelFor, shortLabel, urlHint } = require('../src/label.js');

module.exports = function () {
  suite('label');

  checkEqual('a ticket number wins over the prose around it',
    labelFor('#692 phase 4 — finish the migration'), '692');
  checkEqual('a pull request url names itself after the number',
    labelFor('https://github.com/peuka/backend/pull/1327'), '1327');
  checkEqual('an issue url counts too',
    labelFor('please look at https://github.com/peuka/backend/issues/1801 today'), '1801');
  checkEqual('plain prose is trimmed, not numbered',
    labelFor('mobile 691/2 adjustment'), 'mobile 691/2 adjustment');

  checkEqual('urls are stripped out of the prose name',
    shortLabel('see https://example.com/x for the crash'), 'see for the crash');
  checkEqual('pasted images leave no marker',
    shortLabel('fix this [Image: original 2194x1712] please'), 'fix this please');
  checkEqual('long prompts are cut at 28 characters',
    shortLabel('okay, let us pull the latest main branch and rebase'), 'okay, let us pull the latest…');
  checkEqual('the cut length is adjustable', shortLabel('abcdefghij', 4), 'abcd…');
  checkEqual('nothing to name yields null', shortLabel('   '), null);

  checkEqual('a bare link falls back to host and tail',
    labelFor('https://claude.ai/code/artifact/bf3a12'), 'claude.ai/bf3a12');
  checkEqual('a trailing slash does not become the tail',
    urlHint('https://www.example.com/'), 'example.com');
  checkEqual('text with no url has no hint', urlHint('nothing here'), null);
  checkEqual('an empty prompt has no name at all', labelFor(''), null);
};

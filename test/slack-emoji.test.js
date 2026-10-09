'use strict';
const { applyEmoji, SHORTCODES } = require('../src/slack/emoji.js');

module.exports = async function () {
  suite('emoji shortcodes');

  checkEqual('a known shortcode becomes its unicode', applyEmoji('hi :smile:'), 'hi 😄');
  checkEqual('a skin-tone suffix is stripped along with the code', applyEmoji(':thumbsup::skin-tone-2: nice'), '👍 nice');
  checkEqual('an unknown shortcode is left exactly as typed', applyEmoji('say :not_a_real_emoji:'), 'say :not_a_real_emoji:');
  checkEqual('the alias used in the brief', applyEmoji(':+1:'), '👍');
  check('around two hundred shortcodes are covered', Object.keys(SHORTCODES).length >= 150);
  check('slightly_smiling_face is the real Slack name, not a made-up one', SHORTCODES.slightly_smiling_face === '🙂');
  check('smile_cat is covered, the real Slack name', SHORTCODES.smile_cat === '😸');
  checkEqual('plain text with no shortcode is untouched', applyEmoji('nothing here'), 'nothing here');
};

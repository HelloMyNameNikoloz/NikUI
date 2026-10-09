'use strict';
const { toHtml, toPlain } = require('../src/slack/mrkdwn.js');

module.exports = async function () {
  suite('Slack’s own markup, read by hand');

  const names = { U1: 'Anna Lund' };

  checkEqual('a mention becomes a name', toHtml('hi <@U1>', names), 'hi @Anna Lund');
  checkEqual('a labelled mention prefers its own label', toHtml('hi <@U1|anna>', names), 'hi @anna');
  checkEqual('an unresolved mention falls back to the id', toHtml('hi <@U9>', {}), 'hi @U9');
  checkEqual('a channel link becomes #name', toHtml('see <#C1|general>'), 'see #general');
  checkEqual('a labelled link', toHtml('go to <https://x.com|there>'), 'go to <a href="https://x.com">there</a>');
  checkEqual('a bare link', toHtml('go to <https://x.com>'), 'go to <a href="https://x.com">https://x.com</a>');
  checkEqual('a mailto link', toHtml('mail <mailto:a@b.com|me>'), 'mail <a href="mailto:a@b.com">me</a>');
  checkEqual('bold', toHtml('say *this*'), 'say <strong>this</strong>');
  checkEqual('italic', toHtml('say _this_'), 'say <em>this</em>');
  checkEqual('strikethrough', toHtml('say ~this~'), 'say <del>this</del>');
  checkEqual('inline code', toHtml('run `ls -la`'), 'run <code>ls -la</code>');
  checkEqual('a code block, newlines kept literal', toHtml('```one\ntwo```'), '<pre><code>one\ntwo</code></pre>');
  checkEqual('a blockquote line', toHtml('> quoted\nplain'), '<blockquote>quoted</blockquote><br>plain');
  checkEqual('newlines become <br>', toHtml('a\nb'), 'a<br>b');

  // XSS: nothing in the raw text becomes a tag or a runnable href.
  check('a literal <script> stays escaped text', toHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
  check('a double quote is escaped', toHtml('say "hi"').includes('&quot;hi&quot;'));
  check('a javascript: link is never linkified', !toHtml('<javascript:alert(1)>').includes('<a '));
  check('an mention label cannot carry a tag', !toHtml('<@U1|<img src=x onerror=alert(1)>>', {}).includes('<img'));
  check('a link label cannot carry a tag', !toHtml('<https://x.com|<img src=x>>').includes('<img'));

  // toPlain: resolved, flat, short.
  checkEqual('plain resolves a mention', toPlain('hi <@U1>', names), 'hi @Anna Lund');
  checkEqual('plain drops markup', toPlain('say *bold* and _italic_ and `code`'), 'say bold and italic and code');
  checkEqual('plain collapses newlines', toPlain('a\nb\nc'), 'a b c');
  checkEqual('plain prefers a link’s label', toPlain('see <https://x.com|here>'), 'see here');
  {
    const long = 'x'.repeat(200);
    const plain = toPlain(long);
    check('plain truncates to 140 chars with an ellipsis', plain.length === 140 && plain.endsWith('…'));
  }
  checkEqual('short text is untouched by truncation', toPlain('short'), 'short');

  // Emoji shortcodes: converted before any markup is stripped, unknown ones
  // left exactly as typed, underscores included.
  checkEqual('a shortcode becomes its emoji in html', toHtml(':slightly_smiling_face: hi'), '🙂 hi');
  checkEqual('a shortcode becomes its emoji in plain', toPlain(':slightly_smiling_face: hi'), '🙂 hi');
  checkEqual('an unknown shortcode keeps its underscores in html',
    toHtml(':totally_unknown_code:'), ':totally_unknown_code:');
  checkEqual('an unknown shortcode keeps its underscores in plain',
    toPlain(':totally_unknown_code:'), ':totally_unknown_code:');
  checkEqual('a skin-tone suffix does not leak into the text',
    toPlain(':thumbsup::skin-tone-2: nice work'), '👍 nice work');
};

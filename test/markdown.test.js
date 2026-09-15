'use strict';
const { renderMarkdown } = require('../media/markdown.js');

module.exports = function () {
  suite('markdown');

  const doc = [
    '# Heading', '',
    'Some **bold**, *italic*, `inline code`, and a [link](https://example.com).', '',
    '| Check | Status |', '| --- | --- |', '| Build | ok |', '',
    '- one', '- two', '  - nested', '',
    '1. first', '2. second', '',
    '> quoted line', '',
    '```js', 'const x = 1 < 2 && "a";', '```', '',
    'Injection: <script>alert(1)</script> and <img src=x onerror=alert(1)>', '',
    'Bad link: [click](javascript:alert(1))'
  ].join('\n');
  const html = renderMarkdown(doc);

  check('escapes script tags', !/<script>/.test(html));
  check('no injectable img handler', !/<img[^>]*onerror/.test(html));
  check('neutralises javascript: urls', !/href="javascript:/i.test(html));
  check('keeps safe links', /href="https:\/\/example.com"/.test(html));
  check('renders tables', /<table><thead>/.test(html));
  check('wraps tables for overflow', /<div class="table-wrap">/.test(html));
  check('renders nested lists', /<li>two<ul>|<ul><li>nested/.test(html));
  check('renders ordered lists', /<ol>/.test(html));
  check('tags code fences with a language', /<pre data-lang="js">/.test(html));
  check('escapes code contents', /1 &lt; 2 &amp;&amp;/.test(html));
  check('renders inline code', /<code>inline code<\/code>/.test(html));
  check('renders blockquotes', /<blockquote>/.test(html));

  // The bug from the screenshot: a pipe inside inline code invented columns and
  // pushed the row out of the table.
  const tricky = [
    "| Ask | Status | Evidence |",
    '| --- | --- | --- |',
    "| 1. base ref | OK | `build.yml:224` replaces `\\` with `a|b` then fails |",
    '| 2. ragged | OK | a | b | c | d |',
    '| 3. short | OK |'
  ].join('\n');
  const t = renderMarkdown(tricky);
  const bodyRows = t.split('</tr>').filter((r) => r.includes('<td>'));
  checkEqual('every body row matches the header width', bodyRows.map((r) => (r.match(/<td>/g) || []).length), [3, 3, 3]);
  check('pipes inside code do not split cells', /<code>a\|b<\/code>/.test(t));

  // Links with balanced parens, which wiki-style URLs rely on.
  const wiki = renderMarkdown('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))');
  check('link keeps balanced parens', /href="https:\/\/en.wikipedia.org\/wiki\/Foo_\(bar\)"/.test(wiki));
};

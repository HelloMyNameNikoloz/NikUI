'use strict';
const { highlight, detect } = require('../media/highlight.js');
const { renderMarkdown } = require('../media/markdown.js');

// The text a reader sees: tags gone, entities back.
const text = (html) => html.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const has = (html, cls, word) => html.includes('<span class="tk-' + cls + '">' + word + '</span>');

module.exports = function () {
  suite('code colouring: what the fence says');

  const py = highlight('# Fake\ndef func_fake_get_detail(arg_id):\n  return {"id": arg_id}\n', 'python');
  check('python: comment, def, function name, return, string', has(py.html, 'comment', '# Fake') && has(py.html, 'kw', 'def') &&
    has(py.html, 'fn', 'func_fake_get_detail') && has(py.html, 'ctl', 'return') && has(py.html, 'str', '&quot;id&quot;'));
  check('python: f-strings and decorators', has(highlight('@property\ndef x(self): return f"{a}"', 'py').html, 'str', 'f&quot;{a}&quot;') &&
    has(highlight('@property\ndef x(self): pass', 'py').html, 'fn', '@property'));

  const java = highlight('public class App {\n  public static void main(String[] args) { System.out.println(42); }\n}', 'java').html;
  check('java: keywords, class name, types, calls, numbers', has(java, 'kw', 'public') && has(java, 'type', 'App') &&
    has(java, 'type', 'String') && has(java, 'fn', 'println') && has(java, 'num', '42'));

  const js = highlight('const re = /a+b/g; // x\nif (ok) return `t`;', 'js').html;
  check('javascript: regex, comment, template string, control flow', has(js, 'rx', '/a+b/g') && has(js, 'comment', '// x') &&
    has(js, 'str', '`t`') && has(js, 'ctl', 'if'));

  const vue = highlight('<template><p :a="b">{{ msg }}</p></template>\n<script>\nexport default {}\n</script>\n<style>\n.a { color: red; }\n</style>', 'vue').html;
  check('vue: tags, attributes, interpolation, script and style inside', has(vue, 'tag', 'template') && has(vue, 'attr', ':a') &&
    has(vue, 'var', 'msg') && has(vue, 'ctl', 'export') && has(vue, 'sel', '.a') && has(vue, 'var', 'color') && has(vue, 'val', 'red'));

  const css = highlight('a:hover, .b {\n  margin: 0 4px !important;\n  .nested { x: y; }\n}', 'scss').html;
  check('css: selectors, properties, units, nesting', has(css, 'sel', 'a:hover') && has(css, 'num', '4px') &&
    has(css, 'kw', '!important') && has(css, 'sel', '.nested'));

  const sh = highlight('$ npm install && echo "$HOME" # hi', 'bash').html;
  check('shell: prompt, commands, strings, comments', has(sh, 'fn', 'npm') && has(sh, 'fn', 'echo') && has(sh, 'comment', '# hi'));

  check('a fence that says text stays plain', highlight('def x(): pass', 'text').lang === null &&
    !highlight('def x(): pass', 'text').html.includes('<span'));

  suite('code colouring: guessing the language');

  const cases = [
    ['def a(x):\n    return x', 'python'],
    ['import os\nprint(os.getcwd())', 'python'],
    ['public class A {\n  int x = 1;\n}', 'java'],
    ['const x = require("y");\nmodule.exports = x;', 'js'],
    ['interface A { b: string }\nexport const a: A = { b: "" };', 'ts'],
    ['<template>\n  <div/>\n</template>', 'vue'],
    ['<div class="a"><p>hi</p></div>', 'html'],
    ['.a {\n  color: red;\n}', 'css'],
    ['cd app && npm run build', 'shell'],
    ['SELECT id FROM users WHERE id = 1;', 'sql'],
    ['name: ci\non:\n  push: true', 'yaml'],
    ['{"a": [1, 2]}', 'json']
  ];
  for (const [code, want] of cases) checkEqual('recognises ' + want + ': ' + code.split('\n')[0], detect(code), want);

  const prose = [
    'This is just a normal sentence.\nAnd another one.',
    'Note: run it again.\nSee: the docs.',
    'make sure it builds.',
    'src/a.js\nsrc/b.js',
    '1. first thing\n2. second thing'
  ];
  for (const p of prose) checkEqual('leaves prose plain: ' + p.split('\n')[0], detect(p), null);

  suite('code colouring is still escaping');

  const nasty = '<img src=x onerror=alert(1)>\n<script>alert("x")</script>\n"</span><b>"';
  for (const lang of ['html', 'js', 'python', 'css', 'bash', 'yaml', 'sql', 'json', 'diff', 'go', '']) {
    const out = highlight(nasty, lang).html;
    check(lang + ': no tag of the input survives', !/<(img|script|b)\b/i.test(out));
    checkEqual(lang + ': and every character is still there', text(out), nasty);
  }
  const unterminated = ['"never closed', '/* open', '<div a="x', '.a { color: ', "f'''x", '`tpl ${'];
  for (const u of unterminated) checkEqual('unfinished code keeps its text: ' + u, text(highlight(u, detect(u) ? '' : 'js').html), u);

  suite('fences in markdown');

  const md = renderMarkdown('```\ndef a():\n    return 1\n```\n\n```\nJust words here.\n```');
  check('an unlabelled fence is labelled with what it was recognised as', /<pre data-lang="" data-label="python">/.test(md));
  check('without claiming the fence said so, which the run button trusts', !/data-lang="python"/.test(md));
  check('and coloured', /tk-kw">def</.test(md));
  check('prose in a fence is left alone', /<pre data-lang="" data-label=""><code>Just words here\.<\/code>/.test(md));
};

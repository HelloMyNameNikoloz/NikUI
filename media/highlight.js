/* Syntax colouring for fenced code blocks, dependency-free.

   The fence's language is used when it names one; otherwise the language is
   guessed from the code, and anything that does not look like code stays plain
   text. Every piece of the source is escaped on its way out and only our own
   <span class="tk-…"> tags are added, so this is as safe as escaping it whole.
   The colours themselves are VS Code's Dark+ and Light+ (panel.css). */
(function (root) {
  'use strict';

  // Past this, colouring is not worth the time it takes on a phone.
  const MAX = 100000;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function span(cls, text) {
    if (!text) return '';
    return cls ? '<span class="tk-' + cls + '">' + esc(text) + '</span>' : esc(text);
  }

  function words(s) { return new Set(s.split(/\s+/).filter(Boolean)); }

  // ---- languages written as code -------------------------------------------

  const JS_STORAGE = 'var let const function class extends new this super typeof instanceof void delete in of async get set static';
  const JS_CONTROL = 'if else for while do return import export from default switch case break continue try catch finally throw await yield as with debugger';
  const JS_CONST = 'true false null undefined NaN Infinity';

  const JS = {
    line: ['//'], block: [['/*', '*/']], quotes: ['`', '"', "'"], multiline: ['`'],
    storage: words(JS_STORAGE), control: words(JS_CONTROL), constants: words(JS_CONST), types: words(''),
    defName: { function: 'fn', class: 'type' }, capsType: true, vars: true, regex: true, decorator: true
  };

  const TS = Object.assign({}, JS, {
    storage: words(JS_STORAGE + ' interface type enum implements declare namespace module abstract public private protected readonly keyof infer is satisfies'),
    types: words('string number boolean any unknown never object symbol bigint'),
    defName: { function: 'fn', class: 'type', interface: 'type', type: 'type', enum: 'type' }
  });

  const PYTHON = {
    line: ['#'], block: [], quotes: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"], strPrefix: true,
    storage: words('def class lambda and or not in is global nonlocal del async'),
    control: words('if elif else for while return import from as try except finally raise with yield break continue pass await assert match case'),
    constants: words('True False None'),
    types: words('int float str bool list dict set tuple bytes bytearray object type complex frozenset'),
    defName: { def: 'fn', class: 'type' }, capsType: true, vars: true, decorator: true
  };

  const JAVA_STORAGE = 'abstract boolean byte char class double enum extends final float implements int interface long native new package ' +
    'private protected public short static strictfp super synchronized this transient void volatile var record sealed permits';
  const JAVA_CONTROL = 'if else for while do return import switch case default break continue try catch finally throw throws assert yield';

  const JAVA = {
    line: ['//'], block: [['/*', '*/']], quotes: ['"""', '"', "'"], multiline: ['"""'],
    storage: words(JAVA_STORAGE), control: words(JAVA_CONTROL), constants: words('true false null'), types: words(''),
    defName: { class: 'type', interface: 'type', enum: 'type', record: 'type' }, capsType: true, vars: true, decorator: true
  };

  // C, C++, C#, Go, Rust, Kotlin, Swift, PHP, Scala, Dart: one generous set
  // of keywords is closer to right for all of them than plain text is.
  const CLIKE = {
    line: ['//'], block: [['/*', '*/']], quotes: ['"""', '"', "'", '`'], multiline: ['"""', '`'],
    storage: words(JAVA_STORAGE + ' auto const struct union typedef unsigned signed sizeof template typename namespace using virtual ' +
      'override inline extern register fn let mut impl trait pub use mod crate Self where type func chan map go defer interface ' +
      'val fun object companion data open internal lateinit init protocol extension def function echo readonly'),
    control: words(JAVA_CONTROL + ' goto defer select match when guard elif foreach unless loop in'),
    constants: words('true false null nil None nullptr NULL Some Ok Err'),
    types: words('string bool int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 usize isize i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 str'),
    defName: { fn: 'fn', func: 'fn', fun: 'fn', function: 'fn', def: 'fn', class: 'type', struct: 'type', trait: 'type',
      interface: 'type', enum: 'type', impl: 'type', type: 'type', protocol: 'type' },
    capsType: true, vars: true, decorator: true, dollarVars: true, preprocessor: true
  };

  const JSON_LANG = {
    line: [], block: [], quotes: ['"'], multiline: [], keyStrings: true,
    storage: words(''), control: words(''), constants: words('true false null'), types: words(''), defName: {}
  };

  const SQL = {
    line: ['--'], block: [['/*', '*/']], quotes: ["'", '"', '`'], multiline: ["'"], ci: true,
    storage: words('select from where insert into values update set delete create table alter drop index join left right inner outer ' +
      'full cross on group by order having limit offset as and or not null is in exists like ilike between case when then else end ' +
      'distinct union all primary key foreign references default unique check constraint view begin commit rollback transaction ' +
      'returning with if replace asc desc grant revoke truncate cascade database schema add column rename to using natural over partition'),
    control: words(''),
    constants: words('true false'),
    types: words('int integer smallint bigint serial bigserial varchar char text boolean bool date time timestamp timestamptz ' +
      'interval numeric decimal real float double precision json jsonb uuid bytea'),
    defName: {}
  };

  const CODE = { js: JS, ts: TS, python: PYTHON, java: JAVA, clike: CLIKE, json: JSON_LANG, sql: SQL };

  const ID = /[A-Za-z_$À-￿][\w$À-￿]*/y;
  const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
  const REGEX_BEFORE = /^(|[(,=:[!&|?{};+\-*%<>~^]|return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

  function matchAt(re, src, i) {
    re.lastIndex = i;
    const m = re.exec(src);
    return m ? m[0] : null;
  }

  function nextChar(src, i) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
    return src[i] || '';
  }

  /** Where a string that opens at i with `q` ends. */
  function stringEnd(src, i, q, multiline) {
    let j = i + q.length;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (src.startsWith(q, j)) return j + q.length;
      if (c === '\n' && !multiline) return j;
      j++;
    }
    return src.length;
  }

  function scanCode(src, L) {
    let out = '';
    let i = 0;
    const n = src.length;
    let prev = '';       // the last thing that was not whitespace or a comment
    let pendingDef = null;

    while (i < n) {
      const c = src[i];

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        let j = i + 1;
        while (j < n && /\s/.test(src[j])) j++;
        out += esc(src.slice(i, j));
        i = j;
        continue;
      }

      const line = L.line.find((t) => src.startsWith(t, i));
      if (line) {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        out += span('comment', src.slice(i, j));
        i = j;
        continue;
      }

      const block = L.block.find((b) => src.startsWith(b[0], i));
      if (block) {
        let j = src.indexOf(block[1], i + block[0].length);
        j = j < 0 ? n : j + block[1].length;
        out += span('comment', src.slice(i, j));
        i = j;
        continue;
      }

      // #include, #define: the line is the directive.
      if (L.preprocessor && c === '#' && /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i)) && /[a-z]/.test(src[i + 1] || '')) {
        const word = matchAt(/#\s*[a-z]+/y, src, i);
        out += span('ctl', word);
        i += word.length;
        prev = word;
        continue;
      }

      const q = L.quotes.find((t) => src.startsWith(t, i));
      if (q) {
        const j = stringEnd(src, i, q, L.multiline.includes(q));
        const text = src.slice(i, j);
        out += span(L.keyStrings && nextChar(src, j) === ':' ? 'var' : 'str', text);
        i = j;
        prev = 'str';
        pendingDef = null;
        continue;
      }

      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const num = matchAt(NUM, src, i);
        if (num) {
          out += span('num', num);
          i += num.length;
          prev = 'num';
          pendingDef = null;
          continue;
        }
      }

      if (L.decorator && c === '@' && /[A-Za-z_]/.test(src[i + 1] || '')) {
        const name = matchAt(/@[\w.]+/y, src, i);
        out += span('fn', name);
        i += name.length;
        prev = name;
        continue;
      }

      if (L.dollarVars && c === '$' && /[A-Za-z_]/.test(src[i + 1] || '')) {
        const name = matchAt(/\$\w+/y, src, i);
        out += span('var', name);
        i += name.length;
        prev = 'id';
        continue;
      }

      const word = matchAt(ID, src, i);
      if (word) {
        // A Python prefix is part of the string it is stuck to: f"…", rb'…'.
        if (L.strPrefix && /^[rRbBuUfF]{1,2}$/.test(word)) {
          const sq = L.quotes.find((t) => src.startsWith(t, i + word.length));
          if (sq) {
            const j = stringEnd(src, i + word.length, sq, L.multiline.includes(sq));
            out += span('str', src.slice(i, j));
            i = j;
            prev = 'str';
            continue;
          }
        }
        const key = L.ci ? word.toLowerCase() : word;
        let cls;
        if (pendingDef) { cls = pendingDef; pendingDef = null; }
        else if (L.control.has(key)) cls = 'ctl';
        else if (L.storage.has(key) || L.constants.has(key)) cls = 'kw';
        else if (L.types.has(key)) cls = 'type';
        else if (nextChar(src, i + word.length) === '(') cls = 'fn';
        else if (L.capsType && /^[A-Z]/.test(word) && /[a-z]/.test(word)) cls = 'type';
        else if (L.capsType && /^[A-Z][A-Z0-9_]+$/.test(word)) cls = 'const';
        else cls = L.vars ? 'var' : '';
        if (L.defName[key] && cls !== 'var' && cls !== 'fn') pendingDef = L.defName[key];
        out += span(cls, word);
        i += word.length;
        prev = key;
        continue;
      }

      if (L.regex && c === '/' && REGEX_BEFORE.test(prev)) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n && src[j] !== '\n') {
          const d = src[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { ok = true; j++; break; }
          j++;
        }
        if (ok && j > i + 2) {
          while (j < n && /[a-z]/.test(src[j])) j++;
          out += span('rx', src.slice(i, j));
          i = j;
          prev = 'rx';
          continue;
        }
      }

      out += esc(c);
      prev = c;
      pendingDef = null;
      i++;
    }
    return out;
  }

  // ---- markup: HTML, XML, Vue ----------------------------------------------

  function scanMarkup(src, vue) {
    let out = '';
    let i = 0;
    const n = src.length;

    while (i < n) {
      if (src.startsWith('<!--', i)) {
        let j = src.indexOf('-->', i + 4);
        j = j < 0 ? n : j + 3;
        out += span('comment', src.slice(i, j));
        i = j;
        continue;
      }

      if (src[i] === '<' && /[A-Za-z!/?]/.test(src[i + 1] || '')) {
        const open = matchAt(/<(\/?)([!?]?[A-Za-z][\w:.-]*)/y, src, i);
        if (open) {
          const closing = open[1] === '/';
          const name = open.slice(closing ? 2 : 1);
          out += span('punct', closing ? '</' : '<') + span('tag', name);
          i += open.length;
          let attrs = '';
          let selfClosed = false;
          while (i < n) {
            const c = src[i];
            if (/\s/.test(c)) { out += esc(c); i++; continue; }
            if (src.startsWith('/>', i) || src.startsWith('?>', i)) { out += span('punct', src.slice(i, i + 2)); i += 2; selfClosed = true; break; }
            if (c === '>') { out += span('punct', '>'); i++; break; }
            if (c === '"' || c === "'") {
              let j = src.indexOf(c, i + 1);
              j = j < 0 ? n : j + 1;
              attrs += src.slice(i, j);
              out += span('str', src.slice(i, j));
              i = j;
              continue;
            }
            if (c === '=') { attrs += '='; out += esc(c); i++; continue; }
            const attr = matchAt(/[^\s=>/"']+/y, src, i);
            if (attr) { attrs += ' ' + attr; out += span('attr', attr); i += attr.length; continue; }
            out += esc(c);
            i++;
          }
          // What is inside <script> and <style> is a language of its own.
          const lower = name.toLowerCase();
          if (!closing && !selfClosed && (lower === 'script' || lower === 'style')) {
            const end = src.toLowerCase().indexOf('</' + lower, i);
            const stop = end < 0 ? n : end;
            const inner = src.slice(i, stop);
            const ts = /\blang=["']?(ts|tsx|typescript)\b/i.test(attrs);
            out += lower === 'style' ? scanCss(inner) : scanCode(inner, ts ? TS : JS);
            i = stop;
          }
          continue;
        }
      }

      if (vue && src.startsWith('{{', i)) {
        let j = src.indexOf('}}', i + 2);
        if (j < 0) j = n;
        out += span('punct', '{{') + scanCode(src.slice(i + 2, j), JS) + (j < n ? span('punct', '}}') : '');
        i = Math.min(n, j + 2);
        continue;
      }

      let j = i + 1;
      while (j < n && src[j] !== '<' && !(vue && src.startsWith('{{', j))) j++;
      out += esc(src.slice(i, j));
      i = j;
    }
    return out;
  }

  // ---- CSS, SCSS, Less -----------------------------------------------------

  function scanCss(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let depth = 0;
    let mode = 'sel'; // sel | prop | val | at

    // In a block, a statement is a property unless a { comes first: then it
    // is a nested selector (SCSS, Less, CSS nesting).
    const statementMode = () => {
      if (depth === 0) return 'sel';
      for (let j = i; j < n; j++) {
        const c = src[j];
        if (c === '{') return 'sel';
        if (c === ';' || c === '}') return 'prop';
      }
      return 'prop';
    };

    while (i < n) {
      const c = src[i];

      if (/\s/.test(c)) { out += esc(c); i++; continue; }

      if (src.startsWith('/*', i)) {
        let j = src.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        out += span('comment', src.slice(i, j));
        i = j;
        continue;
      }
      if (mode !== 'val' && src.startsWith('//', i)) {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        out += span('comment', src.slice(i, j));
        i = j;
        continue;
      }

      if (c === '"' || c === "'") {
        const j = stringEnd(src, i, c, false);
        out += span('str', src.slice(i, j));
        i = j;
        continue;
      }

      if (c === '{') { out += esc(c); depth++; i++; mode = statementMode(); continue; }
      if (c === '}') { out += esc(c); depth = Math.max(0, depth - 1); i++; mode = statementMode(); continue; }
      if (c === ';') { out += esc(c); i++; mode = statementMode(); continue; }

      if (c === '@' && /[\w-]/.test(src[i + 1] || '')) {
        const at = matchAt(/@[\w-]+/y, src, i);
        out += span('ctl', at);
        i += at.length;
        mode = 'at';
        continue;
      }

      if (mode === 'sel') {
        const sel = matchAt(/[^\s{},;/]+/y, src, i);
        if (sel) { out += span('sel', sel); i += sel.length; continue; }
        out += esc(c);
        i++;
        continue;
      }

      if (mode === 'prop') {
        if (depth > 0 && statementMode() === 'sel') { mode = 'sel'; continue; }
        const prop = matchAt(/[-\w$]+/y, src, i);
        if (prop) { out += span('var', prop); i += prop.length; continue; }
        if (c === ':') { out += esc(c); i++; mode = 'val'; continue; }
        out += esc(c);
        i++;
        continue;
      }

      // A value, or the rest of an at-rule's line.
      if (c === '!' && /^!important/i.test(src.slice(i, i + 10))) {
        out += span('kw', src.slice(i, i + 10));
        i += 10;
        continue;
      }
      if (c === '#' && /[\da-fA-F]/.test(src[i + 1] || '')) {
        const hex = matchAt(/#[\da-fA-F]+/y, src, i);
        out += span('val', hex);
        i += hex.length;
        continue;
      }
      if (/[\d.]/.test(c) || (c === '-' && /[\d.]/.test(src[i + 1] || ''))) {
        const num = matchAt(/-?(?:\d*\.)?\d+(?:%|[a-zA-Z]+)?/y, src, i);
        if (num) { out += span('num', num); i += num.length; continue; }
      }
      const word = matchAt(/-?-?[A-Za-z_][\w-]*/y, src, i);
      if (word) {
        const cls = word.startsWith('--') ? 'var' : nextChar(src, i + word.length) === '(' ? 'fn' : mode === 'at' ? '' : 'val';
        out += span(cls, word);
        i += word.length;
        continue;
      }
      if (c === '$' && /[\w-]/.test(src[i + 1] || '')) {
        const v = matchAt(/\$[\w-]+/y, src, i);
        out += span('var', v);
        i += v.length;
        continue;
      }
      out += esc(c);
      i++;
    }
    return out;
  }

  // ---- shell ---------------------------------------------------------------

  const SH_KEYWORDS = words('if then else elif fi for while until do done case esac in function select return export local ' +
    'declare readonly unset source alias time');
  // After these a new command starts.
  const SH_RESTART = words('if then else elif do while until time');

  function scanShell(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let cmd = true;

    while (i < n) {
      const c = src[i];

      if (c === '\n') { out += '\n'; i++; cmd = true; continue; }
      if (/\s/.test(c)) { out += esc(c); i++; continue; }

      const lineStart = i === 0 || src[i - 1] === '\n';
      // A console prompt, as in "$ npm install".
      if (lineStart && (c === '$' || c === '>' || c === '%') && src[i + 1] === ' ') {
        out += span('punct', c);
        i++;
        cmd = true;
        continue;
      }

      if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        out += span('comment', src.slice(i, j));
        i = j;
        continue;
      }

      if (c === "'") {
        let j = src.indexOf("'", i + 1);
        j = j < 0 ? n : j + 1;
        out += span('str', src.slice(i, j));
        i = j;
        cmd = false;
        continue;
      }
      if (c === '"') {
        const j = stringEnd(src, i, '"', true);
        out += span('str', src.slice(i, j));
        i = j;
        cmd = false;
        continue;
      }

      if (c === '$') {
        if (src[i + 1] === '(') { out += span('punct', '$('); i += 2; cmd = true; continue; }
        const v = matchAt(/\$(?:\{[^}\n]*\}?|\w+|[@#?$!*0-9-])/y, src, i);
        if (v) { out += span('var', v); i += v.length; cmd = false; continue; }
      }

      if ('|&;()`'.includes(c)) {
        const op = matchAt(/\|\||&&|;;|[|&;()`]/y, src, i);
        out += esc(op);
        i += op.length;
        cmd = true;
        continue;
      }

      const word = matchAt(/[^\s|&;()<>'"`$]+/y, src, i);
      if (word) {
        if (SH_KEYWORDS.has(word)) {
          out += span('ctl', word);
          cmd = SH_RESTART.has(word);
        } else if (cmd && /^[A-Za-z_]\w*=/.test(word)) {
          const eq = word.indexOf('=');
          out += span('var', word.slice(0, eq)) + esc(word.slice(eq));
        } else if (cmd) {
          out += span('fn', word);
          cmd = false;
        } else if (/^-?\d+(\.\d+)?$/.test(word)) {
          out += span('num', word);
        } else {
          out += esc(word);
        }
        i += word.length;
        continue;
      }

      out += esc(c);
      i++;
    }
    return out;
  }

  // ---- line-shaped languages -----------------------------------------------

  function scanYaml(src) {
    return src.split('\n').map((line) => {
      if (/^\s*#/.test(line)) return span('comment', line);
      if (/^(---|\.\.\.)\s*$/.test(line)) return span('punct', line);
      const m = line.match(/^(\s*(?:-\s+)?)([^\s#:'"][^:#]*?|"[^"]*"|'[^']*')(\s*:)(?=\s|$)(.*)$/);
      if (m) return esc(m[1]) + span('tag', m[2]) + esc(m[3]) + yamlValue(m[4]);
      const item = line.match(/^(\s*-\s+)(.*)$/);
      if (item) return esc(item[1]) + yamlValue(item[2]);
      return yamlValue(line);
    }).join('\n');
  }

  function yamlValue(text) {
    const m = text.match(/^(\s*)(.*?)(\s+#.*)?$/);
    const lead = m[1];
    const value = m[2];
    const comment = m[3] || '';
    let cls = 'str';
    if (!value) cls = '';
    else if (/^(true|false|yes|no|on|off|null|~)$/i.test(value)) cls = 'kw';
    else if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value)) cls = 'num';
    else if (/^[&*][\w-]+$/.test(value)) cls = 'type';
    else if (/^[|>][-+]?$/.test(value)) cls = 'punct';
    return esc(lead) + span(cls, value) + span('comment', comment);
  }

  function scanDiff(src) {
    return src.split('\n').map((line) => {
      if (/^(diff |index |\+\+\+ |--- )/.test(line)) return span('head', line);
      if (line.startsWith('@@')) return span('meta', line);
      if (line.startsWith('+')) return span('ins', line);
      if (line.startsWith('-')) return span('del', line);
      return esc(line);
    }).join('\n');
  }

  // ---- naming and guessing -------------------------------------------------

  // What a fence may say → what colours it, and the name the label shows.
  const ALIASES = {
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
    ts: 'ts', typescript: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    py: 'python', python: 'python', python3: 'python', py3: 'python', ipython: 'python',
    java: 'java',
    vue: 'vue', html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html', svelte: 'vue', astro: 'vue',
    css: 'css', scss: 'css', sass: 'css', less: 'css', postcss: 'css',
    json: 'json', jsonc: 'json', json5: 'json', geojson: 'json',
    bash: 'shell', sh: 'shell', shell: 'shell', zsh: 'shell', console: 'shell', shellsession: 'shell', terminal: 'shell', fish: 'shell',
    sql: 'sql', psql: 'sql', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
    yaml: 'yaml', yml: 'yaml',
    diff: 'diff', patch: 'diff',
    c: 'clike', h: 'clike', cpp: 'clike', 'c++': 'clike', cc: 'clike', hpp: 'clike', cs: 'clike', csharp: 'clike',
    go: 'clike', golang: 'clike', rust: 'clike', rs: 'clike', kotlin: 'clike', kt: 'clike', kts: 'clike',
    swift: 'clike', php: 'clike', scala: 'clike', dart: 'clike', groovy: 'clike', gradle: 'clike', objc: 'clike'
  };
  const PLAIN = words('text txt plain plaintext output log logs none nohighlight');

  /** Most of the lines, not just one of them. */
  function share(lines, re) {
    if (!lines.length) return 0;
    return lines.filter((l) => re.test(l)).length / lines.length;
  }

  function count(src, re) {
    const m = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    return m ? m.length : 0;
  }

  /**
   * The language some code is in, or null when it does not look like code —
   * prose, a list of files, command output — which then stays plain.
   */
  function detect(code) {
    const s = String(code).slice(0, 6000);
    const t = s.trim();
    if (!t) return null;
    const lines = s.split('\n').filter((l) => l.trim());

    if (/^[[{]/.test(t) && /[\]}]$/.test(t)) {
      try { JSON.parse(code); if (/[{[]/.test(t.slice(1))) return 'json'; if (/[":]/.test(t)) return 'json'; } catch (_) { /* not JSON */ }
    }
    if (/^(diff --git |--- a\/|\+\+\+ b\/|@@ -\d)/m.test(s) && /^[+-][^+-]/m.test(s)) return 'diff';
    if (/^\s*<template[\s>]/m.test(s) && /^\s*<\/template>/m.test(s)) return 'vue';
    if (/^\s*</.test(t) && /<\/[A-Za-z][\w:-]*>|\/>|<!DOCTYPE/i.test(s) && !/^\s*(import|export|const|function)\b/m.test(s)) return 'html';

    // Sentences are prose, however many colons or command names they contain:
    // "Note: run it again." is not YAML, and "make sure it builds." is not a shell.
    const sentences = share(lines, /^\s*[-*]?\s*[A-Za-z][^;{}=<>]*\s\S+\s\S+.*[.!?:]["')]?\s*$/);
    if (sentences >= 0.5) return null;

    const score = { python: 0, js: 0, ts: 0, java: 0, css: 0, shell: 0, sql: 0, yaml: 0 };

    if (/^\s*(async\s+)?def \w+\s*\(.*\)\s*(->.*)?:\s*$/m.test(s)) score.python += 4;
    if (/^\s*class \w+(\(.*\))?:\s*$/m.test(s)) score.python += 4;
    if (/^\s*(from [\w.]+ import \w|import [\w.]+(\s+as \w+)?\s*$)/m.test(s)) score.python += 3;
    if (/^\s*(if|elif|for|while|with|try|except|else|finally)\b[^;{]*:\s*(#.*)?$/m.test(s)) score.python += 2;
    score.python += Math.min(3, count(s, /\b(elif|self\.|None\b|True\b|False\b|__\w+__|print\(|lambda )/));

    if (/^\s*import\s.*\sfrom\s+['"]/m.test(s) || /^\s*import\s+['"]/m.test(s)) score.js += 4;
    if (/^\s*export\s+(default|const|function|class|async|let|interface|type)\b/m.test(s)) score.js += 4;
    if (/\b(const|let|var)\s+[\w${}[\],\s]+=/.test(s)) score.js += 3;
    if (/=>/.test(s)) score.js += 2;
    if (/\bfunction\s*\*?\s*\w*\s*\(/.test(s)) score.js += 3;
    if (/\bconsole\.\w+\(|\brequire\(['"]|\bdocument\.|\bwindow\./.test(s)) score.js += 3;
    if (/===|!==/.test(s)) score.js += 1;
    if (/\b(interface|type)\s+\w+(<[^>]*>)?\s*[={]/.test(s) || /:\s*(string|number|boolean|any|unknown|void)\b/.test(s)) score.ts += 3;

    if (/\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|interface|enum|record|void|[\w<>[\],\s]+\s+\w+\s*\()/.test(s)) score.java += 5;
    if (/System\.(out|err)\.print/.test(s)) score.java += 5;
    if (/^\s*package [\w.]+;\s*$/m.test(s) || /^\s*import (static )?[\w.]+(\.\*)?;\s*$/m.test(s)) score.java += 4;
    if (/@Override\b|\bString\[\]|\bnew [A-Z]\w*(<[^>]*>)?\(/.test(s)) score.java += 2;

    const declarations = count(s, /^\s*-{0,2}[a-z][\w-]*\s*:\s*[^;{}\n]+;\s*$/m);
    const selectors = count(s, /^\s*[^\s{}();=][^{}();=]*\{\s*$/m);
    if (declarations && (selectors || /^\s*[}]/m.test(s))) score.css += 2 + Math.min(3, declarations);
    if (/^\s*@(media|import|keyframes|font-face|tailwind|apply|use|mixin|include)\b/m.test(s)) score.css += 3;

    if (/^#!.*\b(ba|z|fi)?sh\b/.test(t)) score.shell += 6;
    const commands = share(lines, /^\s*([$%>] )?(sudo |npm |npx |pnpm |yarn |bun |git |cd |ls |pip3? |python3? |node |brew |docker |docker-compose |kubectl |curl |wget |echo |export |mkdir |rm |cp |mv |cat |chmod |chown |source |make |go |cargo |gh |claude |ssh |scp |tar |grep |find |sed |awk |apt(-get)? |systemctl |code |open |touch |uv |poetry |conda |java |mvn |gradle |\.\/)/);
    if (commands >= 0.5) score.shell += 3 + Math.round(commands * 2);
    if (/^\s*(fi|done|esac)\s*$/m.test(s)) score.shell += 3;

    if (/\bSELECT\b[\s\S]+?\bFROM\b/i.test(s) && /\bSELECT\b/.test(s)) score.sql += 4;
    if (/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE (TABLE|INDEX|VIEW|UNIQUE INDEX)|ALTER TABLE|DROP TABLE)\b/i.test(s)) score.sql += 4;

    const keyLines = share(lines.filter((l) => !/^\s*#/.test(l)), /^\s*(- )?[\w.-]+:(\s|$)|^\s*- \S/);
    if (lines.length >= 2 && keyLines >= 0.7 && !/[;{}()]/.test(s)) score.yaml += 3 + Math.round(keyLines * 2);

    if (score.ts && score.js) score.ts += score.js;
    let best = null;
    let top = 0;
    for (const lang of Object.keys(score)) {
      if (score[lang] > top) { best = lang; top = score[lang]; }
    }
    return top >= 3 ? best : null;
  }

  const LABEL = { js: 'javascript', ts: 'typescript', clike: '' };

  function render(code, lang) {
    if (lang === 'vue') return scanMarkup(code, true);
    if (lang === 'html') return scanMarkup(code, false);
    if (lang === 'css') return scanCss(code);
    if (lang === 'shell') return scanShell(code);
    if (lang === 'yaml') return scanYaml(code);
    if (lang === 'diff') return scanDiff(code);
    return scanCode(code, CODE[lang]);
  }

  /**
   * Coloured HTML for a fenced block. `lang` is what the fence said, if
   * anything. Returns the HTML and the language it was taken to be (null
   * when it is shown as plain text).
   */
  function highlight(code, lang) {
    const text = String(code == null ? '' : code);
    const asked = String(lang || '').trim().toLowerCase();
    if (PLAIN.has(asked) || text.length > MAX) return { html: esc(text), lang: null };
    let kind = ALIASES[asked] || null;
    if (!kind) kind = detect(text);
    if (!kind) return { html: esc(text), lang: null };
    try {
      return { html: render(text, kind), lang: kind in LABEL ? LABEL[kind] || asked : kind };
    } catch (_) {
      // A colouring bug must never cost the reader the code itself.
      return { html: esc(text), lang: null };
    }
  }

  const api = { highlight, detect };
  root.NikHighlight = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* The /status sheet: everything the host measured about an instance, laid out
   as six sections you can click or key through. Rendering is pure — a report
   in, HTML out — so the whole sheet can be checked without a browser. */
(function (root) {
  'use strict';

  const charts = root.charts || (typeof require === 'function' ? require('./charts.js') : null);
  const icons = root.icon ? { icon: root.icon } : (typeof require === 'function' ? require('./icons.js') : null);
  const icon = (name, size) => (root.icon ? root.icon(name, size) : (icons && icons.icon ? icons.icon(name, size) : ''));
  const esc = charts.esc;

  // ── formatting ───────────────────────────────────────────────

  const fmt = {
    tokens(n) {
      n = n || 0;
      if (n < 1000) return String(Math.round(n));
      if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
      return (n / 1000000).toFixed(n < 10000000 ? 2 : 1) + 'M';
    },
    money(n) {
      n = n || 0;
      if (!n) return '$0.00';
      if (n < 0.01) return '$' + n.toFixed(4);
      if (n < 100) return '$' + n.toFixed(2);
      return '$' + Math.round(n).toLocaleString();
    },
    pct(n, digits) { return ((n || 0) * 100).toFixed(digits === undefined ? 0 : digits) + '%'; },
    ms(n) {
      n = Math.max(0, Math.round(n || 0));
      if (n < 1000) return n + 'ms';
      const s = n / 1000;
      if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + String(Math.round(s % 60)).padStart(2, '0') + 's';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
      return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    },
    bytes(n) {
      n = n || 0;
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
      if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
      return (n / 1073741824).toFixed(2) + ' GB';
    },
    time(at) {
      if (!at) return '—';
      const d = new Date(at);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
    when(at) {
      if (!at) return '—';
      return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
    count(n) { return (n || 0).toLocaleString(); }
  };

  // The four token types, in one fixed order everywhere they appear.
  const TOKEN_SERIES = [
    { key: 'input', label: 'Input', klass: 'm1' },
    { key: 'output', label: 'Output', klass: 'm2' },
    { key: 'cacheRead', label: 'Cache read', klass: 'm3' },
    { key: 'cacheCreate', label: 'Cache write', klass: 'm4' }
  ];

  const STATUS_WORD = {
    idle: 'Idle', working: 'Working', waiting: 'Needs you',
    done: 'Done', error: 'Error', stopped: 'Stopped', asleep: 'Asleep'
  };

  /** The word for how a conversation left off; asleep is said separately. */
  const stateOf = (who) => who.status || 'idle';
  const word = (who) => STATUS_WORD[stateOf(who)] || stateOf(who);

  // ── building blocks ──────────────────────────────────────────

  function card(title, body, opts) {
    const o = opts || {};
    return '<section class="card' + (o.wide ? ' wide' : '') + (o.klass ? ' ' + o.klass : '') + '">' +
      (title ? '<h3>' + esc(title) + (o.note ? '<span class="note">' + esc(o.note) + '</span>' : '') + '</h3>' : '') +
      body + '</section>';
  }

  function tile(label, value, sub, opts) {
    const o = opts || {};
    return '<div class="tile' + (o.klass ? ' ' + o.klass : '') + '"' +
      (o.tip ? ' data-tip="' + esc(o.tip) + '"' : '') + '>' +
      '<div class="tile-label">' + esc(label) + '</div>' +
      '<div class="tile-value">' + esc(value) + '</div>' +
      (sub ? '<div class="tile-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function facts(list) {
    return '<dl class="facts">' + list.filter(Boolean).map((row) =>
      '<div class="fact' + (row.wide ? ' wide' : '') + '">' +
      '<dt>' + esc(row[0] !== undefined ? row[0] : row.label) + '</dt>' +
      '<dd' + (row.mono === false ? '' : ' class="mono"') + '>' + esc(row[1] !== undefined ? row[1] : row.value) + '</dd>' +
      '</div>').join('') + '</dl>';
  }

  /** `numFrom` is the first column that holds numbers, and so is right-aligned. */
  function table(head, body, opts) {
    const o = Object.assign({ numFrom: 1 }, opts || {});
    if (!body.length) return hint('Nothing recorded yet.');
    const num = (i) => (i >= o.numFrom ? ' class="num"' : '');
    // The scroll lives on a wrapper: a grid item that is itself a scroll
    // container collapses to the height of its first child.
    return '<div class="grid-scroll"><table class="grid"><thead><tr>' +
      head.map((h, i) => '<th' + num(i) + '>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      body.map((row) => '<tr' + (row.action ? ' data-action="' + esc(row.action) + '" tabindex="0"' : '') +
        (row.tip ? ' data-tip="' + esc(row.tip) + '"' : '') + '>' +
        row.cells.map((c, i) => '<td' + num(i) + '>' + c + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  const hint = (text) => '<p class="hint-line">' + esc(text) + '</p>';

  // ── the plan's own limits ────────────────────────────────────

  const LIMIT_STATUS = {
    allowed: 'within your limits',
    allowed_warning: 'getting close',
    rejected: 'used up'
  };

  /** "in 2h 40m", or the time if that is further off than a day. */
  function until(at) {
    if (!at) return 'unknown';
    const left = at - Date.now();
    if (left <= 0) return 'any moment';
    if (left < 86400000) return 'in ' + fmt.ms(left);
    return 'on ' + fmt.when(at);
  }

  function windowRow(label, win, noun) {
    if (!win) {
      return '<div class="meter-line"><span class="meter-name">' + esc(label) + '</span>' +
        charts.meter(0, { klass: 'm-dim', label: label + ' not reported yet' }) +
        '<span class="meter-value dim">—</span></div>';
    }
    const left = Math.max(0, 1 - win.used);
    return '<div class="meter-line">' +
      '<span class="meter-name">' + esc(label) + '</span>' +
      charts.meter(Math.min(1, win.used), {
        marks: [0.7, 0.9],
        label: label + ': ' + fmt.pct(win.used) + ' used, resets ' + until(win.resetsAt)
      }) +
      '<span class="meter-value">' + esc(fmt.pct(left)) + ' left</span></div>' +
      '<p class="hint-line">' + esc(fmt.pct(win.used) + ' of your ' + (noun || label.toLowerCase()) +
        ' used · resets ' + until(win.resetsAt)) + '</p>';
  }

  function pausedCard(r) {
    if (!r.pause) return '';
    const held = (r.fleet || []).filter((m) => m.paused).length;
    return card('Waiting for the quota',
      '<p class="hint-line">' + esc(
        (held || 'Every') + ' instance' + (held === 1 ? '' : 's') + ' ' + (held === 1 ? 'is' : 'are') +
        ' holding until ' + (r.pause.blind ? 'the quota is checked again' : fmt.when(r.pause.until)) +
        ' — ' + until(r.pause.until) + '. Queues are untouched, and anything you send meanwhile joins them. ' +
        'Whatever was cut off mid-turn is nudged to carry on when the window comes back.') + '</p>',
      { wide: true, klass: 'waiting-card', note: until(r.pause.until) });
  }

  function limitsCard(r) {
    const limits = r.limits;
    if (!limits) {
      return card('Plan usage',
        hint('Nothing reported yet. The CLI sends your five-hour and weekly usage when it changes, ' +
          'so this fills in during the next turn.'), { wide: true });
    }
    const stale = Date.now() - (limits.at || 0) > 1800000;
    const w = limits.windows || {};
    return card('Plan usage',
      windowRow('Five-hour session', w.fiveHour, 'five-hour window') +
      windowRow('This week', w.week, 'weekly window') +
      (w.weekOverage ? windowRow('Weekly, overage included', w.weekOverage, 'weekly window including overage') : '') +
      (limits.overage ? hint('Currently running on overage credits.') : '') +
      hint((LIMIT_STATUS[limits.status] || limits.status) +
        (limits.resetsAt && limits.status !== 'allowed' ? ' · resets ' + until(limits.resetsAt) : '') +
        ' · as of ' + fmt.time(limits.at) + (stale ? ' (nothing newer since)' : '')),
      { wide: true, note: LIMIT_STATUS[limits.status] || '' });
  }

  const dot = (status) => '<span class="sdot ' + esc(status) + '"></span>';

  // ── sections ─────────────────────────────────────────────────

  function overview(r) {
    const t = r.totals;
    const runway = r.runway;
    const ctxNote = r.totals.contextWindow
      ? fmt.tokens(t.contextTokens) + ' of ' + fmt.tokens(t.contextWindow)
      : 'not reported yet';

    const hero =
      '<div class="hero">' +
      '<div class="hero-main">' +
      '<div class="hero-label">Session cost</div>' +
      '<div class="hero-value">' + esc(fmt.money(t.cost)) + '</div>' +
      '<div class="hero-sub">' + esc(fmt.count(t.turns) + ' turns · ' + fmt.tokens(t.tokens.total) +
        ' tokens · ' + fmt.ms(t.workedMs) + ' of model time') + '</div>' +
      '</div>' +
      '<div class="hero-side">' +
      '<div class="pill ' + esc(stateOf(r.instance)) + '">' +
        dot(stateOf(r.instance) + (r.instance.asleep ? ' asleep' : '')) +
        esc(word(r.instance)) + '</div>' +
      (r.instance.asleep
        ? '<div class="hero-meta">' + esc('not running — opens where it left off') + '</div>'
        : '') +
      '<div class="hero-meta">' + esc(r.config.model || 'default model') +
        (r.config.effort ? ' · effort ' + esc(r.config.effort) : '') + '</div>' +
      '<div class="hero-meta">' + esc(r.instance.folder || r.instance.cwd || '') +
        (r.git && r.git.branch ? ' · ' + esc(r.git.branch) : '') + '</div>' +
      '</div></div>';

    const kpis = '<div class="tiles">' +
      tile('Turns', fmt.count(t.turns), t.avgTurnMs ? fmt.ms(t.avgTurnMs) + ' each' : 'none yet') +
      tile('Tokens', fmt.tokens(t.tokens.total), fmt.tokens(t.tokens.output) + ' written') +
      tile('Tool calls', fmt.count(t.toolCalls), t.toolErrors ? t.toolErrors + ' failed' : 'all clean') +
      tile('Cache hits', fmt.pct(t.cacheHitRate), 'of everything read',
        { tip: fmt.tokens(t.tokens.cacheRead) + ' of ' + fmt.tokens(t.tokens.input + t.tokens.cacheRead + t.tokens.cacheCreate) + ' prompt tokens came from cache' }) +
      tile('Throughput', Math.round(t.outputPerSecond || 0) + ' tok/s', 'while working') +
      tile('Burn rate', fmt.money(t.burnPerHour), 'per hour of work') +
      '</div>';

    const context = card('Context window',
      '<div class="meter-row">' + charts.meter(t.contextPct, {
        marks: [0.7, 0.9],
        label: 'Context window ' + fmt.pct(t.contextPct) + ' full, ' + ctxNote
      }) +
      '<span class="meter-value">' + esc(fmt.pct(t.contextPct)) + '</span></div>' +
      '<p class="hint-line">' + esc(ctxNote) +
      (runway && runway.turnsLeft !== null
        ? ' · growing ' + fmt.tokens(runway.growthPerTurn) + ' a turn, room for about ' +
          runway.turnsLeft + ' more before compaction'
        : '') + '</p>' +
      (t.compactions
        ? hint('Compacted ' + (t.compactions === 1 ? 'once' : t.compactions + ' times') +
          (t.lastCompactedAt ? ', last at ' + fmt.time(t.lastCompactedAt) : '') +
          ' — the CLI summarised the context when it filled, so this meter measures what has ' +
          'been read since then, not the whole conversation.')
        : ''),
      { wide: true, note: r.totals.contextWindow ? '' : 'after the first turn' });

    const costPoints = r.turns.map((turn) => ({ value: turn.costUsd, turn }));
    const costChart = card('Cost per turn',
      charts.area(costPoints, {
        klass: 'm1',
        label: 'Cost of each of the last ' + r.turns.length + ' turns, ' +
          fmt.money(r.totals.avgCost) + ' on average',
        tip: (p) => 'Turn ' + p.turn.n + ' · ' + fmt.money(p.value) + ' · ' + fmt.ms(p.turn.durationMs)
      }) + spark(r), { wide: true, note: r.turns.length ? fmt.money(r.totals.avgCost) + ' average' : '' });

    const paused = pausedCard(r);
    const plan = r.limits && r.limits.windows ? r.limits.windows : null;
    const planLine = plan && (plan.fiveHour || plan.week)
      ? card('Plan usage',
        (plan.fiveHour ? '<div class="meter-line"><span class="meter-name">Five-hour</span>' +
          charts.meter(Math.min(1, plan.fiveHour.used), { marks: [0.7, 0.9], label: 'Five-hour window ' + fmt.pct(plan.fiveHour.used) + ' used' }) +
          '<span class="meter-value">' + esc(fmt.pct(Math.max(0, 1 - plan.fiveHour.used))) + ' left</span></div>' : '') +
        (plan.week ? '<div class="meter-line"><span class="meter-name">This week</span>' +
          charts.meter(Math.min(1, plan.week.used), { marks: [0.7, 0.9], label: 'Weekly window ' + fmt.pct(plan.week.used) + ' used' }) +
          '<span class="meter-value">' + esc(fmt.pct(Math.max(0, 1 - plan.week.used))) + ' left</span></div>' : '') +
        hint('Your account\u2019s limits, shared by every instance — the full picture is under Fleet.'),
        { wide: true })
      : '';

    const rec = r.records;
    const recordCard = rec ? card('Records', '<div class="tiles small">' +
      tile('Longest turn', fmt.ms(rec.longest.durationMs), 'turn ' + rec.longest.n) +
      tile('Costliest turn', fmt.money(rec.costliest.costUsd), 'turn ' + rec.costliest.n) +
      tile('Biggest turn', fmt.tokens(rec.biggest.tokens), 'turn ' + rec.biggest.n) +
      tile('Peak context', fmt.tokens(rec.peakContext.tokens), 'turn ' + rec.peakContext.n) +
      tile('Most tools in a turn', fmt.count(rec.busiestTurn), 'calls') +
      tile('Focus', fmt.pct(r.totals.focusPct), 'of the session working') +
      '</div>', { wide: true }) : '';

    return hero + kpis + paused + context + planLine + costChart + recordCard;
  }

  function spark(r) {
    if (!r.turns.length) return hint('No finished turns yet — the charts fill in as the conversation runs.');
    const first = r.turns[0];
    const last = r.turns[r.turns.length - 1];
    return '<div class="axis"><span>' + esc('turn ' + first.n + ' · ' + fmt.time(first.at)) +
      '</span><span>' + esc('turn ' + last.n + ' · ' + fmt.time(last.at)) + '</span></div>';
  }

  function usage(r) {
    const t = r.totals;
    const tok = t.tokens;
    const series = TOKEN_SERIES.map((s) => Object.assign({}, s, { value: fmt.tokens(tok[s.key]) }));

    const mix = card('Where the tokens went',
      charts.share(TOKEN_SERIES.map((s) => ({ klass: s.klass, label: s.label, value: tok[s.key] })), {
        label: 'Token mix: ' + TOKEN_SERIES.map((s) => s.label + ' ' + fmt.tokens(tok[s.key])).join(', '),
        tip: (p, total) => p.label + ' · ' + fmt.tokens(p.value) + ' · ' + fmt.pct(p.value / total)
      }) + charts.legend(series) +
      facts([
        ['Read from cache', fmt.tokens(tok.cacheRead) + '  (' + fmt.pct(t.cacheHitRate) + ' of everything read)'],
        ['Written to cache', fmt.tokens(tok.cacheCreate)],
        ['Sent fresh', fmt.tokens(tok.input)],
        ['Generated', fmt.tokens(tok.output)]
      ]), { wide: true });

    const perTurn = card('Tokens per turn',
      charts.stacked(r.turns, TOKEN_SERIES, {
        label: 'Tokens per turn by type over ' + r.turns.length + ' turns; the table under Timeline lists them',
        tip: (row, s) => 'Turn ' + row.n + ' · ' + s.label + ' ' + fmt.tokens(row[s.key])
      }) + charts.legend(TOKEN_SERIES) + spark(r), { wide: true });

    let running = 0;
    const cumulative = r.turns.map((turn) => { running += turn.costUsd; return { value: running, turn }; });
    const spend = card('Spend over the session',
      charts.area(cumulative, {
        klass: 'm1',
        label: 'Spend over the session, ' + fmt.money(t.cost) + ' after ' + r.turns.length + ' turns',
        tip: (p) => 'After turn ' + p.turn.n + ' · ' + fmt.money(p.value)
      }) + spark(r), { wide: true, note: fmt.money(t.cost) + ' so far' });

    const speeds = r.turns.filter((t) => t.durationMs).map((t) => t.output / (t.durationMs / 1000));
    const speed = card('Output speed',
      charts.columns(r.turns.map((turn) => ({
        value: turn.durationMs ? turn.output / (turn.durationMs / 1000) : 0, turn
      })), {
        klass: 'm1',
        label: 'Output speed per turn, ' + Math.round(t.outputPerSecond) + ' tokens a second on average',
        tip: (v) => 'Turn ' + v.turn.n + ' · ' + Math.round(v.value) + ' tok/s · ' + fmt.ms(v.turn.durationMs)
      }) + '<p class="hint-line">' + esc('Tokens written per second of model time. ' +
        (r.lastTurn ? 'Last turn ' + Math.round(r.lastTurn.outputPerSecond) + ' tok/s.' : '')) + '</p>',
      { wide: true, note: speeds.length ? Math.round(Math.max.apply(null, speeds)) + ' tok/s at best' : '' });

    const talk = card('What was said', windowLine(r) + '<div class="tiles small">' +
      tile('Your prompts', fmt.count(t.messages.user), fmt.tokens(t.promptChars / 4) + ' tokens-ish') +
      tile('Replies', fmt.count(t.messages.assistant), fmt.count(t.writtenChars) + ' characters') +
      tile('Thinking blocks', fmt.count(t.messages.thinking), fmt.pct(t.thinkingShare) + ' of the writing') +
      tile('Images sent', fmt.count(t.images), t.images ? 'pasted or dropped' : 'none') +
      '</div>');

    return mix + perTurn + spend + speed + talk;
  }

  function tools(r) {
    const list = r.tools.slice(0, 12).map((tool) => ({
      label: tool.name,
      value: tool.calls,
      klass: 'm1',
      note: tool.errors ? tool.errors + ' failed' : '',
      noteBad: !!tool.errors,
      tip: tool.name + ' · ' + tool.calls + ' calls' + (tool.errors ? ' · ' + tool.errors + ' failed' : '')
    }));

    const toolCard = card('Tools used',
      (list.length ? charts.rows(list, { format: (v) => fmt.count(v) }) : hint('No tool calls yet.')) +
        windowLine(r), { wide: true, note: r.totals.toolCalls + ' calls' + windowNote(r) });

    const fileRows = r.files.map((f) => ({
      action: 'open:' + f.file,
      tip: f.file,
      cells: ['<span class="link">' + esc(f.name) + '</span><span class="dim"> ' + esc(dirOf(f.file, r)) + '</span>', fmt.count(f.count)]
    }));
    const filesCard = card('Files touched most',
      table(['File', 'Touches'], fileRows, { numFrom: 1 }) +
      (fileRows.length ? hint('Click a row to open it beside the conversation.') : ''), { wide: true });

    const cmdRows = r.commands.map((c) => ({ cells: ['<code>' + esc(c.cmd) + '</code>', fmt.count(c.count)] }));
    const cmdCard = card('Shell commands', table(['Command', 'Runs'], cmdRows, { numFrom: 1 }));

    const health = card('Health', '<div class="tiles small">' +
      tile('Tool failures', fmt.count(r.totals.toolErrors), r.totals.toolErrors ? 'check the red ones' : 'none',
        { klass: r.totals.toolErrors ? 'bad' : '' }) +
      tile('Still running', fmt.count(r.totals.toolsRunning), 'tool calls open') +
      tile('Errored turns', fmt.count(r.totals.errors),
        r.instance.lastError ? 'last: ' + r.instance.lastError.slice(0, 40) : (r.totals.errors ? 'recovered since' : 'none'),
        { klass: r.totals.errors ? 'bad' : '' }) +
      tile('Interrupts', fmt.count(r.totals.interrupts), 'Esc pressed') +
      tile('Compactions', fmt.count(r.totals.compactions),
        r.totals.compactions ? 'context summarised' : 'context has fit so far') +
      tile('Permission asks', fmt.count(r.totals.messages.permission), r.config.permissionMode) +
      tile('Notices', fmt.count(r.totals.messages.notice), 'from the CLI') +
      '</div>', { wide: true });

    return toolCard + filesCard + cmdCard + health;
  }

  /** Everything counted off the item list carries the same caveat. */
  function windowNote(r) {
    const w = r.window || {};
    return w.dropped ? ' in the last ' + fmt.count(w.kept) + ' messages' : ' in total';
  }

  function windowLine(r) {
    const w = r.window || {};
    if (!w.dropped) return '';
    return hint('Counted from the ' + fmt.count(w.kept) + ' messages still in memory — ' +
      fmt.count(w.dropped) + ' earlier ones were dropped to keep the panel light, and are in the transcript.');
  }

  function dirOf(file, r) {
    const cwd = r.instance.cwd || '';
    const rel = cwd && file.indexOf(cwd) === 0 ? file.slice(cwd.length + 1) : file;
    const cut = rel.lastIndexOf('/');
    return cut > 0 ? rel.slice(0, cut) : '';
  }

  function timeline(r) {
    const durations = card('Turn by turn',
      charts.columns(r.turns.map((turn) => ({
        value: turn.durationMs,
        turn,
        klass: turn.isError ? 'level-critical' : turn.interrupted ? 'level-warn' : 'm1'
      })), {
        label: 'How long each turn took, ' + fmt.ms(r.totals.avgTurnMs) + ' on average; the table below lists them',
        tip: (v) => 'Turn ' + v.turn.n + ' · ' + fmt.ms(v.value) + ' · ' + v.turn.tools + ' tools · ' + fmt.money(v.turn.costUsd)
      }) + spark(r) +
      '<p class="hint-line">' + esc('Amber marks an interrupted turn, red an errored one.') + '</p>',
      { wide: true, note: r.totals.avgTurnMs ? fmt.ms(r.totals.avgTurnMs) + ' average' : '' });

    const rhythm = card('When you work',
      charts.heat(r.hourly, { unit: 'turns' }) +
      '<p class="hint-line">' + esc('Turns finished, by hour of the day.') + '</p>', { wide: true });

    const context = card('Context growth',
      charts.area(r.turns.map((turn) => ({ value: turn.contextTokens, turn })), {
        klass: 'm1',
        label: 'Context size per turn, now ' + fmt.tokens(r.totals.contextTokens),
        tip: (p) => 'Turn ' + p.turn.n + ' · ' + fmt.tokens(p.value) + ' in context'
      }) + '<p class="hint-line">' + esc(
        r.runway && r.runway.turnsLeft !== null
          ? 'Growing about ' + fmt.tokens(r.runway.growthPerTurn) + ' tokens a turn — roughly ' +
            r.runway.turnsLeft + ' turns of headroom left.'
          : 'The window each turn had to read.') + '</p>', { wide: true });

    const recent = r.turns.slice(-12).reverse().map((turn) => ({
      tip: turn.toolNames.slice(0, 8).join(', ') || 'no tools',
      cells: [
        '<b>' + turn.n + '</b> <span class="dim">' + esc(fmt.time(turn.at)) + '</span>',
        fmt.ms(turn.durationMs),
        fmt.tokens(turn.tokens),
        fmt.count(turn.tools),
        fmt.money(turn.costUsd)
      ]
    }));
    const log = card('Recent turns',
      table(['Turn', 'Took', 'Tokens', 'Tools', 'Cost'], recent, { numFrom: 1 }), { wide: true });

    return durations + rhythm + context + log;
  }

  function fleet(r) {
    const f = r.fleetTotals || {};
    const rows = r.fleet || [];
    const mine = rows.find((m) => m.active);

    const hero =
      '<div class="hero">' +
      '<div class="hero-main">' +
      '<div class="hero-label">Everything running in this window</div>' +
      '<div class="hero-value">' + esc(fmt.money(f.cost)) + '</div>' +
      '<div class="hero-sub">' + esc(
        fmt.count(f.instances) + ' instance' + (f.instances === 1 ? '' : 's') +
        ' across ' + fmt.count(f.projects) + ' project' + (f.projects === 1 ? '' : 's') + ' · ' +
        fmt.tokens(f.tokens) + ' tokens · ' + fmt.ms(f.workedMs) + ' of model time') + '</div>' +
      '</div>' +
      '<div class="hero-side">' +
      '<div class="pill ' + (f.working ? 'working' : 'idle') + '">' + dot(f.working ? 'working' : 'idle') +
        esc(f.working ? f.working + ' working now' : 'nothing running') + '</div>' +
      (mine ? '<div class="hero-meta">' + esc('this instance · ' + fmt.money(mine.cost) +
        ' · ' + fmt.pct(f.share) + ' of the spend') + '</div>' : '') +
      (f.queued ? '<div class="hero-meta">' + esc(f.queued + ' prompt' + (f.queued === 1 ? '' : 's') + ' queued') + '</div>' : '') +
      '</div></div>';

    const tiles = '<div class="tiles">' +
      tile('Instances', fmt.count(f.instances), f.asleep ? f.asleep + ' asleep' : 'all awake') +
      tile('Working', fmt.count(f.working), f.waiting ? f.waiting + ' need you' : 'none blocked',
        { klass: f.waiting ? 'bad' : '' }) +
      tile('Fleet cost', fmt.money(f.cost), fmt.money(f.instances ? f.cost / f.instances : 0) + ' each') +
      tile('Tokens', fmt.tokens(f.tokens), fmt.tokens(f.output) + ' written') +
      tile('Turns', fmt.count(f.turns), f.turns ? fmt.money(f.cost / f.turns) + ' a turn' : 'none yet') +
      tile('Tool calls', fmt.count(f.toolCalls), f.toolErrors ? f.toolErrors + ' failed' : 'all clean',
        { klass: f.toolErrors ? 'bad' : '' }) +
      tile('Cache hits', fmt.pct(f.promptTokens ? f.cacheRead / f.promptTokens : 0), 'across the fleet') +
      tile('Model time', fmt.ms(f.workedMs),
        f.workedMs ? fmt.money(f.cost / (f.workedMs / 3600000)) + ' an hour' : 'none yet') +
      '</div>';

    // Who is doing what, as one bar rather than eight dots to count.
    const states = [
      { key: 'working', label: 'Working', klass: 'm1' },
      { key: 'waiting', label: 'Needs you', klass: 'level-critical' },
      { key: 'idle', label: 'Idle', klass: 'm4' },
      { key: 'asleep', label: 'Asleep', klass: 'm-dim' },
      { key: 'other', label: 'Stopped or errored', klass: 'm2' }
    ];
    const bucket = (m) => (m.busy && m.status !== 'waiting' ? 'working'
      : m.status === 'waiting' ? 'waiting'
      : m.asleep ? 'asleep'
      : m.status === 'error' || m.status === 'stopped' ? 'other' : 'idle');
    const counts = states.map((st) => ({
      klass: st.klass, label: st.label, value: rows.filter((m) => bucket(m) === st.key).length
    }));
    const activity = card('What the fleet is doing',
      charts.share(counts.filter((c) => c.value > 0), {
        label: 'Instances by state: ' + counts.filter((c) => c.value).map((c) => c.label + ' ' + c.value).join(', '),
        tip: (p, total) => p.label + ' · ' + p.value + ' of ' + total
      }) + charts.legend(counts.filter((c) => c.value > 0).map((c) => Object.assign({}, c, { value: c.value }))),
      { wide: true });

    const costBars = card('Cost by instance',
      charts.rows(rows.map((m) => ({
        label: m.label,
        value: m.cost,
        emphasis: m.active,
        klass: m.active ? 'm1' : 'm-dim',
        action: 'switch:' + m.id,
        note: m.active ? 'open' : '',
        tip: m.label + ' · ' + m.status + ' · ' + fmt.tokens(m.tokens) + ' tokens · ' + m.turns + ' turns'
      })), { format: (v) => fmt.money(v) }) + hint('Click an instance to jump to it.'),
      { wide: true, note: fmt.money(f.cost) + ' in total' });

    const tokenBars = card('Tokens by instance',
      charts.stacked(rows, TOKEN_SERIES, {
        height: 130,
        label: 'Token mix per instance: ' + rows.map((m) => m.label + ' ' + fmt.tokens(m.tokens)).join(', '),
        tip: (row, s) => row.label + ' · ' + s.label + ' ' + fmt.tokens(row[s.key])
      }) + charts.legend(TOKEN_SERIES) +
      '<div class="axis axis-even">' + rows.map((m) => '<span>' + esc(m.label) + '</span>').join('') + '</div>',
      { wide: true, note: 'who is reading, who is writing' });

    const pressure = card('Context pressure',
      rows.map((m) => '<div class="meter-line' + (m.active ? ' on' : '') + '">' +
        '<span class="meter-name">' + esc(m.label) + '</span>' +
        charts.meter(m.contextPct, {
          marks: [0.7, 0.9],
          label: m.label + ' context ' + fmt.pct(m.contextPct) + ' full'
        }) +
        '<span class="meter-value">' + esc(m.contextWindow ? fmt.pct(m.contextPct) : '—') + '</span></div>').join('') +
      hint('How full each instance\u2019s context window is. Amber past 70%, red past 90% — that is where compaction starts.'),
      { wide: true });

    const projectRows = (r.projects || []).map((p) => ({
      tip: p.path,
      cells: [
        '<b>' + esc(p.project) + '</b>',
        fmt.count(p.instances) + (p.working ? ' · ' + p.working + ' working' : ''),
        fmt.count(p.turns),
        fmt.tokens(p.tokens),
        fmt.money(p.cost)
      ]
    }));
    const projects = card('By project',
      table(['Project', 'Instances', 'Turns', 'Tokens', 'Cost'], projectRows, { numFrom: 1 }),
      { wide: true, note: 'where the work is going' });

    const detail = rows.map((m) => ({
      action: 'switch:' + m.id,
      tip: m.cwd + (m.branch ? ' · ' + m.branch : ''),
      cells: [
        dot(m.status + (m.asleep ? ' asleep' : '')) + '<span class="link">' + esc(m.label) + '</span>' +
          (m.active ? '<span class="badge">open</span>' : '') +
          (m.queue ? '<span class="badge">' + m.queue + ' queued</span>' : ''),
        '<span class="dim">' + esc(m.project || m.folder) + (m.branch ? ' · ' + esc(m.branch) : '') + '</span>',
        fmt.count(m.turns),
        fmt.tokens(m.tokens),
        fmt.pct(m.cacheHitRate),
        m.contextWindow ? fmt.pct(m.contextPct) : '—',
        m.avgTurnMs ? fmt.ms(m.avgTurnMs) : '—',
        m.quietMs === null ? 'never' : fmt.ms(m.quietMs) + ' ago',
        fmt.money(m.cost),
        '<span class="spark">' + (m.spend.length > 1
          ? charts.area(m.spend.map((v) => ({ value: v })), { width: 120, height: 22, klass: m.active ? 'm1' : 'm-dim' })
          : '') + '</span>'
      ]
    }));
    const detailCard = card('Every instance',
      table(['Instance', 'Project', 'Turns', 'Tokens', 'Cache', 'Context', 'Avg turn', 'Last turn', 'Cost', 'Spend'],
        detail, { numFrom: 2 }) +
      hint('Click a row to jump to that instance.'), { wide: true, klass: 'wide-table' });

    const most = rows.length ? rows[0] : null;
    const busiest = rows.slice().sort((a, b) => b.turns - a.turns)[0];
    const fullest = rows.slice().sort((a, b) => b.contextPct - a.contextPct)[0];
    const oldest = rows.slice().sort((a, b) => b.ageMs - a.ageMs)[0];
    const records = rows.length ? card('Across the fleet', '<div class="tiles small">' +
      tile('Costliest', most.label, fmt.money(most.cost)) +
      tile('Busiest', busiest.label, fmt.count(busiest.turns) + ' turns') +
      tile('Fullest context', fullest.label, fullest.contextWindow ? fmt.pct(fullest.contextPct) : 'not reported') +
      tile('Open longest', oldest.label, fmt.ms(oldest.ageMs)) +
      '</div>', { wide: true }) : '';

    return hero + tiles + pausedCard(r) + limitsCard(r) + activity + costBars + tokenBars + pressure +
      projects + detailCard + records;
  }

  function system(r) {
    const e = r.env || {};
    const q = r.queue;
    const session = card('This instance', facts([
      ['Name', r.instance.label],
      ['Ticket', r.instance.ticket || 'none'],
      ['Folder', r.instance.cwd],
      ['Branch', r.git ? (r.git.branch || r.git.commit + ' (detached)') + (r.git.worktree ? ' · worktree' : '') : 'not a git repo'],
      ['Claude session', r.instance.claudeSessionId || 'not started'],
      ['Process', r.instance.running ? 'running · pid ' + r.instance.pid
        : r.instance.asleep ? 'asleep — starts when you open it' : 'not running'],
      ['Started', fmt.when(r.instance.startedAt)],
      ['Open for', fmt.ms(r.instance.ageMs)],
      ['Process up', r.instance.processUpMs ? fmt.ms(r.instance.processUpMs) : '—']
    ]), { wide: true });

    const cfg = card('How it was launched', facts([
      ['Model', r.config.model || 'CLI default'],
      ['Effort', r.config.effort || 'default'],
      ['Permission mode', r.config.permissionMode],
      ['Output style', r.config.outputStyle || 'default'],
      ['Executable', r.config.claudePath],
      ['Extra arguments', (r.config.extraArgs || []).join(' ') || 'none'],
      ['Auto naming', r.config.autoTitle ? 'on' : 'off'],
      ['Queue delay', fmt.ms(r.config.queueDelayMs)]
    ]), { wide: true });

    const disk = card('Transcript', facts([
      ['File', r.transcript.path || 'none yet'],
      ['Size', r.transcript.exists ? fmt.bytes(r.transcript.sizeBytes) : 'not written yet'],
      ['Turns recorded', fmt.count(r.turns.length)],
      ['In memory', fmt.count((r.window || {}).kept) + ' messages' +
        ((r.window || {}).dropped ? ' · ' + fmt.count(r.window.dropped) + ' dropped' : '')],
      ['Queue', q.length ? q.length + ' waiting' : 'empty']
    ]), { wide: true });

    const host = card('Host', facts([
      ['VS Code', e.vscode || '—'],
      ['NikUI', e.extension || '—'],
      ['Node', e.node || '—'],
      ['Electron', e.electron || '—'],
      ['Platform', (e.platform || '—') + (e.arch ? ' · ' + e.arch : '')],
      ['Machine', (e.cpus ? e.cpus + ' cores' : '—') + (e.memoryGb ? ' · ' + e.memoryGb + ' GB' : '')],
      ['Grouping', e.groupByProject || 'auto'],
      ['Thinking blocks', e.showThinking === false ? 'hidden' : 'shown'],
      // A machine that will not sleep should never be a mystery.
      ['Sleep', awakeLine(e.awake)]
    ]), { wide: true });

    return session + cfg + disk + host + remote(r);
  }

  /**
   * Per-turn figures are measured over the turns still in memory. After a
   * reload that is the last sixty of them, and saying so is the difference
   * between a number and a wrong number.
   */
  function overTurns(r) {
    const logged = (r.totals || {}).turnsLogged || 0;
    const all = (r.totals || {}).turns || 0;
    return logged && all > logged ? ' · over the last ' + logged : '';
  }

  function awakeLine(awake) {
    if (!awake) return 'as the system decides';
    if (!awake.supported) return 'as the system decides';
    if (!awake.held) return 'allowed — nothing is holding this machine awake';
    return 'held awake · ' + (awake.reason || 'an instance is running') +
      (awake.since ? ' · since ' + fmt.when(awake.since) : '');
  }

  /**
   * Who can reach this window from somewhere else, and what they have done.
   *
   * A device pairs read-only; steering is granted separately. The trail keeps
   * refused attempts as well as allowed ones, because a refused attempt is the
   * line you would most want to find afterwards.
   */
  /** What the device says about where its key is. A claim, not a measurement. */
  function heldIn(d) {
    const said = {
      'secure-enclave': 'key in a Secure Enclave',
      'strongbox': 'key in a StrongBox chip',
      'keystore': 'key in the Android Keystore',
      'software': 'key in its browser',
      'unknown': 'key held somewhere unnamed'
    }[d.protection || 'software'];
    return said + (d.biometric ? ', biometric' : '');
  }

  function remote(r) {
    const e = r.env || {};
    const devices = e.devices || [];
    const trail = e.trail || [];
    if (!devices.length && !trail.length) return '';

    // What protects the way in, before the list of who has come through it.
    const reach = e.reach || {};
    const how = card('How a phone reaches this window', facts([
      ['Connections', reach.sealed
        ? 'Sealed end to end — a device must agree a key before it may say anything'
        : 'Not required to be sealed — traffic is readable by whatever carries it'],
      ['Served from here', reach.appOnly
        ? 'The app only — no page, no client, no worker outside this machine'
        : 'The app and a browser page']
    ]), { wide: true });

    const who = card('Paired devices', devices.length
      ? facts(devices.map((d) => [
        d.name,
        (d.control ? 'can steer' : 'watching only') +
          ' · ' + heldIn(d) +
          (d.lastSeenAt ? ' · last seen ' + fmt.when(d.lastSeenAt) : '')
      ]))
      : '<p class="muted">No devices are paired. Only this machine can reach this window.</p>',
      { wide: true });

    const rows = trail.slice(0, 12).map((entry) =>
      '<tr class="' + (entry.allowed ? '' : 'refused') + '">' +
      '<td>' + esc(fmt.when(entry.at)) + '</td>' +
      '<td>' + esc(entry.device) + '</td>' +
      '<td>' + esc(entry.action) + '</td>' +
      '<td>' + esc(entry.instance || '—') + '</td>' +
      '<td>' + (entry.allowed ? 'allowed' : 'refused') + '</td>' +
      '</tr>').join('');

    const log = card('What arrived from a device', trail.length
      ? '<div class="grid-scroll"><table class="grid"><thead><tr>' +
        '<th>When</th><th>Device</th><th>What</th><th>Instance</th><th>Outcome</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<p class="muted">Nothing has arrived from a device yet.</p>',
      { wide: true });

    return how + who + log;
  }

  const SECTIONS = [
    // The fleet leads: the first question is which instance, and only then what
    // that instance has been doing.
    { id: 'fleet', title: 'Fleet', icon: 'cpu', render: fleet },
    { id: 'overview', title: 'This instance', icon: 'sparkles', render: overview },
    { id: 'usage', title: 'Usage', icon: 'coins', render: usage },
    { id: 'tools', title: 'Tools', icon: 'terminal', render: tools },
    { id: 'timeline', title: 'Timeline', icon: 'clock', render: timeline },
    { id: 'system', title: 'System', icon: 'hash', render: system }
  ];

  function renderNav(activeId) {
    return SECTIONS.map((s, i) =>
      '<button class="nav-item' + (s.id === activeId ? ' on' : '') + '" data-section="' + s.id + '">' +
      icon(s.icon, 14) + '<span>' + esc(s.title) + '</span><kbd>' + (i + 1) + '</kbd></button>').join('');
  }

  /** The sheet's whole inner HTML for one report and one open section. */
  function renderSheet(report, activeId) {
    const section = SECTIONS.find((s) => s.id === activeId) || SECTIONS[0];
    return '<h2 class="sr-only" id="sheet-title">Status of ' + esc(report.instance.label) + '</h2>' +
      '<div class="sheet-head">' +
      '<div class="sheet-title">' + icon('sparkles', 15) +
      '<b>' + esc(report.instance.label) + '</b>' +
      '<span class="dim">' + esc(word(report.instance) + (report.instance.asleep ? ' · asleep' : '')) + ' · ' +
      esc(fmt.money(report.totals.cost)) + ' · ' + esc(fmt.tokens(report.totals.tokens.total)) + ' tokens</span>' +
      '</div>' +
      '<div class="sheet-actions">' +
      '<button class="ghost" data-act="cli" title="Send /status to the Claude Code CLI itself">CLI</button>' +
      '<button class="ghost" data-act="copy">Copy report</button>' +
      '<button class="ghost" data-act="refresh">Refresh</button>' +
      '<button class="icon-only" data-act="close" title="Close">' + icon('x', 15) + '</button>' +
      '</div></div>' +
      '<div class="sheet-body">' +
      '<nav class="sheet-nav">' + renderNav(section.id) + '</nav>' +
      '<div class="sheet-content" tabindex="0">' + section.render(report) + '</div>' +
      '</div>' +
      '<div class="sheet-foot">' + esc('Measured ' + fmt.when(report.generatedAt) +
        ' · ↑↓ or 1–6 to move · Esc to close') + '</div>';
  }

  /** A plain-text version of the report, for the Copy button. */
  function asText(r) {
    const lines = [
      'NikUI status — ' + r.instance.label,
      'Folder    ' + r.instance.cwd + (r.git && r.git.branch ? '  (' + r.git.branch + ')' : ''),
      'Model     ' + (r.config.model || 'default') + '  effort ' + (r.config.effort || 'default'),
      'Status    ' + stateOf(r.instance) + (r.instance.running ? ' · pid ' + r.instance.pid
        : r.instance.asleep ? ' · asleep' : ' · not running'),
      'Session   ' + (r.instance.claudeSessionId || 'not started'),
      '',
      'Cost      ' + fmt.money(r.totals.cost) + '  (' + fmt.money(r.totals.avgCost) + ' a turn, ' +
        fmt.money(r.totals.burnPerHour) + ' an hour of work)',
      'Turns     ' + r.totals.turns + '  averaging ' + fmt.ms(r.totals.avgTurnMs),
      'Tokens    ' + fmt.count(r.totals.tokens.total) + '  in ' + fmt.count(r.totals.tokens.input) +
        ' · out ' + fmt.count(r.totals.tokens.output) + ' · cache read ' + fmt.count(r.totals.tokens.cacheRead) +
        ' · cache write ' + fmt.count(r.totals.tokens.cacheCreate),
      'Cache     ' + fmt.pct(r.totals.cacheHitRate) + ' of everything read',
      'Context   ' + fmt.tokens(r.totals.contextTokens) + ' of ' + fmt.tokens(r.totals.contextWindow) +
        ' (' + fmt.pct(r.totals.contextPct) + ')' +
        (r.runway && r.runway.turnsLeft !== null ? ' · ~' + r.runway.turnsLeft + ' turns of headroom' : ''),
      'Compacted ' + (r.totals.compactions || 'never'),
      'Plan      ' + (r.limits && r.limits.windows
        ? ['fiveHour', 'week'].map((k) => {
          const win = r.limits.windows[k];
          return win ? (k === 'week' ? 'weekly ' : '5h ') + fmt.pct(Math.max(0, 1 - win.used)) + ' left' : null;
        }).filter(Boolean).join(', ') || 'not reported'
        : 'not reported'),
      'Tools     ' + r.totals.toolCalls + ' calls, ' + r.totals.toolErrors + ' failed',
      'Top tools ' + (r.tools.slice(0, 5).map((t) => t.name + ' ' + t.calls).join(', ') || 'none'),
      'Files     ' + (r.files.slice(0, 5).map((f) => f.name + ' ' + f.count).join(', ') || 'none')
    ];
    return lines.join('\n');
  }

  const api = { SECTIONS, renderSheet, renderNav, asText, fmt, TOKEN_SERIES };
  root.statusSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

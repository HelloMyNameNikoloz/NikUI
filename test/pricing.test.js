'use strict';
const fs = require('fs');
const path = require('path');

// Cost must always come from the CLI's total_cost_usd, which Anthropic has
// already priced per token type (cache reads at 0.1x input, cache writes at
// 1.25x/2x). Any hardcoded rate table here would drift the moment prices or
// models change, and would silently flatten the token types.
module.exports = function () {
  suite('pricing is delegated, never computed');

  const session = fs.readFileSync(path.join(__dirname, '..', 'src', 'session.js'), 'utf8');

  const assignments = session.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((l) => /this\.totalCost\s*=/.test(l.line));
  check('every cost assignment traces to total_cost_usd or a reset',
    assignments.length > 0 && assignments.every((l) =>
      /total_cost_usd|conversationCost|opts\.totalCost|=\s*0\b/.test(l.line)));

  const turnCost = session.split('\n').filter((l) => /turnCost\s*=/.test(l));
  check('the per-turn figure is a delta of the CLI total',
    turnCost.some((l) => /conversationCost - this\.totalCost/.test(l)) &&
    turnCost.every((l) => !/\d\s*\*\s*(input|output|cache)/i.test(l)));

  // No per-million-token rate constants anywhere in the extension.
  const files = ['src/session.js', 'src/manager.js', 'src/panel.js', 'src/report.js',
    'media/panel.js', 'media/status.js', 'media/charts.js'];
  const offenders = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/(1e6|1_000_000|1000000)/.test(line) && /token|cost|price|rate/i.test(line)) {
        offenders.push(rel + ':' + (i + 1));
      }
      if (/\bMTok\b|per[_ ]?million|pricePer|RATE\s*=/.test(line)) offenders.push(rel + ':' + (i + 1));
    });
  }
  checkEqual('no per-token rate table is embedded anywhere', offenders, []);

  // Token counts must stay split by type so the tooltip can report them.
  check('usage is tracked per token type',
    /input:\s*0,\s*output:\s*0,\s*cacheRead:\s*0,\s*cacheCreate:\s*0/.test(session));
  check('cache reads and writes are counted separately',
    /cache_read_input_tokens/.test(session) && /cache_creation_input_tokens/.test(session));
};

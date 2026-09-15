const { Session } = require(process.env.HOME + '/Codes/NikUI/src/session.js');
const s = new Session({ cwd: '/tmp', model: 'claude-haiku-4-5-20251001', permissionMode: 'bypassPermissions' });

const raw = [];            // ground truth straight off the wire
const turnCosts = [];
const origResult = s._handleResult.bind(s);
s._handleResult = (e) => { raw.push(e); origResult(e); };
s.on('items', (items) => { for (const i of items) if (i.kind === 'result' && !i._seen) { i._seen = true; turnCosts.push(i.costUsd); } });

const lastCtx = (e) => {
  const it = e.usage && e.usage.iterations;
  if (!Array.isArray(it) || !it.length) return null;
  const l = it[it.length - 1];
  return (l.input_tokens||0) + (l.cache_read_input_tokens||0) + (l.cache_creation_input_tokens||0);
};
const summedCtx = (e) => (e.usage.input_tokens||0) + (e.usage.cache_read_input_tokens||0) + (e.usage.cache_creation_input_tokens||0);
const mu = (e) => Object.values(e.modelUsage || {})[0] || {};

const step = (fn, ms) => new Promise(r => setTimeout(() => { fn(); r(); }, ms));
const untilResult = (n) => new Promise(r => {
  const check = () => (raw.length >= n ? r() : setTimeout(check, 250));
  check();
});

(async () => {
  s.start();
  await step(() => s.send('say OK'), 600);
  await untilResult(1);

  await step(() => s.send('Run three separate Bash commands: `echo one`, then `echo two`, then `echo three`. Then say DONE.'), 300);
  await untilResult(2);

  const e2 = raw[1];
  const m2 = mu(e2);
  console.log('--- after a 3-tool turn ---');
  console.log('  context I report      :', s.contextTokens);
  console.log('  last model call ctx   :', lastCtx(e2));
  console.log('  summed (the old bug)  :', summedCtx(e2));
  console.log('  context window        :', s.contextWindow);
  console.log('  tokens in/out (mine)  :', s.usage.input, '/', s.usage.output);
  console.log('  modelUsage cumulative :', m2.inputTokens, '/', m2.outputTokens);
  console.log('  cacheRead (mine)      :', s.usage.cacheRead, ' modelUsage:', m2.cacheReadInputTokens);
  console.log('  cost total (mine)     : $' + s.totalCost.toFixed(7));
  console.log('  total_cost_usd (wire) : $' + e2.total_cost_usd.toFixed(7));

  const snap = { ctx: s.contextTokens, input: s.usage.input, output: s.usage.output, cacheRead: s.usage.cacheRead, cost: s.totalCost };
  const preRestartCost = s.totalCost;
  const preRestartIn = s.usage.input;

  // Restarting keeps the conversation but spawns a new process, which resets
  // the CLI's cumulative cost to zero.
  s.restart({ keepContext: true });
  await new Promise(r => setTimeout(r, 4000));
  await step(() => s.send('say FINAL'), 500);
  await untilResult(3);

  const e3 = raw[2];
  console.log('\n--- after restarting the process ---');
  console.log('  new process reported  : $' + e3.total_cost_usd.toFixed(7), '(restarts at zero)');
  console.log('  cost before restart   : $' + preRestartCost.toFixed(7));
  console.log('  cost after            : $' + s.totalCost.toFixed(7));
  console.log('  that turn charged     : $' + turnCosts[2].toFixed(7));

  const sumTurns = turnCosts.reduce((a, b) => a + b, 0);
  const checks = [
    ['context = last model call, not the sum', snap.ctx === lastCtx(e2)],
    ['context is far below the summed figure', snap.ctx < summedCtx(e2) / 2],
    ['context stays under the window', snap.ctx < s.contextWindow && s.contextTokens < s.contextWindow],
    ['input tokens match modelUsage cumulative', snap.input === m2.inputTokens],
    ['output tokens match modelUsage cumulative', snap.output === m2.outputTokens],
    ['cache reads match modelUsage cumulative', snap.cacheRead === m2.cacheReadInputTokens],
    ['cost total matched the wire before restart', Math.abs(snap.cost - e2.total_cost_usd) < 1e-9],
    ['restart did not collapse the total', s.totalCost > preRestartCost],
    ['restart turn charged only its own cost', turnCosts[2] > 0 && turnCosts[2] < preRestartCost],
    ['per-turn costs still sum to the total', Math.abs(sumTurns - s.totalCost) < 1e-9],
    ['token totals survived the restart', s.usage.input > snap.input]
  ];
  let bad = 0;
  console.log('\n=== CHECKS ===');
  for (const [n, ok] of checks) { console.log((ok ? 'PASS  ' : 'FAIL  ') + n); if (!ok) bad++; }
  console.log(bad ? '\n' + bad + ' FAILED' : '\nALL ACCOUNTING CHECKS PASS');
  s.dispose();
  setTimeout(() => process.exit(0), 300);
})();
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 200000);

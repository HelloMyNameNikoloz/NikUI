'use strict';
const net = require('net'), { spawnSync } = require('child_process');

function portHolders(port, run = spawnSync) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpc'],
      { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    if (result.error || ![0, 1].includes(result.status)) continue;
    const holders = [];
    for (const line of String(result.stdout || '').split('\n')) {
      if (/^p[1-9][0-9]*$/.test(line)) holders.push({ pid: Number(line.slice(1)) });
      else if (line.startsWith('c') && holders.length) holders.at(-1).command = line.slice(1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512);
    }
    if (holders.length) return holders;
  }
  return [];
}
async function inspectPort(port, holders = portHolders) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { port, available: false, code: 'PORT_INVALID', holders: [] };
  if (port === 0) return { port, available: true, holders: [] };
  const server = net.createServer();
  const code = await new Promise((resolve) => {
    server.once('error', (error) => resolve(error.code));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(null)));
  });
  return { port, available: !code, ...(code ? { code: code === 'EADDRINUSE' ? 'PORT_IN_USE' : code } : {}), holders: code === 'EADDRINUSE' ? holders(port) : [] };
}
async function reviewPort(selected, inspect = inspectPort) {
  const routes = selected.flatMap((s) => s.review.routes || []);
  const port = routes[0]?.localPort ?? selected[0]?.review.listener?.configuredPort ?? 4517, result = await inspect(port);
  const takeover = result.code === 'PORT_IN_USE' && result.holders.length > 0 && result.holders.every((holder) =>
    selected.some((source) => source.pid === holder.pid && source.review.listener?.listening === true && source.review.listener.port === port));
  return { ...result, takeover, ready: result.available || takeover };
}
module.exports = { portHolders, inspectPort, reviewPort };

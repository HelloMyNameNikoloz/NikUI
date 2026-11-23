'use strict';
const { hash } = require('./engineOwner');
const { isDeepStrictEqual: equal } = require('util');
const { fail } = require('./daemonPaths');
const ROUTE_KEY = 'nikui.remote.route.v1';
function routeRecord(host, localPort) {
  if (!/^[a-z0-9][a-z0-9.-]*\.ts\.net$/i.test(host || '') || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535)
    throw fail('ROUTE_OWNER_MISMATCH', 'The tailnet hostname or local port is invalid');
  return { version: 1, kind: 'tailscale', host, port: 443, mount: '/', localPort,
    handler: { Proxy: 'http://127.0.0.1:' + localPort }, tcp: { HTTPS: true }, funnel: false };
}
function routeProblem(record, config) {
  const address = record ? `https://${record.host}${record.port === 443 ? '' : ':' + record.port}${record.mount}` : 'the tailnet root route';
  const key = record && record.host + ':' + record.port;
  const handler = config?.Web?.[key]?.Handlers?.[record?.mount];
  const valid = record?.version === 1 && record.kind === 'tailscale' && record.port === 443 && record.mount === '/' &&
    equal(record, routeRecord(record.host, record.localPort));
  if (valid && config?.TCP?.[record.port] && equal(config.TCP[record.port], record.tcp) &&
      equal(handler, record.handler) && (config.AllowFunnel?.[key] === true) === record.funnel) return null;
  const actual = handler?.Proxy || (handler ? 'a different handler' : 'no verified handler');
  return { code: 'ROUTE_OWNER_MISMATCH', route: address, absent: !handler, expected: record?.handler?.Proxy || 'a route created by this NikUI window', actual,
    message: `${address} points to ${actual}; NikUI recorded ${record?.handler?.Proxy || 'no owned handler'}. Restore that exact tailnet handler or stop phone access in its owning window, then Refresh. Other paths, ports and Funnels are left alone.` };
}
// One status subprocess per review/Move, including failures. The cache belongs
// to the operation, so the next Refresh always reads current configuration.
function routeCheck(tailscale) {
  let config;
  return { serveConfig: () => config ||= Promise.resolve().then(() => tailscale.serveConfig({ timeout: require('./tunnel').STATUS_TIMEOUT_MS })) };
}
async function recordWindowRoute(tailscale, localPort) {
  const config = await tailscale.serveConfig();
  const candidates = Object.keys(config.Web || {}).filter((key) => key.endsWith(':443')).map((key) => {
    try { return routeRecord(key.slice(0, -4), localPort); } catch (_) { return null; }
  }).filter((r) => r && !routeProblem(r, config));
  if (candidates.length !== 1) throw fail('ROUTE_OWNER_MISMATCH', `No unique tailnet HTTPS 443 / handler forwards to this window on port ${localPort}.`);
  return candidates[0];
}
async function verifyRoute(tailscale, record, port = record?.localPort) {
  if (!record) return null;
  let problem;
  try {
    if (record.localPort !== port) throw fail('ROUTE_PORT_CHANGED', 'The route belongs to another listening port');
    problem = routeProblem(record, await tailscale.serveConfig());
  }
  catch (_) { problem = { code: 'ROUTE_OWNER_MISMATCH', route: `https://${record.host}/`,
    message: `Cannot verify https://${record.host}/ → ${record.handler?.Proxy}. Check Tailscale is running, then Refresh.` }; }
  if (problem) throw Object.assign(fail(problem.code, problem.message), { diagnostics: problem });
  return record;
}
function transferredRoutes(sources) {
  return [...new Map(sources.flatMap((s) => s.files.routes || []).map((r) => [r.host + ':' + r.port + r.mount, r])).values()];
}
async function attachRoutes({ sources, remote, tailscale = new (require('./tunnel').Tailscale)() }) {
  const candidates = transferredRoutes(sources);
  const exposure = { routes: [], warnings: [], async review() {
    const checked = await transferableRoutes(tailscale, candidates, remote.port);
    exposure.routes = checked.routes; exposure.warnings = checked.warnings;
    remote.publicHost = exposure.routes[0]?.host || null;
    return checked;
  } };
  await exposure.review();
  return exposure;
}
async function transferableRoutes(tailscale, candidates, port) {
  const routes = [], warnings = [], check = routeCheck(tailscale);
  for (const route of candidates) {
    try {
      if (candidates.length > 1) throw fail('ROUTE_OWNER_MISMATCH', 'More than one root route was exported');
      routes.push(await verifyRoute(check, route, port ?? route.localPort));
    } catch (e) { warnings.push({ ...(e.diagnostics || { code: 'ROUTE_OWNER_MISMATCH', message: e.message }),
      message: (e.diagnostics?.message || e.message) + ' Phone route was not transferred; local conversations remain available.' }); }
  }
  return { routes, warnings };
}
module.exports = { ROUTE_KEY, routeRecord, routeProblem, verifyRoute, transferredRoutes, attachRoutes, routeCheck, transferableRoutes, recordWindowRoute };

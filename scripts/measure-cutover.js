#!/usr/bin/env node
'use strict';
// Portable production-composition measurement. No GUI, Keychain or real tools.
const fs = require('fs'), path = require('path'), os = require('os');
const { performance } = require('perf_hooks'), { spawnSync } = require('child_process');
const { productionFixture } = require('../test/helpers/production-cutover');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function measureRouteReview({ samples = 8, cliDelayMs = 180 } = {}) {
  const f = await productionFixture(), dir = fs.mkdtempSync('/tmp/n29-route-cost-');
  const { Tailscale, PLACES, STATUS_TIMEOUT_MS } = require('../src/tunnel');
  const { routeRecord, routeCheck, verifyRoute } = require('../src/routeContinuity');
  const realBinaryPath = PLACES.find((p) => fs.existsSync(p)) || '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  // Execute a disposable shim at the same app-style path depth. The delay
  // explicitly models CLI/daemon IPC cost; the real binary is never executed.
  const binary = path.join(dir, realBinaryPath.slice(1)); fs.mkdirSync(path.dirname(binary), { recursive: true });
  const config = require('../test/production-round27.test').multiRoutes(51239), log = path.join(dir, 'calls');
  fs.writeFileSync(binary, '#!' + process.execPath + '\n' +
    `require('fs').appendFileSync(${JSON.stringify(log)},'1\\n');setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(config))}),${cliDelayMs});`, { mode: 0o700 });
  try {
    const tailscale = new Tailscale({ binary });
    const server = { listening: false, port: 51239, stop() {}, sourceRouteRecord: () => routeRecord('fixture.tail123.ts.net', 51239),
      async sourceReleaseReadiness() {
        const check = routeCheck(tailscale);
        try { await verifyRoute(check, server.sourceRouteRecord()); await verifyRoute(check, server.sourceRouteRecord()); }
        catch (_) { /* Route unavailability is a warning, never a startup dependency. */ }
        return [];
      } };
    const slot = await require('../test/production-round29.test').sourceAdapters(f, { server });
    for (let n = 1; n < 32; n++) slot.engine.manager.create({ id: 'route-measure-' + n, cwd: slot.project, autoStart: false });
    slot.engine.manager.persist(); slot.engine.flush();
    const coordinator = f.coordinator(), values = [];
    for (let i = 0; i < samples; i++) { const begin = performance.now(); const result = await coordinator.review();
      if (!result.ready || result.conversations !== 32) throw Error('ROUTE_REVIEW_INVALID'); values.push(performance.now() - begin); }
    values.sort((a, b) => a - b);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').length;
    if (calls !== samples) throw Error('ROUTE_REVIEW_NOT_CACHED');
    return { samples, conversations: 32, realBinaryPath, executedBinary: binary, realBinaryExecuted: false, modeledCLIDaemonCostMs: cliDelayMs,
      timeoutMs: STATUS_TIMEOUT_MS, callsPerReview: calls / samples, p50Ms: values[Math.floor(samples / 2)], p95Ms: values[Math.floor(samples * .95)], maxMs: values.at(-1) };
  } finally { await f.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
}
async function measure({ conversations = 32, samples = 30, idleMs = 10000 } = {}) {
  const f = await productionFixture(); let runtime;
  const report = { fixture: { sourceWindows: 1, conversations, providers: 'synthetic, no live resources' },
    machine: { platform: process.platform, arch: process.arch, os: os.release(), node: process.version, cpu: os.cpus()[0]?.model } };
  try {
    const slot = f.slots[0];
    for (let n = 1; n < conversations; n++) slot.engine.manager.create({ id: 'measurement-' + n, cwd: slot.project, autoStart: false });
    slot.engine.manager.persist(); slot.engine.flush();
    const coordinator = f.coordinator();
    await coordinator.review();
    const latencies = [];
    for (let n = 0; n < samples; n++) { const start = performance.now(); const review = await coordinator.review();
      if (!review.ready || review.conversations !== conversations) throw Error('MEASUREMENT_REVIEW_INVALID'); latencies.push(performance.now() - start); }
    latencies.sort((a, b) => a - b);
    report.review = { samples, p50Ms: latencies[Math.floor(samples * 0.5)], p95Ms: latencies[Math.floor(samples * 0.95)], maxMs: latencies.at(-1) };
    const move = performance.now(); await coordinator.move(await coordinator.review()); runtime = await f.start(); await coordinator.finish();
    report.moveMs = performance.now() - move;
    await slot.source.dispose(); await delay(2500); // let the one-shot persistence debounce settle
    const work = fs.mkdtempSync('/tmp/n27-perf-'), sampler = path.join(work, 'rusage');
    try {
      if (process.platform === 'darwin') {
        const built = spawnSync('/usr/bin/cc', [path.join(__dirname, 'measure-engine-rusage.c'), '-o', sampler], { encoding: 'utf8', timeout: 30000 });
        report.kernelSampler = built.status === 0 ? 'available' : { pendingNative: true, reason: built.error?.code || built.stderr };
      }
      const read = () => {
        if (!fs.existsSync(sampler)) return null;
        const result = spawnSync(sampler, [String(process.pid)], { encoding: 'utf8', timeout: 3000 });
        return result.status === 0 ? JSON.parse(result.stdout) : null;
      };
      const first = read(), cpu = process.cpuUsage(), begin = performance.now();
      let timerWakeups = 0;
      const timers = new Set(), hook = require('async_hooks').createHook({
        init(id, type) { if (type === 'Timeout') timers.add(id); }, before(id) { if (timers.has(id)) timerWakeups++; }, destroy(id) { timers.delete(id); }
      }); hook.enable();
      await delay(idleMs); hook.disable();
      const elapsedMs = performance.now() - begin, used = process.cpuUsage(cpu), last = read();
      report.idle = { elapsedMs, cpuMs: (used.user + used.system) / 1000, cpuPercent: (used.user + used.system) / (elapsedMs * 10),
        timerWakeups: Math.max(0, timerWakeups - 1), rssMiB: process.memoryUsage().rss / 1048576, heapUsedMiB: process.memoryUsage().heapUsed / 1048576,
        ...(first && last ? { interruptWakeups: last.interruptWakeups - first.interruptWakeups,
          packageIdleWakeups: last.packageIdleWakeups - first.packageIdleWakeups, footprintMiB: last.footprintBytes / 1048576,
          kernelCpuMs: (last.userNs + last.systemNs - first.userNs - first.systemNs) / 1e6 } : { kernelWakeups: 'native: pending Claude run (sampler unavailable in this host)' }) };
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
    report.routeReview = await measureRouteReview();
    report.slowRouteReview = await measureRouteReview({ samples: 4, cliDelayMs: 5000 });
    report.ok = report.review.p95Ms < 1000 && report.routeReview.p95Ms < 1000 && report.slowRouteReview.maxMs < 1100;
    return report;
  } finally { await runtime?.stop(); await f.cleanup(); }
}
module.exports = { measure, measureRouteReview };
if (require.main === module) measure().then((report) => { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.ok ? 0 : 1; }, (error) => { console.error(error); process.exitCode = 1; });

'use strict';

// Also used by the chrome adapter suite: its core graph has an independent,
// entirely poisoned process, so a window stub can never mask core resolution.
const path = require('path');
const { createEngine } = require('../../../src/engine');
const { createMachineHost } = require('../../../src/machineHost');
const { context, settings } = require('./fakes');

module.exports = async function () {
  suite('T03: the adapter core has its own poisoned graph proof');
  const home = process.env.NIKUI_ENGINE_FIXTURE_ROOT;
  const source = settings();
  const neverSpawn = () => { throw new Error('construction must be inert'); };
  const engine = createEngine({ context: context(), settings: source,
    paths: { home, projects: path.join(home, 'projects'), codexCache: path.join(home, 'cache') },
    spawner: neverSpawn, codex: { home: path.join(home, '.codex'), codexPath: '/fixture/codex', spawnFn: neverSpawn },
    slack: {} });
  const host = createMachineHost({ manager: engine.manager, settings: source, codex: () => engine.codex });
  await engine.start();
  checkEqual('the window factory target loads with injected services alone', host.config().claudePath, 'claude');
  checkEqual('its disabled Slack path stays headless', engine.slack.room.stateFor({}).enabled, false);
  checkEqual('its terminal route is explicit without an editor', host.runInTerminal({ command: 'never execute' }).status, 'unavailable');
  engine.dispose();
};

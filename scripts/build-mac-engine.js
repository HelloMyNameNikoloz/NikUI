#!/usr/bin/env node
'use strict';

// Compatibility entry for the P2 native harness. It can ONLY build dev.
const app = require('./build-mac-app');
function build(options = {}) {
  if (options.flavour !== undefined && options.flavour !== 'dev') throw new Error('DEVELOPMENT_PROFILE_ONLY');
  return app.build({ ...options, flavour: 'dev' });
}
if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  try {
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--output': 'output', '--test-home': 'testHome', '--identity': 'identity' }[args[i]];
      if (!key || !args[i + 1] || Object.hasOwn(options, key)) throw new Error('Usage: build-mac-engine.sh [--output dev.app] [--test-home private-home] [--identity identity]');
      options[key] = args[i + 1];
    }
    process.stdout.write(JSON.stringify(build(options)) + '\n');
  } catch (error) { process.stderr.write(String(error.stderr || error.message) + '\n'); process.exitCode = 1; }
}
module.exports = { ...app, build, LABEL: 'com.nikui.engine.development' };

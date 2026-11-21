'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolResolver, MINIMAL_PATH, loginLookup } = require('../src/toolResolver');

module.exports = async function () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tool-'));
  const dirs = ['configured', 'known', 'login'].map((dir) => path.join(home, dir));
  for (const dir of dirs) fs.mkdirSync(dir);
  const tool = (dir, name) => { const file = path.join(dir, name); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); return file; };
  try {
    suite('T61: configured → known directories → cached zsh binary lookup → missing');
    const override = tool(dirs[0], 'claude'), known = tool(dirs[1], 'claude'), login = tool(dirs[2], 'codex');
    let lookups = 0;
    const resolver = createToolResolver({ home, knownDirs: [dirs[1]], configured: { claude: override },
      env: { PATH: MINIMAL_PATH, SSH_AUTH_SOCK: '/fixture/ssh' }, lookup: async ({ home: passed, names }) => {
        lookups++; checkEqual('login lookup gets the explicit private home', passed, home);
        check('lookup requests the binary tool allowlist', names.includes('claude') && names.includes('codex') && names.includes('trust-dir'));
        return { available: true, path: dirs[2] + ':' + MINIMAL_PATH, tools: { claude: known, codex: login } };
      } });
    const [a, b] = await Promise.all([resolver.resolveAll(), resolver.resolveAll()]);
    check('concurrent requests share the startup cache', a === b && lookups === 1);
    checkEqual('configured absolute executable wins', [a.tools.claude.source, a.tools.claude.path], ['configured', override]);
    checkEqual('login-shell fallback accepts the binary path', [a.tools.codex.source, a.tools.codex.path], ['login-shell-binary', login]);
    checkEqual('missing tool has a name and actionable hint', [a.tools.gh.status, /Install gh/.test(a.tools.gh.hint)], ['missing', true]);
    check('configured tool directories precede the cached login PATH for child dependencies', a.childEnv.PATH.startsWith(dirs[0] + ':' + dirs[2] + ':'));
    checkEqual('provider home and SSH socket are explicit, never inherited from a CLI function', [a.childEnv.CODEX_HOME, a.childEnv.HOME, a.childEnv.SSH_AUTH_SOCK],
      [path.join(home, '.codex-work'), home, '/fixture/ssh']);
    check('doctor documents the bypassed shell-function/trust behavior', /functions are bypassed.*CODEX_HOME.*trust/.test(a.wrappers));
    await resolver.resolveAll();
    checkEqual('per-request status never runs a new shell', lookups, 1);
    await resolver.refresh();
    checkEqual('an explicit refresh replaces the cached lookup', lookups, 2);
    const knownResolver = createToolResolver({ home, knownDirs: [dirs[1]], lookup: async () => ({ tools: { claude: override } }) });
    checkEqual('known directories precede shell lookup', (await knownResolver.resolveAll()).tools.claude.path, known);
    const invalid = createToolResolver({ home, knownDirs: [dirs[1]], configured: { claude: '/missing/override' }, lookup: async () => ({ tools: { claude: override } }) });
    checkEqual('a broken configured selection refuses instead of silently changing tools', (await invalid.resolveAll()).tools.claude.status, 'missing');
    const func = createToolResolver({ home, knownDirs: [], lookup: async () => ({ tools: { claude: 'claude () { secret; }' } }) });
    checkEqual('a function definition cannot become an executable', (await func.resolveAll()).tools.claude.path, null);
    const failed = createToolResolver({ home, knownDirs: [], lookup: async () => { throw new Error('secret shell output'); } });
    check('shell failure yields private actionable diagnostics', !JSON.stringify(await failed.resolveAll()).includes('secret shell output'));

    if (process.platform === 'darwin') {
      suite('T61: actual private zsh -lic resolves binaries behind functions');
      fs.writeFileSync(path.join(home, '.zshrc'), `print PRIVATE_STARTUP_BANNER\nexport PATH='${dirs[2]}:/usr/bin:/bin:/usr/sbin:/sbin'\nclaude() { print WRAPPER_MUST_NOT_RUN; }\ncodex() { print WRAPPER_MUST_NOT_RUN; }\n`);
      const binary = tool(dirs[2], 'claude');
      const actual = await loginLookup({ home, env: {}, names: ['claude', 'codex'] });
      checkEqual('whence -p finds the executable rather than the wrapper', [actual.tools.claude, actual.tools.codex], [binary, login]);
      check('the shell functions were never invoked', !JSON.stringify(actual).includes('WRAPPER_MUST_NOT_RUN'));
      check('shell startup noise cannot enter tool diagnostics or child PATH', !JSON.stringify(actual).includes('PRIVATE_STARTUP_BANNER'));
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
};

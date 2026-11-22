'use strict';
const path = require('path');
const { privateRoot } = require('./daemonPaths');
const { atomicJson } = require('./engineOwner');
const safeCode = (error) => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'SIGNED_ENGINE_UNAVAILABLE';
function recordFailure({ selection, ownership }, error) {
  // Called only after signed package/selected-root validation. Diagnostics
  // contain a code and binding, never raw provider, credential or path errors.
  const paths = privateRoot(selection.root, { create: false });
  atomicJson(path.join(paths.root, 'engine-startup-failure.json'), { version: 1, root: paths.root,
    pid: process.pid, at: Date.now(), code: safeCode(error), transition: ownership?.record.transition ?? null });
}
module.exports = { safeCode, recordFailure };

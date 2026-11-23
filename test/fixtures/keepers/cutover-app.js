'use strict';
const fs = require('fs'), path = require('path');
const { atomicJson } = require('../../../src/engineOwner');
const { createProductionCutover } = require('../../../src/productionCutover');
const configFile = process.argv[2], config = JSON.parse(fs.readFileSync(configFile));
const secretAdapter = require('./file-keychain')(config.keychain);
let review;
const coordinator = createProductionCutover({ selection: config.selection, secretAdapter,
  fault(stage) {
    if (stage !== config.boundary && !stage.startsWith(config.boundary + ':')) return;
    atomicJson(path.join(path.dirname(configFile), 'app-boundary.json'), { stage, review });
    // The parent SIGKILLs this exact minted app process while it still holds
    // the real operation lease, without unwinding any coordinator cleanup.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } });
(async () => { review = await coordinator.review(); await coordinator.move(review); throw Error('BOUNDARY_NOT_REACHED'); })()
  .catch((error) => { process.stderr.write(error.stack); process.exit(78); });

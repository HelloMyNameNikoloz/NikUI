'use strict';

const { disconnectStress } = require('./helpers/transport-disconnect');
module.exports = async () => {
  suite('P2 R02 required fix: bounded disconnect/encryption stress');
  const result = await disconnectStress(240);
  checkEqual('240 jittered disconnect/seal/queued-query interleavings ran', result.trials, 240);
  checkEqual('ciphertext always belongs to its live destination channel', result.unsafeWrites, 0);
  checkEqual('held old-channel ciphertext never reaches any socket', result.heldWrites, 0);
  check('a count sampled before the hold can change for unrelated queries', result.falseCountAlarms > 0);
};

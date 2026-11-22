'use strict';
const path = require('path');
const { readPrivateJson, privateFile, fail } = require('./daemonPaths');
const { createOwner } = require('./engineOwner');

// Reading this proof precedes any root creation, SecItem access, tool lookup
// or provider construction in the signed production entry.
function committedOwnership(root) {
  const file = path.join(root, 'production-owner.json');
  if (!privateFile(file, { optional: true })) throw fail('SOURCE_HANDSHAKE_UNAVAILABLE', 'No committed source handshake exists');
  const record = readPrivateJson(file);
  if (record.version !== 1 || record.committed !== true || !Number.isSafeInteger(record.generation) || record.generation < 1 ||
      !/^[a-f0-9]{32}$/.test(record.transition) || !/^[a-f0-9]{32}$/.test(record.member?.lease)) {
    throw fail('SERVICE_OWNERSHIP_REQUIRED', 'Committed ownership proof is incomplete');
  }
  if (record.ownerRoot !== path.join(root, 'o') || !/^[a-f0-9]{64}$/.test(record.profile) ||
      typeof record.install !== 'string' || !(path.isAbsolute(record.install) ||
        record.install === require('../package.json').publisher + '.' + require('../package.json').name) ||
      !['com.nikui.engine', 'com.nikui.engine.development'].includes(record.target) ||
      record.member.id !== record.target || record.member.generation !== record.generation) {
    throw fail('SERVICE_OWNERSHIP_REQUIRED', 'Committed scope or target is invalid');
  }
  const owner = createOwner({ root: record.ownerRoot, profile: record.profile, install: record.install });
  const status = owner.status();
  if (status.mode !== 'service' || status.by !== record.target || status.generation !== record.generation) {
    throw fail('SERVICE_OWNERSHIP_REQUIRED', 'The source generation no longer belongs to this service');
  }
  const assertCurrent = (options) => owner.assertWriter(record.member.lease, record.generation, options);
  assertCurrent();
  return { record, owner, committed: true, generation: String(record.generation), assertCurrent };
}
module.exports = { committedOwnership };

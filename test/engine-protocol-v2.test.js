'use strict';

const { loadCorpus, validateSchemaDefinition, validateSchema, validateVector, malformedVector, FixtureError } = require('./helpers/protocol-v2-fixtures');

module.exports = function () {
  suite('protocol v2 fixture consistency (not runtime conformance)');
  const corpus = loadCorpus();
  checkEqual('intended vector count', corpus.vectors.size, 179);
  checkEqual('intended malformed vector count', corpus.invalid.length, 30);
  checkEqual('all eight areas are consumed', corpus.manifest.files.length, 8);
  checkEqual('all 54 mutation branches are indexed against protocol §8', corpus.manifest.inventory.length, 54);
  checkEqual('all 14 canonical preimages are hashed', [...corpus.vectors.values()].filter(v => v.hash).length, 14);
  for (const entry of corpus.manifest.files) {
    check(entry.category + ' has positive and negative traces', entry.positive > 0 && entry.negative > 0);
  }
  for (const vector of corpus.vectors.values()) check(vector.id, validateVector(vector, corpus.schema));
  for (const test of corpus.invalid) {
    let code = null;
    try { validateVector(malformedVector(test, corpus.vectors), corpus.schema); }
    catch (error) { if (!(error instanceof FixtureError)) throw error; code = error.code; }
    checkEqual('reject malformed vector: ' + test.id, code, test.error);
  }
  let unsupported = false;
  try { validateSchemaDefinition({ anyOf: [{}, { inventedConstraint: true }] }); }
  catch (error) { unsupported = error instanceof FixtureError && error.code === 'schema'; }
  check('unsupported schema keywords cannot silently pass', unsupported);
  const mapSchema = { type: 'object', additionalProperties: { type: 'string' } };
  check('schema-valued additionalProperties accepts valid members', validateSchema({ extra: 'valid' }, mapSchema, corpus.schema));
  let invalidMember = false;
  try { validateSchema({ extra: 42 }, mapSchema, corpus.schema); }
  catch (error) { invalidMember = error instanceof FixtureError && error.code === 'schema'; }
  check('schema-valued additionalProperties cannot skip value validation', invalidMember);
};

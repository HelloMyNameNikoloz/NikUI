'use strict';

// Which models this copy of the CLI knows.
//
// The point of reading them rather than listing them is that a list is wrong
// the day a model ships — so what is checked here is mostly that: a CLI that
// has learned a new one offers it, without anybody editing anything.

const { discover, describe, newestFirst, DATED, ALIASES } = require('../src/models.js');

/** A CLI, as far as this is concerned: a name and the strings inside it. */
function fakeCli(ids, options) {
  const o = options || {};
  return {
    claudePath: '/fake/claude',
    exists: (f) => f === '/fake/claude',
    realpath: (f) => f,
    stat: () => ({ size: o.size || 1000, mtimeMs: o.mtime || 1 }),
    scan: (file, done) => done(o.broken ? null : new Set(ids))
  };
}

module.exports = async function () {
  suite('the list comes from the CLI, newest first');

  {
    const found = await discover(fakeCli([
      'claude-opus-4-5', 'claude-opus-5', 'claude-opus-5-5',
      'claude-opus-5-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5'
    ]));
    checkEqual('read out of the binary rather than guessed', found.from, 'catalog');
    const ids = found.models.filter((m) => !m.alias).map((m) => m.id);
    checkEqual('newest first, and the wide one under its own name', ids, [
      'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5', 'claude-opus-4-5',
      'claude-sonnet-5', 'claude-haiku-4-5'
    ]);
    check('the aliases are there too, at the end',
      found.models.slice(-4).every((m) => m.alias));
  }

  suite('a CLI that has learned a new model offers it');

  {
    // The whole reason this is read rather than written down: nothing here
    // knows what comes after 5.5, and it does not have to.
    const found = await discover(fakeCli(['claude-opus-5-5', 'claude-opus-6', 'claude-opus-6[1m]']));
    const ids = found.models.filter((m) => !m.alias).map((m) => m.id);
    checkEqual('the one nobody has heard of is at the top', ids[0], 'claude-opus-6');
    checkEqual('with its wide form under it', ids[1], 'claude-opus-6[1m]');
    checkEqual('and it is named the way a person would', found.models[0].label, 'Opus 6');
  }

  suite('what is left out, and why');

  check('a dated build is a build, not a choice', DATED.test('claude-opus-4-1-20250805'));
  check('so is its wide form', DATED.test('claude-opus-4-1-20250805[1m]'));
  check('and a provider id beside it', DATED.test('claude-opus-4-6-v1'));
  check('the plain name is not', !DATED.test('claude-opus-4-6'));
  check('nor the wide one', !DATED.test('claude-opus-5-5[1m]'));

  {
    const found = await discover(fakeCli([
      'claude-opus-5-5', 'claude-opus-5-5[1m]',
      'claude-opus-4-1-20250805', 'claude-opus-4-6-v1'
    ]));
    checkEqual('so a menu has only the names somebody would pick',
      found.models.filter((m) => !m.alias).map((m) => m.id),
      ['claude-opus-5-5', 'claude-opus-5-5[1m]']);
  }

  suite('what a row says');

  checkEqual('a version reads as a version', describe('claude-opus-5-5').label, 'Opus 5.5');
  checkEqual('the wide one says what is wide about it',
    describe('claude-opus-5-5[1m]').detail, '1M context');
  checkEqual('and is still named for the model', describe('claude-opus-5-5[1m]').label, 'Opus 5.5');
  checkEqual('a family on its own is a family', describe('claude-sonnet-5').label, 'Sonnet 5');

  suite('when the CLI cannot be read at all');

  {
    // Aliases always resolve to the newest of their family, so this is a worse
    // list and never a wrong one.
    const missing = await discover({ claudePath: '/nowhere/claude', exists: () => false });
    checkEqual('there are still the aliases', missing.from, 'aliases');
    checkEqual('which are the four families',
      missing.models.map((m) => m.id), ALIASES.map((m) => m.id));
    check('and each says what it means',
      missing.models.every((m) => /newest/.test(m.detail)));

    const broken = await discover(fakeCli([], { broken: true }));
    checkEqual('a binary that will not read falls back the same way', broken.from, 'aliases');
  }

  suite('read once per CLI, not once per menu');

  {
    let scans = 0;
    const store = new Map();
    const cache = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: (k, v) => store.set(k, v) };
    const cli = (mtime) => ({
      claudePath: '/fake/claude',
      exists: () => true,
      realpath: (f) => f,
      stat: () => ({ size: 10, mtimeMs: mtime }),
      scan: (file, done) => { scans++; done(new Set(['claude-opus-5-5'])); },
      cache
    });

    await discover(cli(1));
    await discover(cli(1));
    checkEqual('the same CLI is read once', scans, 1);
    checkEqual('and the answer is remembered', (await discover(cli(1))).from, 'remembered');

    // Updating Claude Code is exactly the moment the list should change.
    const after = await discover(cli(2));
    checkEqual('a CLI that has been updated is read again', scans, 2);
    checkEqual('and that answer is the fresh one', after.from, 'catalog');
  }

  suite('the order itself');

  {
    const rows = ['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5']
      .map(describe).sort(newestFirst).map((m) => m.id);
    checkEqual('families keep their own order, newest within each', rows,
      ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  }
};

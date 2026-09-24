'use strict';

// What a slash in the composer offers.
//
// Two halves of one feature. The host works out which values a command takes —
// out of the CLI's replies, and out of the CLI itself — and the page works out
// which of them to show for what has been typed, and what picking one writes.
// Neither half needs a browser to be checked, so neither is checked in one.

const { install } = require('./helpers/vscode-stub.js');
install();

const { commandArgs, learnCommandArgs, offerCommandArgs } = require('../src/session.js');
const palette = require('../media/palette.js');

// The reply this exists for, verbatim from the CLI.
const MODEL_REPLY = 'Current model: `Opus 5 (1M context)` (effort: max)\n' +
  'Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], ' +
  'opus[1m], fable[1m], opusplan, default, or a full model ID.';

// The same shape, about a command nothing else touches. What a command takes is
// remembered for the whole process, and by the time this runs the window has
// usually already read the real models out of the real binary — so the exact
// lists are checked here, where nothing else can have got there first.
const MADE_UP = 'Current voice: `Calm`\n' +
  'Usage: /voice <name>. Available: calm, brisk, plain, or any voice file.';

const values = (cmd) => (commandArgs()[cmd] || []).map((v) => v.value);
const at = (cmd, value) => values(cmd).indexOf(value);

module.exports = function () {
  suite('the values a command takes are read out of its own reply');

  {
    check('a reply that is not a usage line changes nothing',
      !learnCommandArgs('Done. Nothing else to do here.'));

    check('a usage line teaches us something', learnCommandArgs(MADE_UP));
    checkEqual('every name it lists is offered', values('voice'), ['calm', 'brisk', 'plain']);
    // "or any voice file" — like "or a full model ID" — is the CLI being honest
    // that the set is open. It is prose, and a palette full of prose is a
    // palette nobody can read.
    check('the sentence at the end of the list is not one of them',
      !values('voice').some((v) => /\s/.test(v)));

    check('the real model reply reads the same way', learnCommandArgs(MODEL_REPLY));
    check('so every alias it names can be picked',
      ['sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'default', 'opus[1m]']
        .every((alias) => values('model').includes(alias)));

    check('the older shape still reads',
      learnCommandArgs('Usage: /output-style <concise|explanatory|learning>'));
    checkEqual('with the values from between the angle brackets',
      values('output-style'), ['concise', 'explanatory', 'learning']);

    check('effort is known before anything has been run',
      values('effort').includes('max') && values('effort').includes('low'));
  }

  suite('what the window reads out of the binary goes above the aliases');

  {
    // The CLI names `opus`; the window reads `claude-opus-5-5` out of the
    // binary. Both work, and the one somebody picks deliberately goes first.
    check('offering a described list changes it', offerCommandArgs('voice', [
      { value: 'calm-2', label: 'Calm 2', detail: 'the newer one' }
    ]));
    checkEqual('it is at the top', values('voice'), ['calm-2', 'calm', 'brisk', 'plain']);
    checkEqual('and keeps what it says about itself',
      commandArgs().voice[0].detail, 'the newer one');

    offerCommandArgs('model', [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }]);
    check('a real identifier outranks the alias for the same thing',
      at('model', 'claude-opus-5-5') >= 0 && at('model', 'claude-opus-5-5') < at('model', 'opus'));

    check('offering the same list again changes nothing',
      !offerCommandArgs('voice', [{ value: 'calm-2', label: 'Calm 2' }]));
    check('and neither does an empty one', !offerCommandArgs('voice', []));
  }

  // From here on the page's half, against a fixed set of sources rather than
  // whatever the checks above have taught the host.
  const SOURCES = {
    commands: ['model', 'effort', 'compact', 'status', 'table', 'decisions'],
    own: ['status', 'table', 'decisions'],
    snippets: { table: 'AS A TABLE', decisions: 'THE DECISIONS' },
    args: {
      model: [
        { value: 'claude-opus-5-5', label: 'Opus 5.5', detail: '' },
        { value: 'claude-opus-5-5[1m]', label: 'Opus 5.5', detail: '1M context' },
        { value: 'claude-sonnet-5', label: 'Sonnet 5', detail: '' },
        { value: 'opus' },
        { value: 'sonnet' }
      ],
      effort: [{ value: 'low' }, { value: 'medium' }, { value: 'max' }]
    },
    now: { model: 'claude-opus-5-5[1m]', effort: 'max' }
  };

  const pick = (text, at) => palette.apply(palette.plan(text, SOURCES), at || 0, SOURCES);
  const shown = (text) => (palette.plan(text, SOURCES) || { matches: [] }).matches.map((m) => m.value);

  suite('a slash at the start offers commands');

  {
    checkEqual('typing narrows them', shown('/mod'), ['model']);
    checkEqual('nothing typed offers all of them', shown('/').length, SOURCES.commands.length);
    checkEqual('a URL does not open it', palette.plan('see https://example.com/', SOURCES), null);
    checkEqual('nor does a path', palette.plan('open src/', SOURCES), null);

    const taken = pick('/mod');
    checkEqual('picking one writes it', taken.value, '/model ');
    check('and the palette stays open, because it takes values', taken.more);

    check('one that takes no values closes it', !pick('/comp').more);
  }

  suite('values, chosen the way anything else is chosen');

  {
    checkEqual('with nothing typed, every one it knows',
      shown('/model '), SOURCES.args.model.map((v) => v.value));
    // The identifiers all begin "claude-", so a palette that only matched from
    // the front would answer "no match" to the word somebody actually knows.
    // What ranks first is a name that begins with it — "Opus 5.5" does, and so
    // the model comes above the alias that merely contains the same letters.
    checkEqual('typing a word finds it wherever it sits', shown('/model opus'),
      ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'opus']);
    checkEqual('and the newest is the one under the cursor',
      shown('/model opus')[0], 'claude-opus-5-5');

    const plan = palette.plan('/model ', SOURCES);
    checkEqual('a row reads as a person would say it', plan.matches[0].label, 'Opus 5.5');
    checkEqual('with what will actually be typed beside it', plan.matches[0].note, 'claude-opus-5-5');
    checkEqual('and what is different about it', plan.matches[1].note,
      'claude-opus-5-5[1m] · 1M context · current');
    checkEqual('the one in force says so',
      plan.matches.filter((m) => /current/.test(m.note)).length, 1);
    checkEqual('an undescribed value is just itself',
      palette.plan('/effort ', SOURCES).matches[0].note, '');

    checkEqual('picking writes the whole line', pick('/model op').value,
      '/model claude-opus-5-5');
    checkEqual('one arrow down is the wide one', pick('/model op', 1).value,
      '/model claude-opus-5-5[1m]');
    check('and there is nothing more to choose', !pick('/model op').more);
    checkEqual('the box says which command it is answering for',
      palette.plan('/model ', SOURCES).hint, '/model');

    checkEqual('a command with no values has no list', palette.plan('/compact ', SOURCES), null);
    checkEqual('nor does a command named in the middle of a sentence',
      palette.plan('tell me what /model does', SOURCES), null);
  }

  suite('at the end of a prompt, only what can be added');

  {
    // A CLI command is the whole prompt or it is nothing: "/model" after a
    // sentence is not a command, it is a word somebody typed. Snippets are the
    // one kind that reads as an addition, so they are the one kind offered.
    checkEqual('the snippets', shown('fix the refund path /'), ['table', 'decisions']);
    checkEqual('narrowed as usual', shown('fix the refund path /dec'), ['decisions']);
    checkEqual('and no commands', shown('fix the refund path /mod'), []);

    const taken = pick('fix the refund path /dec');
    checkEqual('what came before is kept', taken.value, 'fix the refund path /decisions ');
    check('and it does not turn into a list of values', !taken.more);

    // Which is what makes a second one possible: the trailing space means the
    // next "/" opens the palette again.
    const second = pick(taken.value + '/tab');
    checkEqual('so another one goes on the end', second.value,
      'fix the refund path /decisions /table ');
    checkEqual('the hint says as much', palette.plan('fix it /', SOURCES).hint,
      'Add to this prompt');
  }

  suite('what the composer ends up sending');

  {
    const { expand } = require('../media/snippets.js');
    const out = expand('fix the refund path /decisions /table ', SOURCES.snippets);
    checkEqual('the panel still shows your words', out.text, 'fix the refund path');
    checkEqual('both instructions are appended, in the order written',
      out.sent, 'fix the refund path\n\nTHE DECISIONS\n\nAS A TABLE');
    checkEqual('and the prompt says which were used', out.used, ['decisions', 'table']);
  }
};

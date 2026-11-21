'use strict';

// One catalog per engine; legacy constructors keep the window's shared catalog.
function createCommandCatalog() {
  // Commands that take a fixed set of values, so the composer can offer them
  // rather than expecting somebody to know them. Seeded with the ones we know,
  // extended at runtime from the CLI's own replies, and — for the models — from
  // the catalog the window reads out of the CLI itself.
  //
  // An entry is { value, label, detail }: the label and detail are what a row
  // says, and only the value is ever typed into the prompt.
  const COMMAND_ARGS = new Map();

  // Everything on the Usage line, because the values are written after it in two
  // different shapes and both are worth reading.
  const USAGE_RE = /Usage:\s*\/([\w:.-]+)([^\n]*)/g;

  // A value as the CLI prints one: a word, possibly with a [1m] on the end. The
  // point of the shape is what it excludes — "or a full model ID" is prose.
  const VALUE = /^[\w@[\].:/-]+$/;

  /**
   * The values out of one Usage line, written either way the CLI writes them.
   *
   * `/effort <low|medium|high>` names them in the placeholder. `/model <name>`
   * cannot, because the set is open, so it lists them after: "Available: sonnet,
   * opus, …, or a full model ID". Both are read, because in both cases they are
   * what somebody is choosing between.
   */
  function readValues(line) {
    const angled = /<([^>]+)>/.exec(line);
    const listed = /\bAvailable:\s*(.+)$/i.exec(line);
    const parts = [];
    if (angled && angled[1].includes('|')) parts.push.apply(parts, angled[1].split('|'));
    if (listed) parts.push.apply(parts, listed[1].split(','));
    return parts
      .map((v) => v.trim().replace(/[.,;]+$/, ''))
      .filter((v) => v && VALUE.test(v));
  }

  const described = (v) => ({ value: v.value, label: v.label || '', detail: v.detail || '' });

  /**
   * Add values to a command's list, keeping what is already there.
   *
   * `atFront` is for the described ones: the model catalog is more useful than the
   * aliases the CLI's own reply names, so it goes above them however the two
   * happen to arrive. A described value replaces a bare one of the same name.
   */
  function merge(name, values, atFront) {
    const have = COMMAND_ARGS.get(name) || [];
    const seen = new Map();
    for (const entry of (atFront ? values.concat(have) : have.concat(values))) {
      const old = seen.get(entry.value);
      if (!old) seen.set(entry.value, described(entry));
      else if (entry.label || entry.detail) {
        seen.set(entry.value, {
          value: old.value,
          label: entry.label || old.label,
          detail: entry.detail || old.detail
        });
      }
    }
    const next = [...seen.values()];
    const same = have.length === next.length &&
      have.every((v, i) => v.value === next[i].value && v.label === next[i].label);
    COMMAND_ARGS.set(name, next);
    return !same;
  }

  /** Read out of a reply the CLI just gave. */
  function learnCommandArgs(text) {
    if (!text || text.indexOf('Usage:') < 0) return false;
    let found = false;
    let m;
    USAGE_RE.lastIndex = 0;
    while ((m = USAGE_RE.exec(text)) !== null) {
      const values = readValues(m[2]);
      if (values.length > 1 && merge(m[1], values.map((v) => ({ value: v })), false)) found = true;
    }
    return found;
  }

  /**
   * Values NikUI knows that the CLI never prints.
   *
   * The models are the case this exists for. The CLI's own reply lists the
   * aliases and then says "or a full model ID" — true, and not a list — while the
   * identifiers themselves are in the binary. The window reads them there and
   * hands them here, so the composer offers what this CLI actually knows.
   *
   * @returns {boolean} whether anything changed, so a page can be told
   */
  function offerCommandArgs(name, values) {
    if (!name || !Array.isArray(values) || !values.length) return false;
    return merge(name, values.map(described), true);
  }

  // Known before any reply arrives, so "/effort " offers its values on a fresh
  // instance rather than only after somebody has already run it once.
  merge('effort', ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']
    .map((v) => ({ value: v })), false);

  function commandArgs() {
    const out = {};
    for (const [k, v] of COMMAND_ARGS) out[k] = v.map(described);
    return out;
  }

  return { commandArgs, learnCommandArgs, offerCommandArgs };
}

const defaultCommandCatalog = createCommandCatalog();
module.exports = { createCommandCatalog, defaultCommandCatalog };

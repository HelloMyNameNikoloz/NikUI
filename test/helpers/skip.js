'use strict';

/**
 * A check that did not run is not a check that passed.
 *
 * These harnesses need something the machine may not have — a browser, a Swift
 * compiler — and skipping keeps a clean checkout green. What it must not do is
 * look like a pass: the line is loud, and `NIKUI_REQUIRE_CHECKS=1` turns a skip
 * into a failure for anywhere that has no excuse, like CI.
 */
function skipped(why) {
  const banner = '─'.repeat(Math.min(72, why.length + 10));
  if (process.env.NIKUI_REQUIRE_CHECKS === '1') {
    console.error('\n' + banner + '\n  NOT RUN  ' + why + '\n' +
      '  NIKUI_REQUIRE_CHECKS=1 is set, so this counts as a failure.\n' + banner + '\n');
    process.exit(1);
  }
  console.log('\n' + banner + '\n  SKIPPED  ' + why + '\n' +
    '  Nothing was verified here. Set NIKUI_REQUIRE_CHECKS=1 to make this fail instead.\n' +
    banner + '\n');
  process.exit(0);
}

module.exports = { skipped };

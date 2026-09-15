'use strict';
const { nextTicket, findTicket } = require('../src/ticket.js');

module.exports = function () {
  suite('ticket naming');

  checkEqual('takes the first number from a PR link', nextTicket(null, 'https://github.com/peuka/backend/pull/1338 check this'), '1338');
  checkEqual('keeps the ticket when a prompt has no number', nextTicket('1338', 'why is the test flaky'), '1338');
  checkEqual('a read-only ask does not steal the tab', nextTicket('1338', 'analyze https://github.com/peuka/backend/pull/1339 for me'), '1338');
  checkEqual('working on another PR switches', nextTicket('1338', 'fix the failing check on .../pull/1339'), '1339');
  checkEqual('accepts the hash form', nextTicket(null, 'and #691 too'), '691');
  checkEqual('accepts issue links', nextTicket(null, 'https://github.com/peuka/backend/issues/704 repro'), '704');
  checkEqual('"look at" is read-only', nextTicket('1338', 'look at PR 1400 quickly'), '1338');
  checkEqual('no number means no ticket', nextTicket(null, 'no numbers here'), null);
  checkEqual('single digits are ignored in prose', findTicket('item #5 in the list'), null);
  checkEqual('the first number on a fresh tab always sticks', nextTicket(null, 'review PR 1400'), '1400');
};

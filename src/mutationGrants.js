'use strict';

// Application grants, independent of advertised capabilities and untrusted from.
// The owner still checks current authentication/control on every authority read.
const LOCAL = new Set(['allSettings', 'slack', 'openPr', 'pr:open', 'pr:link',
  'slack:connect', 'slack:disconnect', 'slack:signIn', 'slack:settings', 'slack:openTicket', 'slack:setup', 'slack:link']);
function mayMutate(context, message) {
  const type = message?.type, seat = context.seat;
  if (!seat) return false;
  const paired = !seat.local && context.principal?.startsWith('device:');
  if (type === '@apple' || type === '@listen') return paired;
  if (type === 'forget') return paired && (context.principal === 'device:' + message.id || seat.control === true);
  if (LOCAL.has(type)) return seat.local === true;
  if (['ready', 'visible', 'pr:pane', 'slack:open'].includes(type)) return true;
  return seat.control === true;
}
module.exports = { mayMutate, LOCAL };

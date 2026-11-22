'use strict';
// Progress is emitted only after a real operation advances, never on a timer.
let observer = () => {};
const note = () => observer();
function observe(callback) { observer = callback; return () => { observer = () => {}; }; }
function monitor({ parent, end, timeoutMs = 30000, output = (line) => process.stdout.write(line) }) {
  let timer, sequence = 0;
  const stop = observe(() => {
    clearTimeout(timer); timer = setTimeout(() => end({ ok: false, code: 'CUTOVER_TIMEOUT' }), timeoutMs);
    output(JSON.stringify({ cutoverProgress: ++sequence }) + '\n');
  });
  const parentWatch = setInterval(() => { if (parent > 0 && process.ppid !== parent) end({ ok: false, code: 'CUTOVER_PARENT_EXITED' }); }, 250);
  note();
  return () => { stop(); clearTimeout(timer); clearInterval(parentWatch); };
}
module.exports = { note, observe, monitor };

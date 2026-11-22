'use strict';
const { parseInventory } = require('../src/sourceWindowInventory');
module.exports = () => {
  suite('Selected-editor all-window inventory');
  const table = 'Version: Code\n\nCPU %\tMem MB\t   PID\tProcess\n0\t100\t10\tcode\n0\t10\t20\twindow [1] (source)\n0\t10\t30\textension-host [1]\n\nWorkspace Stats:\n';
  checkEqual('the selected editor reports both its windows and extension hosts', parseInventory(table, 30), { complete: true, pids: [30], windows: 1 });
  for (const [name, value, pid] of [
    ['missing selected host', table, 99], ['unsupported output', 'not a manifest', 30],
    ['old or missing source host', table.replace('\n\nWorkspace Stats:', '\n0\t10\t40\twindow [2] (old build)\n\nWorkspace Stats:'), 30],
    ['duplicate host rows', table.replace('\n\nWorkspace Stats:', '\n0\t10\t30\textension-host [1]\n\nWorkspace Stats:'), 30]
  ]) {
    let code; try { parseInventory(value, pid); } catch (e) { code = e.code; }
    checkEqual(name + ' refuses rather than guessing completeness', code, 'SOURCE_MANIFEST_INCOMPLETE');
  }
};

'use strict';
const { fail } = require('./daemonPaths');

// Primary contract: VS Code issue.contribution.ts (_issues.getSystemStatus)
// and diagnosticsService.ts (formatProcessList). No process-name discovery or
// arbitrary CLI is invoked: the selected source asks its own editor instance.
// https://github.com/microsoft/vscode/blob/main/src/vs/platform/diagnostics/node/diagnosticsService.ts
function parseInventory(text, pid = process.pid) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) throw fail('SOURCE_MANIFEST_INCOMPLETE', 'Editor inventory is unavailable');
  const lines = text.split(/\r?\n/), at = lines.findIndex((line) => /^CPU %\tMem MB\t\s*PID\tProcess$/.test(line));
  if (at < 0) throw fail('SOURCE_MANIFEST_INCOMPLETE', 'Editor inventory format is unsupported');
  const hosts = [], windows = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || !line.includes('\t')) break;
    const columns = line.split('\t'), processID = Number(columns[2]?.trim()), name = columns[3]?.trim();
    if (columns.length !== 4 || !Number.isSafeInteger(processID) || processID < 1) throw fail('SOURCE_MANIFEST_INCOMPLETE', 'Editor inventory row is invalid');
    if (/^extension-host(?:\s|$)/.test(name)) hosts.push(processID);
    if (/^window \[\d+\] \(/.test(name)) windows.push(processID);
  }
  if (!hosts.includes(pid) || !windows.length || hosts.length !== windows.length || new Set(hosts).size !== hosts.length) {
    throw fail('SOURCE_MANIFEST_INCOMPLETE', 'Every loaded editor window needs a compatible local source');
  }
  return { complete: true, pids: hosts.sort((a, b) => a - b), windows: windows.length };
}
async function sourceWindowInventory(vscode) {
  let timer;
  try {
    return parseInventory(await Promise.race([vscode.commands.executeCommand('_issues.getSystemStatus'), new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('SOURCE_MANIFEST_INCOMPLETE', 'Editor inventory timed out')), 4000);
    })]));
  } finally { clearTimeout(timer); }
}
module.exports = { parseInventory, sourceWindowInventory };

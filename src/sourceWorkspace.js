'use strict';
const path = require('path');
const absolute = (value) => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;
function roots(workspace) {
  return [...new Set((workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath))].sort();
}
function identity(workspace) {
  const folders = roots(workspace);
  if (!folders.length) return '';
  if (workspace.workspaceFile?.scheme !== 'untitled' && absolute(workspace.workspaceFile?.fsPath)) return workspace.workspaceFile.fsPath;
  return folders.length === 1 ? folders[0] : 'folders:' + JSON.stringify(folders);
}
function valid(value) {
  if (value === '' || absolute(value)) return true;
  if (typeof value !== 'string' || !value.startsWith('folders:')) return false;
  try {
    const folders = JSON.parse(value.slice(8));
    return Array.isArray(folders) && folders.length > 1 && folders.every(absolute) &&
      value === 'folders:' + JSON.stringify([...new Set(folders)].sort());
  } catch (_) { return false; }
}
module.exports = { identity, roots, valid };

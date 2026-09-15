'use strict';

const vscode = require('vscode');
const path = require('path');
const { listSessions } = require('./history');

const PAGE = 40;

class HistoryTree {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.scope = 'workspace'; // or 'all'
    this.limit = PAGE;
    this.filter = '';
    this._publishScope();
  }

  /** What the view header says it is showing, so the scope is never invisible. */
  get summary() {
    const bits = [this.scope === 'all' ? 'all folders' : 'this workspace'];
    if (this.filter) bits.push(`“${this.filter}”`);
    return bits.join(' · ');
  }

  setFilter(text) {
    this.filter = String(text || '').trim();
    this.limit = PAGE; // a new question starts at the top of the answer
    this.refresh();
    return this.filter;
  }

  showMore() {
    this.limit += PAGE;
    this.refresh();
    return this.limit;
  }

  refresh() { this._onDidChangeTreeData.fire(); }

  toggleScope() {
    this.scope = this.scope === 'workspace' ? 'all' : 'workspace';
    this.limit = PAGE;
    this._publishScope();
    this.refresh();
    return this.scope;
  }

  /** An empty list means different things per scope, so the view can say which. */
  _publishScope() {
    try { vscode.commands.executeCommand('setContext', 'nikui.historyScope', this.scope); }
    catch (_) { /* nothing depends on it being set */ }
  }

  getTreeItem(entry) {
    if (entry.__more) {
      const item = new vscode.TreeItem(`Show ${entry.more} more`, vscode.TreeItemCollapsibleState.None);
      item.id = 'history:more';
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.contextValue = 'historyMore';
      item.command = { command: 'nikui.historyMore', title: 'Show more' };
      return item;
    }
    // The same short name the instance would carry, so a transcript and the
    // tab it opens as are recognisably the same conversation.
    const name = entry.label || entry.title;
    const prompt = entry.title && entry.title !== name ? entry.title : '';
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.id = entry.sessionId;
    item.iconPath = new vscode.ThemeIcon('history');
    item.description = `${path.basename(entry.cwd || '')} · ${ago(entry.modified)}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${name}**`,
        prompt ? `\n${prompt}\n` : '',
        `- Folder: \`${entry.cwd || 'unknown'}\``,
        entry.branch ? `- Branch: \`${entry.branch}\`` : '',
        `- Last used: ${entry.modified.toLocaleString()}`,
        `- Session: \`${entry.sessionId}\``
      ].filter(Boolean).join('\n')
    );
    item.contextValue = 'historyEntry';
    item.command = { command: 'nikui.resumeHistory', title: 'Resume', arguments: [entry] };
    return item;
  }

  async getChildren(element) {
    if (element) return [];
    try {
      return await this._children();
    } catch (err) {
      // A tree provider that throws leaves the section empty and unrecoverable.
      console.error('NikUI history:', err);
      return [];
    }
  }

  async _children() {
    // Read a wide slice once, then narrow it here: scope, then the filter, then
    // however much of it the reader has asked to see.
    const folders = vscode.workspace.workspaceFolders || [];
    const sweep = Math.max(200, this.limit * 3);
    let entries = await listSessions({ limit: sweep });

    if (this.scope === 'workspace' && folders.length) {
      const roots = folders.map((f) => f.uri.fsPath);
      entries = entries.filter((e) => e.cwd && roots.some((r) => e.cwd === r || e.cwd.startsWith(r + '/')));
    }
    if (this.filter) entries = entries.filter((e) => matches(e, this.filter));

    const page = entries.slice(0, this.limit);
    if (entries.length > page.length) {
      page.push({ __more: true, more: entries.length - page.length, sessionId: 'more' });
    }
    return page;
  }
}

/** Name, opening prompt or folder — whichever the reader was thinking of. */
function matches(entry, needle) {
  const q = needle.toLowerCase();
  return [entry.label, entry.title, entry.cwd, entry.branch]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().indexOf(q) >= 0);
}

function ago(date) {
  const secs = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

module.exports = { HistoryTree, matches, PAGE };

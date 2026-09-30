'use strict';

const path = require('path');
const { execFile } = require('child_process');

/**
 * Tell the laptop when an instance is done.
 *
 * A banner from the system, not a toast inside the editor, because the point
 * is to be told while looking at something else — and a toast in a window that
 * is behind three others is seen by nobody. With it, if asked, a chime: three
 * soft notes rising, made by tools/sound.js.
 *
 * Once per turn, at the moment it ends. Not for a turn you stopped yourself,
 * since you know. Not while its agents are still out in the background, since
 * the instance is not done until they are — session.js keeps it working till
 * then. The banner is skipped when you are already looking at that instance;
 * the chime is not, because hearing it is how you know without looking.
 *
 * Nothing here knows about VS Code: settings, visibility and the two ways of
 * making a noise are handed in.
 */

const SOUND = path.join(__dirname, '..', 'sounds', 'done.wav');

class DoneNotifier {
  /**
   * @param {object} deps
   * @param {() => {popup: boolean, sound: boolean}} deps.settings
   * @param {(id: string) => boolean} [deps.isLookingAt]  on screen, in a focused window
   * @param {(title: string, body: string, session: object) => void} [deps.banner]
   * @param {() => void} [deps.chime]
   */
  constructor(deps) {
    this.settings = deps.settings;
    this.isLookingAt = deps.isLookingAt || (() => false);
    this.banner = deps.banner || banner;
    this.chime = deps.chime || chime;
    this.was = new Map(); // session id -> the status it had last
  }

  seen(session) {
    if (!session) return;
    const before = this.was.get(session.id);
    this.was.set(session.id, session.status);
    if (session.status !== 'done' || before === 'done') return;
    if (before !== 'working' && before !== 'waiting') return;
    const items = session.items || [];
    const last = items.filter((i) => i.kind === 'result').pop();
    if (last && last.interrupted) return;

    const on = this.settings() || {};
    if (!on.popup) return;
    if (on.sound !== false) this.chime();
    if (this.isLookingAt(session.id)) return;
    const name = session.customTitle || session.label || 'An instance';
    this.banner(name + ' is done', summary(items.filter((i) => i.kind === 'text').pop()), session);
  }

  forget(session) { if (session) this.was.delete(session.id); }

  watch(manager) {
    const changed = (s) => this.seen(s);
    const removed = (s) => this.forget(s);
    manager.on('session-changed', changed);
    manager.on('removed', removed);
    return () => { manager.off('session-changed', changed); manager.off('removed', removed); };
  }
}

/** The first line of what it said last, which is usually the answer. */
function summary(said) {
  const text = said && typeof said.text === 'string' ? said.text : '';
  const line = text.split('\n').map((l) => l.replace(/[#*`_>]/g, '').trim()).find(Boolean) || 'Finished its turn.';
  return line.length > 140 ? line.slice(0, 139) + '…' : line;
}

/**
 * The system's own banner, where it has one anybody can post. Not a Mac's:
 * osascript's banners belong to Script Editor, and clicking one opens it —
 * there the extension uses NikUI's own app instead (notifier.js).
 */
function banner(title, body) {
  if (process.platform === 'linux') {
    execFile('notify-send', ['--app-name=NikUI', title, body], () => {});
  }
}

function chime() {
  if (process.platform === 'darwin') execFile('afplay', [SOUND], () => {});
  else if (process.platform === 'linux') execFile('paplay', [SOUND], () => {});
  else if (process.platform === 'win32') {
    execFile('powershell', ['-NoProfile', '-Command',
      '(New-Object Media.SoundPlayer $args[0]).PlaySync()', SOUND], () => {});
  }
}

module.exports = { DoneNotifier, summary, banner, chime, SOUND };

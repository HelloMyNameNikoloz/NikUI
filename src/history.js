'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { labelFor } = require('./label');

// Claude Code stores transcripts at ~/.claude/projects/<slug>/<session-id>.jsonl
// where the slug is the cwd with every "/" and "." replaced by "-".
function slugFor(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
}

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

const titleCache = new Map(); // file -> { mtimeMs, title, cwd, at }

/**
 * First real user prompt in a transcript, used as its title. Transcripts can be
 * hundreds of megabytes, so this streams and bails out at the first hit.
 */
function readHead(file) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch (_) { return done(null); }

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lines = 0;
    rl.on('line', (line) => {
      if (++lines > 400) { rl.close(); return; } // header ran long; give up cheaply
      if (!line.trim()) return;
      let entry;
      try { entry = JSON.parse(line); } catch (_) { return; }
      if (entry.type !== 'user' || !entry.message) return;
      const content = entry.message.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        const block = content.find((b) => b && b.type === 'text');
        text = block ? block.text : '';
      }
      text = String(text || '').trim();
      if (!text || text.startsWith('<')) return; // harness payload, not a real prompt
      done({
        title: clean(text),
        // Naming reads the untruncated prompt: a ticket number often sits past
        // the end of the title, in the tail of a pull request URL.
        raw: text.slice(0, 400),
        cwd: entry.cwd || null,
        at: entry.timestamp || null,
        branch: entry.gitBranch || null
      });
      rl.close();
    });
    rl.on('close', () => done(null));
    rl.on('error', () => done(null));
  });
}

function clean(text) {
  return text
    .replace(/\[Image[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

async function describe(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; }

  const cached = titleCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const head = await readHead(file);
  const fallback = path.basename(file, '.jsonl').slice(0, 8);
  const entry = {
    mtimeMs: stat.mtimeMs,
    sessionId: path.basename(file, '.jsonl'),
    file,
    size: stat.size,
    modified: stat.mtime,
    title: head && head.title ? head.title : fallback,
    // The short name, built the same way an instance builds its own.
    label: (head && labelFor(head.raw)) || fallback,
    cwd: head && head.cwd ? head.cwd : null,
    branch: head ? head.branch : null
  };
  titleCache.set(file, entry);
  return entry;
}

/**
 * Recent transcripts, newest first. `cwd` limits to one project folder;
 * omit it to sweep every project.
 */
/**
 * The most recent conversations, newest first.
 *
 * `keep` is the reason this takes a callback at all: the caller wants N
 * entries *that match something*, and the matching needs a described entry.
 * Truncating to a limit first and filtering afterwards is how the History view
 * used to come up empty on a machine with a couple of hundred transcripts —
 * every one of the newest 200 belonged to another project, so the page had
 * nothing in it and nothing to click for more.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]    only this project's transcripts
 * @param {number} [options.limit]  how many wanted, after keep()
 * @param {(entry: object) => boolean} [options.keep]
 * @param {number} [options.scan]   how many files to open before giving up
 */
async function listSessions({ cwd, limit = 30, keep, scan = 600 } = {}) {
  const root = projectsRoot();
  let dirs = [];
  if (cwd) {
    dirs = [path.join(root, slugFor(cwd))];
  } else {
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name));
    } catch (_) { return []; }
  }

  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      if (!stat.isFile() || stat.size < 200) continue;
      files.push({ file, mtimeMs: stat.mtimeMs });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  let opened = 0;
  for (const f of files) {
    if (out.length >= limit) break;
    // A ceiling on work, not on results: without one, a filter that matches
    // nothing would read every transcript on the machine.
    if (opened >= scan) break;
    opened++;
    const entry = await describe(f.file);
    if (!entry) continue;
    if (keep && !keep(entry)) continue;
    out.push(entry);
  }
  out.exhausted = out.length < limit && opened < scan;
  return out;
}

// Where a transcript has already been found, so the sweep below happens once
// per conversation rather than every time the panel or /status asks.
const located = new Map();

/**
 * The transcript for a session. It is usually under the slug of the instance's
 * own folder, but not always: the CLI files a conversation under the project it
 * considers it to belong to, which for a folder opened inside another project
 * is the outer one. Deriving the path from the cwd alone therefore finds
 * nothing, and the panel comes up empty on a conversation that is right there
 * on disk. So: try the obvious place, then the folders above it, then look
 * properly — and remember the answer.
 */
function transcriptPath(cwd, sessionId) {
  if (!cwd || !sessionId) return null;

  const cached = located.get(sessionId);
  if (cached && exists(cached)) return cached;

  const root = projectsRoot();
  const file = sessionId + '.jsonl';

  const direct = path.join(root, slugFor(cwd), file);
  if (exists(direct)) return remember(sessionId, direct);

  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const up = path.dirname(dir);
    if (!up || up === dir) break;
    dir = up;
    const above = path.join(root, slugFor(dir), file);
    if (exists(above)) return remember(sessionId, above);
  }

  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { dirs = []; }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, file);
    if (exists(candidate)) return remember(sessionId, candidate);
  }

  // Nothing yet — a conversation that has not written its first line still has
  // a place it is going to appear.
  return direct;
}

function remember(sessionId, file) {
  located.set(sessionId, file);
  return file;
}

function exists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

module.exports = { listSessions, slugFor, projectsRoot, transcriptPath };

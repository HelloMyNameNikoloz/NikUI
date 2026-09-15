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
async function listSessions({ cwd, limit = 30 } = {}) {
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
  const picked = files.slice(0, limit);
  const out = [];
  for (const f of picked) {
    const entry = await describe(f.file);
    if (entry) out.push(entry);
  }
  return out;
}

function transcriptPath(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  return path.join(projectsRoot(), slugFor(cwd), sessionId + '.jsonl');
}

module.exports = { listSessions, slugFor, projectsRoot, transcriptPath };

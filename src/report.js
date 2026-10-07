'use strict';

const fs = require('fs');
const path = require('path');

// Everything /status shows, derived in one place so the webview only draws.
// Money is never computed here: every figure traces back to the cost the CLI
// itself reported, the same rule the rest of the extension follows.

const TOP = 8; // how many rows the "top N" tables keep before folding the tail

/** Which argument of a tool call names a file, in the order tools use them. */
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath'];

function sum(list, pick) {
  let total = 0;
  for (const item of list) total += pick(item) || 0;
  return total;
}

function tokensOf(t) {
  return (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreate || 0);
}

// Reading .git is cheap but not free, and an open status sheet asks for every
// instance's branch every second and a half. Five seconds is short enough to
// notice a branch switch and long enough that a refresh costs nothing.
const gitCache = new Map();
const GIT_TTL_MS = 5000;

function readGit(cwd) {
  const hit = gitCache.get(cwd);
  const now = Date.now();
  if (hit && now - hit.at < GIT_TTL_MS) return hit.value;
  const value = readGitFromDisk(cwd);
  gitCache.set(cwd, { at: now, value });
  return value;
}

/**
 * The branch an instance is working on. Read straight out of .git rather than
 * shelling out: /status must never block on a process.
 */
function readGitFromDisk(cwd) {
  if (!cwd) return null;
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    const marker = path.join(dir, '.git');
    let stat;
    try { stat = fs.statSync(marker); } catch (_) { stat = null; }
    if (stat) {
      let gitDir = marker;
      if (stat.isFile()) {
        // A worktree's .git is a file pointing at the real directory.
        try {
          const pointer = fs.readFileSync(marker, 'utf8').match(/gitdir:\s*(.+)/);
          if (pointer) gitDir = path.resolve(dir, pointer[1].trim());
        } catch (_) { return null; }
      }
      let head = '';
      try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch (_) { return null; }
      const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      return {
        root: dir,
        branch: ref ? ref[1] : null,
        commit: ref ? null : head.slice(0, 12),
        detached: !ref,
        worktree: stat.isFile()
      };
    }
    const up = path.dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return null;
}

function fileFacts(file) {
  if (!file) return { path: null, exists: false, sizeBytes: 0 };
  try {
    const stat = fs.statSync(file);
    return { path: file, exists: true, sizeBytes: stat.size, modified: stat.mtime.getTime() };
  } catch (_) {
    return { path: file, exists: false, sizeBytes: 0 };
  }
}

/** Tool calls, what they touched, and what they ran — read off the item list. */
function readItems(items) {
  const tools = new Map();
  const files = new Map();
  const commands = new Map();
  const counts = { user: 0, assistant: 0, thinking: 0, tool: 0, permission: 0, notice: 0, images: 0 };
  let textChars = 0;
  let thinkingChars = 0;
  let promptChars = 0;
  let toolErrors = 0;
  let running = 0;

  for (const item of items) {
    switch (item.kind) {
      case 'user':
        counts.user += 1;
        promptChars += (item.text || '').length;
        counts.images += (item.images && item.images.length) || 0;
        break;
      case 'text':
        counts.assistant += 1;
        textChars += (item.text || '').length;
        break;
      case 'thinking':
        counts.thinking += 1;
        thinkingChars += (item.text || '').length;
        break;
      case 'permission':
        counts.permission += 1;
        break;
      case 'notice':
        counts.notice += 1;
        break;
      case 'tool': {
        counts.tool += 1;
        const name = item.name || 'tool';
        const stat = tools.get(name) || { name, calls: 0, errors: 0 };
        stat.calls += 1;
        if (item.isError) { stat.errors += 1; toolErrors += 1; }
        if (item.status !== 'done') running += 1;
        tools.set(name, stat);

        const input = item.input || {};
        const key = PATH_KEYS.find((k) => typeof input[k] === 'string');
        if (key) {
          const file = input[key];
          files.set(file, (files.get(file) || 0) + 1);
        }
        if (name === 'Bash' && typeof input.command === 'string') {
          const head = input.command.trim().split(/\s+/)[0];
          if (head) commands.set(head, (commands.get(head) || 0) + 1);
        }
        break;
      }
      default: break;
    }
  }

  const rank = (map, toRow) => [...map.entries()].map(toRow).sort((a, b) => b.count - a.count);

  return {
    counts,
    textChars,
    thinkingChars,
    promptChars,
    toolErrors,
    toolsRunning: running,
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    files: rank(files, ([file, count]) => ({ file, name: path.basename(file), count })).slice(0, TOP),
    commands: rank(commands, ([cmd, count]) => ({ cmd, count })).slice(0, TOP)
  };
}

/**
 * How many turns of headroom are left before the context window fills. Growth
 * is measured over the last few turns, because early turns load the codebase
 * and would make the estimate far too pessimistic.
 */
function contextRunway(turns, contextTokens, contextWindow) {
  if (!contextWindow || !contextTokens) return null;
  const withContext = turns.filter((t) => t.contextTokens > 0);
  if (withContext.length < 2) return null;
  const recent = withContext.slice(-6);
  const span = recent[recent.length - 1].contextTokens - recent[0].contextTokens;
  const growth = span / (recent.length - 1);
  if (!(growth > 0)) return { growthPerTurn: Math.round(growth), turnsLeft: null };
  const room = contextWindow * 0.9 - contextTokens; // compaction bites before the ceiling
  return { growthPerTurn: Math.round(growth), turnsLeft: Math.max(0, Math.floor(room / growth)) };
}

/** Turn activity by hour of the day, for the rhythm heatmap. */
function hourly(turns) {
  const buckets = new Array(24).fill(0);
  for (const turn of turns) buckets[new Date(turn.at).getHours()] += 1;
  return buckets;
}

function records(turns) {
  if (!turns.length) return null;
  const longest = turns.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
  const costliest = turns.reduce((a, b) => (b.costUsd > a.costUsd ? b : a));
  const biggest = turns.reduce((a, b) => (tokensOf(b) > tokensOf(a) ? b : a));
  const peakContext = turns.reduce((a, b) => (b.contextTokens > a.contextTokens ? b : a));
  return {
    longest: { n: longest.n, durationMs: longest.durationMs },
    costliest: { n: costliest.n, costUsd: costliest.costUsd },
    biggest: { n: biggest.n, tokens: tokensOf(biggest) },
    peakContext: { n: peakContext.n, tokens: peakContext.contextTokens },
    busiestTurn: turns.reduce((a, b) => (b.tools.length > a.tools.length ? b : a)).tools.length
  };
}

/**
 * Everything the fleet dashboard needs about one instance. Read from the live
 * object, so an instance nobody has opened still reports honestly — and from
 * its own item window, which is why tool counts carry the same caveat as they
 * do for the instance being reported on.
 */
function fleetMember(s, activeId, now) {
  const usage = s.usage || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const turns = s.turnLog || [];
  const read = readItems(s.items || []);
  const workedMs = sum(turns, (t) => t.durationMs);
  const promptTokens = usage.input + usage.cacheRead + usage.cacheCreate;
  const last = turns.length ? turns[turns.length - 1] : null;
  const git = readGit(s.cwd);

  return {
    id: s.id,
    label: s.label,
    // Two different facts: how the conversation left off, and whether anything
    // is running behind it. A restored instance keeps the first and reports the
    // second, rather than one hiding the other.
    status: s.status,
    busy: !s.isAsleep && !!s.isBusy,
    asleep: !!s.isAsleep,
    paused: !!s.isPaused,
    running: !!s.isRunning,
    active: s.id === activeId,
    cwd: s.cwd,
    folder: s.cwd ? path.basename(s.cwd) : '',
    project: path.basename(projectOf(s.cwd)) || '',
    projectPath: projectOf(s.cwd),
    branch: git && git.branch ? git.branch : null,
    model: (s.meta && s.meta.model) || s.model || null,
    effort: s.effort || null,
    cost: s.totalCost || 0,
    turns: s.turns || 0,
    tokens: tokensOf(usage),
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreate: usage.cacheCreate,
    cacheHitRate: promptTokens ? usage.cacheRead / promptTokens : 0,
    contextTokens: s.contextTokens || 0,
    contextWindow: s.contextWindow || 0,
    contextPct: s.contextWindow ? (s.contextTokens || 0) / s.contextWindow : 0,
    workedMs,
    avgTurnMs: turns.length ? workedMs / turns.length : 0,
    // A reload keeps the last sixty turns and the whole cost, so dividing one
    // by the other read "$0.67 a turn × 200 turns" next to a total of $40.
    // Both sides of these come from the same turns now.
    avgCost: turns.length ? loggedCost(turns) / turns.length : 0,
    burnPerHour: workedMs > 0 ? loggedCost(turns) / (workedMs / 3600000) : 0,
    turnsLogged: turns.length,
    toolCalls: read.counts.tool,
    toolErrors: read.toolErrors,
    errors: s.errors || 0,
    interrupts: s.interrupts || 0,
    compactions: s.compactions || 0,
    queue: (s.queue || []).length,
    ageMs: s.startedAt ? now - s.startedAt : 0,
    lastTurnAt: last ? last.at : null,
    quietMs: last ? now - last.at : null,
    // Small enough to draw a sparkline from, in a table cell.
    spend: turns.slice(-24).map((t) => t.costUsd)
  };
}

/** One project per row, however many instances are working inside it. */
function byProject(members) {
  const map = new Map();
  for (const m of members) {
    const key = m.projectPath || m.cwd || '';
    const row = map.get(key) || {
      project: m.project || key, path: key, instances: 0, working: 0,
      cost: 0, tokens: 0, turns: 0, toolCalls: 0
    };
    row.instances += 1;
    if (m.busy) row.working += 1;
    row.cost += m.cost;
    row.tokens += m.tokens;
    row.turns += m.turns;
    row.toolCalls += m.toolCalls;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

const projectOf = (cwd) => {
  const git = readGit(cwd);
  return (git && git.root) || cwd || '';
};

/**
 * The whole report. `session` is the live instance, `fleet` every other
 * instance open in the window, and `env` whatever only the host can answer.
 */
/** What the turns in hand actually cost, as against the session's running total. */
function loggedCost(turns) {
  return turns.reduce((sum, t) => sum + (t.costUsd || 0), 0);
}

function buildReport({ session, fleet = [], env = {}, lifetime = null, now = Date.now() } = {}) {
  const turns = session.turnLog || [];
  const items = session.items || [];
  const read = readItems(items);
  const usage = session.usage || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const totalTokens = tokensOf(usage);
  const promptTokens = usage.input + usage.cacheRead + usage.cacheCreate;

  const workedMs = sum(turns, (t) => t.durationMs);
  const wallMs = Math.max(1, now - (session.startedAt || now));
  const outputPerSecond = workedMs > 0 ? (usage.output / (workedMs / 1000)) : 0;
  const lastTurn = turns.length ? turns[turns.length - 1] : null;

  const git = readGit(session.cwd);
  const transcript = fileFacts(env.transcriptPath || null);
  const members = fleet.map((s) => fleetMember(s, session.id, now)).sort((a, b) => b.cost - a.cost);

  return {
    generatedAt: now,
    // Cost, tokens, turns and context come from counters that do not depend on
    // how much of the conversation is still in memory. Anything read off the
    // item list — the tool histogram, the files, the message counts — covers
    // the window only, and says so when the window has dropped anything.
    window: {
      kept: items.length,
      dropped: session.droppedItems || 0,
      limit: session.maxItems || 0
    },
    instance: {
      id: session.id,
      label: session.label,
      ticket: session.ticket || null,
      customTitle: session.customTitle || null,
      status: session.status,
      busy: !!session.isBusy,
      running: !!session.isRunning,
      // Restored from a previous window and never opened since.
      asleep: !!session.isAsleep,
      cwd: session.cwd,
      folder: session.cwd ? path.basename(session.cwd) : '',
      claudeSessionId: session.claudeSessionId || null,
      pid: session.proc ? session.proc.pid : null,
      startedAt: session.startedAt || null,
      ageMs: wallMs,
      processUpMs: session.processStartedAt ? now - session.processStartedAt : 0,
      lastError: session.lastError || null,
      paused: !!session.isPaused,
      pausedUntil: session.pausedUntil || null
    },
    config: {
      model: (session.meta && session.meta.model) || session.model || null,
      requestedModel: session.model || null,
      effort: session.effort || null,
      permissionMode: session.permissionMode,
      outputStyle: session.outputStyle || null,
      claudePath: session.claudePath,
      autoTitle: !!session.autoTitle,
      extraArgs: session.extraArgs || [],
      queueDelayMs: session.queueDelayMs
    },
    totals: {
      cost: session.totalCost || 0,
      turns: session.turns || 0,
      tokens: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheCreate: usage.cacheCreate,
        total: totalTokens
      },
      // Share of everything fed to the model that came back from cache rather
      // than being sent again — the single best signal of a cheap session.
      cacheHitRate: promptTokens ? usage.cacheRead / promptTokens : 0,
      contextTokens: session.contextTokens || 0,
      contextWindow: session.contextWindow || 0,
      contextPct: session.contextWindow ? (session.contextTokens || 0) / session.contextWindow : 0,
      workedMs,
      wallMs,
      idleMs: Math.max(0, wallMs - workedMs),
      focusPct: wallMs ? Math.min(1, workedMs / wallMs) : 0,
      avgTurnMs: turns.length ? workedMs / turns.length : 0,
      // Over the turns still in hand, with the cost of those same turns: a
      // reload keeps sixty of them and the running total of all of them.
      avgCost: turns.length ? loggedCost(turns) / turns.length : 0,
      turnsLogged: turns.length,
      outputPerSecond,
      // Cost per hour of actual work, not of sitting idle.
      burnPerHour: workedMs > 0 ? loggedCost(turns) / (workedMs / 3600000) : 0,
      messages: read.counts,
      toolCalls: read.counts.tool,
      toolErrors: read.toolErrors,
      toolsRunning: read.toolsRunning,
      errors: session.errors || 0,
      interrupts: session.interrupts || 0,
      // The CLI summarises the context when it fills. After one of these, the
      // meter below is measuring the window since that point, not the whole
      // conversation.
      compactions: session.compactions || 0,
      lastCompactedAt: session.lastCompactedAt || null,
      thinkingShare: (read.thinkingChars + read.textChars)
        ? read.thinkingChars / (read.thinkingChars + read.textChars) : 0,
      writtenChars: read.textChars + read.thinkingChars,
      promptChars: read.promptChars,
      images: read.counts.images
    },
    turns: turns.map((t) => ({
      n: t.n,
      at: t.at,
      durationMs: t.durationMs,
      costUsd: t.costUsd,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheCreate: t.cacheCreate,
      tokens: tokensOf(t),
      contextTokens: t.contextTokens,
      tools: t.tools.length,
      toolNames: t.tools,
      model: t.model,
      interrupted: t.interrupted,
      isError: t.isError
    })),
    lastTurn: lastTurn ? {
      n: lastTurn.n,
      durationMs: lastTurn.durationMs,
      costUsd: lastTurn.costUsd,
      tokens: tokensOf(lastTurn),
      tools: lastTurn.tools.length,
      outputPerSecond: lastTurn.durationMs ? lastTurn.output / (lastTurn.durationMs / 1000) : 0
    } : null,
    tools: read.tools,
    files: read.files,
    commands: read.commands,
    hourly: hourly(turns),
    runway: contextRunway(turns, session.contextTokens || 0, session.contextWindow || 0),
    records: records(turns),
    queue: {
      length: (session.queue || []).length,
      drainAt: session.drainAt || null,
      delayMs: session.queueDelayMs
    },
    git,
    transcript,
    fleet: members,
    fleetTotals: {
      instances: members.length,
      running: members.filter((m) => m.running).length,
      working: members.filter((m) => m.busy).length,
      waiting: members.filter((m) => m.status === 'waiting').length,
      asleep: members.filter((m) => m.asleep).length,
      errored: members.filter((m) => m.status === 'error').length,
      queued: sum(members, (m) => m.queue),
      cost: sum(members, (m) => m.cost),
      tokens: sum(members, (m) => m.tokens),
      output: sum(members, (m) => m.output),
      cacheRead: sum(members, (m) => m.cacheRead),
      promptTokens: sum(members, (m) => m.input + m.cacheRead + m.cacheCreate),
      turns: sum(members, (m) => m.turns),
      toolCalls: sum(members, (m) => m.toolCalls),
      toolErrors: sum(members, (m) => m.toolErrors),
      workedMs: sum(members, (m) => m.workedMs),
      projects: new Set(members.map((m) => m.projectPath)).size,
      share: (() => {
        const total = sum(members, (m) => m.cost);
        const mine = members.find((m) => m.active);
        return total && mine ? mine.cost / total : 0;
      })()
    },
    projects: byProject(members),
    // Every instance NikUI has ever run, not just the ones open in this
    // window — null until a ledger is wired in to say otherwise.
    lifetime,
    // What is left of the plan's own five-hour and weekly windows. Account-wide
    // and reported by the CLI, so it is the same figure whichever instance asks.
    limits: env.limits || session.limits || null,
    // Set while the whole window is holding for the quota to come back.
    pause: env.pause || null,
    env
  };
}

module.exports = { buildReport, readGit, readItems, contextRunway, records, hourly, fileFacts, fleetMember, byProject };

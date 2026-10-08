/* @mentions: who an @ in a pull request comment should offer, and in what order.

   GitHub offers the people taking part first and then everybody else, and
   leaves you to arrow down past the same ten names every time to reach the
   one you always want. This keeps a little memory of who you actually mention
   on each repository, so that person is at the top — and says *why* every
   name is where it is ("you mention often", "review requested", "commented
   12m ago"), so the order reads as a decision rather than a shuffle.

   Pure functions, no DOM: the pane (media/prpane.js) draws what `rank`
   returns, and the tests can argue with the order directly. */
(function (root) {
  'use strict';

  const HISTORY_KEY = 'nikui:mentions:v1';
  const MAX_PER_REPO = 60;
  const HOUR = 3600000;

  // What a part in the pull request is worth, before recency.
  const PART = {
    requested: { weight: 300, says: 'Review requested' },
    changes: { weight: 290, says: 'Requested changes' },
    author: { weight: 280, says: 'Opened this PR' },
    approved: { weight: 260, says: 'Approved' },
    reviewed: { weight: 250, says: 'Reviewed' },
    assignee: { weight: 240, says: 'Assigned' },
    commented: { weight: 200, says: 'Commented' },
    committed: { weight: 160, says: 'Committed' }
  };

  function agoShort(at, now) {
    const ms = now - at;
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 60000) return 'just now';
    if (ms < HOUR) return Math.round(ms / 60000) + 'm ago';
    if (ms < 24 * HOUR) return Math.round(ms / HOUR) + 'h ago';
    return Math.round(ms / (24 * HOUR)) + 'd ago';
  }

  /**
   * The @ the caret is in, if any: `{ start, query }` where `start` is the
   * index of the @ itself. Only an @ that begins a word counts — `a@b.com` is
   * an address, not a mention — and a space ends it, as on GitHub.
   */
  function trigger(text, caret) {
    const before = String(text || '').slice(0, caret == null ? undefined : caret);
    const m = /(^|[^\w`@/])@([A-Za-z0-9-]*(?:\/[A-Za-z0-9_.-]*)?)$/.exec(before);
    if (!m) return null;
    // Inside a fenced code block nobody is mentioning anybody.
    if ((before.match(/```/g) || []).length % 2 === 1) return null;
    return { start: before.length - m[2].length - 1, query: m[2] };
  }

  /** Every @login written in a comment, as typed — for remembering who was named. */
  function mentioned(text) {
    const out = [];
    const re = /(^|[^\w`@/])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_.-]+)?)/g;
    let m;
    while ((m = re.exec(String(text || '')))) out.push(m[2]);
    return out;
  }

  /**
   * The people in this pull request and the strongest reason each is there,
   * from the snapshot src/prView.js builds. `{ login -> {weight, says, at} }`.
   */
  function participants(st, now) {
    const out = new Map();
    if (!st) return out;
    const note = (login, kind, at) => {
      if (!login || login === 'ghost') return;
      const part = PART[kind];
      const when = Date.parse(at) || 0;
      // Recent activity counts for a little on top of the part itself, so of
      // two people who commented, the one from ten minutes ago comes first.
      // A part that is a standing role (author, reviewer asked) does not fade.
      const fades = kind === 'commented' || kind === 'committed' || kind === 'reviewed';
      const fresh = when && fades ? Math.max(0, 60 - (now - when) / HOUR) : 0;
      const weight = part.weight + fresh;
      const had = out.get(login);
      if (had && had.weight >= weight) return;
      out.set(login, { weight, says: part.says, at: when, kind });
    };
    note(st.author, 'author', st.createdAt);
    for (const r of st.reviewers || []) {
      if (r.team) continue;
      const kind = r.state === 'PENDING' || r.rerequested ? 'requested'
        : r.state === 'CHANGES_REQUESTED' ? 'changes'
          : r.state === 'APPROVED' ? 'approved' : 'reviewed';
      note(r.login, kind, r.at);
    }
    for (const a of st.assignees || []) note(a.login, 'assignee', null);
    for (const c of st.comments || []) note(c.author, 'commented', c.at);
    for (const t of st.threads || []) for (const c of t.comments || []) note(c.author, 'commented', c.at);
    for (const item of st.timeline || []) {
      if (item.kind === 'comment' || item.kind === 'review') note(item.author, 'commented', item.at);
    }
    for (const c of st.commits || []) note(c.author, 'committed', c.at);
    return out;
  }

  // ---- memory: who you mention, per repository --------------------------------

  function loadHistory(storage) {
    try { return JSON.parse(storage.getItem(HISTORY_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  /** Remember that these logins were mentioned on `repo` just now. */
  function remember(storage, repo, logins, now) {
    if (!storage || !repo || !logins || !logins.length) return;
    const all = loadHistory(storage);
    const mine = all[repo] || {};
    for (const raw of logins) {
      const login = String(raw);
      const key = login.toLowerCase();
      const had = mine[key] || { login, n: 0, at: 0 };
      mine[key] = { login, n: had.n + 1, at: now };
    }
    const kept = Object.entries(mine).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PER_REPO);
    all[repo] = Object.fromEntries(kept);
    try { storage.setItem(HISTORY_KEY, JSON.stringify(all)); } catch (_) { /* full: forget quietly */ }
  }

  /** Frecency: how often, discounted by how long ago — a week-old habit still counts, a year-old one barely. */
  function habit(entry, now) {
    if (!entry) return 0;
    const days = Math.max(0, (now - entry.at) / (24 * HOUR));
    return (1 + Math.log2(1 + entry.n)) * 1000 / (1 + days / 7);
  }

  // ---- matching ---------------------------------------------------------------

  /**
   * How well `query` fits this person, and which letters of the login (or
   * name) it matched, for highlighting. 0 means not at all.
   *   4 login is it · 3 login starts with it · 2.5 a word of the name starts
   *   with it · 1.5 login contains it · 1 the letters appear in order.
   */
  function match(query, login, name) {
    const q = String(query || '').toLowerCase();
    if (!q) return { score: 1, login: [], name: [] };
    const l = String(login || '').toLowerCase();
    const n = String(name || '').toLowerCase();
    const span = (from, len) => Array.from({ length: len }, (_, i) => from + i);
    if (l === q) return { score: 4, login: span(0, q.length), name: [] };
    if (l.startsWith(q)) return { score: 3, login: span(0, q.length), name: [] };
    // "peuka-b" should find peuka-bob, and so should "bob".
    const part = l.split(/[-_/]/);
    let offset = 0;
    for (const word of part) {
      if (word.startsWith(q)) return { score: 2.8, login: span(offset, q.length), name: [] };
      offset += word.length + 1;
    }
    const words = n.split(/\s+/);
    offset = 0;
    for (const word of words) {
      if (word && word.startsWith(q)) return { score: 2.5, login: [], name: span(offset, q.length) };
      offset += word.length + 1;
    }
    const at = l.indexOf(q);
    if (at >= 0) return { score: 1.5, login: span(at, q.length), name: [] };
    const hits = [];
    let i = 0;
    for (let j = 0; j < l.length && i < q.length; j++) if (l[j] === q[i]) { hits.push(j); i++; }
    if (i === q.length && q.length >= 2) return { score: 1, login: hits, name: [] };
    return { score: 0, login: [], name: [] };
  }

  /**
   * The list to show. `everyone` is GitHub's mentionable users (and teams),
   * `history` this repository's memory, `parts` from `participants`.
   *
   * With nothing typed, it is three sections — who you mention, who is in this
   * pull request, everybody else — so the person you want is almost always in
   * the first three rows. Once something is typed it is one list, best match
   * first, and within equally good matches the same order as above.
   */
  function rank(o) {
    const now = o.now || Date.now();
    const query = String(o.query || '');
    const viewer = String(o.viewer || '').toLowerCase();
    const history = o.history || {};
    const parts = o.parts || new Map();
    const people = new Map();
    const add = (p) => {
      if (!p || !p.login) return;
      const key = p.login.toLowerCase();
      if (key === viewer) return;
      const had = people.get(key);
      if (had) {
        if (!had.name && p.name) had.name = p.name;
        if (!had.avatar && p.avatar) had.avatar = p.avatar;
        return;
      }
      people.set(key, { login: p.login, name: p.name || null, avatar: p.avatar || null, team: !!p.team });
    };
    for (const p of o.everyone || []) add(p);
    for (const [login] of parts) add({ login, avatar: (o.avatars || {})[login] || null });
    for (const key of Object.keys(history)) add({ login: history[key].login });

    const out = [];
    for (const [key, p] of people) {
      const m = match(query, p.login, p.name);
      if (!m.score) continue;
      const h = history[key];
      const part = parts.get(p.login) || null;
      const reasons = [];
      if (h && h.n >= 3) reasons.push('You mention often');
      else if (h) reasons.push('You mentioned ' + agoShort(h.at, now));
      if (part) reasons.push(part.says + (part.kind === 'commented' || part.kind === 'committed'
        ? (part.at ? ' ' + agoShort(part.at, now) : '') : ''));
      if (p.team && !reasons.length) reasons.push('Team');
      const section = h ? 'recent' : part ? 'pr' : 'everyone';
      out.push({
        login: p.login, name: p.name, avatar: p.avatar, team: p.team,
        reason: reasons.slice(0, 2).join(' · '),
        section,
        quality: m.score >= 2.5 ? 2 : m.score,
        weight: habit(h, now) + (part ? part.weight : 0),
        hits: { login: m.login, name: m.name }
      });
    }
    const ORDER = { recent: 0, pr: 1, everyone: 2 };
    out.sort((a, b) => {
      if (query && b.quality !== a.quality) return b.quality - a.quality;
      if (!query && ORDER[a.section] !== ORDER[b.section]) return ORDER[a.section] - ORDER[b.section];
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (a.team !== b.team) return a.team ? 1 : -1;
      return a.login.toLowerCase() < b.login.toLowerCase() ? -1 : 1;
    });
    return out.slice(0, o.limit || 50);
  }

  const api = { trigger, mentioned, participants, remember, loadHistory, match, rank, HISTORY_KEY };
  root.NikMentions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

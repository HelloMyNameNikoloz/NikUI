'use strict';
const path = require('path');
const {
  resolveRepoFolder, originOf, repoFromRemote, parseOriginUrl, clearCache
} = require('../src/repoFolders.js');

/**
 * A filesystem that exists only in memory, built from a plain description —
 * no real fs or exec anywhere in this file, as asked.
 *
 * @param {object} desc  path -> 'dir' | { config?: string, worktree?: string, commondirConfig?: string }
 */
function fakeFs(desc) {
  const dirs = new Set();
  const files = new Map();

  for (const [p, spec] of Object.entries(desc)) {
    dirs.add(p);
    if (spec === 'dir') continue;
    if (spec.config !== undefined) {
      dirs.add(path.join(p, '.git'));
      files.set(path.join(p, '.git', 'config'), spec.config);
    }
    if (spec.worktree !== undefined) {
      // `.git` is a *file* here, pointing at a gitdir elsewhere.
      files.set(path.join(p, '.git'), 'gitdir: ' + spec.worktree);
    }
    if (spec.commondirConfig !== undefined) {
      // The real checkout's .git that the worktree's gitdir points back to.
      files.set(path.join(spec.worktree || '', 'commondir'), '../..');
      files.set(path.join(spec.worktree || '', '..', '..', 'config'), spec.commondirConfig);
    }
  }

  // Register every ancestor directory implicitly, so readdirSync on a parent
  // sees its declared children.
  for (const p of Array.from(dirs)) {
    let dir = path.dirname(p);
    while (dir && dir !== path.dirname(dir) && !dirs.has(dir)) { dirs.add(dir); dir = path.dirname(dir); }
  }

  return {
    statSync(p) {
      if (files.has(p)) return { isDirectory: () => false };
      if (dirs.has(p)) return { isDirectory: () => true };
      const err = new Error('ENOENT: ' + p); err.code = 'ENOENT'; throw err;
    },
    readFileSync(p, enc) {
      if (!files.has(p)) { const err = new Error('ENOENT: ' + p); err.code = 'ENOENT'; throw err; }
      return files.get(p);
    },
    readdirSync(dir, opts) {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const names = new Set();
      for (const p of dirs) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest || rest.includes(path.sep)) continue;
        names.add(rest);
      }
      const out = Array.from(names).map((name) => ({
        name,
        isDirectory: () => dirs.has(path.join(dir, name)) || true
      }));
      if (opts && opts.withFileTypes) return out;
      return out.map((d) => d.name);
    }
  };
}

const httpsConfig = (owner, repo) =>
  `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/${owner}/${repo}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`;
const sshConfig = (owner, repo) =>
  `[remote "origin"]\n\turl = git@github.com:${owner}/${repo}.git\n`;

module.exports = function () {
  suite('repoFolders');

  check('parses an https remote with .git', JSON.stringify(repoFromRemote('https://github.com/peuka/frontend.git')) === JSON.stringify({ owner: 'peuka', repo: 'frontend' }));
  check('parses an https remote without .git', JSON.stringify(repoFromRemote('https://github.com/peuka/frontend')) === JSON.stringify({ owner: 'peuka', repo: 'frontend' }));
  check('parses a git@ remote', JSON.stringify(repoFromRemote('git@github.com:peuka/frontend.git')) === JSON.stringify({ owner: 'peuka', repo: 'frontend' }));
  check('finds the origin url inside a git config', parseOriginUrl(httpsConfig('peuka', 'frontend')) === 'https://github.com/peuka/frontend.git');
  check('a non-git url has no repo', repoFromRemote('not a url') === null);

  clearCache();
  {
    const fs = fakeFs({
      '/Users/nikoloz/Codes/Peuka/frontend': { config: httpsConfig('peuka', 'frontend') }
    });
    const info = originOf('/Users/nikoloz/Codes/Peuka/frontend', fs);
    check('originOf reads owner/repo from .git/config', info && info.owner === 'peuka' && info.repo === 'frontend' && !info.worktree);
  }

  clearCache();
  {
    const fs = fakeFs({
      '/Users/nikoloz/Codes/Peuka/frontend': { config: httpsConfig('peuka', 'frontend') },
      '/Users/elsewhere/old-frontend': { config: httpsConfig('peuka', 'frontend') }
    });
    const got = resolveRepoFolder({ owner: 'peuka', repo: 'frontend' }, {
      fsImpl: fs,
      override: { 'peuka/frontend': '/Users/elsewhere/old-frontend' },
      candidateDirs: ['/Users/nikoloz/Codes/Peuka/frontend']
    });
    check('the override wins when its folder exists', got === '/Users/elsewhere/old-frontend');
  }

  clearCache();
  {
    // Only `backend` was ever opened as an instance's cwd — `frontend` is
    // found because it is backend's sibling, the real layout this is for.
    const fs = fakeFs({
      '/Users/nikoloz/Codes/Peuka/backend': { config: httpsConfig('peuka', 'backend') },
      '/Users/nikoloz/Codes/Peuka/frontend': { config: httpsConfig('peuka', 'frontend') },
      '/Users/nikoloz/Codes/Peuka/mobile-v3': { config: httpsConfig('peuka', 'mobile-v3') }
    });
    const got = resolveRepoFolder({ owner: 'peuka', repo: 'frontend' }, {
      fsImpl: fs,
      candidateDirs: ['/Users/nikoloz/Codes/Peuka/backend']
    });
    check('a sibling of a known cwd is found', got === '/Users/nikoloz/Codes/Peuka/frontend');
  }

  clearCache();
  {
    const got = resolveRepoFolder({ owner: 'peuka', repo: 'smartparking' }, {
      fsImpl: fakeFs({
        '/Users/nikoloz/Codes': 'dir',
        '/Users/nikoloz/Codes/Peuka/smartparking': { config: httpsConfig('peuka', 'smartparking') }
      }),
      codeRoots: ['/Users/nikoloz/Codes']
    });
    check('a code root is scanned two levels deep', got === '/Users/nikoloz/Codes/Peuka/smartparking');
  }

  clearCache();
  {
    // The real checkout, plus a worktree of the same repo under
    // backend/.claude/worktrees — the worktree must not be preferred.
    const fs = fakeFs({
      '/Users/nikoloz/Codes/Peuka/backend': { config: httpsConfig('peuka', 'backend') },
      '/Users/nikoloz/Codes/Peuka/backend/.claude/worktrees/w1': {
        worktree: '/Users/nikoloz/Codes/Peuka/backend/.git/worktrees/w1',
        commondirConfig: httpsConfig('peuka', 'backend')
      }
    });
    const got = resolveRepoFolder({ owner: 'peuka', repo: 'backend' }, {
      fsImpl: fs,
      candidateDirs: [
        '/Users/nikoloz/Codes/Peuka/backend/.claude/worktrees/w1',
        '/Users/nikoloz/Codes/Peuka/backend'
      ]
    });
    check('the real checkout is preferred over its own worktree', got === '/Users/nikoloz/Codes/Peuka/backend');
  }

  clearCache();
  {
    // Nothing matches but a worktree: still better than nothing.
    const fs = fakeFs({
      '/Users/nikoloz/Codes/Peuka/backend/.claude/worktrees/w1': {
        worktree: '/Users/nikoloz/Codes/Peuka/backend/.git/worktrees/w1',
        commondirConfig: httpsConfig('peuka', 'backend')
      }
    });
    const got = resolveRepoFolder({ owner: 'peuka', repo: 'backend' }, {
      fsImpl: fs,
      candidateDirs: ['/Users/nikoloz/Codes/Peuka/backend/.claude/worktrees/w1']
    });
    check('a worktree is used when nothing else matches', got === '/Users/nikoloz/Codes/Peuka/backend/.claude/worktrees/w1');
  }

  clearCache();
  {
    let now = 1000;
    const fs = fakeFs({ '/a/frontend': { config: httpsConfig('peuka', 'frontend') } });
    const opts = { fsImpl: fs, candidateDirs: ['/a/frontend'], now: () => now };
    const first = resolveRepoFolder({ owner: 'peuka', repo: 'frontend' }, opts);
    // The folder vanishes, but within 5 minutes the cached answer still holds.
    const fs2 = fakeFs({});
    now += 60000;
    const cached = resolveRepoFolder({ owner: 'peuka', repo: 'frontend' }, Object.assign({}, opts, { fsImpl: fs2 }));
    now += 5 * 60000;
    const expired = resolveRepoFolder({ owner: 'peuka', repo: 'frontend' }, Object.assign({}, opts, { fsImpl: fs2 }));
    check('found once, then cached for a while', first === '/a/frontend' && cached === '/a/frontend');
    check('the cache expires after 5 minutes', expired === null);
  }

  check('no owner or repo resolves to nothing', resolveRepoFolder({}, {}) === null);
};

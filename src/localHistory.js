'use strict';

const fs = require('fs');
const path = require('path');
const { noSymlinks, inside, fail } = require('./daemonPaths');
const insist = (v, code) => { if (!v) throw fail(code, code); };

function createLocalHistory({ root, history, owners, approvedProject, resume, existing = () => null }) {
  root = fs.realpathSync(root);
  const cwdAllowed = (cwd) => { insist(approvedProject(cwd), 'PROJECT_APPROVAL_REQUIRED'); noSymlinks(cwd); };
  function identity({ conversation, cwd }) {
    cwdAllowed(cwd);
    insist(/^[A-Za-z0-9_-]{1,200}$/.test(conversation), 'HISTORY_OUTSIDE_ROOT');
    const file = history.transcriptPath(cwd, conversation);
    insist(typeof file === 'string' && inside(root, path.resolve(file)) && file.endsWith(path.sep + conversation + '.jsonl'), 'HISTORY_OUTSIDE_ROOT');
    noSymlinks(file);
    const stat = fs.lstatSync(file);
    insist(stat.isFile() && stat.nlink === 1 && inside(root, fs.realpathSync(file)), 'HISTORY_OUTSIDE_ROOT');
    return { file, stat };
  }
  function assertInactive(evidence, conversation) {
    insist(evidence?.complete === true && Array.isArray(evidence.owners), 'HISTORY_OWNER_UNPROVEN');
    for (const owner of evidence.owners) {
      insist(owner.connected === true && owner.metaVersion === 1 && Array.isArray(owner.runs), 'HISTORY_OWNER_UNPROVEN');
      for (const run of owner.runs) {
        if (run.exited === true) continue;
        insist(typeof run.conversation === 'string' && run.conversation, 'KEEPER_META_INCOMPLETE');
        insist(run.conversation !== conversation, 'HISTORY_ACTIVE');
      }
    }
  }
  async function proveInactive(conversation) {
    const evidence = await owners(conversation);
    try { assertInactive(evidence, conversation); return evidence; }
    catch (e) { await evidence?.release?.(); throw e; }
  }
  return {
    async list({ cwd, filter, offset, limit }) {
      if (cwd !== null) cwdAllowed(cwd);
      const needle = filter.toLowerCase();
      const entries = await history.listSessions({ cwd, limit: offset + limit + 1, scan: 20000,
        keep: (entry) => !needle || [entry.label, entry.customTitle, entry.cwd, entry.sessionId].some((v) => String(v || '').toLowerCase().includes(needle)) });
      return { entries: entries.slice(offset, offset + limit), offset, hasMore: entries.length > offset + limit,
        exhausted: entries.exhausted === true };
    },
    async resume(args, revalidate) {
      const { file } = identity(args), current = existing(args.conversation);
      if (current) { revalidate(); return { id: current.id, resumed: false }; }
      const evidence = await proveInactive(args.conversation);
      try {
        revalidate(); insist(typeof resume === 'function', 'HISTORY_RESUME_UNAVAILABLE');
        return await resume({ ...args, file });
      } finally { await evidence.release?.(); }
    },
    async delete(args, revalidate) {
      const { file, stat } = identity(args), evidence = await proveInactive(args.conversation);
      try {
        insist(evidence.guarded === true && typeof evidence.revalidate === 'function', 'HISTORY_OWNER_UNPROVEN');
        // This guard stays held across all owners until release. Its current
        // proof is synchronous with unlink, so no new admission can race the
        // final lookup. An ordinary cached keeper list is insufficient.
        assertInactive(evidence.revalidate(), args.conversation); revalidate();
        noSymlinks(file);
        const current = fs.lstatSync(file);
        insist(stat.ino === current.ino && stat.dev === current.dev && stat.size === current.size && stat.mtimeMs === current.mtimeMs && current.nlink === 1,
          'HISTORY_CHANGED');
        fs.unlinkSync(file); return { conversation: args.conversation, deleted: true };
      } finally { await evidence.release?.(); }
    }
  };
}

module.exports = { createLocalHistory };

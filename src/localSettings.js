'use strict';

const path = require('path');
const { createDaemonConfig, disposition, PROJECT, EDITOR, MACHINE } = require('./daemonConfig');
const { inside, noSymlinks, fail } = require('./daemonPaths');
const properties = require('../package.json').contributes.configuration.properties;
const clone = (v) => v === undefined ? undefined : structuredClone(v);
const insist = (v, code) => { if (!v) throw fail(code, code); };

// The caller owns authorization and serialization. A phone's curated update()
// never calls this adapter. Editor values live in the enrolled client's store.
function createLocalSettings({ root, read, commit, editorStore, approvedProject, provenance }) {
  function selected(scope, project) {
    insist(['user', 'project', 'editor'].includes(scope), 'CONFIG_SCOPE');
    if (scope === 'project') {
      insist(typeof project === 'string' && path.isAbsolute(project) && inside(root, path.resolve(project)), 'CONFIG_SCOPE');
      noSymlinks(project); insist(approvedProject(project), 'PROJECT_APPROVAL_REQUIRED');
    } else insist(project === null, 'CONFIG_SCOPE');
    const saved = clone(read());
    const record = scope === 'project' ? saved.projects.find((p) => p.root === project) : null;
    const values = scope === 'editor' ? editorStore.get('settings', {}) : scope === 'project' ? record?.values || {} : saved.user;
    return { saved, record, values };
  }
  return {
    get(scope, project) {
      const { saved, record, values } = selected(scope, project);
      const cfg = createDaemonConfig({ ...saved, root });
      const effective = scope === 'project' ? cfg.forProject(project) : cfg;
      const settings = [];
      for (const [full, schema] of Object.entries(properties)) {
        const key = full.slice(6);
        if (scope === 'editor' ? !EDITOR.has(key) : EDITOR.has(key) || scope === 'project' && !PROJECT.has(key)) continue;
        const explicit = Object.hasOwn(values, key);
        const contributingProject = scope === 'project' ? saved.projects.filter((p) => inside(p.root, project) && Object.hasOwn(p.values, key))
          .sort((a, b) => b.root.length - a.root.length)[0] : null;
        const origin = scope === 'editor' && explicit ? { scope: 'editor', root: null, provenance: editorStore.get('provenance', provenance) }
          : contributingProject ? { scope: 'project', root: contributingProject.root, provenance: contributingProject.provenance }
            : scope !== 'editor' && Object.hasOwn(saved.user, key) ? { scope: 'user', root: null, provenance: saved.provenance?.[key] || provenance }
              : { scope: 'default', root: null, provenance: null };
        let resolved = scope === 'editor' ? explicit ? clone(values[key]) : clone(schema.default) : effective.get(key);
        if (['promptSnippets', 'promptSnippetDescriptions'].includes(key)) resolved = { ...clone(schema.default), ...resolved };
        settings.push({ key, disposition: disposition(key), default: clone(schema.default),
          explicit, value: explicit ? clone(values[key]) : null,
          effective: resolved, effectiveSource: clone(origin),
          provenance: explicit ? clone(scope === 'project' ? record.provenance : scope === 'editor'
            ? editorStore.get('provenance', provenance) : saved.provenance?.[key] || provenance) : null });
      }
      return { scope, root: project, provenance: clone(record?.provenance || provenance), settings };
    },
    async update({ scope, root: project, key, value, provenance: source }, revalidate = () => {}) {
      const { saved, record, values } = selected(scope, project), schema = properties['nikui.' + key];
      insist(schema && (scope === 'editor' ? EDITOR.has(key) : !EDITOR.has(key)), 'CONFIG_SCOPE');
      insist(scope !== 'project' || PROJECT.has(key), 'CONFIG_SCOPE');
      insist(source && ['profile', 'workspace', 'rawScope'].every((k) => typeof source[k] === 'string' && source[k]), 'CONFIG_PROVENANCE');
      insist(source.profile === provenance.profile, 'CONFIG_PROVENANCE');
      // Setup requires an attended, correlated, expiring UI response. Focus or
      // simply writing true cannot authorize machine setup.
      insist(!(key === 'lidClosed' && value === true), 'ATTENDED_CONFIRMATION_REQUIRED');
      const next = { ...values };
      if (value === null) delete next[key]; else next[key] = clone(value);
      if (scope === 'editor') {
        const { matches } = require('./localManagementProtocol');
        insist(value === null || matches(value, schema), 'CONFIG_INVALID');
        revalidate(); await editorStore.update('settings', next, revalidate); revalidate(); await editorStore.update('provenance', source, revalidate);
      } else {
        if (scope === 'user') { saved.user = next; saved.provenance ||= {}; saved.provenance[key] = clone(source); }
        else {
          const changed = { root: project, approved: true, values: next, provenance: clone(source) };
          saved.projects = saved.projects.filter((p) => p !== record).concat(changed);
        }
        createDaemonConfig({ ...saved, root }); // validate every value/scope before commit
        revalidate(); await commit(saved, revalidate, { scope, root: project, key, value: clone(value), provenance: clone(source) });
      }
      return { scope, root: project, key, requiresRestart: MACHINE.has(key) && !['keepAwake', 'lidClosed'].includes(key) };
    }
  };
}

module.exports = { createLocalSettings };

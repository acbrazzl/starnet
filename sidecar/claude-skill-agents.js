'use strict';

/* sidecar/claude-skill-agents.js — CREW-SKILL BAYS (fork, 2026-11-14): which station agents hand their step to one of the
 * Commander's own Claude Code skills.
 *
 * A line's bays run StarNet's stateless per-step agents. A bay staffed by a BOUND agent instead runs its step as ONE
 * `claude -p "/<skill> …"` in a directory Claude Code already trusts (sidecar/providers/claude-cli.js, the claudeSkill
 * branch), so the step gets that skill, the project's CLAUDE.md and its auto-memory: the crew's real know-how, not a
 * persona. Read-only tools, no connectors, no session file: a skill step can read and draft, never post or write.
 *
 * The binding lives HERE, in the sidecar, not on the page-owned roster: the roster is pushed by the browser and a field
 * the page does not know would be dropped on the next push, and a binding is a sidecar fact about how a run spawns.
 * Same shape as claude-crew.managed.json. Keyed by roster agentId.
 *
 * WHAT IS ALLOWED, checked at bind time AND again when a step runs (trust can be withdrawn, a skill uninstalled):
 *   skill — a plain name (no path), installed as <skillDir>/<skill>/SKILL.md (default skill dir ~/.claude/skills)
 *   dir   — an absolute, existing directory that Claude Code already trusts: it or an ancestor has
 *           hasTrustDialogAccepted:true in ~/.claude.json. StarNet never accepts a trust prompt for the Commander.
 * No clock and no randomness here (lint-determinism).
 */

const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function makeClaudeSkillAgents(o) {
  o = o || {};
  const fs = o.fs || require('fs');
  const path = o.path || require('path');
  const home = String(o.home || require('os').homedir());
  const claudeJson = o.claudeJson || path.join(home, '.claude.json');
  const skillDirs = (Array.isArray(o.skillDirs) && o.skillDirs.length ? o.skillDirs : [path.join(home, '.claude', 'skills')]).map(String);
  const save = typeof o.save === 'function' ? o.save : () => {};
  const agents = new Map();
  const loaded = typeof o.load === 'function' ? o.load() : null;
  if (loaded && loaded.agents && typeof loaded.agents === 'object') {
    for (const [id, b] of Object.entries(loaded.agents)) if (b && typeof b === 'object' && b.skill && b.dir) agents.set(String(id), { skill: String(b.skill), dir: String(b.dir) });
  }

  const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
  const isFile = p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
  function trustedProjects() {
    let j = null;
    try { j = JSON.parse(String(fs.readFileSync(claudeJson, 'utf8'))); } catch (_) { j = null; }
    const out = [];
    const projects = j && j.projects && typeof j.projects === 'object' ? j.projects : {};
    for (const [dir, p] of Object.entries(projects)) if (p && p.hasTrustDialogAccepted === true) out.push(path.resolve(dir));
    return out;
  }
  const within = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

  // { ok:true, skill, dir } or { ok:false, error } — the error is said to the lead, so it names the remedy
  function check(b) {
    const skill = String((b && b.skill) || '').trim().replace(/^\//, '');
    const raw = String((b && b.dir) || '').trim();
    if (!SKILL_RE.test(skill)) return { ok: false, error: 'the skill must be a plain Claude Code skill name (like meshflow-social), not a path' };
    if (!skillDirs.some(d => isFile(path.join(d, skill, 'SKILL.md')))) return { ok: false, error: 'no Claude Code skill named "' + skill + '" is installed (looked in ' + skillDirs.join(', ') + ')' };
    if (!raw || !path.isAbsolute(raw)) return { ok: false, error: 'the directory must be an absolute path to a project folder' };
    let dir = path.resolve(raw);
    try { dir = fs.realpathSync(dir); } catch (_) { dir = path.resolve(raw); }   // a missing dir fails the isDir check below
    if (!isDir(dir)) return { ok: false, error: 'the directory ' + dir + ' does not exist' };
    if (within(dir, path.join(home, '.claude'))) return { ok: false, error: 'the Claude config directory is not a project folder' };
    if (!trustedProjects().some(root => within(dir, root))) return { ok: false, error: 'Claude Code does not trust ' + dir + ' yet — the Commander opens `claude` there once and accepts the trust prompt; StarNet never accepts it for them' };
    return { ok: true, skill, dir };
  }
  const persist = () => { const out = {}; for (const [id, b] of agents) out[id] = { skill: b.skill, dir: b.dir }; save({ agents: out }); };

  return {
    check,
    get(agentId) { const b = agents.get(String(agentId || '')); return b ? { skill: b.skill, dir: b.dir } : null; },
    list() { return Array.from(agents, ([agentId, b]) => ({ agentId, skill: b.skill, dir: b.dir })); },
    set(agentId, b) {
      const id = String(agentId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { ok: false, error: 'unknown agent id' };
      const c = check(b);
      if (!c.ok) return c;
      agents.set(id, { skill: c.skill, dir: c.dir });
      persist();
      return { ok: true, agentId: id, skill: c.skill, dir: c.dir };
    },
    clear(agentId) { const had = agents.delete(String(agentId || '')); if (had) persist(); return had; },
    // at RUN time: null = not a skill agent (a normal step); else the binding re-checked ({ ok:false, error } refuses the step)
    resolve(agentId) { const b = agents.get(String(agentId || '')); return b ? check(b) : null; }
  };
}

module.exports = { makeClaudeSkillAgents, SKILL_RE };

/* sidecar/tools/builtin/claude-skill-agent.js — the LEAD binds a station agent to one of the Commander's Claude Code skills.

     claude.skill_agent  write  { agent, skill, dir }   bind: that agent's line steps run as ONE read-only
                                                        `claude -p "/<skill> …"` in `dir` (sidecar/claude-skill-agents.js)
                                { agent, clear: true }  unbind (its steps run as ordinary StarNet steps again)
                                {}                      list the bindings

   Refused unless the agent is on the live roster, the skill is a plain installed Claude Code skill and the directory is
   one Claude Code ALREADY trusts (StarNet never accepts a trust prompt for the Commander). It writes nothing but the
   binding, runs nothing, posts nothing. Approval: it asks like any orchestrator write, unless the Commander opted the lead
   into crew building (STARNET_AUTO_BUILD_CREW=1, index.js autoBuildAllows).

     makeClaudeSkillAgentTool({ store, hasAgent, nameOf, skills }) -> { tool, register }   */
'use strict';

function makeClaudeSkillAgentTool(deps) {
  const store = deps && deps.store;
  const hasAgent = (deps && typeof deps.hasAgent === 'function') ? deps.hasAgent : () => false;
  const nameOf = (deps && typeof deps.nameOf === 'function') ? deps.nameOf : id => id;
  const skills = (deps && typeof deps.skills === 'function') ? deps.skills : () => [];
  // the agent is named the way the Commander and the lead name it: its id, or its roster name (any case)
  const resolveAgent = deps && typeof deps.resolveAgent === 'function' ? deps.resolveAgent : (a => (hasAgent(a) ? a : ''));

  const tool = {
    name: 'claude.skill_agent', capability: 'orchestrator', scope: 'write', requiresConsent: true, timeoutMs: 15000,
    description: 'Bind one of YOUR crew agents to one of the Commander\'s own Claude Code skills, so a workflow-line bay staffed by that agent runs its step through the skill ' +
      '(one `claude -p "/<skill> …"` in a project folder, with the skill, that project\'s CLAUDE.md and its memory), READ-ONLY: it can read and draft, never post, write files or run commands. ' +
      'Use it when a line step needs the crew\'s real know-how (e.g. bind a SOCIAL agent to meshflow-social in ~/code/meshFlow, then staff the bay with that agent via station.plan staff). ' +
      'Args: { agent, skill, dir } binds (dir = an absolute folder Claude Code already trusts); { agent, clear: true } unbinds; no args lists the bindings and the installed skills. ' +
      'The agent must already be on the crew (team.summon creates one). Never bind the lead itself.',
    schema: { type: 'object', additionalProperties: false, properties: {
      agent: { type: 'string', maxLength: 40, description: 'The crew agent: its id or its name as the crew list shows it.' },
      skill: { type: 'string', maxLength: 64, description: 'A Claude Code skill name, e.g. "meshflow-social" (no slash, no path).' },
      dir: { type: 'string', maxLength: 400, description: 'Absolute project folder Claude Code already trusts, where the step runs (its CLAUDE.md and memory load).' },
      clear: { type: 'boolean', description: 'true = unbind this agent.' } } },
    run: async (args) => {
      if (!store) throw new Error('crew-skill bindings are not available on this station');
      const a = args || {};
      if (!a.agent) {
        return { content: JSON.stringify({ bindings: store.list().map(b => Object.assign({ name: nameOf(b.agentId) }, b)), installedSkills: skills() }),
          summary: store.list().length + ' crew-skill binding(s)' };
      }
      const id = resolveAgent(String(a.agent).trim());
      if (!id) throw new Error('no crew agent named "' + String(a.agent).trim() + '" is on the roster — create it first (team.summon), then bind it');
      if (id === 'agent') throw new Error('the lead itself cannot be bound to a skill: bind a crew agent and staff the bay with it');
      if (a.clear === true) {
        const had = store.clear(id);
        return { content: JSON.stringify({ ok: true, agentId: id, cleared: had }), summary: had ? 'unbound ' + nameOf(id) : nameOf(id) + ' had no skill binding' };
      }
      const out = store.set(id, { skill: a.skill, dir: a.dir });
      if (!out.ok) throw new Error(out.error);
      return { content: JSON.stringify({ ok: true, agentId: id, name: nameOf(id), skill: out.skill, dir: out.dir,
        next: 'staff a bay with this agent (station.plan { staff: { line, steps: [{ step, agent: "' + nameOf(id) + '" }] } }, then station.build); its steps run read-only through /' + out.skill }),
        summary: 'bound ' + nameOf(id) + ' to /' + out.skill + ' in ' + out.dir };
    },
  };
  return { tool, register(reg) { reg.register(tool); return reg; } };
}

module.exports = { makeClaudeSkillAgentTool };

/* sidecar/tools/builtin/claude-session-agent.js — the LEAD binds a station agent to a CREW-SESSION SLOT.

     claude.session_agent  write  { agent, slot }         bind: that agent's line step LAUNCHES the slot's real crew session
                                                          (the Commander's own launcher, e.g. the cron sweep script), waits
                                                          for it, and hands its final report on (sidecar/claude-session-bays.js)
                                  { agent, clear: true }  unbind
                                  {}                      list the slots, bindings and today's launches

   Only a slot the Commander configured (STARNET_SESSION_BAY_SLOTS) can be bound: the lead names a slot, never a command.
   Always asks (never on the AUTO-BUILD lists): a binding decides that a line run will start real work.

     makeClaudeSessionAgentTool({ store, resolveAgent, nameOf }) -> { tool, register }   */
'use strict';

function makeClaudeSessionAgentTool(deps) {
  const store = deps && deps.store;
  const nameOf = (deps && typeof deps.nameOf === 'function') ? deps.nameOf : id => id;
  const resolveAgent = deps && typeof deps.resolveAgent === 'function' ? deps.resolveAgent : () => '';

  const tool = {
    name: 'claude.session_agent', capability: 'orchestrator', scope: 'write', requiresConsent: true, timeoutMs: 15000,
    description: 'Bind one of YOUR crew agents to a CREW-SESSION SLOT the Commander configured, so a workflow-line bay staffed by that agent LAUNCHES a real Claude Code crew session ' +
      '(e.g. the periodic security sweep, through the same launcher cron uses), waits for it to finish, and hands the session\'s final report to the next bay. ' +
      'Guardrails, enforced at every run: the bay must be FIRST on its line (a run carrying upstream text never launches), at most one launch a day per slot, ' +
      'never while that kind of session is still working, a wall-clock cap. The bay\'s job text is NOT passed to the session — its brief is fixed in the launcher. ' +
      'Args: { agent, slot } binds; { agent, clear: true } unbinds; no args lists slots, bindings and today\'s launches. Never bind the lead itself.',
    schema: { type: 'object', additionalProperties: false, properties: {
      agent: { type: 'string', maxLength: 40, description: 'The crew agent: its id or its name as the crew list shows it.' },
      slot: { type: 'string', maxLength: 32, description: 'A configured slot name, e.g. "security".' },
      clear: { type: 'boolean', description: 'true = unbind this agent.' } } },
    run: async (args) => {
      if (!store) throw new Error('session bays are not available on this station');
      const a = args || {};
      if (!a.agent) {
        return { content: JSON.stringify({ enabled: store.enabled, slots: store.slots(), slotErrors: store.slotErrors, bindings: store.list().map(b => Object.assign({ name: nameOf(b.agentId) }, b)), launches: store.launches() }),
          summary: store.slots().length + ' session slot(s), ' + store.list().length + ' binding(s)' };
      }
      const id = resolveAgent(String(a.agent).trim());
      if (!id) throw new Error('no crew agent named "' + String(a.agent).trim() + '" is on the roster — create it first, then bind it');
      if (id === 'agent') throw new Error('the lead itself cannot be bound to a session slot: bind a crew agent and staff the bay with it');
      if (a.clear === true) {
        const had = store.clear(id);
        return { content: JSON.stringify({ ok: true, agentId: id, cleared: had }), summary: had ? 'unbound ' + nameOf(id) : nameOf(id) + ' had no session binding' };
      }
      const out = store.set(id, a.slot);
      if (!out.ok) throw new Error(out.error);
      return { content: JSON.stringify({ ok: true, agentId: id, name: nameOf(id), slot: out.slot,
        next: 'staff the FIRST bay of a line with this agent (station.plan staff), then station.build; each run of that line launches one ' + out.slot + ' session' }),
        summary: 'bound ' + nameOf(id) + ' to the ' + out.slot + ' session slot' };
    },
  };
  return { tool, register(reg) { reg.register(tool); return reg; } };
}

module.exports = { makeClaudeSessionAgentTool };

/* sidecar/tools/builtin/claude-crew.js — the LEAD's handle on the Commander's own Claude Code sessions.

   The CLAUDE CREW (sidecar/claude-crew.js) projects the user's `claude` CLI sessions onto the floor. These tools
   let the Overseer see and staff that crew the way it staffs its own:

     claude.crew    read     the live Claude sessions (name, dir, working/idle/needs-you, remote-capable) plus the
                             Claude Code SKILLS a new session can be launched with. No consent — it spends nothing.
     claude.launch  write    start a BACKGROUND Claude session with Remote Control on, optionally loading one skill
                             (its first line becomes `/<skill>`). NO approval — the Commander's standing policy is
                             that the lead may staff as many sessions as it wants; they are the station's (launched).
     claude.adopt   write    take over a PRE-EXISTING session (one the station did not launch). The Commander
                             approves this ONCE per session (confirmEveryTime: never cached, never unattended);
                             after that the session is the station's to message and stop without asking.
     claude.send    write    message a MANAGED session (launched or adopted). No approval.
     claude.stop    write    stop a MANAGED background session. No approval.

   A launched session is NOT a StarNet agent: StarNet never runs, meters, or authenticates it (see
   sidecar/claude-crew.js). The Commander talks to it over its claude.ai/code Remote Control link, which
   claude.crew does not fabricate — a session whose link has not appeared yet says so.

     makeClaudeCrewTools({ crew, defaultCwd }) -> { crewTool, launchTool, stopTool, register }   */
'use strict';

function makeClaudeCrewTools(deps) {
  const crew = deps && deps.crew;
  const defaultCwd = String((deps && deps.defaultCwd) || '');
  const need = () => { if (!crew || !crew.enabled) throw new Error('Claude crew is off on this station (start it with STARNET_CLAUDE_CREW=1)'); };

  const crewTool = {
    name: 'claude.crew', capability: 'orchestrator', scope: 'read', requiresConsent: false,
    description: 'List the Commander\'s own Claude Code sessions (the "Claude crew" on the station floor) and the Claude Code skills a new session can be launched with. ' +
      'Each session has a name, directory, status (working / idle / needs-you), whether the station manages it (launched here or adopted — only managed sessions can be messaged or stopped), and whether it is a background session. ' +
      'Call this before claude.launch to pick a skill, and whenever the Commander asks what their Claude agents are doing.',
    schema: { type: 'object', properties: {} },
    run: async () => {
      need();
      const listed = await crew.list();
      const sessions = (listed.sessions || []).map(s => ({
        name: s.name, id: s.shortId || null, dir: s.cwd, kind: s.kind,
        status: s.needsInput ? 'needs-you' : s.busy ? 'working' : 'idle', stoppable: !!s.stoppable,
        managed: s.managed || 'no — claude.adopt first',
      }));
      const skills = crew.listSkills().map(sk => ({ name: sk.name, description: sk.description }));
      const needs = sessions.filter(s => s.status === 'needs-you').length;
      return {
        content: JSON.stringify({ available: listed.available !== false, reason: listed.reason || undefined, sessions, skills,
          defaultDir: defaultCwd || undefined }),
        summary: (listed.available === false ? 'claude CLI unavailable: ' + (listed.reason || '?') + ' · ' : '') +
          sessions.length + ' Claude session(s)' + (needs ? ', ' + needs + ' waiting on the Commander' : '') + ' · ' + skills.length + ' skill(s)',
      };
    },
  };

  const launchTool = {
    name: 'claude.launch', capability: 'orchestrator', scope: 'write', requiresConsent: false, timeoutMs: 60000,
    description: 'Start a new background Claude Code session for the Commander, with Remote Control on so they can drive it from claude.ai or their phone. ' +
      'Optionally load one Claude Code skill (from claude.crew) — e.g. a social-media, dev or debugging specialist. ' +
      'Without a message, a skilled session loads the skill, orients itself read-only, reports readiness and waits. ' +
      'The session runs on the Commander\'s own Claude login and keeps running after this turn; it appears on the floor and in the CREW rail.',
    schema: {
      type: 'object', required: ['name'],
      properties: {
        name: { type: 'string', maxLength: 40, description: 'Short display name (letters, digits, space, . _ -), e.g. "social".' },
        skill: { type: 'string', maxLength: 64, description: 'Optional skill name exactly as claude.crew lists it.' },
        dir: { type: 'string', maxLength: 400, description: 'Absolute directory to work in; must already be trusted by Claude Code. Defaults to the station default.' },
        message: { type: 'string', maxLength: 4000, description: 'Optional first instruction for the session.' },
        permissionMode: { type: 'string', enum: ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'], description: 'Omit to use the station default. default = asks the Commander before each action; auto = routine safe actions proceed, risky ones still ask; plan = read-only; bypassPermissions = no prompts at all (only if the station allows it).' },
      },
    },
    run: async (args) => {
      need();
      const a = args || {};
      const cwd = String(a.dir || defaultCwd || '');
      if (!cwd) throw new Error('no directory: pass dir (an absolute path Claude Code trusts)');
      const out = await crew.spawn({ name: a.name, skill: a.skill || '', cwd, prompt: a.message || '', permissionMode: a.permissionMode || '' });   // '' = the station default
      if (!out.ok) throw new Error(out.error || 'launch failed');
      return {
        content: JSON.stringify({ ok: true, id: out.shortId || null, name: a.name, skill: a.skill || null, dir: cwd }),
        summary: 'launched Claude session "' + a.name + '"' + (a.skill ? ' with /' + a.skill : '') + (out.shortId ? ' (' + out.shortId + ')' : ''),
      };
    },
  };

  const stopTool = {
    name: 'claude.stop', capability: 'orchestrator', scope: 'write', requiresConsent: false, timeoutMs: 30000,
    description: 'Stop one of the station-managed BACKGROUND Claude sessions (launched here or adopted), by name or id from claude.crew. Terminal sessions cannot be stopped from the station. Its conversation is kept and can be resumed.',
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 80, description: 'Session name or 8-hex id from claude.crew.' } } },
    run: async (args) => {
      need();
      const out = await crew.stopManaged(String((args && args.id) || ''));
      if (!out.ok) throw new Error(out.error || 'stop failed');
      return { content: JSON.stringify({ ok: true, name: out.name }), summary: 'stopped Claude session ' + out.name };
    },
  };

  const sendTool = {
    name: 'claude.send', capability: 'orchestrator', scope: 'write', requiresConsent: false, timeoutMs: 180000,
    description: 'Send a message into a station-MANAGED Claude Code session (launched here, or a pre-existing one taken over with claude.adopt) — terminal (interactive) sessions included — by its name from claude.crew. ' +
      'Use it to task or brief a Claude session. The session receives it as a teammate message and acts within its OWN permission settings; it cannot reply to you through this relay (its answer stays in its own session, where the Commander reads it). ' +
      'Delivery is verified: a failed or altered send is reported as such.',
    schema: { type: 'object', required: ['to', 'message'], properties: {
      to: { type: 'string', maxLength: 80, description: 'The session name exactly as claude.crew lists it (e.g. "meshflow-ff").' },
      message: { type: 'string', maxLength: 6000, description: 'The full message to deliver.' } } },
    run: async (args, ctx) => {
      need();
      let from = String((ctx && (ctx.agentName || ctx.agentId)) || 'overseer').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 30);
      if (!from || from === 'agent') from = 'overseer';   // the hero's id is the generic 'agent'
      const out = await crew.send({ to: args && args.to, message: args && args.message, from: 'starnet-' + from, requireManaged: true });
      if (!out.ok) throw new Error(out.error || 'send failed');
      return { content: JSON.stringify({ ok: true, to: out.to, verbatim: out.verbatim, note: out.error || undefined }),
        summary: 'delivered to ' + out.to + (out.verbatim ? '' : ' — WARNING: ' + out.error) };
    },
  };

  const adoptTool = {
    name: 'claude.adopt', capability: 'orchestrator', scope: 'write', requiresConsent: true, confirmEveryTime: true, timeoutMs: 30000,
    description: 'Take over a PRE-EXISTING Claude session (one the station did not launch — e.g. the Commander\'s own terminal session) so the station may message and stop it. ' +
      'The Commander approves this once per session; afterwards claude.send / claude.stop work on it without asking. Sessions launched with claude.launch are already managed.',
    schema: { type: 'object', required: ['session'], properties: { session: { type: 'string', maxLength: 80, description: 'Session name or id from claude.crew.' } } },
    run: async (args) => {
      need();
      const out = await crew.adopt(String((args && args.session) || ''));
      if (!out.ok) throw new Error(out.error || 'adopt failed');
      return { content: JSON.stringify(out), summary: out.already ? out.name + ' was already managed (' + out.managed + ')' : 'took over ' + out.name + ' — the station may now message and stop it' };
    },
  };

  return {
    crewTool, launchTool, stopTool, sendTool, adoptTool,
    register(reg) { reg.register(crewTool); reg.register(launchTool); reg.register(stopTool); reg.register(sendTool); reg.register(adoptTool); return reg; },
  };
}

module.exports = { makeClaudeCrewTools };

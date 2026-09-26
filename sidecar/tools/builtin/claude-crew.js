/* sidecar/tools/builtin/claude-crew.js — the LEAD's handle on the Commander's own Claude Code sessions.

   The CLAUDE CREW (sidecar/claude-crew.js) projects the user's `claude` CLI sessions onto the floor. These tools
   let the Overseer see and staff that crew the way it staffs its own:

     claude.crew    read     the live Claude sessions (name, dir, working/idle/needs-you, remote-capable) plus the
                             Claude Code SKILLS a new session can be launched with. No consent — it spends nothing.
     claude.launch  execute  start a BACKGROUND Claude session with Remote Control on, optionally loading one skill
                             (its first line becomes `/<skill>`), in a directory Claude Code already trusts.
                             Consent-gated like team.summon/team.spawn: it starts real, subscription-spending work
                             that keeps running after this turn, and scope 'execute' means an autonomous run can
                             never spend it off a cached grant.
     claude.stop    write    stop a background Claude session. Consent-gated: it ends someone's running work.

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
      'Each session has a name, directory, status (working / idle / needs-you), and whether it is a background session the station can stop. ' +
      'Call this before claude.launch to pick a skill, and whenever the Commander asks what their Claude agents are doing.',
    schema: { type: 'object', properties: {} },
    run: async () => {
      need();
      const listed = await crew.list();
      const sessions = (listed.sessions || []).map(s => ({
        name: s.name, id: s.shortId || null, dir: s.cwd, kind: s.kind,
        status: s.needsInput ? 'needs-you' : s.busy ? 'working' : 'idle', stoppable: !!s.stoppable,
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
    name: 'claude.launch', capability: 'orchestrator', scope: 'execute', requiresConsent: true, timeoutMs: 60000,
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
        permissionMode: { type: 'string', enum: ['default', 'plan', 'acceptEdits', 'auto'], description: 'Omit to use the station default. default = asks the Commander before each action; auto = routine safe actions proceed, risky ones still ask; plan = read-only.' },
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
    name: 'claude.stop', capability: 'orchestrator', scope: 'write', requiresConsent: true, timeoutMs: 30000,
    description: 'Stop one of the Commander\'s BACKGROUND Claude sessions by its id from claude.crew. Terminal sessions cannot be stopped from the station. Its conversation is kept and can be resumed from the CLI.',
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 16, description: 'The 8-hex session id from claude.crew.' } } },
    run: async (args) => {
      need();
      const out = await crew.stop(String((args && args.id) || ''));
      if (!out.ok) throw new Error(out.error || 'stop failed');
      return { content: JSON.stringify({ ok: true, id: args.id }), summary: 'stopped Claude session ' + args.id };
    },
  };

  return {
    crewTool, launchTool, stopTool,
    register(reg) { reg.register(crewTool); reg.register(launchTool); reg.register(stopTool); return reg; },
  };
}

module.exports = { makeClaudeCrewTools };

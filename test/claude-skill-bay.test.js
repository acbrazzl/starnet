/* node test/claude-skill-bay.test.js - CREW-SKILL BAYS (fork, 2026-11-14): a roster agent bound to one of the Commander's
   Claude Code skills runs its line step as ONE `claude -p "/<skill> …"` in a directory Claude Code already trusts, with
   READ-ONLY tools, no connectors and no session file. No real `claude` is spawned. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { EventEmitter } = require('events');
const { makeClaudeCliProvider } = require('../sidecar/providers/claude-cli.js');
const { makeClaudeSkillAgents } = require('../sidecar/claude-skill-agents.js');

// A fake `claude` child (the provider.claude-cli.test.js shape): records argv, cwd and stdin, replays stream-json lines.
function fakeSpawn(lines) {
  const calls = [];
  function spawn(file, args, opts) {
    const child = new EventEmitter();
    const stream = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = stream(); child.stderr = stream(); child.pid = 4243; child.exitCode = null;
    const call = { file, args, opts, stdin: '' };
    calls.push(call);
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    child.kill = () => exit(null);
    child.stdin = { on() {}, end(text) { call.stdin += text || ''; setImmediate(() => { for (const l of lines) child.stdout.emit('data', JSON.stringify(l) + '\n'); exit(0); }); } };
    return child;
  }
  return { spawn, calls };
}
const written = {};
const fakeFs = { statSync() { return { isFile: () => true }; }, writeFileSync(f, s) { written[f] = String(s); }, unlinkSync() {} };
const init = { type: 'system', subtype: 'init', apiKeySource: 'none', tools: ['Glob', 'Grep', 'Read'] };
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const result = { type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', total_cost_usd: 0.2,
  usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 } };
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
const flag = (args, f) => args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined;

(async () => {
  // A. THE PROVIDER BRANCH: a request carrying claudeSkill + claudeDir runs the skill, read-only, in that directory.
  {
    // the CLI answers the skill-load turn first ("The skill is loaded…", its own result line), then the hand-off turn
    const f = fakeSpawn([init, delta('Join the free alpha'), delta(' — link in bio.'), result]);
    // persistence ON and tools offered: the skill turn must still be one-shot and must not offer StarNet's tools
    const p = makeClaudeCliProvider({ spawn: f.spawn, fs: fakeFs, bin: 'claude', env: { PATH: '' }, platform: 'linux' });
    const evs = await collect(p, {
      model: 'claude-sonnet-5-5', claudeSkill: 'meshflow-social', claudeDir: '/home/u/code/meshFlow',
      tools: [{ type: 'function', function: { name: 'station.map', description: 'x', parameters: { type: 'object', properties: {} } } }],
      messages: [{ role: 'system', content: 'You are stage 2 of a work line. The line only drafts.' }, { role: 'user', content: 'PIPELINE HANDOFF — draft the caption.' }]
    });
    A.eq(f.calls.length, 1, 'one child for one step');
    const { args, opts, stdin } = f.calls[0];
    A.eq(opts.cwd, '/home/u/code/meshFlow', 'the step runs IN the bound directory (its CLAUDE.md, auto-memory and project skills load)');
    A.eq(flag(args, '--tools'), 'Read,Grep,Glob', 'READ-ONLY tools: no Bash, Write, Edit or web — the step can only draft');
    A.ok(args.indexOf('--strict-mcp-config') >= 0 && flag(args, '--mcp-config') === '{"mcpServers":{}}', 'no connector (MCP server) reaches the step');
    A.ok(args.indexOf('--no-session-persistence') >= 0, 'no session file');
    A.ok(args.indexOf('--setting-sources') < 0, 'the user\'s own settings load, so their skills do');
    A.ok(args.indexOf('--disable-slash-commands') < 0, 'slash commands stay on: the skill is invoked as /<skill>');
    A.ok(args.indexOf('--system-prompt-file') < 0 && !!flag(args, '--append-system-prompt-file'), 'StarNet\'s stage brief is APPENDED: Claude Code keeps its own prompt (memory, skills)');
    A.ok(Object.values(written).some(s => s.includes('The line only drafts')), 'the appended file carries the stage brief');
    A.eq(flag(args, '--model'), 'claude-sonnet-5-5', 'the bay\'s model');
    /* NO SKILL ARGUMENTS (2026-11-14, live): Claude Code substitutes $1/$2/$ARGUMENTS in a skill's body with the slash
       command's arguments, so "/<skill>\n\n<hand-off>" turned the posting log's "under $1,000/yr" into "under HANDOFF,000/yr"
       in every step. And a second user message for the hand-off is NOT a reliable second turn: Opus merged the two queued
       messages into ONE turn (one result line), so skipping "the load turn" dropped the answer ("exited before answering").
       So: ONE message, the slash command ALONE; the hand-off rides the appended system prompt; exactly one turn. */
    A.eq(flag(args, '--input-format'), 'stream-json', 'the message goes as stream-json');
    const msgs = stdin.trim().split('\n').map(l => JSON.parse(l));
    A.eq(msgs.length, 1, 'ONE message: one turn, one result, on every model');
    A.eq(msgs[0].message.content, '/meshflow-social', 'the slash command ALONE — no arguments to substitute into the skill');
    const appended = Object.values(written).find(t => t.includes('The line only drafts')) || '';
    A.ok(appended.includes('PIPELINE HANDOFF — draft the caption.'), 'the hand-off rides the appended system prompt, with the stage brief');
    A.ok(!stdin.includes('station.map'), 'StarNet\'s tools are never offered to a skill step');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Join the free alpha — link in bio.', 'the one turn\'s reply is the step\'s answer');
    A.eq(evs.filter(e => e.type === 'done').length, 1, 'one done');
  }
  // A2. without claudeSkill nothing changes: the stateless no-tools turn (the default claude-cli path)
  {
    const f = fakeSpawn([init, delta('ok'), result]);
    const p = makeClaudeCliProvider({ spawn: f.spawn, fs: fakeFs, bin: 'claude', env: { PATH: '', STARNET_CLAUDE_CLI_PERSIST: '0' }, platform: 'linux' });
    await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(flag(f.calls[0].args, '--tools'), '', 'a plain step still has every CLI tool off');
    A.ok(f.calls[0].args.indexOf('--disable-slash-commands') >= 0, 'and no skills');
  }
  // A3. a skill request with no usable directory is refused, never run somewhere else
  {
    const f = fakeSpawn([init, result]);
    const p = makeClaudeCliProvider({ spawn: f.spawn, fs: fakeFs, bin: 'claude', env: { PATH: '' }, platform: 'linux' });
    let err = null; try { await collect(p, { model: 'sonnet', claudeSkill: 'meshflow-social', claudeDir: 'relative/dir', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err && /directory/i.test(err.message), 'a relative claudeDir throws');
    A.eq(f.calls.length, 0, 'and nothing was spawned');
  }

  // B. THE BINDING STORE: an agent is bound only to an INSTALLED skill and a directory Claude Code already TRUSTS.
  {
    const home = '/home/u';
    const files = {
      '/home/u/.claude.json': JSON.stringify({ projects: { '/home/u/code/meshFlow': { hasTrustDialogAccepted: true }, '/home/u/code/untrusted': { hasTrustDialogAccepted: false } } }),
      '/home/u/.claude/skills/meshflow-social/SKILL.md': '---\nname: meshflow-social\n---\n'
    };
    const dirs = new Set(['/home/u/code/meshFlow', '/home/u/code/meshFlow/app', '/home/u/code/untrusted', '/home/u/code/other']);
    let saved = null;
    const fs = {
      readFileSync(f) { if (f in files) return files[f]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      existsSync(f) { return f in files || dirs.has(f); },
      statSync(f) { if (dirs.has(f)) return { isDirectory: () => true, isFile: () => false }; if (f in files) return { isDirectory: () => false, isFile: () => true }; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      realpathSync(f) { return f; }
    };
    const store = makeClaudeSkillAgents({ fs, path: path.posix, home, file: '/ws/claude-skill-agents.json', load: () => null, save: v => { saved = v; } });
    A.eq(store.set('social', { skill: 'meshflow-social', dir: '/home/u/code/meshFlow' }).ok, true, 'installed skill + trusted dir: bound');
    A.eq(store.get('social'), { skill: 'meshflow-social', dir: '/home/u/code/meshFlow' }, 'the binding reads back');
    A.eq(saved && saved.agents && saved.agents.social, { skill: 'meshflow-social', dir: '/home/u/code/meshFlow' }, 'and is saved');
    A.eq(store.set('a2', { skill: 'meshflow-social', dir: '/home/u/code/meshFlow/app' }).ok, true, 'a folder inside a trusted project is trusted (as Claude Code treats it)');
    const untrusted = store.set('a3', { skill: 'meshflow-social', dir: '/home/u/code/untrusted' });
    A.ok(!untrusted.ok && /trust/i.test(untrusted.error), 'a directory whose trust prompt was not accepted is refused');
    A.ok(!store.set('a4', { skill: 'meshflow-social', dir: '/home/u/code/other' }).ok, 'a directory Claude Code has never trusted is refused');
    const noSkill = store.set('a5', { skill: 'no-such-skill', dir: '/home/u/code/meshFlow' });
    A.ok(!noSkill.ok && /skill/i.test(noSkill.error), 'a skill that is not installed is refused');
    A.ok(!store.set('a6', { skill: '../etc', dir: '/home/u/code/meshFlow' }).ok, 'a skill name that is not a plain name is refused');
    A.ok(!store.set('a7', { skill: 'meshflow-social', dir: 'code/meshFlow' }).ok, 'a relative directory is refused');
    A.ok(!store.set('a8', { skill: 'meshflow-social', dir: '/home/u/.claude' }).ok, 'the Claude config dir is not a project');
    A.eq(store.get('a3'), null, 'a refused binding is not stored');
    // the run re-checks: trust withdrawn after binding means the step refuses instead of running untrusted
    files['/home/u/.claude.json'] = JSON.stringify({ projects: {} });
    const r = store.resolve('social');
    A.ok(r && !r.ok && /trust/i.test(r.error), 'resolve() at run time re-checks trust');
    A.eq(store.resolve('nobody'), null, 'an unbound agent resolves to null (a normal step)');
    A.eq(store.clear('social'), true, 'a binding clears');
    A.eq(store.get('social'), null, 'and is gone');
  }
  // C. THE LEAD'S TOOL: claude.skill_agent binds a crew agent by id or name; never the lead; refusals carry the reason.
  {
    const { makeClaudeSkillAgentTool } = require('../sidecar/tools/builtin/claude-skill-agent.js');
    const bound = new Map();
    const store = { list: () => Array.from(bound, ([agentId, b]) => Object.assign({ agentId }, b)), clear: id => bound.delete(id),
      set: (id, b) => b.dir === '/trusted' ? (bound.set(id, { skill: b.skill, dir: b.dir }), { ok: true, skill: b.skill, dir: b.dir }) : { ok: false, error: 'Claude Code does not trust ' + b.dir + ' yet' } };
    const roster = new Map([['agent', { name: 'NOVA' }], ['writer-1', { name: 'WRITER' }]]);
    const { tool } = makeClaudeSkillAgentTool({ store, hasAgent: id => roster.has(id), nameOf: id => (roster.get(id) || {}).name || id,
      resolveAgent: a => roster.has(a) ? a : ([...roster].find(([, r]) => r.name.toLowerCase() === a.toLowerCase()) || [''])[0], skills: () => ['meshflow-social'] });
    A.eq([tool.name, tool.capability, tool.requiresConsent], ['claude.skill_agent', 'orchestrator', true], 'a lead-only write that asks unless the crew switch is on');
    const r = await tool.run({ agent: 'writer', skill: 'meshflow-social', dir: '/trusted' });
    A.eq(JSON.parse(r.content).agentId, 'writer-1', 'the agent is found by its roster name, any case');
    A.eq(bound.get('writer-1'), { skill: 'meshflow-social', dir: '/trusted' }, 'and bound');
    const fails = async a => { try { await tool.run(a); return ''; } catch (e) { return e.message; } };
    A.ok(/trust/.test(await fails({ agent: 'WRITER', skill: 'meshflow-social', dir: '/elsewhere' })), 'the store\'s refusal reaches the lead with its reason');
    A.ok(/lead/.test(await fails({ agent: 'NOVA', skill: 'meshflow-social', dir: '/trusted' })), 'the lead itself is never bound');
    A.ok(/team\.summon/.test(await fails({ agent: 'GHOST', skill: 'meshflow-social', dir: '/trusted' })), 'an agent not on the roster: told how to create one');
    const listed = JSON.parse((await tool.run({})).content);
    A.eq([listed.bindings.length, listed.installedSkills], [1, ['meshflow-social']], 'no args lists the bindings and the installed skills');
    await tool.run({ agent: 'writer-1', clear: true });
    A.eq(bound.size, 0, 'clear unbinds');
  }

  // D. HOST WIRING (index.js): allowlisted, a bound agent's run gets no StarNet tools and carries the binding, refused off-login
  {
    const src = require('./helpers/source.js').readSidecarSource();
    const capReg = require('fs').readFileSync(path.join(__dirname, '..', 'sidecar', 'capability', 'registry.js'), 'utf8');
    A.ok(capReg.includes("capId: 'orchestrator', tool: 'claude.skill_agent', scope: 'write', requiresConsent: true"), 'claude.skill_agent is on the orchestrator allowlist (lead-only, asks)');
    A.ok(/const skillBinding = routedToOverseer \? null : claudeSkillAgents\.resolve\(agentId\);/.test(src), 'every run resolves (and re-checks) its agent\'s binding');
    A.ok(/if \(skillBinding && \(!skillBinding\.ok \|\| providerId !== 'claude-cli'\)\)/.test(src), 'a broken binding or a non-Claude provider refuses the step');
    A.ok(/const toolDefs = \(isTask && !routedToOverseer && !skillBinding\)/.test(src), 'a skill step is offered no StarNet tools');
    A.ok(/claudeSkill: skillBinding\.skill, claudeDir: skillBinding\.dir/.test(src), 'the provider request carries the skill and directory');
    A.ok(/rotationFallbacks = rotationFallbacks\.map\(f => Object\.assign\(\{\}, f, \{ provider: asSkill\(f\.provider\) \}\)\)/.test(src), 'a rotation to another Claude sign-in keeps the skill');
  }

  A.report();
})().catch(e => { console.error(e); process.exit(1); });

/* node test/claude-crew.test.js — CLAUDE CREW: parsing, spawn argv guards, and the injected-exec lifecycle. */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/claude-crew.js');

const U1 = '54946c2f-4378-4c04-a9ea-32ecbfc83752';
const U2 = 'e3453a95-f504-4de7-89cc-935357d866d9';
const RAW = JSON.stringify([
  { id: '54946c2f', cwd: '/home/u/code', kind: 'background', startedAt: 1, sessionId: U1, name: 'ops', state: 'working' },
  { pid: 9, cwd: '/home/u/code/x', kind: 'interactive', startedAt: 2, sessionId: U2, name: 'meshflow-ff', status: 'idle' },
  { kind: 'interactive', sessionId: 'not-a-uuid', status: 'busy' },
  { id: '3439187a', kind: 'background', sessionId: '3439187a-0000-4000-8000-000000000000', name: 'delta', status: 'waiting', state: 'blocked' },
  null,
]);

(async () => {
  // ---- normalizeSessions ----
  const s = C.normalizeSessions(RAW);
  A.eq(s.length, 3, 'entries without a uuid sessionId are dropped');
  A.eq([s[2].needsInput, s[2].busy], [true, false], 'blocked session needs the operator and is not busy');
  A.eq(s[0].needsInput, false, 'working session does not need input');
  A.eq(s[0].id, 'cc-' + U1, 'floor id is namespaced cc-<uuid>');
  A.ok(s[0].id.length <= 40, 'floor id fits the roster id cap');
  A.eq(s[0].busy, true, 'background state:working is busy');
  A.eq(s[0].stoppable, true, 'background session with a short id is stoppable');
  A.eq(s[1].busy, false, 'interactive status:idle is not busy');
  A.eq(s[1].shortId, null, 'interactive session has no short id');
  A.eq(s[1].stoppable, false, 'interactive session is never stoppable from the station');
  A.eq(C.normalizeSessions('garbage'), [], 'unparseable json -> empty');
  A.eq(C.normalizeSessions({}), [], 'non-array -> empty');

  // ---- parseRemoteUrl ----
  const log = '\x1b[2J/remote-control\x1b[19Gis active · https://claude.ai/code/session_01AAA\x1b[39m ... https://claude.ai/code/session_01BBB';
  A.eq(C.parseRemoteUrl(log), 'https://claude.ai/code/session_01BBB', 'last session url wins, ansi stripped');
  A.eq(C.parseRemoteUrl('/rc connecting…'), null, 'no url yet -> null');

  // ---- buildSpawnArgs ----
  const ok = C.buildSpawnArgs({ name: 'bravo', prompt: '--rm -rf; $(x)', permissionMode: 'plan' });
  A.eq(ok.ok, true, 'valid spawn builds');
  A.eq(ok.args.slice(0, 6), ['--bg', '--remote-control', 'bravo', '--name', 'bravo', '--permission-mode'], 'bg + remote control + name');
  A.eq(ok.args.slice(-2), ['--', '--rm -rf; $(x)'], 'prompt passes as one argv after --, never parsed as a flag');
  A.eq(C.buildSpawnArgs({ name: 'x' }).args.indexOf('default') > 0, true, 'permission mode defaults to default');
  A.eq(C.buildSpawnArgs({ name: 'x', prompt: '  ' }).args.indexOf('--'), -1, 'blank prompt adds no positional');
  A.eq(C.buildSpawnArgs({ name: 'x', permissionMode: 'bypassPermissions' }).ok, false, 'bypassPermissions refused');
  A.eq(C.buildSpawnArgs({ name: 'x', permissionMode: 'dontAsk' }).ok, false, 'dontAsk refused');
  A.eq(C.buildSpawnArgs({ name: '' }).ok, false, 'empty name refused');
  A.eq(C.buildSpawnArgs({ name: 'a;rm' }).ok, false, 'shell-ish name refused');
  A.eq(C.buildSpawnArgs({ name: 'x', prompt: 'y'.repeat(8001) }).ok, false, 'oversized prompt refused');
  A.eq(C.parseBackgroundId('Starting background service…\nbackgrounded · 95035ad3\n'), '95035ad3', 'short id parsed from --bg output');

  // ---- factory with a fake execFile ----
  const calls = [];
  let t = 1000, fail = null;
  const execFile = (bin, args, opts, cb) => {
    calls.push({ bin, args, cwd: opts.cwd });
    if (fail) return cb(fail, '', '');
    if (args[0] === 'agents') return cb(null, RAW, '');
    if (args[0] === '--bg') return cb(null, 'backgrounded · 0badc0de\n', '');
    if (args[0] === 'stop') return cb(null, 'stopped ' + args[1], '');
    if (args[0] === 'logs') return cb(null, 'x https://claude.ai/code/session_01ZZZ y', '');
    cb(new Error('unexpected'));
  };
  const off = C.makeClaudeCrew({ enabled: false, execFile });
  const offList = await off.list();
  A.eq([offList.enabled, calls.length], [false, 0], 'disabled: list never shells out');
  A.eq((await off.spawn({ name: 'x', cwd: '/' })).ok, false, 'disabled: spawn refused');

  const crew = C.makeClaudeCrew({ enabled: true, execFile, bin: '/opt/claude', now: () => t, isDir: p => p === '/work', minPollMs: 2500 });
  const l1 = await crew.list();
  A.eq([l1.available, l1.sessions.length, calls[0].bin], [true, 3, '/opt/claude'], 'list parses sessions via the configured bin');
  await crew.list();
  A.eq(calls.length, 1, 'list is cached inside minPollMs');
  t += 3000; await crew.list();
  A.eq(calls.length, 2, 'list refreshes after minPollMs');

  A.eq((await crew.spawn({ name: 'bravo', cwd: '/nope' })).ok, false, 'spawn refuses a non-directory cwd');
  const sp = await crew.spawn({ name: 'bravo', cwd: '/work', prompt: 'hi' });
  A.eq([sp.ok, sp.shortId], [true, '0badc0de'], 'spawn returns the background short id');
  A.eq(calls[calls.length - 1].cwd, '/work', 'spawn runs in the requested cwd');
  const n = calls.length; await crew.list();
  A.eq(calls.length, n + 1, 'spawn invalidates the list cache');

  A.eq((await crew.stop('../etc')).ok, false, 'stop refuses a malformed id');
  A.eq((await crew.stop('0badc0de')).ok, true, 'stop ok');
  const u1 = await crew.remoteUrl('0badc0de');
  A.eq(u1.url, 'https://claude.ai/code/session_01ZZZ', 'remote url scraped from logs');
  const m = calls.length; await crew.remoteUrl('0badc0de');
  A.eq(calls.length, m, 'remote url is cached per session');

  fail = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  t += 3000;
  const miss = await crew.list();
  A.eq(miss.available, false, 'missing binary -> unavailable, not a throw');
  A.ok(/not found/.test(miss.reason), 'missing binary reason is honest');


  // ---- CREW rail: Claude sessions are a display-only group, never merged into the roster `present` ----
  const fsm = require('node:fs');
  const ui = fsm.readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  const cc = fsm.readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'app', 'claude-crew.js'), 'utf8');
  A.ok(/function setExternalCrew\(list\)/.test(ui) && /setExternalCrew, leave/.test(ui), 'StationUI exposes setExternalCrew');
  A.ok(!/present\s*=\s*[^;]*externalCrew/.test(ui) && !/present\.(push|concat)\([^)]*external/.test(ui), 'external crew never merges into the roster list');
  A.ok(/crew-row crew-ext/.test(ui) && /ClaudeCrew\.open\(li\.dataset\.extId\)/.test(ui), 'rail rows open the Claude session card');
  A.ok(/StationUI\.setExternalCrew\(list\)/.test(cc) && !/pushRoster\(|summonAgent\(/.test(cc), 'claude-crew feeds the rail and never touches the App roster');


  // ---- SKILLS: catalog from SKILL.md frontmatter; a skilled launch starts with /<skill> ----
  A.eq(C.parseSkill('x', '---\nname: meshflow-social\ndescription: "Posting plans"\n---\nbody'), { name: 'meshflow-social', description: 'Posting plans' }, 'frontmatter name + description parsed');
  A.eq(C.parseSkill('dirname', 'no frontmatter'), { name: 'dirname', description: '' }, 'no frontmatter falls back to the dir name');
  A.eq(C.parseSkill('x', '---\nname: ../evil\n---'), null, 'a hostile skill name is rejected');
  const files = { '/s1/a/SKILL.md': '---\nname: alpha\ndescription: A\n---', '/s1/nope/README.md': 'x', '/s2/a/SKILL.md': '---\nname: alpha\ndescription: dup\n---', '/s2/b/SKILL.md': '---\nname: beta\n---' };
  const dirs = { '/s1': ['a', 'nope'], '/s2': ['b', 'a'] };
  const fakeFs = { readdirSync: d => { if (!dirs[d]) throw new Error('ENOENT'); return dirs[d].slice(); }, readFileSync: f => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; } };
  const sk = C.makeClaudeCrew({ enabled: true, execFile, fs: fakeFs, skillDirs: ['/s1', '/s2', '/missing'], isDir: () => true });
  A.eq(sk.listSkills().map(x => [x.name, x.description]), [['alpha', 'A'], ['beta', '']], 'skills listed across dirs; no-SKILL.md dirs skipped; first dir wins; missing dir tolerated');
  const skilled = C.buildSpawnArgs({ name: 'social', skill: 'alpha' }).args;
  A.eq(skilled[skilled.length - 1], '/alpha\n\n' + C.DEFAULT_SKILL_PROMPT, 'skill with no message: /skill + load-and-wait prompt');
  A.eq(C.buildSpawnArgs({ name: 's', skill: 'alpha', prompt: 'post today' }).args.slice(-1)[0], '/alpha\n\npost today', 'skill + message');
  A.eq(C.buildSpawnArgs({ name: 's', skill: '../x' }).ok, false, 'bad skill name refused before spawn');
  A.eq((await sk.spawn({ name: 's', skill: 'gamma', cwd: '/w' })).ok, false, 'unknown skill refused (catalog-checked)');
  A.eq(C.makeClaudeCrew({ enabled: false, fs: fakeFs, skillDirs: ['/s1'] }).listSkills(), [], 'disabled: no catalog');

  // ---- the lead's tools: claude.crew / claude.launch / claude.stop ----
  const T = require('../sidecar/tools/builtin/claude-crew.js');
  const spawned = [];
  const fakeCrew = { enabled: true, list: async () => ({ available: true, sessions: C.normalizeSessions(RAW) }),
    listSkills: () => [{ name: 'alpha', description: 'A' }],
    spawn: async b => { spawned.push(b); return b.skill === 'bad' ? { ok: false, error: 'unknown skill: bad' } : { ok: true, shortId: 'abcd1234' }; },
    stop: async id => (id === 'abcd1234' ? { ok: true } : { ok: false, error: 'bad session id' }) };
  const tools = T.makeClaudeCrewTools({ crew: fakeCrew, defaultCwd: '/home/u/code' });
  A.eq([tools.crewTool.requiresConsent, tools.launchTool.requiresConsent, tools.launchTool.scope, tools.stopTool.requiresConsent], [false, true, 'execute', true], 'listing is free; launch (execute) and stop ask first');
  const listing = JSON.parse((await tools.crewTool.run({})).content);
  A.eq([listing.sessions.length, listing.sessions[2].status, listing.skills[0].name], [3, 'needs-you', 'alpha'], 'crew listing carries status incl. needs-you, plus skills');
  const launched = await tools.launchTool.run({ name: 'social', skill: 'alpha' });
  A.eq([spawned[0].cwd, spawned[0].skill, spawned[0].permissionMode], ['/home/u/code', 'alpha', ''], 'launch defaults: station dir, station-default permission mode');
  A.ok(/launched Claude session "social" with \/alpha \(abcd1234\)/.test(launched.summary), 'launch summary names skill and id');
  let err = null; try { await tools.launchTool.run({ name: 'x', skill: 'bad' }); } catch (e) { err = e; }
  A.ok(err && /unknown skill/.test(err.message), 'a failed launch throws (never reported as done)');
  err = null; try { await T.makeClaudeCrewTools({ crew: fakeCrew }).launchTool.run({ name: 'x' }); } catch (e) { err = e; }
  A.ok(err && /no directory/.test(err.message), 'no default dir and no dir -> refused');
  A.eq((await tools.stopTool.run({ id: 'abcd1234' })).summary, 'stopped Claude session abcd1234', 'stop ok');
  err = null; try { await T.makeClaudeCrewTools({ crew: { enabled: false } }).crewTool.run({}); } catch (e) { err = e; }
  A.ok(err && /STARNET_CLAUDE_CREW/.test(err.message), 'crew off -> honest error');
  const capReg = fsm.readFileSync(require('node:path').join(__dirname, '..', 'sidecar', 'capability', 'registry.js'), 'utf8');
  A.ok(['claude.crew', 'claude.launch', 'claude.stop'].every(t => capReg.includes("capId: 'orchestrator', tool: '" + t + "'")), 'all three tools are on the orchestrator allowlist (lead-only)');


  // ---- Claude Code's own records: remote link for any kind (terminal too) + what a blocked job waits on ----
  A.eq(C.remoteUrlFromBridge('cse_016qDg'), 'https://claude.ai/code/session_016qDg', 'cse_ bridge id -> session URL');
  A.eq(C.remoteUrlFromBridge('session_01AB'), 'https://claude.ai/code/session_01AB', 'session_ bridge id -> URL');
  A.eq([C.remoteUrlFromBridge(null), C.remoteUrlFromBridge('evil/../x')], [null, null], 'no/odd bridge id -> no link (never fabricated)');
  const recFiles = {
    '/ch/sessions/100.json': JSON.stringify({ sessionId: U2, bridgeSessionId: 'session_TERM1' }),
    '/ch/sessions/200.json': '{broken',
    '/ch/jobs/3439187a/state.json': JSON.stringify({ needs: 'approve Entering worktree', detail: 'orienting', bridgeSessionId: 'cse_JOB1' }),
  };
  const recFs = { readdirSync: d => { if (d === '/ch/sessions') return ['100.json', '200.json', 'x.key']; throw new Error('ENOENT'); },
    readFileSync: f => { if (!(f in recFiles)) throw new Error('ENOENT'); return recFiles[f]; } };
  const execOk = (bin, args, opts, cb) => cb(null, args[0] === 'agents' ? RAW : '', '');   // the shared fake was switched to ENOENT above
  const rc = C.makeClaudeCrew({ enabled: true, execFile: execOk, fs: recFs, claudeHome: '/ch', now: () => 1 });
  const enriched = (await rc.list()).sessions;
  const byName = n => enriched.find(x => x.name === n);
  A.eq(byName('meshflow-ff').remoteUrl, 'https://claude.ai/code/session_TERM1', 'interactive session gets its Remote Control link from the session record');
  A.eq([byName('delta').remoteUrl, byName('delta').waitingOn], ['https://claude.ai/code/session_JOB1', 'approve Entering worktree'], 'blocked job: link + what it waits on');
  A.eq(byName('ops').waitingOn, undefined, 'a working (not blocked) session has no waitingOn');
  A.eq((await rc.remoteUrl('3439187a')).url, 'https://claude.ai/code/session_JOB1', 'remoteUrl prefers the job record over scraping logs');
  const bare = C.makeClaudeCrew({ enabled: true, execFile: execOk, now: () => 1 });
  A.eq((await bare.list()).sessions.length, 3, 'no fs/claudeHome -> listing unchanged (fail-soft)');


  // ---- station default permission mode (STARNET_CLAUDE_CREW_MODE) ----
  const modeOf = args => args[args.indexOf('--permission-mode') + 1];
  A.eq(modeOf(C.buildSpawnArgs({ name: 'x', defaultMode: 'auto' }).args), 'auto', 'unset mode takes the station default');
  A.eq(modeOf(C.buildSpawnArgs({ name: 'x', permissionMode: 'plan', defaultMode: 'auto' }).args), 'plan', 'an explicit mode beats the default');
  A.eq(modeOf(C.buildSpawnArgs({ name: 'x', defaultMode: 'bypassPermissions' }).args), 'default', 'a bypassing default is ignored -> ask');
  const autoCrew = C.makeClaudeCrew({ enabled: true, execFile: (b, args, o, cb) => { autoCrew._last = args; cb(null, 'backgrounded · 0badc0de', ''); }, isDir: () => true, defaultMode: 'auto', now: () => 1 });
  await autoCrew.spawn({ name: 'x', cwd: '/w', permissionMode: '' });
  A.eq([autoCrew.defaultMode, modeOf(autoCrew._last)], ['auto', 'auto'], 'factory default mode reaches the CLI argv');
  A.eq(C.makeClaudeCrew({ enabled: true, defaultMode: 'dontAsk' }).defaultMode, 'default', 'factory refuses a bypassing default');

  A.report();
})();

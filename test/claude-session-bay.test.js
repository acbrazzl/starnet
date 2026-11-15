/* node test/claude-session-bay.test.js - CREW-SESSION BAYS (fork, 2026-11-15): a line step that launches a REAL crew session
   through a fixed, Commander-configured launcher (the cron sweep script), waits for it, and hands its final report on.
   Every guardrail Proxima set is a refusal here. No real `claude` and no real launcher run. */
'use strict';
const A = require('node:assert/strict');
const { makeClaudeSessionBays, parseSlots, lastAssistantText } = require('../sidecar/claude-session-bays.js');

const SLOTS = { security: { run: ['/office/reviews/run-sweep.sh', 'security'], session: 'security-sweep-', capMin: 10 } };

// a fake world: a clock, the session list, job states, a launcher that "starts" a session, transcripts
function world(opts) {
  opts = opts || {};
  const w = { t: 1000, sessions: (opts.sessions || []).slice(), jobs: {}, launched: [], stopped: [], claimed: [], saved: null,
    listOk: opts.listOk !== false, day: '2026-11-16', transcript: opts.transcript || '' };
  w.crew = {
    async list() { return w.listOk ? { available: true, sessions: w.sessions.slice() } : { available: false, sessions: [] }; },
    async stop(id) { w.stopped.push(id); w.sessions = w.sessions.filter(s => s.shortId !== id); return { ok: true }; },
    claimLaunched(id, name) { w.claimed.push([id, name]); return true; }
  };
  w.execFile = (file, args, o, cb) => {
    w.launched.push([file].concat(args));
    if (opts.launcherFails) return cb(Object.assign(new Error('exit 1'), { code: 1 }), '', 'boom');
    if (!opts.noSession) {
      w.sessions.push({ shortId: 'abcd1234', sessionId: '11111111-2222-3333-4444-555555555555', name: 'security-sweep-20261116', cwd: '/m', busy: true, remoteUrl: 'https://claude.ai/code/session_X' });
      w.jobs.abcd1234 = { state: 'working', tempo: 'working' };
    }
    cb(null, 'ok', '');
  };
  // each sleep advances the clock and, on the Nth poll, moves the job to its scripted end state
  let polls = 0;
  w.sleep = async ms => { w.t += ms; polls++; if (opts.endAfter && polls === opts.endAfter && w.jobs.abcd1234) Object.assign(w.jobs.abcd1234, opts.endState); };
  w.bays = makeClaudeSessionBays(Object.assign({
    enabled: true, slots: JSON.stringify(SLOTS), crew: w.crew, execFile: w.execFile, now: () => w.t, today: () => w.day, sleep: w.sleep,
    pollMs: 60000, findMs: 30000, jobState: id => w.jobs[id] || null,
    transcriptPath: (cwd, sid) => cwd + '/' + sid + '.jsonl', readFile: () => w.transcript,
    load: () => opts.loaded || null, save: v => { w.saved = JSON.parse(JSON.stringify(v)); }
  }, opts.bayOpts || {}));
  return w;
}
const report = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Area: loopback. 2 hypotheses killed, 1 draft PR #700.' }] } });

(async () => {
  // SLOTS: only well-formed, absolute launchers; a bad env never becomes a slot
  {
    const p = parseSlots(JSON.stringify({ security: SLOTS.security, 'Bad Name': SLOTS.security, rel: { run: ['run-sweep.sh'], session: 'x-' }, nopre: { run: ['/a'] } }));
    A.deepEqual(Array.from(p.slots.keys()), ['security'], 'only the well-formed slot is kept');
    A.equal(p.errors.length, 3, 'each malformed slot is named');
    A.equal(parseSlots('{oops').slots.size, 0, 'unparsable env = no slots');
    A.equal(parseSlots('').errors.length, 0, 'no env = no slots, no error');
  }
  A.equal(lastAssistantText([report, '{"type":"user","message":{"content":"x"}}', '{partial'].join('\n')), 'Area: loopback. 2 hypotheses killed, 1 draft PR #700.', 'the final report is the last assistant text');

  // BINDING: only to a named slot, and only while bays are on
  {
    const w = world();
    A.equal(w.bays.set('analyst', 'deploy').ok, false, 'an unknown slot cannot be bound');
    A.equal(w.bays.set('analyst', 'security').ok, true, 'a named slot binds');
    A.deepEqual(w.saved.agents, { analyst: { slot: 'security' } }, 'the binding persists');
    const off = world({ bayOpts: { enabled: false } });
    A.match(off.bays.set('analyst', 'security').error, /STARNET_SESSION_BAYS=1/, 'bays off: binding refused, and the switch is named');
  }

  // REFUSALS — each launches nothing
  {
    const w = world({ bayOpts: { enabled: false } });
    const r = await w.bays.runStep('security', {});
    A.equal(r.ok, false); A.match(r.text, /REFUSED.*STARNET_SESSION_BAYS=1/, 'kill switch: refused'); A.equal(w.launched.length, 0, 'kill switch launches nothing');
  }
  {
    const w = world();
    const r = await w.bays.runStep('security', { taintedBy: 'upstream agent output' });
    A.match(r.text, /REFUSED.*untrusted text.*FIRST on its line/, 'taint lock: refused'); A.equal(w.launched.length, 0, 'a tainted run launches nothing');
  }
  {
    const w = world({ sessions: [{ shortId: 'feedf00d', name: 'security-sweep-20261116', busy: true }] });
    const r = await w.bays.runStep('security', {});
    A.match(r.text, /REFUSED.*still working.*one session per job/, 'a live sweep (e.g. cron\'s) blocks a second'); A.equal(w.launched.length, 0);
  }
  {
    const w = world({ loaded: { launches: { security: { day: '2026-11-16', shortId: 'aaaa0000', name: 'security-sweep-20261116' } } } });
    const r = await w.bays.runStep('security', {});
    A.match(r.text, /REFUSED.*already launched today.*one launch a day/, 'daily cap: refused'); A.equal(w.launched.length, 0);
  }
  {
    const w = world({ listOk: false });
    const r = await w.bays.runStep('security', {});
    A.match(r.text, /REFUSED.*unreadable/, 'an unreadable session list fails closed'); A.equal(w.launched.length, 0);
  }

  // A FULL RUN: the fixed launcher argv runs, the new session is claimed, the step waits, the report is handed on
  {
    const w = world({ endAfter: 2, endState: { tempo: 'idle', state: 'working' }, transcript: report });
    const waits = [];
    const r = await w.bays.runStep('security', { onWait: (p, n) => waits.push(n) });
    A.deepEqual(w.launched, [['/office/reviews/run-sweep.sh', 'security']], 'exactly the configured launcher argv — the hand-off never reaches it');
    A.deepEqual(w.claimed, [['abcd1234', 'security-sweep-20261116']], 'the launched session is recorded as the station\'s');
    A.equal(r.ok, true); A.equal(r.end, 'finished');
    A.match(r.text, /^SWEEP SESSION security-sweep-20261116 \(job abcd1234\) finished/, 'the outcome is said first');
    A.match(r.text, /Remote Control: https:\/\/claude\.ai\/code\/session_X/, 'with its Remote Control link');
    A.match(r.text, /1 draft PR #700/, 'and the session\'s own final report');
    A.ok(waits.some(n => /working/.test(n)), 'the wait is reported while it runs');
    A.equal(w.saved.launches.security.shortId, 'abcd1234', 'today\'s launch is recorded');
    const again = await w.bays.runStep('security', {});
    A.match(again.text, /already launched today/, 'the second run that day is refused');
  }
  // the daily launch is counted BEFORE the launcher runs: a failed launcher still spends the day
  {
    const w = world({ launcherFails: true });
    const r = await w.bays.runStep('security', {});
    A.match(r.text, /LAUNCH FAILED.*boom/, 'a failing launcher is said');
    A.equal(w.saved.launches.security.day, '2026-11-16', 'and the day is spent');
  }
  {
    const w = world({ noSession: true });
    const r = await w.bays.runStep('security', {});
    A.match(r.text, /LAUNCH UNCONFIRMED.*security-sweep-\*/, 'no new session appearing is said, not guessed');
  }
  // WALL-CLOCK CAP: the station stops the session it launched
  {
    const w = world({ transcript: report });
    const r = await w.bays.runStep('security', {});
    A.equal(r.end, 'capped'); A.deepEqual(w.stopped, ['abcd1234'], 'the capped session is stopped');
    A.match(r.text, /STOPPED at the 10-minute wall-clock cap/);
  }
  // WAITING ON THE COMMANDER: the step ends and says what the session waits on
  {
    const w = world({ endAfter: 1, endState: { tempo: 'blocked', needs: 'approve Bash: git push' } });
    const r = await w.bays.runStep('security', {});
    A.equal(r.end, 'needs-you'); A.match(r.text, /WAITING ON THE COMMANDER: approve Bash: git push/);
    A.equal(w.stopped.length, 0, 'a waiting session is never stopped');
  }
  // a cancelled line run leaves the session to finish (never kills real work)
  {
    const w = world();
    const ac = new AbortController();
    w.sleep = async ms => { w.t += ms; ac.abort(); };
    const bays = makeClaudeSessionBays({ enabled: true, slots: SLOTS, crew: w.crew, execFile: w.execFile, now: () => w.t, today: () => w.day,
      sleep: w.sleep, pollMs: 60000, jobState: id => w.jobs[id] || null });
    const r = await bays.runStep('security', { signal: ac.signal });
    A.equal(r.end, 'left-running'); A.equal(w.stopped.length, 0, 'cancel does not stop the session');
  }
  // WIRING (index.js): a session step calls no model, is offered no tools and never falls back to one; the tool always asks
  {
    const src = require('./helpers/source.js').readSidecarSource();
    const capReg = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidecar', 'capability', 'registry.js'), 'utf8');
    A.ok(capReg.includes("capId: 'orchestrator', tool: 'claude.session_agent', scope: 'write', requiresConsent: true"), 'claude.session_agent is lead-only and asks');
    A.ok(!/AUTO_BUILD_CREW_TOOLS = new Set\([^)]*claude\.session_agent/.test(src), 'binding a session slot is never on an AUTO-BUILD list');
    A.ok(/const sessionBinding = routedToOverseer \? null : claudeSessionBays\.resolve\(agentId\);/.test(src), 'every run resolves its session binding');
    A.ok(/const toolDefs = \(isTask && !routedToOverseer && !skillBinding && !sessionBinding\)/.test(src), 'a session step is offered no StarNet tools');
    A.ok(/const fallbacks = sessionBinding \? \[\] :/.test(src), 'a session step never falls back to a model');
    A.ok(/taintedBy: execution\.taintedBy\(\)/.test(src), 'the run\'s taint reaches the launch check');
    A.ok(/enabled: \/\^\(1\|true\|yes\|on\)\$\/i\.test\(String\(ENV\('SESSION_BAYS'\)/.test(src), 'off unless STARNET_SESSION_BAYS=1');
  }
  console.log('claude-session-bay: ok');
})().catch(e => { console.error(e); process.exit(1); });

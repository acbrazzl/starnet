/* node test/overseer-session.test.js — the Overseer as one persistent Claude Code session: start/resume argv,
   typing a turn through the attach PTY, reading the reply from the transcript, the cleaning rule, stop. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const S = require('../sidecar/overseer-session.js');

(async () => {
  // ---- pure helpers ----
  A.eq(S.cwdSlug('/home/u/code/meshFlow'), '-home-u-code-meshFlow', 'transcript dir slug matches Claude Code\'s');
  A.eq([S.windowFor('opus[1m]'), S.windowFor('sonnet'), S.windowFor('--model opus')], [1000000, 200000, 200000], 'context window from the model');
  A.eq([S.sessionModel('opus'), S.sessionModel('sonnet'), S.sessionModel('opus[1m]')], ['opus[1m]', 'sonnet', 'opus[1m]'], 'the Overseer launches Opus with the 1M window, like the Commander\'s sessions');
  A.eq(S.isRealUserTurn({ type: 'user', message: { content: 'hello' } }), true, 'typed text is a real user turn');
  A.eq(S.isRealUserTurn({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }), false, 'a tool result is not');
  A.eq(S.isRealUserTurn({ type: 'user', message: { content: '<command-name>/compact</command-name>' } }), false, 'a slash-command echo is not');
  A.eq(S.isRealUserTurn({ type: 'user', isCompactSummary: true, message: { content: 'summary' } }), false, 'a compaction summary is not');

  // ---- a fake Claude Code: bg launch, agents listing, attach PTY that "answers" into a real transcript file ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovs-'));
  const home = path.join(root, 'claude'), ws = path.join(root, 'ws'), cwd = '/w/meshFlow';
  fs.mkdirSync(ws, { recursive: true });
  const sid = 'abcd1234-0000-4000-8000-000000000000';
  const tdir = path.join(home, 'projects', S.cwdSlug(cwd)); fs.mkdirSync(tdir, { recursive: true });
  const tfile = path.join(tdir, sid + '.jsonl');
  fs.writeFileSync(tfile, JSON.stringify({ type: 'user', message: { content: 'old history' } }) + '\n');
  fs.mkdirSync(path.join(home, 'jobs', 'abcd1234'), { recursive: true });
  fs.writeFileSync(path.join(home, 'jobs', 'abcd1234', 'state.json'), JSON.stringify({ sessionId: sid, state: 'idle' }));
  const calls = []; let running = false; const typed = [];
  const line = o => fs.appendFileSync(tfile, JSON.stringify(o) + '\n');
  const execFile = (bin, args, opts, cb) => {
    calls.push(args);
    if (args[0] === '--bg') { running = true; return cb(null, 'Starting…\nbackgrounded · abcd1234\n', ''); }
    if (args[0] === 'agents') return cb(null, JSON.stringify(running ? [{ id: 'abcd1234' }] : []), '');
    cb(null, '', '');
  };
  const spawnPty = () => {
    let buf = '';
    return { onExit() {}, kill() {}, write(d) {
      if (d !== '\r') { buf += d; return; }
      const msg = buf.replace(/\x1b\[20[01]~/g, ''); buf = ''; typed.push(msg);
      if (msg === '/compact') { line({ type: 'user', message: { content: '<command-name>/compact</command-name>' } }); return; }
      // someone ELSE typed in the Claude app first — must not be mistaken for our turn
      line({ type: 'user', message: { content: 'from the app: status?' } });
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'app reply' }], stop_reason: 'end_turn' } });
      line({ type: 'user', message: { content: msg } });
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git status' } }], stop_reason: 'tool_use' } });
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'On branch dev.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 150000, output_tokens: 5 } } });
    } };
  };
  const events = []; let t = 1000;
  const mk = over => S.makeOverseerSession(Object.assign({ enabled: true, execFile, spawnPty, fs, path, now: () => t, stateDir: ws, claudeHome: home, cwd,
    name: () => 'PROXIMA', model: () => 'sonnet', permissionMode: 'bypassPermissions', appendPrompt: () => 'You are PROXIMA.', onActivity: (k, p) => events.push([k, p.name || p.callId]) }, over || {}));

  // first boot: fresh session, Remote Control, the Commander's mode, appended role; no opening prompt
  const ov = mk();
  const st = await ov.start();
  const launch = calls.find(a => a[0] === '--bg');
  A.eq(st.ok, true, 'session starts');
  A.eq([launch.includes('--remote-control'), launch[launch.indexOf('--remote-control') + 1], launch[launch.indexOf('--permission-mode') + 1]], [true, 'proxima', 'bypassPermissions'], 'bg + Remote Control named after the Overseer, station permission mode');
  A.eq(launch[launch.indexOf('--append-system-prompt') + 1], 'You are PROXIMA.', 'the Overseer role is APPENDED to Claude Code\'s own prompt');
  A.ok(!launch.includes('--') && !launch.includes('--resume'), 'fresh start: no resume, no opening prompt');
  A.eq(JSON.parse(fs.readFileSync(path.join(ws, 'overseer-session.json'), 'utf8')).sessionId, sid, 'session id persisted for the next boot');

  // a turn: typed through the PTY; OUR reply is read from the transcript even though the app spoke first
  const got = [];
  const origSetTimeout = global.setTimeout; global.setTimeout = (fn, ms) => origSetTimeout(fn, Math.min(ms, 5));   // no real 4s TUI wait in tests
  for await (const x of ov.ask('Which branch?')) got.push(x);
  global.setTimeout = origSetTimeout;
  A.eq(typed, ['Which branch?'], 'the message is typed into the session as a user turn');
  A.eq(got.filter(x => x.text).map(x => x.text), ['On branch dev.'], 'only OUR turn\'s reply comes back (not the app\'s)');
  A.eq(got[got.length - 1].done, true, 'the turn ends on end_turn');
  A.ok(events.some(e => e[0] === 'tool_call' && e[1] === 'Bash') && events.some(e => e[0] === 'tool_result'), 'tool activity is surfaced for the floor');

  // multi-line text is one bracketed paste
  const typedRaw = [];
  const ov2 = mk({ spawnPty: () => ({ onExit() {}, kill() {}, write: d => typedRaw.push(d) }) });
  await ov2.start();
  const it = ov2.ask('line one\nline two')[Symbol.asyncIterator]();
  global.setTimeout = (fn, ms) => origSetTimeout(fn, Math.min(ms, 5));
  const pending = it.next(); await new Promise(r => origSetTimeout(r, 60)); global.setTimeout = origSetTimeout;
  A.eq(typedRaw.slice(0, 2), ['\x1b[200~line one\nline two\x1b[201~', '\r'], 'multi-line message pasted as one message');
  void pending;

  // an aborted StarNet run: a dropped connection detaches; only an explicit stop sends Esc
  const escs = [];
  const quiet = mk({ spawnPty: () => ({ onExit() {}, kill() {}, write: d => escs.push(d) }) });
  await quiet.start();
  for (const [label, explicit] of [['connection drop', false], ['explicit stop', true]]) {
    escs.length = 0;
    const ac = new AbortController();
    const g = quiet.ask('long task', { signal: ac.signal, interruptOnAbort: () => explicit })[Symbol.asyncIterator]();
    global.setTimeout = (fn, ms) => origSetTimeout(fn, Math.min(ms, 5));
    const nx = g.next(); await new Promise(r => origSetTimeout(r, 40)); ac.abort(); await nx; global.setTimeout = origSetTimeout;
    A.eq(escs.includes('\x1b'), explicit, label + (explicit ? ' interrupts the Overseer (Esc)' : ' does NOT interrupt the Overseer'));
  }

  // cleaning rule: first check starts the daily clock; >70% of the window compacts when idle
  typed.length = 0;
  await ov.maintenance();
  A.eq(typed, [], 'first maintenance only starts the daily clock');
  await ov.maintenance();
  A.eq(typed, ['/compact'], 'context past 70% of the window (150k of 200k) -> /compact');
  typed.length = 0; await ov.maintenance();
  A.eq(typed, [], 'not again right after compacting');
  t += 25 * 3600 * 1000; await ov.maintenance();
  A.eq(typed, ['/compact'], 'daily compaction when idle');

  // second boot: resume the SAME conversation (session still running -> reuse; stopped -> --resume)
  running = false; calls.length = 0;
  const ov3 = mk();
  await ov3.start();
  const relaunch = calls.find(a => a[0] === '--bg');
  A.eq(relaunch[relaunch.indexOf('--resume') + 1], sid, 'the next boot resumes the saved conversation');
  running = true; calls.length = 0;
  const ov4 = mk(); const r4 = await ov4.start();
  A.eq([r4.reused, calls.some(a => a[0] === '--bg')], [true, false], 'a session still running is reused, not duplicated');
  running = false; calls.length = 0;
  await mk({ fresh: true }).start();
  A.ok(!calls.find(a => a[0] === '--bg').includes('--resume'), 'STARNET_OVERSEER_SESSION_FRESH starts clean');

  // StarNet shutdown stops the session; ownsSession lets the crew list exclude it
  const stopped = [];
  ov.stopSync((bin, args) => stopped.push(args));
  A.eq(stopped, [['stop', 'abcd1234']], 'StarNet shutdown stops the session');
  const kept = [];
  const ka = mk({ keepAlive: true }); await ka.start();
  ka.stopSync((bin, args) => kept.push(args));
  A.eq(kept, [], 'keep-alive: StarNet shutdown detaches and leaves the session running (same Remote Control link)');
  A.eq([ov.ownsSession(sid, null), ov.ownsSession('x', 'abcd1234'), ov.ownsSession('x', 'y')], [true, true, false], 'the crew list can tell the Overseer\'s own session apart');
  A.eq((await S.makeOverseerSession({ enabled: false }).start()).ok, false, 'disabled: never launches');

  fs.rmSync(root, { recursive: true, force: true });
  A.report('overseer-session.test');
})().catch(e => { console.error(e); process.exit(1); });

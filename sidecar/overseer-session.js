/* sidecar/overseer-session.js — the Overseer as ONE persistent Claude Code session (opt-in: STARNET_OVERSEER_SESSION=1).

   WHY. The per-turn claude-cli brain is a fresh `claude -p` every reply with the conversation pasted in as a
   transcript and StarNet's jailed tools — nothing like the continuous Claude Code session the Commander uses at
   their own terminal. This runs the Overseer as a REAL background Claude Code session instead:
     · `claude --bg --remote-control <name>`  → it is a normal session: visible and drivable in the Claude app
                                                (Remote Control) and attachable from a terminal (`claude attach`);
     · full Claude Code: the Commander's settings, skills, CLAUDE.md, auto-memory, tools and subagents, in
       STARNET_CLAUDE_CREW_DIR, with the station's crew permission mode (the Commander's policy);
     · the Overseer's role/standing orders are APPENDED to Claude Code's own prompt (--append-system-prompt).

   HOW STARNET TALKS TO IT. StarNet is just one more screen on the same session, exactly like the app or a
   terminal:
     · IN:  a long-lived `claude attach <id>` in a PTY; a COMMS message is typed (bracketed paste + Enter), so it
            lands as a genuine user turn — proven: the transcript records it as an ordinary user message;
     · OUT: the session's own transcript (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl) is tailed; assistant
            text streams back into COMMS, tool_use/tool_result entries animate the floor, and an assistant entry
            with stop_reason end_turn closes the turn.
   Messages typed in the app or a terminal land in the same session; StarNet sees them in the transcript.

   LIFECYCLE. Started at sidecar boot, stopped in gracefulShutdown (`claude stop`), so it lives as long as StarNet.
   The session id is persisted, so the next boot RESUMES the same conversation (`--resume`) — a restart does not
   wipe the Overseer (STARNET_OVERSEER_SESSION_FRESH=1 starts clean instead).

   CLEANING (the Commander's rule): compact when the context passes ~70% of the model's window, and once a day
   while idle; never mid-turn. Compaction is Claude Code's own `/compact`, typed like any command.

   Injected deps (spawnPty, execFile, fs, path, now, setInterval) keep this unit-testable; index.js wires the
   real ones. Every read of Claude Code's files is fail-soft: they are undocumented internals. */
'use strict';

const STATE_FILE = 'overseer-session.json';
const COMPACT_AT = 0.70;
const DAILY_MS = 24 * 3600 * 1000;
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;

function cwdSlug(cwd) { return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'); }
function windowFor(model) { return /\[1m\]/i.test(String(model || '')) ? 1000000 : 200000; }
/* The station stores the brain as a plain alias ('opus'); the Commander's own sessions run Opus with the 1M window
   ('opus[1m]'). Launch the Overseer the same way, so its window — and the 70% cleaning rule — match reality. */
function sessionModel(model) { const m = String(model || '').trim(); return m === 'opus' ? 'opus[1m]' : m; }
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
}
/* a user entry the Commander (or StarNet) actually typed — not a tool result, meta note, command echo or summary */
function isRealUserTurn(j) {
  if (!j || j.type !== 'user' || !j.message || j.isMeta || j.isCompactSummary) return false;
  const c = j.message.content;
  if (Array.isArray(c) && c.some(x => x && x.type === 'tool_result')) return false;
  const t = textOf(c);
  return !!t && !/^<(command-name|local-command|command-message)/.test(t.trim());
}

function makeOverseerSession(o) {
  const enabled = !!o.enabled;
  const execFile = o.execFile;
  const spawnPty = o.spawnPty;                   // (bin, args, opts) -> { write, kill, onData, onExit }
  const fs = o.fs, path = o.path;
  const bin = o.bin || 'claude';
  const now = typeof o.now === 'function' ? o.now : () => 0;
  const stateDir = String(o.stateDir || '');
  const claudeHome = String(o.claudeHome || '');
  const cwd = String(o.cwd || '');
  const nameNow = () => String((typeof o.name === 'function' ? o.name() : o.name) || 'overseer').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || 'overseer';
  const mode = String(o.permissionMode || 'default');
  const fresh = !!o.fresh;
  // KEEP-ALIVE: StarNet shutting down only DETACHES — the session keeps running, so the next boot reattaches to the
  // SAME session and its Remote Control link does not change. (A `claude remote-control --session-id` reattach does
  // not apply to --bg sessions — verified; so a stopped session always comes back with a new link.)
  const keepAlive = !!o.keepAlive;
  const appendPrompt = typeof o.appendPrompt === 'function' ? o.appendPrompt : () => '';
  const log = typeof o.log === 'function' ? o.log : () => {};
  const onActivity = typeof o.onActivity === 'function' ? o.onActivity : () => {};   // (kind, payload): tool activity for the floor

  let state = { shortId: null, sessionId: null, lastCompactAt: 0 };
  let pty = null, ptyReady = null, starting = null;
  let offset = 0;                                 // bytes of the transcript already consumed
  let lastUsage = 0, busy = false;
  const waiters = [];                             // turn listeners: { onEntry(j) }

  function readState() {
    try { state = Object.assign(state, JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE), 'utf8'))); } catch (_) { state.shortId = state.shortId || null; }   // first run: no state yet
  }
  function saveState() {
    try { fs.writeFileSync(path.join(stateDir, STATE_FILE), JSON.stringify(state, null, 2)); } catch (e) { log('overseer-session: could not persist state: ' + e.message); }
  }
  function run(args, opts) {
    return new Promise(resolve => execFile(bin, args, Object.assign({ timeout: 60000, windowsHide: true, maxBuffer: 4 << 20 }, opts || {}),
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })));
  }
  function jobState(id) {
    try { return JSON.parse(fs.readFileSync(path.join(claudeHome, 'jobs', id, 'state.json'), 'utf8')); } catch (_) { return null; }
  }
  function transcriptPath() {
    return state.sessionId ? path.join(claudeHome, 'projects', cwdSlug(cwd), state.sessionId + '.jsonl') : null;
  }
  async function isRunning(id) {
    const r = await run(['agents', '--json']);
    if (r.err) return false;
    try { return JSON.parse(r.stdout).some(s => s && s.id === id); } catch (_) { return false; }
  }

  /* start() — reuse a still-running session, resume the saved one, or start fresh. Idempotent. */
  function start() {
    if (!enabled) return Promise.resolve({ ok: false, error: 'overseer session disabled' });
    if (starting) return starting;
    starting = (async () => {
      readState();
      if (state.shortId && await isRunning(state.shortId)) { await afterStart(); return { ok: true, reused: true, id: state.shortId }; }
      const name = nameNow();
      const model = typeof o.model === 'function' ? o.model() : o.model;
      const args = ['--bg', '--remote-control', name, '--name', name, '--permission-mode', mode];
      if (model) args.push('--model', sessionModel(model));
      const extra = String(appendPrompt() || '').trim();
      if (extra) args.push('--append-system-prompt', extra);
      if (state.sessionId && !fresh) args.push('--resume', state.sessionId);
      // no opening prompt: the session starts (or resumes) idle, so the first thing it hears is the Commander
      const r = await run(args, { cwd });
      const m = (r.stdout || '').replace(ANSI_RE, '').match(/backgrounded\s*\S*\s*([0-9a-f]{8})/);
      if (r.err || !m) { starting = null; return { ok: false, error: (r.stderr || r.stdout || (r.err && r.err.message) || 'launch failed').trim().slice(0, 300) }; }
      state.shortId = m[1];
      const js = jobState(state.shortId);
      state.sessionId = (js && js.sessionId) || state.sessionId;
      saveState();
      await afterStart();
      log('overseer-session: ' + name + ' running as ' + state.shortId + ' (session ' + String(state.sessionId).slice(0, 8) + ')');
      return { ok: true, id: state.shortId };
    })();
    return starting;
  }
  async function afterStart() {
    const js = jobState(state.shortId);
    if (js && js.sessionId && js.sessionId !== state.sessionId) { state.sessionId = js.sessionId; saveState(); }
    const tp = transcriptPath();
    try { offset = tp ? fs.statSync(tp).size : 0; } catch (_) { offset = 0; }   // only NEW activity streams to StarNet
  }

  /* the PTY attach is StarNet's keyboard on the session */
  function attach() {
    if (pty) return ptyReady;
    pty = spawnPty(bin, ['attach', state.shortId], { name: 'xterm-256color', cols: 160, rows: 48, cwd });
    pty.onExit(() => { pty = null; ptyReady = null; });
    ptyReady = new Promise(r => setTimeout(r, 4000));   // the TUI needs a moment to render before it takes input
    return ptyReady;
  }
  async function type(text) {
    await attach();
    const t = String(text);
    // bracketed paste keeps a multi-line message ONE message; Enter submits it
    pty.write(t.includes('\n') ? '\x1b[200~' + t + '\x1b[201~' : t);
    await new Promise(r => setTimeout(r, 300));
    pty.write('\r');
  }

  /* poll(): consume new transcript lines, notify waiters, track usage/busy, animate the floor */
  function poll() {
    const tp = transcriptPath();
    if (!tp) return;
    let size = 0;
    try { size = fs.statSync(tp).size; } catch (_) { return; }
    if (size < offset) offset = 0;                // rotated/rewritten: re-read from the start
    if (size === offset) return;
    let chunk = '';
    try {
      const fd = fs.openSync(tp, 'r'); const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd); chunk = buf.toString('utf8');
    } catch (_) { return; }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) return;                       // wait for a complete line
    offset += Buffer.byteLength(chunk.slice(0, lastNl + 1));
    for (const line of chunk.slice(0, lastNl).split('\n')) {
      let j; try { j = JSON.parse(line); } catch (_) { continue; }
      if (j.type === 'assistant' && j.message) {
        const u = j.message.usage || {};
        const tot = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (tot) lastUsage = tot;
        busy = j.message.stop_reason !== 'end_turn';
        for (const c of j.message.content || []) if (c && c.type === 'tool_use') onActivity('tool_call', { callId: c.id, name: c.name, args: c.input });
      }
      if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
        for (const c of j.message.content) if (c && c.type === 'tool_result') onActivity('tool_result', { callId: c.tool_use_id, ok: !c.is_error });
      }
      if (isRealUserTurn(j)) busy = true;
      for (const w of waiters.slice()) { try { w(j); } catch (e) { log('overseer-session waiter: ' + e.message); } }
    }
  }

  /* ask(text, { signal }) -> async iterable of { text } | { done, usage } — one COMMS turn */
  async function* ask(text, opts) {
    const signal = opts && opts.signal;
    const st = await start();
    if (!st.ok) throw new Error('Overseer session unavailable: ' + st.error);
    poll();                                       // flush anything already written so our turn starts clean
    const queue = []; let wake = null, seenUser = false, finished = false;
    const push = x => { queue.push(x); if (wake) { wake(); wake = null; } };
    // OUR turn is the real user turn carrying OUR text — not merely the next one (the Commander may be typing in the
    // Claude app at the same moment). A long paste can be stored differently, so after 20s any real user turn counts.
    const probe = String(text).trim().slice(0, 60);
    const askedAt = now();
    const waiter = j => {
      if (finished) return;
      if (!seenUser) {
        if (isRealUserTurn(j) && (textOf(j.message.content).includes(probe) || now() - askedAt > 20000)) seenUser = true;
        return;
      }
      if (j.type === 'assistant' && j.message) {
        const t = textOf(j.message.content);
        if (t) push({ text: t });
        if (j.message.stop_reason === 'end_turn' || j.message.stop_reason === 'stop_sequence') { finished = true; push({ done: true, usage: j.message.usage || null }); }
      }
    };
    waiters.push(waiter);
    const timer = setInterval(poll, 400);
    try {
      await type(text);
      while (true) {
        if (signal && signal.aborted) { if (pty) pty.write('\x1b'); break; }   // Esc interrupts the turn, like a human would
        if (queue.length) { const x = queue.shift(); yield x; if (x.done) break; continue; }
        await new Promise(r => { wake = r; setTimeout(r, 1000); });
      }
    } finally {
      clearInterval(timer);
      const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1);
    }
  }

  /* maintenance(): the cleaning rule — never mid-turn */
  async function maintenance() {
    if (!enabled || !state.shortId) return;
    poll();
    const js = jobState(state.shortId);
    const idle = !busy && !(js && (js.tempo === 'active' || js.state === 'working'));
    if (!idle) return;
    const full = lastUsage > COMPACT_AT * (o.contextWindow || windowFor((js && (js.respawnFlags || []).join(' ')) || sessionModel(typeof o.model === 'function' ? o.model() : o.model)));
    const daily = state.lastCompactAt && (now() - state.lastCompactAt) > DAILY_MS;
    if (!state.lastCompactAt) { state.lastCompactAt = now(); saveState(); return; }   // start the daily clock
    if (full || daily) {
      log('overseer-session: compacting (' + (full ? 'context ' + lastUsage + ' tokens' : 'daily') + ')');
      await type('/compact');
      state.lastCompactAt = now(); lastUsage = 0; saveState();
    }
  }

  /* stopSync(): called from gracefulShutdown — StarNet down ⇒ the Overseer session stops (its conversation is kept). */
  function stopSync(execFileSync) {
    if (!state.shortId) return;
    try { if (pty) pty.kill(); } catch (_) { pty = null; }   // already gone
    if (keepAlive) { log('overseer-session: detached; ' + state.shortId + ' keeps running (keep-alive)'); return; }
    // bounded to fit inside gracefulShutdown's 3s deadline
    try { execFileSync(bin, ['stop', state.shortId], { timeout: 2500, stdio: 'ignore' }); } catch (e) { log('overseer-session stop: ' + e.message); }
  }

  function status() { return { enabled, keepAlive, name: nameNow(), shortId: state.shortId, sessionId: state.sessionId, busy, contextTokens: lastUsage, lastCompactAt: state.lastCompactAt || null }; }
  function ownsSession(sessionId, shortId) { return !!((state.sessionId && sessionId === state.sessionId) || (state.shortId && shortId === state.shortId)); }

  return { start, ask, poll, maintenance, stopSync, status, ownsSession, enabled };
}

module.exports = { makeOverseerSession, isRealUserTurn, textOf, cwdSlug, windowFor, sessionModel };

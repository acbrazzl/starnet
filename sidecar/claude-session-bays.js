'use strict';

/* sidecar/claude-session-bays.js — CREW-SESSION BAYS (fork, 2026-11-15): a line step that IS a real Claude Code crew session.
 *
 * WHY. A crew-skill bay (claude-skill-agents.js) runs one read-only `claude -p` turn: it can read and draft, never do the
 * work. Some of the Commander's workflows ARE the work — the periodic security and quality sweeps take an area, prove or kill
 * hypotheses, open draft PRs and report to Proxima. The Commander (2026-11-15): "wouldn't we want the sweep themselves to be a
 * workflow?" A session bay makes the line LAUNCH that work instead of digesting it afterwards.
 *
 * WHAT IT RUNS — ONLY a named SLOT the Commander configured, never a command a model wrote. Slots come from the env
 * (STARNET_SESSION_BAY_SLOTS, JSON) and each names a fixed launcher argv plus the session-name prefix it produces:
 *     { "security": { "run": ["/home/…/reviews/run-sweep.sh", "security"], "session": "security-sweep-", "capMin": 180 } }
 * The launcher is the SAME script cron already runs, so a line-launched sweep is indistinguishable from a cron one (same
 * name, worktree/branch scheme, brief and permission mode — Proxima's condition, 2026-11-15). The step's hand-off text is
 * NEVER passed to the session: the brief is fixed in the launcher, so nothing upstream can steer it.
 *
 * GUARDRAILS (Proxima, 2026-11-15), each a refusal with its reason, checked at every step:
 *   off by default ............ STARNET_SESSION_BAYS=1 (the kill switch is unsetting it); unknown slot = refused
 *   taint lock ................ a run that was handed or has read untrusted text never launches (put the bay FIRST on its line)
 *   one session per job ....... refused while a session with the slot's prefix is still working
 *   at most one launch a day .. per slot, recorded BEFORE the launch so a failed identification still counts
 *   wall-clock cap ............ capMin (default 180): the station stops the session it launched and says so
 *   recorded .................. the launched job id goes into claude-crew.managed.json (launched) like any station launch
 *
 * OUTPUT. The step's text is the session's own final report (its last assistant text), with its name, job id, how it ended
 * and its Remote Control link — so the next bay (a digest/judge) and the outbox see what the sweep found.
 *
 * Injected everything (lint-determinism: no clock here — `now` and `today` come from index.js).
 */

const SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PREFIX_RE = /^[A-Za-z0-9._-]{1,32}$/;
const REPORT_MAX = 6000;
// the ONE token a parameterised slot passes to its launcher (a design name): plain name characters only, no path
const ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
// a status file that carries any decimal number or a millimetre unit is WITHHELD, never forwarded (part geometry must
// never leave the CAD area — belt and braces on top of the skill's own fixed headings)
const GEOMETRY_RE = /\d*\.\d+|\bmm\b|\dmm\b/i;

/* jobArg(text) -> the design name from a job "Reconstruct <DESIGN>" or "<DESIGN>", else null. Exactly one token. */
function jobArg(text) {
  const m = String(text == null ? '' : text).trim().match(/^(?:reconstruct\s+)?(\S+)$/i);
  return m && ARG_RE.test(m[1]) ? m[1] : null;
}

/* parseSlots(raw) -> { slots: Map<name, {run, session, capMin}>, errors: [] }. raw = the env JSON (string) or an object. */
function parseSlots(raw, isAbs) {
  const abs = typeof isAbs === 'function' ? isAbs : p => String(p).startsWith('/');
  const slots = new Map(), errors = [];
  let obj = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { slots, errors };
    try { obj = JSON.parse(raw); } catch (e) { return { slots, errors: ['STARNET_SESSION_BAY_SLOTS is not JSON: ' + e.message] }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { slots, errors: obj == null ? [] : ['STARNET_SESSION_BAY_SLOTS must be an object of slots'] };
  for (const [name, s] of Object.entries(obj)) {
    if (!SLOT_RE.test(name)) { errors.push('slot "' + name + '": a slot name is lowercase letters, digits and -'); continue; }
    const run = s && Array.isArray(s.run) ? s.run.map(String) : null;
    if (!run || !run.length || !abs(run[0])) { errors.push('slot "' + name + '": run must be an argv whose first item is an absolute launcher path'); continue; }
    const session = String((s && s.session) || '');
    if (!PREFIX_RE.test(session)) { errors.push('slot "' + name + '": session must be the session-name prefix the launcher produces'); continue; }
    const capMin = Number(s.capMin) > 0 ? Math.min(Number(s.capMin), 24 * 60) : 180;
    // CAD-shaped options (2026-11-15, Proxima): one checked parameter, busy guards, a memory floor, a status-file report
    if (s.arg != null && s.arg !== 'design') { errors.push('slot "' + name + '": arg can only be "design"'); continue; }
    const busyPrefixes = Array.isArray(s.busyPrefixes) ? s.busyPrefixes.map(String) : [];
    if (busyPrefixes.some(p => !PREFIX_RE.test(p))) { errors.push('slot "' + name + '": busyPrefixes must be session-name prefixes'); continue; }
    const busyProcess = s.busyProcess == null ? '' : String(s.busyProcess);
    if (busyProcess && !/^[A-Za-z0-9._-]{3,64}$/.test(busyProcess)) { errors.push('slot "' + name + '": busyProcess must be a plain program name'); continue; }
    const minAvailGB = Number(s.minAvailGB) > 0 ? Number(s.minAvailGB) : 0;
    const report = s.report === 'statusFile' ? 'statusFile' : 'session';
    const statusFile = report === 'statusFile' ? String(s.statusFile || '') : '';
    if (report === 'statusFile' && (!abs(statusFile) || statusFile.indexOf('{arg}') < 0 || !s.arg)) { errors.push('slot "' + name + '": a statusFile report needs arg and an absolute statusFile path containing {arg}'); continue; }
    const label = /^[A-Z][A-Z0-9 -]{0,31}$/.test(String(s.label || '')) ? String(s.label) : 'SWEEP SESSION';
    slots.set(name, { run, session, capMin, arg: s.arg || null, busyPrefixes, busyProcess, minAvailGB, report, statusFile, label });
  }
  return { slots, errors };
}

/* lastAssistantText(jsonlText) — the session's final report: the text of the last assistant entry that has any. */
function lastAssistantText(jsonl) {
  const lines = String(jsonl || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    let j = null;
    try { j = JSON.parse(l); } catch (_) { continue; }   // a partial last line while the CLI is writing
    if (!j || j.type !== 'assistant' || !j.message) continue;
    const c = j.message.content;
    const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n') : '');
    if (text.trim()) return text.trim();
  }
  return '';
}

function makeClaudeSessionBays(o) {
  o = o || {};
  const enabled = !!o.enabled;
  const { slots, errors: slotErrors } = parseSlots(o.slots == null ? '' : o.slots, o.isAbs);
  const crew = o.crew;                                   // claude-crew.js: list(), stop(shortId), claimLaunched(shortId, name)
  const execFile = o.execFile;
  const readFile = typeof o.readFile === 'function' ? o.readFile : () => null;   // (absPath) -> text | null
  const transcriptPath = typeof o.transcriptPath === 'function' ? o.transcriptPath : () => null;   // (cwd, sessionId) -> path
  const jobState = typeof o.jobState === 'function' ? o.jobState : () => null;   // (shortId) -> state.json object | null
  const now = typeof o.now === 'function' ? o.now : () => 0;
  const today = typeof o.today === 'function' ? o.today : () => '';
  const procList = typeof o.procList === 'function' ? o.procList : () => null;   // -> [cmdline strings] | null (unreadable)
  const availGB = typeof o.availGB === 'function' ? o.availGB : () => null;      // -> number | null (unreadable)
  const sleep = typeof o.sleep === 'function' ? o.sleep : (ms => new Promise(r => setTimeout(r, ms)));
  const pollMs = Number(o.pollMs) > 0 ? Number(o.pollMs) : 15000;
  const findMs = Number(o.findMs) > 0 ? Number(o.findMs) : 90000;
  const launchTimeoutMs = Number(o.launchTimeoutMs) > 0 ? Number(o.launchTimeoutMs) : 120000;
  const save = typeof o.save === 'function' ? o.save : () => {};
  const loaded = typeof o.load === 'function' ? (o.load() || {}) : {};
  const agents = new Map(Object.entries((loaded && loaded.agents) || {}).filter(([, b]) => b && typeof b.slot === 'string').map(([id, b]) => [String(id), { slot: String(b.slot) }]));
  const launches = Object.assign({}, (loaded && loaded.launches) || {});   // slot -> { day, shortId, name, at }
  const persist = () => { const a = {}; for (const [id, b] of agents) a[id] = { slot: b.slot }; save({ agents: a, launches }); };

  function checkSlot(slot) {
    if (!enabled) return { ok: false, error: 'session bays are off on this station (the Commander turns them on with STARNET_SESSION_BAYS=1)' };
    const s = slots.get(String(slot || ''));
    if (!s) return { ok: false, error: 'no session slot named "' + String(slot || '') + '" — the slots are ' + (slots.size ? Array.from(slots.keys()).join(', ') : 'none (STARNET_SESSION_BAY_SLOTS)') };
    return { ok: true, slot: String(slot), spec: s };
  }

  const refusal = (text) => ({ ok: false, text: 'SESSION BAY REFUSED — ' + text + '. Nothing was launched.' });

  async function liveSessions() {
    const l = crew && typeof crew.list === 'function' ? await crew.list() : null;
    if (!l || !l.available) return null;                 // unreadable = refuse (fail closed), never launch blind
    return l.sessions || [];
  }

  /* runStep(slot, { taintedBy, signal, onWait }) -> { ok, text }. Never throws: every failure is a said refusal/outcome,
     so the line's next bay and the outbox see it (and the run never falls back to an ordinary model step). */
  async function runStep(slotName, ctx) {
    ctx = ctx || {};
    const wait = typeof ctx.onWait === 'function' ? ctx.onWait : () => {};
    const c = checkSlot(slotName);
    if (!c.ok) return refusal(c.error);
    const { spec } = c;
    if (ctx.taintedBy) return refusal('this run carries untrusted text (' + String(ctx.taintedBy).slice(0, 120) + '); a session bay launches only from a clean run, so put it FIRST on its line');
    let arg = null;
    if (spec.arg) {
      arg = jobArg(ctx.jobText);
      if (!arg) return refusal('the job must name exactly ONE ' + spec.arg + ' — "Reconstruct <' + spec.arg.toUpperCase() + '>", letters, digits, . _ - only, no path — but it was: "' + String(ctx.jobText == null ? '' : ctx.jobText).trim().slice(0, 80) + '"');
    }
    const capKey = c.slot + (arg ? ':' + arg : '');
    const day = today();
    const last = launches[capKey];
    if (day && last && last.day === day) return refusal('the "' + capKey + '" slot already launched today (' + (last.name || last.shortId || 'unidentified') + '); at most one launch a day');
    if (spec.minAvailGB) {
      const gb = availGB();
      if (gb == null || !Number.isFinite(Number(gb))) return refusal('available memory is unreadable, and this slot needs at least ' + spec.minAvailGB + ' GB free');
      if (gb < spec.minAvailGB) return refusal('only ' + Math.floor(gb) + ' GB of memory is available; this slot needs at least ' + spec.minAvailGB + ' GB (CAD work has priority on this box)');
    }
    if (spec.busyProcess) {
      const procs = procList();
      if (!Array.isArray(procs)) return refusal('the process list is unreadable, and a launch is never made blind');
      if (procs.some(cmd => String(cmd).indexOf(spec.busyProcess) >= 0)) return refusal('a ' + spec.busyProcess + ' process is running (CAD work has priority on this box)');
    }
    const before = await liveSessions();
    if (!before) return refusal('the Claude session list is unreadable right now, and a launch is never made blind');
    const working = before.find(s => String(s.name || '').startsWith(spec.session) && (s.busy || s.needsInput));
    if (working) return refusal(working.name + ' is still ' + (working.needsInput ? 'waiting on the Commander' : 'working') + '; one session per job');
    // CAD priority: ANY live (listed) session of a CAD crew blocks a launch, idle or not (Proxima, 2026-11-15)
    const cad = spec.busyPrefixes.length ? before.find(s => spec.busyPrefixes.some(p => String(s.name || '').startsWith(p))) : null;
    if (cad) return refusal(cad.name + ' is live (a CAD crew session; CAD work has priority on this box)');
    const known = new Set(before.map(s => s.shortId).filter(Boolean));

    launches[capKey] = { day, shortId: null, name: null, at: now() };   // counted BEFORE the launch: a lost id still used the day
    persist();
    const r = await new Promise(resolve => {
      if (typeof execFile !== 'function') return resolve({ err: new Error('no process runner') });
      execFile(spec.run[0], spec.run.slice(1).concat(arg ? [arg] : []), { timeout: launchTimeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
    if (r.err) return { ok: false, text: 'SESSION BAY LAUNCH FAILED — the "' + c.slot + '" launcher refused or failed: ' + String((r.stderr || r.err.message || '')).trim().slice(0, 300) };

    // find the session the launcher started: a NEW background session with the slot's prefix
    let sess = null;
    const findUntil = now() + findMs;
    while (!sess) {
      const l = await liveSessions();
      sess = (l || []).find(s => s.shortId && !known.has(s.shortId) && String(s.name || '').startsWith(spec.session)) || null;
      if (sess || now() >= findUntil || (ctx.signal && ctx.signal.aborted)) break;
      wait('launching', 'waiting for the ' + c.slot + ' session to appear');
      await sleep(Math.min(pollMs, 5000));
    }
    if (!sess) return { ok: false, text: 'SESSION BAY LAUNCH UNCONFIRMED — the "' + c.slot + '" launcher ran, but no new ' + spec.session + '* session appeared within ' + Math.round(findMs / 1000) + ' s. Check `claude agents` before running the line again (today\'s launch is spent).' };
    launches[capKey] = { day, shortId: sess.shortId, name: sess.name, at: launches[capKey].at };
    persist();
    if (crew && typeof crew.claimLaunched === 'function') crew.claimLaunched(sess.shortId, sess.name);

    // wait for it to finish: idle after having worked, waiting on the Commander, gone, or the cap
    const started = now();
    const capMs = spec.capMin * 60000;
    /* FINISHED needs BOTH signals to agree, twice in a row (live 2026-11-15: the R31 reconstruct session waited on a
       background build with its job tempo 'idle' while `claude agents` still listed it busy, and the bay ended "finished
       after 7 min" while the session worked on). Idle = the job's tempo is idle AND the listing does not show it busy. */
    let sawWork = false, end = null, needs = '', idleStreak = 0;
    for (;;) {
      if (ctx.signal && ctx.signal.aborted) { end = 'left-running'; break; }
      const job = jobState(sess.shortId) || {};
      const tempo = String(job.tempo || ''), state = String(job.state || '');
      const l = await liveSessions();
      const listed = l ? l.find(s => s.shortId === sess.shortId) : undefined;
      if (l && !listed) { end = 'gone'; break; }
      const listedBusy = !!(listed && listed.busy);
      if (tempo === 'working' || listedBusy || (state === 'working' && tempo !== 'blocked' && tempo !== 'idle')) sawWork = true;
      if (state === 'done' || state === 'failed' || state === 'stopped') { end = state === 'done' ? 'finished' : state; break; }
      if (tempo === 'blocked' && sawWork) { end = 'needs-you'; needs = String(job.needs || ''); break; }
      const idleNow = tempo === 'idle' && l != null && !listedBusy && (sawWork || now() - started > 120000);
      idleStreak = idleNow ? idleStreak + 1 : 0;
      if (idleStreak >= 2) { end = 'finished'; break; }
      if (now() - started >= capMs) {
        end = 'capped';
        if (crew && typeof crew.stop === 'function') await crew.stop(sess.shortId);
        break;
      }
      wait('working', sess.name + ' working · ' + Math.round((now() - started) / 60000) + ' min');
      await sleep(pollMs);
    }

    let report = '', reportHead = 'The session\'s final report:';
    if (spec.report === 'statusFile') {
      // NEVER the session transcript for this slot: only its status file, and only when it carries no geometry
      const sf = spec.statusFile.split('{arg}').join(arg);
      const st = readFile(sf);
      reportHead = 'Its status file (' + sf + '):';
      if (st == null) report = '(no status file was written)';
      else if (GEOMETRY_RE.test(st)) report = 'STATUS WITHHELD — the status file contains a decimal number or "mm", and part geometry must never leave the CAD area. Nothing from it is forwarded; the CAD crew fixes the file.';
      else report = String(st).trim().slice(0, REPORT_MAX);
    } else {
      const tp = transcriptPath(sess.cwd, sess.sessionId);
      report = tp ? lastAssistantText(readFile(tp)) : '';
      if (report.length > REPORT_MAX) report = report.slice(0, REPORT_MAX) + '\n…(report cut at ' + REPORT_MAX + ' chars; the full text is in the session)';
    }
    const how = {
      finished: 'finished', 'needs-you': 'is WAITING ON THE COMMANDER' + (needs ? ': ' + needs.slice(0, 200) : ''),
      capped: 'was STOPPED at the ' + spec.capMin + '-minute wall-clock cap', gone: 'ended (no longer listed)',
      failed: 'FAILED', stopped: 'was stopped', 'left-running': 'is still running (this line run was cancelled; the session was left to finish)'
    }[end] || end;
    const head = spec.label + ' ' + sess.name + ' (job ' + sess.shortId + ') ' + how + ' after ' + Math.round((now() - started) / 60000) + ' min.' +
      (sess.remoteUrl ? '\nRemote Control: ' + sess.remoteUrl : '');
    return { ok: end === 'finished', end, shortId: sess.shortId, name: sess.name, text: head + '\n\n' + reportHead + '\n' + (report || '(it wrote no report text)') };
  }

  return {
    enabled, slotErrors,
    slots: () => Array.from(slots, ([name, s]) => ({ name, launcher: s.run.join(' '), session: s.session, capMin: s.capMin, arg: s.arg, report: s.report })),
    get(agentId) { const b = agents.get(String(agentId || '')); return b ? { slot: b.slot } : null; },
    list() { return Array.from(agents, ([agentId, b]) => ({ agentId, slot: b.slot })); },
    launches: () => Object.assign({}, launches),
    set(agentId, slot) {
      const id = String(agentId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { ok: false, error: 'unknown agent id' };
      const c = checkSlot(slot);
      if (!c.ok) return c;
      agents.set(id, { slot: c.slot });
      persist();
      return { ok: true, agentId: id, slot: c.slot };
    },
    clear(agentId) { const had = agents.delete(String(agentId || '')); if (had) persist(); return had; },
    // at RUN time: null = not a session agent; else { slot } (runStep re-checks everything)
    resolve(agentId) { const b = agents.get(String(agentId || '')); return b ? { slot: b.slot } : null; },
    runStep
  };
}

module.exports = { makeClaudeSessionBays, parseSlots, lastAssistantText, jobArg, GEOMETRY_RE };

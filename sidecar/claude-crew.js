/* sidecar/claude-crew.js — CLAUDE CREW: real Claude Code CLI sessions projected onto the station floor.

   WHAT IT IS. A read-mostly bridge to the user's own `claude` CLI. StarNet does NOT run these agents: it never
   calls a model for them, never meters their spend, and never adds them to the roster (the roster is what
   team.dispatch / cron / channels run against — an external session there would make StarNet try to drive it).
   It only (a) lists live sessions via `claude agents --json`, (b) starts new BACKGROUND sessions with Remote
   Control enabled via `claude --bg --remote-control`, (c) stops background sessions it can address, and
   (d) scrapes a background session's claude.ai/code Remote Control URL out of `claude logs` so the station can
   hand the operator a link that continues the session on their phone.

   AUTH LAW. This module never reads, copies, or forwards a Claude credential. Every session runs as the user's
   own `claude` binary under whatever login that binary already holds (`claude auth status`) — a claude.ai
   subscription login or otherwise. StarNet has no key to leak because it never touches one.

   CONSENT LAW. Permission escalation defaults to deny: spawn accepts only the non-bypassing permission modes.
   A session that hits a permission prompt waits for the operator, who answers it over Remote Control.

   OPT-IN. The whole surface is inert unless STARNET_CLAUDE_CREW=1 (index.js reads it and passes `enabled`), so a
   StarNet install without Claude Code never shells out to a binary it does not have.

   Pure helpers (normalizeSessions / parseRemoteUrl / buildSpawnArgs) are exported for tests; the factory takes an
   injected execFile + clock, exactly like the other sidecar makeX(opts) modules. */
'use strict';

const ID_PREFIX = 'cc-';                       // floor-body id namespace; 'cc-' + 36-char uuid = 39 <= roster id cap 40
const SHORT_ID_RE = /^[0-9a-f]{8}$/;           // the short id `claude --bg` prints and `claude stop|logs` take
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPAWN_MODES = ['default', 'plan', 'acceptEdits', 'auto'];   // NEVER bypassPermissions / dontAsk
const NAME_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
const PROMPT_MAX = 8000;
// the first message a skilled session gets when the launcher gave none: load, orient read-only, report, wait
const DEFAULT_SKILL_PROMPT = 'Load this skill and orient yourself read-only (current state, open work, anything in flight). ' +
  'Reply with a short readiness summary: what you own, what looks most useful to do first. ' +
  'Do NOT make changes, run builds, touch devices, or push — wait for instructions from the operator over Remote Control.';
const REMOTE_URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;

function str(x, max) { return String(x == null ? '' : x).slice(0, max || 400); }

/* normalizeSessions(raw) — `claude agents --json` output (array or JSON text) -> stable crew records.
   Interactive entries report `status` (idle|busy); background entries report `status` and/or `state`
   (working|done|…). busy is the only thing the floor animates, so it is decided ONCE here. */
function normalizeSessions(raw) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch (_) { return []; } }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const sessionId = str(s.sessionId, 64).toLowerCase();
    if (!UUID_RE.test(sessionId)) continue;             // no stable identity -> no floor body
    const status = str(s.status, 20).toLowerCase();
    const state = str(s.state, 20).toLowerCase();
    const kind = s.kind === 'background' ? 'background' : 'interactive';
    const shortId = SHORT_ID_RE.test(str(s.id, 16)) ? str(s.id, 16) : null;
    out.push({
      id: ID_PREFIX + sessionId,
      sessionId,
      shortId,                                          // only background sessions carry one (stop/logs need it)
      name: str(s.name, 80) || sessionId.slice(0, 8),
      cwd: str(s.cwd, 400),
      kind,
      busy: status === 'busy' || state === 'working',
      needsInput: state === 'blocked',                  // waiting on a permission prompt / question — only the operator can unblock it
      status: status || state || 'unknown',
      startedAt: Number.isFinite(s.startedAt) ? s.startedAt : null,
      stoppable: kind === 'background' && !!shortId,
    });
  }
  return out;
}

/* parseRemoteUrl(logText) — the LAST claude.ai/code session URL a session printed (ANSI stripped), or null. */
function parseRemoteUrl(text) {
  const clean = String(text || '').replace(ANSI_RE, '');
  const m = clean.match(REMOTE_URL_RE);
  return m && m.length ? m[m.length - 1] : null;
}

/* SKILLS. The user's Claude Code skills live as <dir>/<name>/SKILL.md with a YAML frontmatter `name:` and
   `description:`. parseSkill reads just those two fields (no YAML dep); a directory without a SKILL.md is not a
   skill. A session launched with a skill starts with `/<name>` as its first line — Claude Code's own way to load
   one — so the skill text never passes through StarNet at all. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
function parseSkill(dirName, text) {
  const t = String(text || '');
  const fm = t.match(/^---\s*\n([\s\S]*?)\n---/);
  const field = k => { const m = fm && fm[1].match(new RegExp('^' + k + ':\\s*(.*)$', 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  const name = field('name') || dirName;
  if (!SKILL_NAME_RE.test(name)) return null;
  return { name, description: str(field('description'), 300) };
}

/* buildSpawnArgs({ name, prompt, permissionMode, skill }) -> { ok, args } | { ok:false, error }.
   argv only (execFile, no shell), so the prompt can carry any text without injection risk. */
function buildSpawnArgs(o) {
  o = o || {};
  const name = str(o.name, 80).trim();
  if (!NAME_RE.test(name)) return { ok: false, error: 'name must be 1-40 chars of letters, digits, space, . _ -' };
  const mode = o.permissionMode == null || o.permissionMode === '' ? (SPAWN_MODES.indexOf(o.defaultMode) >= 0 ? o.defaultMode : 'default') : String(o.permissionMode);
  if (SPAWN_MODES.indexOf(mode) < 0) return { ok: false, error: 'permissionMode must be one of ' + SPAWN_MODES.join(', ') };
  let prompt = String(o.prompt == null ? '' : o.prompt);
  if (prompt.length > PROMPT_MAX) return { ok: false, error: 'prompt too long' };
  if (o.skill != null && o.skill !== '') {
    const skill = String(o.skill);
    if (!SKILL_NAME_RE.test(skill)) return { ok: false, error: 'bad skill name' };
    prompt = '/' + skill + '\n\n' + (prompt.trim() || DEFAULT_SKILL_PROMPT);
  }
  const args = ['--bg', '--remote-control', name, '--name', name, '--permission-mode', mode];
  if (prompt.trim()) args.push('--', prompt);
  return { ok: true, args };
}

/* the short id `claude --bg` prints ("backgrounded · 95035ad3"). */
function parseBackgroundId(text) {
  const m = String(text || '').replace(ANSI_RE, '').match(/backgrounded\s*\S*\s*([0-9a-f]{8})\b/);
  return m ? m[1] : null;
}

/* CLAUDE CODE'S OWN RECORDS (best-effort, fail-soft). The CLI keeps two small JSON files per session that are
   far more reliable than scraping `claude logs` (which only returns the recent SCREEN, so a Remote Control link
   printed at startup scrolls out of it — the station then wrongly said "not connected yet"):
     <claudeHome>/sessions/<pid>.json   { sessionId, name, kind, jobId?, bridgeSessionId: 'session_…' | null }
                                        — every live session, interactive ones included; bridgeSessionId is set
                                        while Remote Control is on
     <claudeHome>/jobs/<id>/state.json  background jobs: { needs: 'approve Bash: …', detail: '…', bridgeSessionId }
   These are undocumented internals: every field is optional, any read/parse failure just leaves the session as
   the listing reported it, and the logs scrape remains the fallback for the URL. */
function remoteUrlFromBridge(bridgeId) {
  const b = String(bridgeId || '');
  const m = b.match(/^(?:session_|cse_)([A-Za-z0-9]+)$/);
  return m ? 'https://claude.ai/code/session_' + m[1] : null;
}

/* makeClaudeCrew({ enabled, execFile, bin, now, isDir, minPollMs, timeoutMs, fs, join, skillDirs, claudeHome }) */
function makeClaudeCrew(opts) {
  const o = opts || {};
  const enabled = !!o.enabled;
  const execFile = o.execFile;
  const bin = o.bin || 'claude';
  const now = typeof o.now === 'function' ? o.now : null;   // injected clock (lint-determinism); none = no list cache
  const isDir = typeof o.isDir === 'function' ? o.isDir : () => false;
  const skillDirs = Array.isArray(o.skillDirs) ? o.skillDirs.filter(Boolean) : [];
  const fsx = o.fs || null;   // { readdirSync, readFileSync } — injected; absent = no skill catalog
  const pathJoin = typeof o.join === 'function' ? o.join : (a, b) => String(a).replace(/[\\/]+$/, '') + '/' + b;
  const claudeHome = o.claudeHome ? String(o.claudeHome) : '';
  // the station's default permission mode for new sessions (STARNET_CLAUDE_CREW_MODE); never a bypassing mode
  const defaultMode = SPAWN_MODES.indexOf(o.defaultMode) >= 0 ? o.defaultMode : 'default';

  function readJson(file) {
    try { return JSON.parse(fsx.readFileSync(file, 'utf8')); } catch (_) { return null; }   // absent/partial file = no record
  }
  /* enrich(sessions) — attach remoteUrl (any kind) and, for background jobs, what the session is waiting on. */
  function enrich(sessions) {
    if (!fsx || !claudeHome) return sessions;
    const byId = new Map();
    let files = [];
    try { files = fsx.readdirSync(pathJoin(claudeHome, 'sessions')); } catch (_) { files = []; }   // no sessions dir = nothing to add
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      const j = readJson(pathJoin(pathJoin(claudeHome, 'sessions'), f));
      if (j && typeof j.sessionId === 'string') byId.set(j.sessionId.toLowerCase(), j);
    }
    return sessions.map(s => {
      const rec = byId.get(s.sessionId) || {};
      const job = s.shortId ? (readJson(pathJoin(pathJoin(pathJoin(claudeHome, 'jobs'), s.shortId), 'state.json')) || {}) : {};
      const url = remoteUrlFromBridge(rec.bridgeSessionId) || remoteUrlFromBridge(job.bridgeSessionId);
      const out = Object.assign({}, s);
      if (url) out.remoteUrl = url;
      if (s.needsInput && typeof job.needs === 'string' && job.needs) out.waitingOn = str(job.needs, 240);
      if (typeof job.detail === 'string' && job.detail) out.detail = str(job.detail, 160);
      return out;
    });
  }
  const minPollMs = Number.isFinite(o.minPollMs) ? o.minPollMs : 2500;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 30000;
  let cache = null, cacheAt = 0, inflight = null;
  const urls = new Map();                                // shortId -> remote url (stable for a session's life)

  function run(args, cwd) {
    return new Promise(resolve => {
      execFile(bin, args, { cwd: cwd || undefined, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
  }
  function why(r) {
    if (r.err && r.err.code === 'ENOENT') return 'claude CLI not found (set STARNET_CLAUDE_BIN or install Claude Code)';
    return str((r.stderr || r.stdout || (r.err && r.err.message) || 'claude failed').replace(ANSI_RE, '').trim(), 300);
  }

  async function list() {
    if (!enabled) return { ok: true, enabled: false, available: false, sessions: [] };
    if (cache && now && now() - cacheAt < minPollMs) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await run(['agents', '--json']);
      const out = r.err
        ? { ok: true, enabled: true, available: false, reason: why(r), sessions: [] }
        : { ok: true, enabled: true, available: true, sessions: enrich(normalizeSessions(r.stdout)) };
      cache = out; cacheAt = now ? now() : 0;
      return out;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  /* listSkills() -> [{ name, description, dir }] across skillDirs (first dir wins on a duplicate name). */
  function listSkills() {
    if (!enabled || !fsx) return [];
    const out = [], seen = new Set();
    for (const dir of skillDirs) {
      let entries = [];
      try { entries = fsx.readdirSync(dir); } catch (_) { entries = []; }   // a missing skills dir is simply empty
      for (const ent of entries.sort()) {
        let text = null;
        try { text = fsx.readFileSync(pathJoin(pathJoin(dir, ent), 'SKILL.md'), 'utf8'); } catch (_) { text = null; }   // no SKILL.md = not a skill
        if (text == null) continue;
        const sk = parseSkill(ent, text);
        if (!sk || seen.has(sk.name)) continue;
        seen.add(sk.name);
        out.push(Object.assign(sk, { dir }));
      }
    }
    return out;
  }

  async function spawn(body) {
    if (!enabled) return { ok: false, error: 'claude crew disabled (STARNET_CLAUDE_CREW=1)' };
    const b = body || {};
    if (b.skill && !listSkills().some(sk => sk.name === String(b.skill))) return { ok: false, error: 'unknown skill: ' + str(b.skill, 64) };
    const cwd = str(b.cwd, 400);
    if (!cwd || !isDir(cwd)) return { ok: false, error: 'cwd must be an existing absolute directory' };
    const built = buildSpawnArgs(Object.assign({}, b, { defaultMode }));
    if (!built.ok) return built;
    const r = await run(built.args, cwd);
    if (r.err) return { ok: false, error: why(r) };
    cache = null;                                        // the next list() must see the new session
    return { ok: true, shortId: parseBackgroundId(r.stdout) };
  }

  async function stop(shortId) {
    if (!enabled) return { ok: false, error: 'claude crew disabled' };
    const id = str(shortId, 16);
    if (!SHORT_ID_RE.test(id)) return { ok: false, error: 'bad session id' };
    const r = await run(['stop', id]);
    if (r.err) return { ok: false, error: why(r) };
    cache = null; urls.delete(id);
    return { ok: true };
  }

  async function remoteUrl(shortId) {
    if (!enabled) return { ok: false, error: 'claude crew disabled' };
    const id = str(shortId, 16);
    if (!SHORT_ID_RE.test(id)) return { ok: false, error: 'bad session id' };
    if (urls.has(id)) return { ok: true, url: urls.get(id) };
    const job = (fsx && claudeHome) ? readJson(pathJoin(pathJoin(pathJoin(claudeHome, 'jobs'), id), 'state.json')) : null;
    const fromJob = job && remoteUrlFromBridge(job.bridgeSessionId);
    if (fromJob) { urls.set(id, fromJob); return { ok: true, url: fromJob }; }
    const r = await run(['logs', id]);
    if (r.err) return { ok: false, error: why(r) };
    const url = parseRemoteUrl(r.stdout);
    if (url) urls.set(id, url);
    return { ok: true, url };                            // url:null = Remote Control not (yet) connected — said, not guessed
  }

  return { list, spawn, stop, remoteUrl, listSkills, enabled, defaultMode };
}

module.exports = { makeClaudeCrew, normalizeSessions, parseRemoteUrl, remoteUrlFromBridge, buildSpawnArgs, parseBackgroundId, parseSkill, SPAWN_MODES, ID_PREFIX, DEFAULT_SKILL_PROMPT };

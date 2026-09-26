/* frontend/app/claude-crew.js — CLAUDE CREW on the floor.

   Projects the sidecar's GET /api/claude-crew (the user's own `claude` CLI sessions) onto the station as crew
   bodies: one body per live session, seated + "working…" while the session is busy, strolling while idle, and
   removed when the session ends. Bodies are namespaced `cc-<sessionId>` and are NEVER added to App's roster
   (agents / pushRoster) — StarNet does not run these agents, so nothing that dispatches work may see them.

   Tapping a Claude body opens a small card: name, directory, status, and — for background sessions StarNet can
   address — OPEN REMOTE (the claude.ai/code Remote Control link, the way to talk to it from a phone) and STOP.
   A NEW CLAUDE button starts a fresh background session with Remote Control on.

   Inert unless the sidecar reports enabled (STARNET_CLAUDE_CREW=1): the first poll answers enabled:false and
   the module stops polling and adds no UI. It never asserts state it did not read: an unreachable CLI shows
   its reason, and a session with no Remote Control URL yet says so instead of showing a dead link. */
(function () {
  'use strict';
  const POLL_MS = 4000;
  const COLOR = '#d97757';
  const SKIN = 'robot';
  const bodies = new Map();       // floor id -> last session record
  let timer = null, lastErr = '', card = null, btn = null;

  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text != null) e.textContent = text;
    return e;
  }
  const PANEL = 'position:fixed;z-index:9990;background:#0b1020;color:#e8e6df;border:2px solid ' + COLOR + ';' +
    'font-family:VT323,monospace;font-size:20px;padding:12px 14px;box-shadow:0 0 0 2px #000,0 8px 24px rgba(0,0,0,.6);';
  const BUTTON = 'font:inherit;background:#1a2138;color:#e8e6df;border:1px solid ' + COLOR + ';padding:6px 10px;margin:6px 6px 0 0;cursor:pointer;';

  function stateText(s) { return s.needsInput ? 'needs you (answer over Remote Control)' : s.busy ? 'working' : s.status; }

  function closeCard() { if (card) { card.remove(); card = null; } }

  async function api(path, init) {
    const r = await fetch(path, init);
    let j = null; try { j = await r.json(); } catch (_) {}
    return j || { ok: false, error: 'HTTP ' + r.status };
  }

  function sync(sessions) {
    if (typeof World === 'undefined' || !World.spawnAgent) return;
    const seen = new Set();
    for (const s of sessions) {
      seen.add(s.id);
      const prev = bodies.get(s.id);
      // relabel() doubles as the presence check (true iff a body with this id is on the floor). The floor is
      // rebuilt by loadStation after onboarding / station switches, so a body can vanish under us: re-spawn it.
      let present = false;
      try { present = !!(World.relabel && World.relabel(s.id, s.name)); } catch (_) {}
      if (!present) {
        try {
          if (typeof registerAgent === 'function') registerAgent(s.id, COLOR);
          World.spawnAgent({ id: s.id, name: s.name, color: COLOR, skin: SKIN });
        } catch (_) { continue; }
      }
      if (!present || !prev || prev.busy !== s.busy) {
        try { World.setActivityFor(s.id, s.busy ? 'task' : 'idle'); } catch (_) {}
      }
      bodies.set(s.id, s);
    }
    for (const id of [...bodies.keys()]) {
      if (seen.has(id)) continue;
      try { World.despawnAgent(id); } catch (_) {}
      bodies.delete(id);
    }
    pushRail();
  }
  // the top-left CREW rail lists sessions too (display-only group); repaint it only when something visible changed
  let railSig = '';
  function pushRail() {
    const list = [...bodies.values()];
    const sig = JSON.stringify(list.map(x => [x.id, x.name, x.busy, x.needsInput, x.shortId]));
    if (sig === railSig) return;
    railSig = sig;
    try { if (typeof StationUI !== 'undefined' && StationUI.setExternalCrew) StationUI.setExternalCrew(list); } catch (_) {}
  }

  async function poll() {
    let out;
    try { out = await api('/api/claude-crew'); } catch (e) { out = null; }
    if (!out) {                                              // network blip: say so only once the feature proved itself
      if (btn) { lastErr = 'station unreachable'; btn.textContent = 'CLAUDE · offline'; }
      return;
    }
    if (out.enabled !== true) { stop(); return; }            // feature off / no sidecar route (website demo): leave no trace
    ensureButton();
    if (out.available === false) {
      lastErr = out.reason || out.error || 'claude CLI unavailable';
      btn.textContent = 'CLAUDE · offline';
      return;                                                // keep the last known floor; do not invent departures
    }
    lastErr = '';
    const list = out.sessions || [];
    const busy = list.filter(x => x.busy).length, needs = list.filter(x => x.needsInput).length;
    btn.textContent = 'CLAUDE · ' + list.length + (busy ? ' (' + busy + ' busy)' : '') + (needs ? ' · ' + needs + ' NEED YOU' : '');
    sync(list);
  }

  function ensureButton() {
    if (btn || !document.body) return;
    btn = el('button', PANEL + 'top:14px;left:50%;transform:translateX(-50%);padding:4px 12px;cursor:pointer;white-space:nowrap;', 'CLAUDE');
    btn.setAttribute('aria-label', 'Claude crew');
    btn.addEventListener('click', openRosterCard);
    document.body.appendChild(btn);
  }

  function cardShell(title) {
    closeCard();
    card = el('div', PANEL + 'left:50%;top:50%;transform:translate(-50%,-50%);width:min(92vw,420px);max-height:86vh;overflow:auto;');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', title);
    const h = el('div', 'font-size:24px;color:' + COLOR + ';margin-bottom:6px;', title);
    const x = el('button', BUTTON + 'position:absolute;top:4px;right:4px;margin:0;', 'X');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeCard);
    card.append(h, x);
    document.body.appendChild(card);
    return card;
  }
  function line(parent, label, value) {
    const d = el('div', 'margin:2px 0;word-break:break-all;');
    d.append(el('span', 'color:#8a93b2;', label + ' '), el('span', '', value));
    parent.appendChild(d);
    return d;
  }

  async function openSession(id) {
    const s = bodies.get(id);
    if (!s) return false;
    const c = cardShell('CLAUDE · ' + s.name);
    line(c, 'STATUS', stateText(s));
    line(c, 'DIR', s.cwd || '?');
    line(c, 'KIND', s.kind === 'background' ? 'background (started from the station or claude --bg)' : 'interactive terminal session');
    const row = el('div', 'margin-top:6px;');
    c.appendChild(row);
    if (!s.shortId) {
      line(c, '', 'Terminal sessions are shown read-only. Run /remote-control in that session to reach it from your phone.');
      return true;
    }
    const note = line(c, 'REMOTE', 'looking up…');
    const r = await api('/api/claude-crew/remote?id=' + encodeURIComponent(s.shortId));
    note.lastChild.textContent = r.url ? r.url : (r.error || 'Remote Control not connected yet — try again shortly');
    if (r.url) {
      const open = el('a', BUTTON + 'display:inline-block;text-decoration:none;', 'OPEN REMOTE');
      open.href = r.url; open.target = '_blank'; open.rel = 'noopener';
      row.appendChild(open);
    }
    const stopBtn = el('button', BUTTON, 'STOP');
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true; stopBtn.textContent = 'STOPPING…';
      const res = await api('/api/claude-crew/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.shortId }) });
      if (res.ok) { closeCard(); poll(); } else { stopBtn.disabled = false; stopBtn.textContent = 'STOP'; note.lastChild.textContent = res.error || 'stop failed'; }
    });
    row.appendChild(stopBtn);
    return true;
  }

  // the phone-first entry point: every session as a tappable row (the floor sprites are small on a handset)
  function openRosterCard() {
    const c = cardShell('CLAUDE CREW');
    if (lastErr) line(c, 'WARN', lastErr);
    const rows = [...bodies.values()].sort((a, b) => (b.needsInput - a.needsInput) || (b.busy - a.busy) || String(a.name).localeCompare(String(b.name)));
    if (!rows.length) line(c, '', 'No Claude sessions running.');
    for (const s of rows) {
      const r = el('button', BUTTON + 'display:block;width:100%;text-align:left;margin:6px 0 0;');
      const mark = s.needsInput ? ['#ffd34a', '! '] : s.busy ? [COLOR, '● '] : ['#6fcf97', '○ '];
      r.append(el('span', 'color:' + mark[0] + ';', mark[1]), el('span', '', s.name),
        el('span', 'color:#8a93b2;', ' · ' + stateText(s) + (s.shortId ? ' · remote' : '')));
      r.setAttribute('aria-label', 'Open ' + s.name);
      r.addEventListener('click', () => openSession(s.id));
      c.appendChild(r);
    }
    const n = el('button', BUTTON + 'margin-top:12px;', '+ NEW SESSION');
    n.setAttribute('aria-label', 'Start a new Claude session');
    n.addEventListener('click', openNewCard);
    c.appendChild(n);
  }

  function openNewCard() {
    const c = cardShell('NEW CLAUDE SESSION');
    if (lastErr) line(c, 'WARN', lastErr);
    const field = (label, input) => { const w = el('label', 'display:block;margin:6px 0;'); w.append(el('div', 'color:#8a93b2;', label), input); c.appendChild(w); return input; };
    const IN = 'font:inherit;width:100%;box-sizing:border-box;background:#141a2e;color:#e8e6df;border:1px solid #39406a;padding:4px 6px;';
    const name = field('NAME', el('input', IN)); name.maxLength = 40; name.placeholder = 'e.g. delta';
    const known = [...bodies.values()].map(s => s.cwd).filter(Boolean);
    const cwd = field('DIRECTORY (absolute, already trusted by claude)', el('input', IN)); cwd.value = known[0] || '';
    const mode = field('PERMISSIONS', el('select', IN));
    for (const [v, t] of [['default', 'ask me (answer over Remote Control)'], ['plan', 'plan only (read-only)'], ['acceptEdits', 'accept file edits'], ['auto', 'auto']]) {
      const o = el('option', '', t); o.value = v; mode.appendChild(o);
    }
    const prompt = field('FIRST MESSAGE (optional)', el('textarea', IN + 'height:90px;'));
    const status = el('div', 'min-height:22px;margin-top:4px;color:#8a93b2;');
    const go = el('button', BUTTON, 'LAUNCH');
    go.addEventListener('click', async () => {
      go.disabled = true; status.textContent = 'launching…';
      const res = await api('/api/claude-crew/spawn', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value.trim(), cwd: cwd.value.trim(), permissionMode: mode.value, prompt: prompt.value }) });
      if (res.ok) { status.textContent = 'launched ' + (res.shortId || '') + ' — it will walk in shortly'; setTimeout(closeCard, 1500); poll(); }
      else { go.disabled = false; status.textContent = res.error || 'launch failed'; }
    });
    c.append(go, status);
    name.focus();
  }

  function start() { if (!timer) { poll(); timer = setInterval(poll, POLL_MS); } }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  window.ClaudeCrew = { isClaudeBody: id => typeof id === 'string' && id.indexOf('cc-') === 0, open: openSession, start, stop, _bodies: bodies };
  // after App has booted the world (the World body registry exists once the station loads)
  if (document.readyState === 'complete') setTimeout(start, 1500);
  else window.addEventListener('load', () => setTimeout(start, 1500));
})();

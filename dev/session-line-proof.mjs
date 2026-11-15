// dev/session-line-proof.mjs — LIVE end-to-end proof (fork) of a CREW-SESSION BAY on a THROWAWAY station: a workflow line
// whose first bay LAUNCHES a real Claude Code background session through a fixed launcher, waits for it, and hands the
// session's own final report to a model step (the digest) and the outbox. Plus the guardrail refusals, each a real line run.
//
//   SKYNET_CHROME=~/.local/bin/chrome-nosandbox node dev/session-line-proof.mjs
//     PROOF_STEP_MODEL=<id>  what the DIGEST step runs on (default claude-sonnet-5-5) — run once per model
//     PROOF_LEAD_MODEL=<id>  the building lead (default claude-sonnet-5-5)
//     PROOF_LAUNCHER=<path>  the slot's launcher (default ../cutover/proof-sweep.sh: run-sweep.sh's launch shape, a tiny
//                            read-only brief, a real `claude --bg` session) — NEVER the real sweep script here
//     PROOF_OUT=<dir>, PROOF_KEEP=1
//
// PHASES (one scratch workspace, the station restarted between them, Full Access OFF):
//   1 BUILD   the lead (AUTO-BUILD) lays out line SWEEP [SWEEP bay: a new recruit][DIGEST: lead] and line TAINT
//             [RELAY: lead][SWEEP AGAIN: the same recruit]. No test yet.
//   2 BIND    the station is stopped and the recruit is bound to slot "proof" in claude-session-bays.json — the file the
//             Commander's approved claude.session_agent writes (that tool always asks, so a `starnet -p` lead cannot).
//   3 RUN     test_line SWEEP  -> delivered; the launcher ran once, the session's codeword report reached the outbox.
//   4 CAP     test_line SWEEP  -> the session bay REFUSES: already launched today. No second session.
//   5 TAINT   test_line TAINT  -> the bay is second, its run is handed upstream text: REFUSED, nothing launched.
//   6 OFF     restart WITHOUT STARNET_SESSION_BAYS, test_line SWEEP -> REFUSED by the kill switch.
// ORACLE: the station's records (line-jobs.json outputs, runs.jsonl) + the launcher's own log (how many launches) — never
// the lead's account. The launched proof session is stopped at the end.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEP_MODEL = process.env.PROOF_STEP_MODEL || 'claude-sonnet-5-5';
const LEAD_MODEL = process.env.PROOF_LEAD_MODEL || 'claude-sonnet-5-5';
const LAUNCHER = process.env.PROOF_LAUNCHER || join(REPO, '..', 'cutover', 'proof-sweep.sh');
const CODEWORD = 'PROOF-REPORT-7Q4';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const readJsonl = f => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) : [];
const findJobs = o => !o || typeof o !== 'object' ? null : Array.isArray(o.jobs) ? o.jobs : Object.values(o).map(findJobs).find(Boolean) || null;

function seedClaudeLogin(ws) {
  const saveFile = join(ws, 'agent.save.json'); const save = JSON.parse(readFileSync(saveFile, 'utf8'));
  save.doc.prov = 'claude-cli'; save.doc.agent.provider = 'claude-cli'; save.doc.agent.model = STEP_MODEL;
  writeFileSync(saveFile, JSON.stringify(save, null, 2));
  const rosterFile = join(ws, 'agent.roster.json'); const roster = JSON.parse(readFileSync(rosterFile, 'utf8'));
  for (const a of roster.agents) { a.provider = 'claude-cli'; a.model = STEP_MODEL; }
  writeFileSync(rosterFile, JSON.stringify(roster, null, 2));
}

async function station(ws, { bays }) {
  const port = await freePort(), cdpPort = await freePort();
  const env = Object.assign({}, process.env, { STARNET_WORKSPACES: ws, SKYNET_WORKSPACES: ws, STARNET_PORT: String(port), SKYNET_PORT: String(port), SKYNET_DEV: '1', STARNET_AUTO_BUILD: '1' });
  for (const k of ['SKYNET_FULL_ACCESS', 'STARNET_FULL_ACCESS', 'SKYNET_AUTO_BUILD', 'STARNET_AUTO_BUILD_CREW', 'SKYNET_AUTO_BUILD_CREW', 'STARNET_OVERSEER_SESSION',
    'STARNET_SESSION_BAYS', 'SKYNET_SESSION_BAYS', 'STARNET_SESSION_BAY_SLOTS', 'SKYNET_SESSION_BAY_SLOTS', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']) delete env[k];
  env.STARNET_CLAUDE_CREW = '1';   // the session list + managed record the bay uses
  env.STARNET_SESSION_BAY_SLOTS = JSON.stringify({ proof: { run: [LAUNCHER, 'proof', join(ws, 'launcher.log')], session: 'proof-sweep-', capMin: 10 } });
  if (bays) env.STARNET_SESSION_BAYS = '1';
  const side = spawn(process.execPath, [join(REPO, 'sidecar', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; side.stdout.on('data', d => logs.push(d)); side.stderr.on('data', d => logs.push(d));
  for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) break; } catch (_) {} await sleep(500); }
  const prof = mkdtempSync(join(tmpdir(), 'sn-sbprof-'));
  const { proc: chrome } = launchChrome({ cdpPort, profileDir: prof });
  const cdp = await connectCDP(cdpPort); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) { ready = !!(await evalJS(cdp, `typeof App!=='undefined'&&App.station&&!!App.station()&&!!App.station().rooms`).catch(() => false)); if (!ready) await sleep(500); }
  if (!ready) throw new Error('the station page never became ready');
  await sleep(4000);
  const lead = (prompt, tag) => {
    const t0 = Date.now();
    const cli = spawnSync(process.execPath, [join(REPO, 'bin', 'starnet.js'), '--port', String(port), '--no-spawn', '--json', '--provider', 'claude-cli', '--model', LEAD_MODEL, '--timeout', '1800', '-p', prompt],
      { env, encoding: 'utf8', timeout: 1900000, cwd: REPO, maxBuffer: 64 << 20 });
    writeFileSync(join(ws, 'cli-' + tag + '.txt'), String(cli.stdout || '') + '\n--- stderr ---\n' + String(cli.stderr || ''));
    console.log('[' + tag + '] starnet -p exit ' + cli.status + ' after ' + Math.round((Date.now() - t0) / 1000) + 's');
    return cli;
  };
  const stop = async () => {
    writeFileSync(join(ws, 'sidecar-' + Date.now() + '.log'), Buffer.concat(logs));
    try { cdp.close && cdp.close(); } catch (_) {}
    try { chrome.kill('SIGTERM'); } catch (_) {}
    side.kill('SIGTERM'); await sleep(2500);
    try { rmSync(prof, { recursive: true, force: true }); } catch (_) {}
  };
  return { lead, stop, env };
}

const jobsOf = ws => findJobs(existsSync(join(ws, 'line-jobs.json')) ? JSON.parse(readFileSync(join(ws, 'line-jobs.json'), 'utf8')) : {}) || [];
const launches = ws => existsSync(join(ws, 'launcher.log')) ? readFileSync(join(ws, 'launcher.log'), 'utf8').split('\n').filter(l => / launching /.test(l)).length : 0;
const testJob = (line, job) => 'Send ONE test job down the workflow line "' + line + '" with station.test_line, job text: "' + job + '". Do not change the line, do not build anything, do not test again, do not ask me anything. Report the delivered output verbatim, or the error.';

async function main() {
  const ws = mkdtempSync(join(tmpdir(), 'sn-sessionline-'));
  cpSync(join(REPO, 'dev', 'fixtures', 'seed-workspace'), ws, { recursive: true });
  seedClaudeLogin(ws);
  const out = process.env.PROOF_OUT || ws; mkdirSync(out, { recursive: true });
  const verdict = {};
  let sessionId = null;
  try {
    // 1 BUILD
    let st = await station(ws, { bays: true });
    st.lead('Build a new room named "SWEEP DECK" beside the main room, joined by a hallway. In it build TWO workflow lines. '
      + 'Line "SWEEP": an intake, then two bays, then an outbox. Bay 1 "SWEEP": staff it with ONE NEW specialist recruited for it (station.plan staff with agent "new"), named SWEEPER. '
      + 'Bay 2 "DIGEST": staff it with yourself (the lead); its brief: read the sweep session\'s report handed to you and write a short digest — the outcome line, the area, findings, and anything that needs the Commander; never invent findings. '
      + 'Line "TAINT": an intake, then two bays, then an outbox. Bay 1 "RELAY": staff with yourself; brief: pass the job text on unchanged. Bay 2 "SWEEP AGAIN": staff it with the same SWEEPER agent (not a new recruit). '
      + 'First read station.map and station.map {catalog:true}, plan with station.plan, build with station.build. Do NOT test either line and do not set any schedule. Do not ask me anything. Report what was built and who staffs each bay.', 'build');
    await st.stop();
    // 2 BIND — every recruit (only SWEEPER is expected) to slot "proof"
    const roster = JSON.parse(readFileSync(join(ws, 'agent.roster.json'), 'utf8')).agents;
    const recruits = roster.filter(a => a.agentId !== 'agent').map(a => a.agentId);
    console.log('recruits: ' + JSON.stringify(roster.filter(a => a.agentId !== 'agent').map(a => [a.agentId, a.name])));
    if (!recruits.length) throw new Error('the lead recruited no one — nothing to bind');
    writeFileSync(join(ws, 'claude-session-bays.json'), JSON.stringify({ agents: Object.fromEntries(recruits.map(id => [id, { slot: 'proof' }])), launches: {} }, null, 2));

    // 3 RUN + 4 CAP + 5 TAINT
    st = await station(ws, { bays: true });
    const n0 = jobsOf(ws).length;
    st.lead(testJob('SWEEP', 'Run today\'s sweep.'), 'run');
    const run = jobsOf(ws).slice(n0);
    const delivered = run.find(j => j.status === 'delivered');
    verdict.run = !!delivered && new RegExp(CODEWORD).test(String(delivered.output || '')) && launches(ws) === 1;
    console.log('RUN: jobs=' + run.length + ' delivered=' + !!delivered + ' codeword in outbox=' + (!!delivered && new RegExp(CODEWORD).test(String(delivered.output))) + ' launches=' + launches(ws));
    const bayRec = existsSync(join(ws, 'claude-session-bays.json')) ? JSON.parse(readFileSync(join(ws, 'claude-session-bays.json'), 'utf8')) : {};
    const shortId = bayRec.launches && bayRec.launches.proof && bayRec.launches.proof.shortId;
    console.log('station launch record: ' + JSON.stringify(bayRec.launches || {}));
    if (delivered) {
      const ids = new Set((delivered.runs || []).map(r => r.runId));
      const steps = readJsonl(join(ws, 'runs.jsonl')).filter(r => ids.has(r.runId)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      for (const r of steps) console.log('  step bay=' + r.dockId + ' agent=' + r.agentId + ' provider=' + r.provider + ' model=' + r.model + ' reason=' + r.reason + ' tokens=' + r.tokens + ' ' + r.durationMs + 'ms');
      writeFileSync(join(out, 'run-delivered.md'), '# delivered output\n\n' + String(delivered.output || '') + '\n');
    }
    const n1 = jobsOf(ws).length;
    st.lead(testJob('SWEEP', 'Run today\'s sweep again.'), 'cap');
    const cap = jobsOf(ws).slice(n1);
    const capText = cap.map(j => String(j.output || '') + ' ' + String(j.error || '')).join('\n');
    verdict.cap = /already launched today/.test(capText) && launches(ws) === 1;
    console.log('CAP: refused=' + /already launched today/.test(capText) + ' launches still=' + launches(ws));
    const n2 = jobsOf(ws).length;
    st.lead(testJob('TAINT', 'Run today\'s sweep.'), 'taint');
    const taint = jobsOf(ws).slice(n2);
    const taintText = taint.map(j => String(j.output || '') + ' ' + String(j.error || '')).join('\n');
    verdict.taint = /untrusted text/.test(taintText) && launches(ws) === 1;
    console.log('TAINT: refused=' + /untrusted text/.test(taintText) + ' launches still=' + launches(ws));
    await st.stop();
    // 6 OFF — the kill switch (a fresh day record, so only the switch can refuse it)
    const rec = JSON.parse(readFileSync(join(ws, 'claude-session-bays.json'), 'utf8')); rec.launches = {}; writeFileSync(join(ws, 'claude-session-bays.json'), JSON.stringify(rec, null, 2));
    st = await station(ws, { bays: false });
    const n3 = jobsOf(ws).length;
    st.lead(testJob('SWEEP', 'Run today\'s sweep.'), 'off');
    const off = jobsOf(ws).slice(n3);
    const offText = off.map(j => String(j.output || '') + ' ' + String(j.error || '')).join('\n');
    verdict.off = /STARNET_SESSION_BAYS=1/.test(offText) && launches(ws) === 1;
    console.log('OFF: refused=' + /STARNET_SESSION_BAYS=1/.test(offText) + ' launches still=' + launches(ws));
    await st.stop();
    writeFileSync(join(out, 'line-jobs.json'), readFileSync(join(ws, 'line-jobs.json')));
    writeFileSync(join(out, 'refusals.md'), '# CAP\n\n' + capText + '\n\n# TAINT\n\n' + taintText + '\n\n# OFF\n\n' + offText + '\n');
    sessionId = shortId;
  } finally {
    if (sessionId) { try { execFileSync('claude', ['stop', sessionId], { stdio: 'ignore', timeout: 30000 }); console.log('stopped the proof session ' + sessionId); } catch (_) { console.log('could not stop ' + sessionId); } }
    if (existsSync(join(ws, 'launcher.log'))) writeFileSync(join(out, 'launcher.log'), readFileSync(join(ws, 'launcher.log')));
    if (!process.env.PROOF_KEEP) try { rmSync(ws, { recursive: true, force: true }); } catch (_) {} else console.log('workspace kept: ' + ws);
  }
  const pass = verdict.run && verdict.cap && verdict.taint && verdict.off;
  console.log('\nverdict: ' + JSON.stringify(verdict) + ' (digest step model ' + STEP_MODEL + ')\nRESULT: ' + (pass ? 'PASS' : 'FAIL'));
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error('proof error: ' + (e && e.stack || e)); process.exit(2); });

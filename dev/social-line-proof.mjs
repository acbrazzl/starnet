// dev/social-line-proof.mjs — LIVE end-to-end proof (fork): ONE `starnet -p` prompt builds a room + a workflow line, and
// the line's test job RUNS every step on the Commander's own Claude login (provider claude-cli) and delivers a post draft.
//
//   SKYNET_CHROME=~/.local/bin/chrome-nosandbox node dev/social-line-proof.mjs
//     PROOF_MODEL=<id>   the claude model the station runs (default claude-sonnet-5-5)
//     PROOF_KEEP=1       keep the scratch workspace for reading afterwards
//     PROOF_OUT=<dir>    write the receipt, the job record and the run rows there (default: the scratch workspace)
//     PROOF_ARM=fixture  the A/B "before": keep the fixture's own station default (prov openrouter, no model) — exactly
//                        Proxima's 2026-11-13 trial. The lead still runs on claude-cli (--provider), builds the line, and
//                        the test job must FAIL at $0 with "has no roster model" (no model pin) or "connect a OPENROUTER API
//                        key" (a model but the openrouter pin), the two errors the trial hit; RESULT: PASS means it did.
//
//     PROOF_ARM=skill    CREW-SKILL BAY (STARNET_AUTO_BUILD_CREW=1): the lead also recruits a new specialist for bay 2, binds it
//                        to the Commander's Claude Code skill meshflow-social in ~/code/meshFlow (claude.skill_agent) and
//                        staffs CAPTION with it. Oracle: the binding on disk, that agent's run row (claude-cli, done), and its
//                        OWN reply naming the skill's standing CTA ("Join the free alpha — link in bio.") — a line only the
//                        skill knows; the plain line never mentions it. The step may use it or (2026-11-14 run) cite it and
//                        swap it for a Play CTA, explaining why: either way only a step that read the skill can name it.
//     PROOF_ARM=skill-off the same prompt with the crew switch OFF: claude.skill_agent is denied and nothing is bound.
// A THROWAWAY station: a scratch copy of dev/fixtures/seed-workspace, an OS-assigned port, Full Access OFF,
// STARNET_AUTO_BUILD=1. The scratch save and roster are set to claude-cli + a model BEFORE boot, so the station's
// default (the hero's own provider pin, which every unpinned bay follows) is the Claude login — the fixture's
// `prov: "openrouter"` is what made the earlier trial's test job refuse with "connect a OPENROUTER API key".
//
// THE ORACLE is what the STATION recorded, never the lead's own account:
//   - line-jobs.json: the test job's record — status 'delivered' and its output text (what the OUTBOX received)
//   - runs.jsonl: one run row per step under the job's streamId, each reason 'done', at four distinct bays
// The line only DRAFTS: nothing is posted anywhere (no channel, no connector, no SEND TO).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.env.PROOF_MODEL || 'claude-sonnet-5-5';
const LINE = 'SOCIAL POST';
const ASK = process.env.PROOF_ASK || ('Build a new room named "SOCIAL STUDIO" beside the main room, joined by a hallway, and in it ONE workflow line named "SOCIAL POST" for making a social media post draft. '
  + 'The line: an intake, then four bays in order, then an outbox. Staff every bay with yourself (the lead); recruit no one. '
  + 'Bay 1 "PLAN": from the job (a product update or a clip description) pick the angle, the hook and the audience (ATAK hobbyists and developers; founder voice: authentic, technical, practical; Instagram-first, organic, no paid boosts). '
  + 'Bay 2 "CAPTION": write the caption, a call to action, hashtags and a pinned comment. '
  + 'Bay 3 "CLAIMS CHECK": check every claim in the draft is precise and supported by the job text; strike or flag anything that is not; never invent facts. '
  + 'Bay 4 "PACKAGE": deliver the final post text, pinned comment, and a short posting note. '
  + 'The line only drafts; it never posts anywhere. First read station.map and station.map {catalog:true}, plan with station.plan, build with station.build. '
  + 'Then send ONE test job down the line with station.test_line: "MeshFlow 0.1.23 is out on Google Play: live video from a phone or action camera onto an ATAK map over a mesh, no media server to set up." '
  + 'If the test job does not deliver, fix the line and test again. Do not set a schedule or trigger. Do not ask me anything first. At the end report what was built and what the test job delivered.');
const ARM = process.env.PROOF_ARM || 'claude';
const SKILL_DIR = process.env.PROOF_SKILL_DIR || join(homedir(), 'code', 'meshFlow');
const SKILL_ASK = 'Build a new room named "SOCIAL STUDIO" beside the main room, joined by a hallway, and in it ONE workflow line named "SOCIAL POST" for making a social media post draft. '
  + 'The line: an intake, then four bays in order, then an outbox. Bay 1 "PLAN": pick the angle, the hook and the audience. '
  + 'Bay 2 "CAPTION": write the caption, a call to action, hashtags and a pinned comment. Bay 3 "CLAIMS CHECK": check every claim against the job text and the conventions bay 2 cited; flag anything unsupported; never invent facts; keep the call to action. '
  + 'Bay 4 "PACKAGE": deliver the final post text, pinned comment and a short posting note. The line only drafts; it never posts anywhere. '
  + 'Staff bays 1, 3 and 4 with yourself (the lead). Staff bay 2 with a NEW specialist recruited for it (station.plan staff with agent "new"), then bind that new agent to the Commander\'s Claude Code skill "meshflow-social" in the folder ' + SKILL_DIR + ' with claude.skill_agent, so bay 2 writes the caption with the social crew\'s own skill and posting log. '
  + 'First read station.map and station.map {catalog:true}, plan with station.plan, build with station.build. '
  + 'Then send ONE test job down the line with station.test_line: "MeshFlow 0.1.23 is out on Google Play: live video from a phone or action camera onto an ATAK map over a mesh, no media server to set up." '
  + 'If the test job does not deliver, fix the line and test again. If a tool is refused, do not work around it: report it. Do not set a schedule or trigger. Do not ask me anything first. At the end report what was built, who staffs each bay, and what the test job delivered.';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const readJsonl = f => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) : [];

// Point the scratch station's default at the Claude login: the hero's provider pin + model, in the save the page boots from
// and in the roster the sidecar starts with.
function seedClaudeLogin(ws) {
  const saveFile = join(ws, 'agent.save.json');
  const save = JSON.parse(readFileSync(saveFile, 'utf8'));
  save.doc.prov = 'claude-cli';
  save.doc.agent.provider = 'claude-cli';
  save.doc.agent.model = MODEL;
  writeFileSync(saveFile, JSON.stringify(save, null, 2));
  const rosterFile = join(ws, 'agent.roster.json');
  const roster = JSON.parse(readFileSync(rosterFile, 'utf8'));
  for (const a of roster.agents) { a.provider = 'claude-cli'; a.model = MODEL; }
  writeFileSync(rosterFile, JSON.stringify(roster, null, 2));
}

// Each step's OWN reply, from the station's transcript store (an assistant row whose sourceRunId is that step's run):
// the run rows carry the bay, provider and tokens but not the text the step handed on.
function stepReport(ws, job, steps) {
  const tdir = join(ws, 'transcript-history-v2');
  const rows = existsSync(tdir) ? readdirSync(tdir).filter(f => f.endsWith('.jsonl')).flatMap(f => readJsonl(join(tdir, f))) : [];
  let o = '# Line job ' + job.id + ' · ' + job.status + ' · $' + (job.usd || 0) + '\n\n## Per-step run records (runs.jsonl)\n\n';
  for (const r of steps) o += '- ' + new Date(r.ts || 0).toISOString() + ' · bay ' + r.dockId + ' · agent ' + r.agentId + ' · provider ' + r.provider + ' · model ' + r.model
    + ' · reason ' + r.reason + ' · tokens ' + r.tokens + ' · ' + r.durationMs + ' ms · runId ' + r.runId + '\n';
  steps.forEach((r, i) => {
    const said = rows.filter(t => t.sourceRunId === r.runId && t.role === 'assistant').map(t => String(t.content || '').trim()).filter(Boolean);
    o += '\n## Step ' + (i + 1) + ' (bay ' + r.dockId + ') — its own reply\n\n' + (said.join('\n\n') || '(no transcript row for this run)') + '\n';
  });
  return o + '\n## What the OUTBOX delivered (line-jobs.json output)\n\n' + String(job.output || '').trim() + '\n';
}

async function main() {
  const ws = mkdtempSync(join(tmpdir(), 'sn-socialline-'));
  cpSync(join(REPO, 'dev', 'fixtures', 'seed-workspace'), ws, { recursive: true });
  const fixtureArm = ARM === 'fixture', skillArm = ARM === 'skill' || ARM === 'skill-off';
  if (fixtureArm) {   // the trial's setup: the model alone set on the hero, its provider pin left at the fixture's openrouter
    const f = join(ws, 'agent.save.json'); const s = JSON.parse(readFileSync(f, 'utf8')); s.doc.agent.model = MODEL; writeFileSync(f, JSON.stringify(s, null, 2));
  } else seedClaudeLogin(ws);
  const out = process.env.PROOF_OUT || ws; mkdirSync(out, { recursive: true });
  const port = await freePort(), cdpPort = await freePort();
  const env = Object.assign({}, process.env, { STARNET_WORKSPACES: ws, SKYNET_WORKSPACES: ws, STARNET_PORT: String(port), SKYNET_PORT: String(port), SKYNET_DEV: '1', STARNET_AUTO_BUILD: '1' });
  for (const k of ['SKYNET_FULL_ACCESS', 'STARNET_FULL_ACCESS', 'SKYNET_AUTO_BUILD', 'STARNET_AUTO_BUILD_CREW', 'SKYNET_AUTO_BUILD_CREW', 'STARNET_OVERSEER_SESSION', 'STARNET_CLAUDE_CREW', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']) delete env[k];
  if (ARM === 'skill') env.STARNET_AUTO_BUILD_CREW = '1';
  const side = spawn(process.execPath, [join(REPO, 'sidecar', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; side.stdout.on('data', d => logs.push(d)); side.stderr.on('data', d => logs.push(d));
  let chrome = null, cdp = null, pass = false;
  try {
    for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) break; } catch (_) {} await sleep(500); }
    const prof = join(ws, 'chrome'); mkdirSync(prof, { recursive: true });
    ({ proc: chrome } = launchChrome({ cdpPort, profileDir: prof }));
    cdp = await connectCDP(cdpPort); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { ready = !!(await evalJS(cdp, `typeof App!=='undefined'&&App.station&&!!App.station()&&!!App.station().rooms`).catch(() => false)); if (!ready) await sleep(500); }
    if (!ready) throw new Error('the station page never became ready');
    await sleep(4000);   // the page's roster push + SSE subscription (the station bridge) settle
    const hero = JSON.parse(readFileSync(join(ws, 'agent.roster.json'), 'utf8')).agents.find(a => a.agentId === 'agent') || {};
    console.log('station default (server roster, hero): provider=' + hero.provider + ' model=' + hero.model);
    if (!fixtureArm && (hero.provider !== 'claude-cli' || !hero.model)) throw new Error('the page did not keep the hero on claude-cli — the test job would not run on the Claude login');

    const t0 = Date.now();
    const cli = spawnSync(process.execPath, [join(REPO, 'bin', 'starnet.js'), '--port', String(port), '--no-spawn', '--json', '--provider', 'claude-cli', '--model', MODEL, '--timeout', '2400', '-p', skillArm ? SKILL_ASK : ASK],
      { env, encoding: 'utf8', timeout: 2500000, cwd: REPO, maxBuffer: 64 << 20 });
    writeFileSync(join(out, 'cli-stdout.txt'), String(cli.stdout || '')); writeFileSync(join(out, 'cli-stderr.txt'), String(cli.stderr || ''));
    console.log('starnet -p exit ' + cli.status + ' after ' + Math.round((Date.now() - t0) / 1000) + 's');
    const rooms = await evalJS(cdp, `App.station().rooms().filter(r=>r&&r.kind!=='corridor').map(r=>r.name||'')`);
    console.log('rooms on the floor: ' + JSON.stringify(rooms));

    // ---- the oracle: the station's own records ----
    const jobsDoc = existsSync(join(ws, 'line-jobs.json')) ? JSON.parse(readFileSync(join(ws, 'line-jobs.json'), 'utf8')) : {};
    const findJobs = o => !o || typeof o !== 'object' ? null : Array.isArray(o.jobs) ? o.jobs : Object.values(o).map(findJobs).find(Boolean) || null;
    const jobs = findJobs(jobsDoc) || [];
    const runs = readJsonl(join(ws, 'runs.jsonl'));
    writeFileSync(join(out, 'line-jobs.json'), JSON.stringify(jobsDoc, null, 2));
    writeFileSync(join(out, 'runs.jsonl'), runs.map(r => JSON.stringify(r)).join('\n') + '\n');
    console.log('\nline jobs recorded: ' + jobs.length);
    for (const j of jobs) console.log('  job ' + j.id + ' · ' + (j.status || '?') + ' · $' + (j.usd || 0) + (j.error ? ' · error: ' + j.error : ''));
    const delivered = jobs.filter(j => j && j.status === 'delivered' && String(j.output || '').trim());
    const job = delivered[delivered.length - 1] || null;
    if (job) {
      const ids = new Set((job.runs || []).map(r => r.runId));
      const steps = runs.filter(r => ids.has(r.runId)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      console.log('\nper-step run records of the delivered job (runs.jsonl):');
      for (const r of steps) console.log('  ' + new Date(r.ts || 0).toISOString().slice(11, 19) + ' bay=' + (r.dockId || '?') + ' agent=' + r.agentId + ' provider=' + (r.provider || '?') + ' model=' + (r.model || '?') + ' reason=' + r.reason + ' usd=' + (r.usd == null ? '-' : r.usd));
      const bays = new Set(steps.map(r => r.dockId).filter(Boolean));
      const allDone = steps.length >= 4 && steps.every(r => r.reason === 'done');
      const onClaude = steps.every(r => !r.provider || /^claude-cli$/.test(String(r.provider)));
      console.log('\nOUTBOX delivered (' + String(job.output).length + ' chars):\n' + '-'.repeat(60) + '\n' + String(job.output).trim() + '\n' + '-'.repeat(60));
      pass = allDone && bays.size >= 4 && onClaude;
      if (skillArm) {
        const bindings = existsSync(join(ws, 'claude-skill-agents.json')) ? (JSON.parse(readFileSync(join(ws, 'claude-skill-agents.json'), 'utf8')).agents || {}) : {};
        const boundIds = Object.keys(bindings).filter(id => bindings[id].skill === 'meshflow-social');
        console.log('crew-skill bindings on disk: ' + JSON.stringify(bindings));
        const tdir = join(ws, 'transcript-history-v2');
        const trows = existsSync(tdir) ? readdirSync(tdir).filter(f => f.endsWith('.jsonl')).flatMap(f => readJsonl(join(tdir, f))) : [];
        const skillSteps = steps.filter(r => boundIds.indexOf(r.agentId) >= 0);
        const said = r => trows.filter(t => t.sourceRunId === r.runId && t.role === 'assistant').map(t => String(t.content || '')).join('\n');
        const cta = /join the free alpha/i;
        for (const r of skillSteps) console.log('skill step: bay=' + r.dockId + ' agent=' + r.agentId + ' provider=' + r.provider + ' reason=' + r.reason + ' · its reply names the skill\'s standing CTA: ' + cta.test(said(r)));
        const loaded = skillSteps.length > 0 && skillSteps.every(r => r.provider === 'claude-cli' && r.reason === 'done' && cta.test(said(r)));
        console.log('the delivered draft mentions the skill CTA (used or cited, not required): ' + cta.test(String(job.output)));
        pass = ARM === 'skill' ? (pass && loaded) : false;
      }
      writeFileSync(join(out, 'proof-report.md'), stepReport(ws, job, steps));
      console.log('per-step report: ' + join(out, 'proof-report.md'));
      console.log('steps=' + steps.length + ' distinct bays=' + bays.size + ' all done=' + allDone + ' on claude-cli=' + onClaude);
    } else {
      const last = jobs[jobs.length - 1];
      console.log('no delivered job' + (last ? ' — last job: ' + JSON.stringify({ status: last.status, error: last.error }) : ''));
      if (fixtureArm) pass = !!last && last.status === 'failed' && /has no roster model|OPENROUTER API key/i.test(String(last.error || '')) && !(last.usd > 0);
    }
    if (ARM === 'skill-off') {
      // the before-arm: with the crew switch off, the bind is refused (non-interactive default deny) and nothing is bound
      const bindings = existsSync(join(ws, 'claude-skill-agents.json')) ? (JSON.parse(readFileSync(join(ws, 'claude-skill-agents.json'), 'utf8')).agents || {}) : {};
      let rec = null; try { rec = JSON.parse(String(cli.stdout || '').trim().split('\n').pop()); } catch (_) {}
      const binds = ((rec && rec.toolCalls) || []).filter(t => /claude[._]skill_agent/.test(t.name || ''));
      console.log('claude.skill_agent calls: ' + JSON.stringify(binds.map(t => t.summary)) + ' · bindings on disk: ' + JSON.stringify(bindings));
      pass = binds.length > 0 && binds.every(t => /denied|refused/i.test(String(t.summary || ''))) && Object.keys(bindings).length === 0;
    }
    let receipt = null; try { receipt = JSON.parse(String(cli.stdout || '').trim().split('\n').pop()); } catch (_) {}
    if (receipt && Array.isArray(receipt.toolCalls)) console.log('\nlead tool calls: ' + receipt.toolCalls.map(t => t.name + '(' + (t.summary || '') + ')').join(', '));
  } finally {
    writeFileSync(join(ws, 'sidecar.log'), Buffer.concat(logs));
    try { cdp && cdp.close && cdp.close(); } catch (_) {}
    try { chrome && chrome.kill('SIGTERM'); } catch (_) {}
    side.kill('SIGTERM');
    await sleep(1500);
    if (!process.env.PROOF_KEEP) try { rmSync(ws, { recursive: true, force: true }); } catch (_) {} else console.log('workspace kept: ' + ws);
  }
  console.log('\nRESULT: ' + (pass ? 'PASS' : 'FAIL') + (fixtureArm ? ' (fixture arm: the job was expected to fail on the openrouter pin)' : ARM === 'skill-off' ? ' (skill-off arm: the bind was expected to be denied)' : ''));
  process.exit(pass ? 0 : 1);
}
// node dev/social-line-proof.mjs --report <kept workspace> <out.md>: re-write the per-step report of a kept run
if (process.argv[2] === '--report') {
  const ws = process.argv[3], f = process.argv[4];
  const findJobs = o => !o || typeof o !== 'object' ? null : Array.isArray(o.jobs) ? o.jobs : Object.values(o).map(findJobs).find(Boolean) || null;
  const job = (findJobs(JSON.parse(readFileSync(join(ws, 'line-jobs.json'), 'utf8'))) || []).filter(j => j.status === 'delivered').pop();
  const ids = new Set(((job && job.runs) || []).map(r => r.runId));
  const steps = readJsonl(join(ws, 'runs.jsonl')).filter(r => ids.has(r.runId)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  writeFileSync(f, job ? stepReport(ws, job, steps) : 'no delivered job in ' + ws + '\n'); console.log('wrote ' + f); process.exit(job ? 0 : 1);
} else main().catch(e => { console.error('proof error: ' + (e && e.stack || e)); process.exit(2); });

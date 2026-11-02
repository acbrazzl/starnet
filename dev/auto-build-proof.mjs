// dev/auto-build-proof.mjs — LIVE A/B proof of AUTO-BUILD (fork): the Overseer's path to the station builder.
//
//   SKYNET_CHROME=~/.local/bin/chrome-nosandbox node dev/auto-build-proof.mjs [on|off|both]
//
// For each arm it boots a THROWAWAY station (scratch workspace from dev/fixtures/seed-workspace, an OS-assigned port,
// Full Access OFF — unlike dev/seed.js, which turns it on and would make the A/B meaningless), attaches a headless
// station page (the floor is page-owned: station.plan/build need one), then runs the exact command the Overseer would:
//   node bin/starnet.js --port <p> --json -p "<build request>"      (no --yes)
// and reads the floor back from the page. The oracle is the ROOM ON THE FLOOR, never the model's own report.
//   on  (STARNET_AUTO_BUILD=1): the room is built, with no approval asked
//   off (unset):                 the build is refused (the CLI's non-interactive default is DENY); no room
// It uses the Commander's own `claude` login (provider claude-cli). Nothing touches the live station on :8787.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOM = 'PROOF BAY';
const MODEL = process.env.PROOF_MODEL || 'claude-sonnet-5-5';
const ask = 'Build one new small room named "' + ROOM + '" beside the main room, joined to it by a hallway. ' +
  'Plan it with station.plan, then build it with station.build. Do not ask me anything first; just do it.';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

async function arm(autoBuild) {
  const label = autoBuild ? 'ON ' : 'OFF';
  const ws = mkdtempSync(join(tmpdir(), 'sn-autobuild-'));
  cpSync(join(REPO, 'dev', 'fixtures', 'seed-workspace'), ws, { recursive: true });
  const rosterFile = join(ws, 'agent.roster.json');
  const roster = JSON.parse(readFileSync(rosterFile, 'utf8'));
  for (const a of roster.agents) if (a.agentId === 'agent') { a.provider = 'claude-cli'; a.model = MODEL; }
  writeFileSync(rosterFile, JSON.stringify(roster, null, 2));
  const port = await freePort(), cdpPort = await freePort();
  const env = Object.assign({}, process.env, { STARNET_WORKSPACES: ws, SKYNET_WORKSPACES: ws, STARNET_PORT: String(port), SKYNET_PORT: String(port), SKYNET_DEV: '1' });
  for (const k of ['SKYNET_FULL_ACCESS', 'STARNET_FULL_ACCESS', 'STARNET_AUTO_BUILD', 'SKYNET_AUTO_BUILD', 'STARNET_OVERSEER_SESSION', 'STARNET_CLAUDE_CREW']) delete env[k];
  if (autoBuild) env.STARNET_AUTO_BUILD = '1';
  const log = join(ws, 'sidecar.log');
  const side = spawn(process.execPath, [join(REPO, 'sidecar', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; side.stdout.on('data', d => logs.push(d)); side.stderr.on('data', d => logs.push(d));
  let chrome = null, cdp = null;
  try {
    for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) break; } catch (_) {} await sleep(500); }
    const prof = join(ws, 'chrome'); mkdirSync(prof, { recursive: true });
    ({ proc: chrome } = launchChrome({ cdpPort, profileDir: prof }));
    cdp = await connectCDP(cdpPort); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { ready = !!(await evalJS(cdp, `typeof App!=='undefined'&&App.station&&!!App.station()&&!!App.station().rooms`).catch(() => false)); if (!ready) await sleep(500); }
    if (!ready) throw new Error('the station page never became ready');
    await sleep(3000);   // the page's SSE subscription (the station bridge) settles
    const roomsOf = () => evalJS(cdp, `App.station().rooms().filter(r=>r&&r.kind!=='corridor').map(r=>r.name||'')`);
    const before = await roomsOf();
    const cli = spawnSync(process.execPath, [join(REPO, 'bin', 'starnet.js'), '--port', String(port), '--no-spawn', '--json', '--provider', 'claude-cli', '--model', MODEL, '--timeout', '420', '-p', ask],
      { env: Object.assign({}, env), encoding: 'utf8', timeout: 480000, cwd: REPO });
    await sleep(1500);
    const after = await roomsOf();
    const built = after.some(n => String(n).toUpperCase() === ROOM) && !before.some(n => String(n).toUpperCase() === ROOM);
    const stderr = String(cli.stderr || '');
    const consentLines = stderr.split('\n').filter(l => /consent|approv|auto-build|denied|refused|station\.(plan|build)/i.test(l)).slice(0, 20);
    let receipt = null; try { receipt = JSON.parse(String(cli.stdout || '').trim().split('\n').pop()); } catch (_) {}
    console.log('\n=== AUTO-BUILD ' + label + ' — port ' + port + ', workspace ' + ws);
    console.log('rooms before: ' + JSON.stringify(before));
    console.log('rooms after:  ' + JSON.stringify(after));
    console.log('room "' + ROOM + '" built: ' + built + '   (cli exit ' + cli.status + ')');
    console.log('consent/tool lines from the CLI:\n  ' + (consentLines.join('\n  ') || '(none)'));
    if (receipt) console.log('receipt: ' + JSON.stringify({ reason: receipt.reason, text: String(receipt.text || '').slice(0, 400), error: receipt.error }));
    if (receipt && Array.isArray(receipt.toolCalls)) console.log('tool calls:\n  ' + (receipt.toolCalls.map(t => JSON.stringify(t).slice(0, 260)).join('\n  ') || '(none)'));
    if (cli.status !== 0) console.log('cli stderr tail:\n  ' + stderr.trim().split('\n').slice(-6).join('\n  '));
    writeFileSync(log, Buffer.concat(logs));
    return { autoBuild, built, exit: cli.status, ws };
  } finally {
    try { cdp && cdp.close && cdp.close(); } catch (_) {}
    try { chrome && chrome.kill('SIGTERM'); } catch (_) {}
    side.kill('SIGTERM');
    await sleep(1500);
    if (!process.env.PROOF_KEEP) try { rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
}

const which = process.argv[2] || 'both';
const results = [];
if (which === 'on' || which === 'both') results.push(await arm(true));
if (which === 'off' || which === 'both') results.push(await arm(false));
const ok = results.every(r => r.built === r.autoBuild);
console.log('\nRESULT: ' + (ok ? 'PASS' : 'FAIL') + ' — ' + results.map(r => (r.autoBuild ? 'ON built=' : 'OFF built=') + r.built).join(', '));
process.exit(ok ? 0 : 1);

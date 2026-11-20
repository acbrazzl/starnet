// dev/station-page.mjs — keep ONE headless station page attached to a running station, so a `starnet -p` lead can BUILD.
//
//   SKYNET_CHROME=~/.local/bin/chrome-nosandbox node dev/station-page.mjs --port <station port> [--cdp <port>] [--profile <dir>]
//
// The floor is page-owned (sidecar/station-bridge.js): station.map / station.plan / station.build AND station.test_line ask
// the open station page and FAIL with a reason when none is attached ("no station page answered — open StarNet to run
// station commands", measured 2026-11-14 for test_line after a 6 s bridge wait). claude.skill_agent and routine.* run in
// the sidecar and do not need one. This opens the station in headless Chromium, waits until the station is ready,
// prints `PAGE READY <url>` and stays attached until SIGTERM/SIGINT (then closes Chromium).
//
// ⚠ THE PAGE IS A WRITER, not a viewer: it owns the roster and agent.save.json and pushes them. Two pages on one station
// (this one + the Commander's tab or phone) are two writers; the station merges roster rows and refuses a stale save, but
// a refused save leaves an agent.save-conflict-*.json behind. On the LIVE station attach this only while no other station
// tab is open, and close it when the build is done. Throwaway stations: no caveat.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const port = Number(arg('--port', process.env.STARNET_PORT || ''));
if (!port) { console.error('usage: node dev/station-page.mjs --port <station port> [--cdp <port>] [--profile <dir>]'); process.exit(2); }
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const cdpPort = Number(arg('--cdp', '')) || await freePort();
const profile = arg('--profile', '') || mkdtempSync(join(tmpdir(), 'sn-station-page-'));
mkdirSync(profile, { recursive: true });

const url = 'http://127.0.0.1:' + port + '/';
const { proc: chrome } = launchChrome({ cdpPort, profileDir: profile });
let closing = false;
const close = (code) => { if (closing) return; closing = true; try { chrome.kill('SIGTERM'); } catch (_) {} setTimeout(() => process.exit(code), 500); };
process.on('SIGTERM', () => close(0)); process.on('SIGINT', () => close(0));
chrome.on('exit', () => { if (!closing) { console.error('PAGE LOST: Chromium exited'); process.exit(1); } });
try {
  const cdp = await connectCDP(cdpPort); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) { ready = !!(await evalJS(cdp, `typeof App!=='undefined'&&App.station&&!!App.station()&&!!App.station().rooms`).catch(() => false)); if (!ready) await sleep(500); }
  if (!ready) { console.error('PAGE FAILED: the station page never became ready at ' + url); close(1); }
  else { await sleep(3000); console.log('PAGE READY ' + url + ' (cdp ' + cdpPort + ', profile ' + profile + ')'); }
} catch (e) { console.error('PAGE FAILED: ' + ((e && e.message) || e)); close(1); }

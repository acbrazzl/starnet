/* node test/remote-host-floor.test.js — the every-path Host floor honours STARNET_REMOTE_HOSTS (fork, 2026-11-16).
   Live bug: after the 11-14 cutover the phone page at http://<zerotier-ip>:8787/ answered 403 "forbidden host",
   because the DNS-rebinding floor (sidecar/index.js, the main server) called isAllowedHost(host) WITHOUT the
   configured remote hosts, while the /api gate passed them. A listed remote host must load the page; any other
   host must still be refused. Boots the real sidecar. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const REMOTE = '172.23.17.189';
(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-remotehost-', env: { STARNET_REMOTE_HOSTS: REMOTE } });
  await fixture.start();
  const u = new URL(fixture.baseUrl);
  const get = (p, host) => new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers: { Host: host } }, (res) => {
      let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  try {
    const listed = await get('/', REMOTE + ':' + u.port);
    A.eq(listed.status, 200, 'a host listed in STARNET_REMOTE_HOSTS loads the station page (was 403 forbidden host)');
    A.ok(!/forbidden host/.test(listed.body), 'the listed host is not refused by the Host floor');
    const loop = await get('/', '127.0.0.1:' + u.port);
    A.eq(loop.status, 200, 'loopback still loads the page');
    const other = await get('/', '172.23.17.190:' + u.port);
    A.eq(other.status, 403, 'a host NOT in the list is still refused (rebinding floor intact)');
    const evil = await get('/', 'rebind.evil.example:' + u.port);
    A.eq(evil.status, 403, 'a rebound name is still refused');
    A.ok(!/__STARNET_API_TOKEN__/.test(other.body + evil.body), 'refused hosts get no API token');
  } finally {
    await fixture.dispose();
  }
  A.report('remote-host-floor.test');
})().catch(e => { console.log('FAIL: remote-host-floor.test threw -- ' + (e && e.stack || e)); process.exit(1); });

#!/usr/bin/env node
/* dev/overlay-forward.js — expose the loopback station on ONE overlay-network address (e.g. ZeroTier).

   The sidecar binds 127.0.0.1 only. This forwards raw TCP from <listen-ip>:<port> to 127.0.0.1:<port>, so the
   browser's Host header stays `<listen-ip>:<port>` — the sidecar accepts it only when that exact IP is listed in
   STARNET_REMOTE_HOSTS (see sidecar/apiauth.js). It listens on the ONE address given, never 0.0.0.0, so the
   station is reachable from the overlay (and nothing else on this machine's other networks).

     node dev/overlay-forward.js <listen-ip> [port=8787]                                                   */
'use strict';
const net = require('node:net');

const ip = String(process.argv[2] || '');
const port = Number(process.argv[3] || process.env.STARNET_PORT || 8787);
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.startsWith('0.') || ip === '127.0.0.1') {
  console.error('usage: node dev/overlay-forward.js <overlay-ipv4> [port]  (a specific address, never 0.0.0.0/loopback)');
  process.exit(2);
}

const server = net.createServer(client => {
  const upstream = net.connect(port, '127.0.0.1');
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close); upstream.on('error', close);
  client.pipe(upstream); upstream.pipe(client);
});
server.on('error', e => { console.error('overlay-forward: ' + e.message); process.exit(1); });
server.listen(port, ip, () => console.log('overlay-forward: http://' + ip + ':' + port + '/ -> 127.0.0.1:' + port));

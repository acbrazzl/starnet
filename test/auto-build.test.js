/* node test/auto-build.test.js — AUTO-BUILD (fork, STARNET_AUTO_BUILD=1): the Commander's standing yes for the lead's
   station building, workflow lines and schedules. Proves the tier allows exactly the named tools on every surface, and
   that everything around it still asks or refuses: the paid prop maker, a fresh-consent escalation, shell, the
   hardline floor, confirm-every-time. Also locks the host wiring (the named set, lead-only, routing of terminal runs). */
'use strict';
const A = require('./_assert.js');
const { makeConsentBroker } = require('../sidecar/permissions.js');
const src = require('./helpers/source.js').readSidecarSource();

const NAMED = new Set(['station.plan', 'station.build', 'station.test_line', 'station.start_line',
  'routine.create', 'routine.manage', 'task.create', 'task.manage']);
const tool = (name, extra) => Object.assign({ name, capability: 'orchestrator', scope: 'write', requiresConsent: true }, extra || {});
const call = name => ({ name, args: {} });
const broker = (o) => makeConsentBroker(Object.assign({ surface: 'autonomous', autoBuild: c => NAMED.has(c.name) }, o || {}));

(async () => {
  // ---- the tier allows the named tools, on an unattended surface too ----
  for (const n of NAMED) {
    const d = broker()(call(n), tool(n));
    A.eq(d.allow, true, 'auto-build allows ' + n + ' with nobody watching');
    A.ok(/auto-build/.test(d.reason), n + ': the receipt names the auto-build grant');
  }
  // ---- …and nothing else on the same orchestrator:write class ----
  const prop = broker()(call('station.make_prop'), tool('station.make_prop', { taintLocked: true }));
  A.eq(prop.allow, false, 'station.make_prop (spends StarNet credits) is NOT covered: an unattended run is refused');
  let asked = 0;
  const live = await broker({ surface: 'interactive', prompt: () => { asked++; return 'once'; } })(call('station.make_prop'), tool('station.make_prop'));
  A.eq([live.allow, asked], [true, 1], 'station.make_prop still asks the Commander on a watched run');
  asked = 0;
  const built = await broker({ surface: 'interactive', prompt: () => { asked++; return 'deny'; } })(call('station.build'), tool('station.build'));
  A.eq([built.allow, asked], [true, 0], 'station.build on a watched run lands without an approval card');

  // ---- the tier never widens past its guards ----
  A.eq(broker({ autoBuild: () => true })(call('x.exec'), tool('x.exec', { scope: 'execute' })).allow, false, 'never an execute-scope tool (no shell from this tier)');
  A.eq(broker({ autoBuild: () => true })(call('station.power'), tool('station.power', { freshConsent: true, consentKey: 'station.power' })).allow, false, 'never a fresh-consent escalation');
  const floor = broker({ autoBuild: () => true, hardline: () => 'protected' })(call('station.build'), tool('station.build'));
  A.eq([floor.allow, !!floor.hardline], [false, true], 'the hardline floor still wins');
  const cet = broker({ autoBuild: () => true })(call('claude.send'), tool('claude.send', { confirmEveryTime: true }));
  A.eq(cet.allow, false, 'confirm-every-time (Claude crew hand-offs) is untouched: unattended is refused');
  A.eq(broker({ autoBuild: () => { throw new Error('boom'); } })(call('station.build'), tool('station.build')).allow, false, 'a throwing predicate fails closed');
  A.eq(makeConsentBroker({ surface: 'autonomous' })(call('station.build'), tool('station.build')).allow, false, 'no autoBuild injected: behaves exactly as before');

  // ---- host wiring (index.js) ----
  const m = /const AUTO_BUILD_TOOLS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  A.ok(!!m, 'AUTO_BUILD_TOOLS is declared');
  const hostSet = new Set(((m && m[1]) || '').match(/'[^']+'/g).map(x => x.slice(1, -1)));
  A.eq([...hostSet].sort(), [...NAMED].sort(), 'the host set is exactly the named build/workflow/schedule tools');
  A.ok(!hostSet.has('station.make_prop') && !hostSet.has('station.power') && !hostSet.has('station.control'), 'paid and escalating tools are not in it');
  A.ok(/AUTO_BUILD = \/\^\(1\|true\|yes\|on\)\$\/i\.test\(String\(ENV\('AUTO_BUILD'\)/.test(src), 'opt-in: off unless STARNET_AUTO_BUILD is set');
  // the predicate itself, run from the host source under each switch (AUTO-BUILD CREW, 2026-11-14: a SEPARATE opt-in)
  const block = /const AUTO_BUILD = [\s\S]*?\nfunction autoBuildAllows\(agentId, call\) \{[\s\S]*?\n\}/.exec(src);
  A.ok(!!block, 'the AUTO_BUILD switches and autoBuildAllows are declared together');
  const allows = env => require('vm').runInNewContext((block ? block[0] : '') + '\n;autoBuildAllows', { ENV: k => env[k], String, Set });
  const off = allows({}), on = allows({ AUTO_BUILD: '1' }), crew = allows({ AUTO_BUILD: '1', AUTO_BUILD_CREW: '1' }), crewOnly = allows({ AUTO_BUILD_CREW: '1' });
  A.eq(off('agent', call('station.build')), false, 'off unless STARNET_AUTO_BUILD is set');
  A.eq(on('agent', call('station.build')), true, 'AUTO_BUILD allows the named build tools for the lead');
  A.eq(on('engineer', call('station.build')), false, 'the lead only');
  A.eq([on('agent', call('team.summon')), on('agent', call('claude.skill_agent'))], [false, false], 'AUTO_BUILD alone does NOT cover adding crew or binding a skill (the 11-02 list is not widened)');
  A.eq([crew('agent', call('team.summon')), crew('agent', call('claude.skill_agent'))], [true, true], 'STARNET_AUTO_BUILD_CREW=1 adds team.summon + claude.skill_agent');
  A.eq(crew('engineer', call('claude.skill_agent')), false, 'still the lead only');
  A.eq([crewOnly('agent', call('claude.skill_agent')), crewOnly('agent', call('station.build'))], [false, false], 'the crew switch does nothing without AUTO_BUILD itself');
  A.eq([crew('agent', call('station.make_prop')), crew('agent', call('station.control')), crew('agent', call('claude.adopt'))], [false, false, false], 'the crew switch covers nothing else (paid prop, control, adopt still ask)');
  A.ok(/autoBuild: \(call\) => autoBuildAllows\(agentId, call\)/.test(src), 'every run\'s broker gets the predicate');
  A.ok(/const routedToOverseer = [^\n]*&& !o\.stationClient\);/.test(src), 'a terminal/editor run is never routed into the Overseer session');
  A.ok(/stationClient: \(body && \(body\.client === 'terminal' \|\| body\.client === 'editor'\)\) \? body\.client : ''/.test(src), '/api/run passes the client through');

  A.report('auto-build.test');
})().catch(e => { console.error(e); process.exit(1); });

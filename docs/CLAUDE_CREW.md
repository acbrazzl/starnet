# Claude Crew — Claude Code sessions on the station floor

Claude Crew puts your running [Claude Code](https://claude.com/claude-code) sessions on the StarNet floor.
Each live session is a crew body: seated and "working…" while the session is busy, strolling while it is idle,
gone when the session ends. From the station you can also start new sessions, and each new session gets a
claude.ai/code Remote Control link, so you can drive it from your phone.

The feature is opt-in and disabled by default:

```bash
STARNET_CLAUDE_CREW=1 node sidecar/index.js
```

## What it is — and what it is not

StarNet does **not** run these agents. It never calls a model for them, never meters their spend, and never
adds them to the roster. The roster is what `team.dispatch`, cron and channels run against, so an external
session in it would make StarNet try to drive it. Claude Crew is a projection of the `claude` CLI's own truth:

| Station action | CLI call (argv, no shell) |
|---|---|
| show sessions (polled, cached ≥2.5s) | `claude agents --json` |
| **CLAUDE** header button → tappable list | same listing |
| + NEW SESSION | `claude --bg --remote-control <name> --name <name> --permission-mode <mode> -- <prompt>` in the chosen directory |
| tap a body / row → OPEN REMOTE | the `https://claude.ai/code/session_…` URL scraped from `claude logs <id>` |
| STOP | `claude stop <id>` |

**Skills.** A new session can start with one of your Claude Code skills (`~/.claude/skills/*/SKILL.md`, plus
`STARNET_CLAUDE_SKILL_DIRS`). Its first line becomes `/<skill>`, so Claude Code loads the skill itself. With no
message, it loads the skill, orients read-only, reports readiness and waits.

**The Overseer can staff the crew.** The lead agent gets three tools on the orchestrator capability:
- `claude.crew` (read): lists the sessions and the available skills.
- `claude.launch` (execute, consent): starts a session, optionally skilled, in `STARNET_CLAUDE_CREW_DIR` or a
  given trusted directory.
- `claude.stop` (consent): stops a background session.

So "spin up a social agent" works from COMMS.

**Messaging any session, terminal ones included.** The `claude` CLI has no send command, but every session has
Claude Code's built-in SendMessage. `POST /api/claude-crew/send`, the card's MESSAGE box, and the lead's
consent-gated `claude.send` all run a one-shot relay for this. The relay is `claude -p` restricted to
`--tools SendMessage`, with no MCP servers, settings or persistence. It is told to call the tool once,
verbatim. The relay's stream is then checked: recipient and text must match exactly, and the tool result must
report success. Otherwise the send is reported failed or altered. The recipient handles the message as a
teammate message within its own permission settings; a peer cannot escalate or approve pending prompts. The
relay exits immediately, so the message says replies stay in the recipient's own session.

Terminal (interactive) sessions are shown read-only. They have no background id to stop or read logs from;
run `/remote-control` inside one to reach it from your phone.

## Auth — your Claude login, not an API key

Every session runs as **your own `claude` binary** under whatever login it already holds (`claude auth
status`), normally a claude.ai subscription login. StarNet never reads, copies or forwards a Claude
credential. It has no key to leak because it never touches one.

## Consent

**Skip-permissions crews (opt-in).** `STARNET_CLAUDE_CREW_ALLOW_BYPASS=1` adds Claude Code's
`bypassPermissions` mode. It can also be the station default; `dontAsk` stays refused.

**Managed sessions — who the Overseer may drive.** The station records every Claude session it launched, and
every pre-existing session the Commander let it take over (`claude-crew.managed.json` in the workspace).

| Lead tool | Approval |
|---|---|
| `claude.launch` | never; launched sessions are the station's |
| `claude.send`, `claude.stop` | never, but managed sessions only |
| `claude.adopt` | taking over a pre-existing session (e.g. the Commander's own terminal): asked **once per session**. It uses the `confirmEveryTime` consent tier: above Full Power, never cached, and refused on unattended runs. It is then recorded, so it is never asked again. |

The card's **LET OVERSEER MANAGE / RELEASE** button does the same from the station (the click is the approval).
The Commander's own SEND box is never gated.

`STARNET_CLAUDE_CREW_MODE` sets the station's default mode for new sessions. The choices are `default` (ask
before each action), `auto` (routine actions proceed and risky ones still ask), `plan` and `acceptEdits`.
Unset means `default`. `dev/remote-station-zerotier.sh` reads personal settings from
`~/.config/starnet/remote.env`.


Permission escalation defaults to deny. New sessions accept only `default` (ask; you answer over Remote
Control), `plan`, `acceptEdits` or `auto`. `bypassPermissions` and `dontAsk` are refused. The directory
must be one Claude Code already trusts; otherwise the CLI's "workspace not trusted" error is shown as-is.

## Claude as the Overseer's brain ("Claude Code" provider)

Upstream now ships this provider itself: **CLAUDE CODE** (`claude-cli`, `sidecar/providers/claude-cli.js`, see
`docs/CLAUDE_CLI_PROVIDER.md`). The fork's earlier `claudecode` provider and its catalog-only MCP shim were retired
in the 2026-11 upstream sync in favour of it. `claudecode` and `claude-login` stay as **aliases** of `claude-cli`
(registry + the frontend normalizers), so a station saved with the old id still loads on the Claude login.

The Overseer session (below) keys on the normalized id: an interactive COMMS turn to the hero is routed to the
persistent session when the hero's provider normalizes to `claude-cli`.

## The Overseer as one persistent Claude Code session (opt-in)

`STARNET_OVERSEER_SESSION=1` (with the Claude-login brain and Claude crew on) runs the hero agent as **one
continuous Claude Code background session with Remote Control**, instead of a fresh `claude -p` per turn. It is
the same kind of session the Commander uses at their own terminal: full tools, skills, CLAUDE.md, auto-memory and
subagents, in `STARNET_CLAUDE_CREW_DIR`, with the station's crew permission mode. The Overseer's name, purpose,
context and standing orders are appended to Claude Code's own prompt.

**One session, three screens.** StarNet types each COMMS message into the session through a `claude attach` PTY
(a genuine user turn) and streams the reply from the session's transcript. The same conversation is open in the
Claude app (Remote Control) and at a terminal (`claude attach`). Only interactive COMMS turns to the hero go to it;
internal or auxiliary runs keep the stateless brain, so they never pollute the conversation.

**Lifecycle.** The session starts with StarNet and stops in `gracefulShutdown`. The next boot resumes the same
conversation (`STARNET_OVERSEER_SESSION_FRESH=1` starts clean instead). The session is excluded from the Claude crew
list, because it *is* the Overseer.

**Playbook.** `STARNET_OVERSEER_SKILL=<skill>` tells the session to load that Claude Code skill at start and after every
compaction (e.g. a role playbook kept in `~/.claude/skills`).

**Keep-alive.** With `STARNET_OVERSEER_SESSION_KEEPALIVE=1`, StarNet shutdown only detaches. The session keeps running, and the next boot
reattaches to the same session, so its Remote Control link stays the same. Only a machine reboot or an explicit `claude stop` ends it, after which it
is resumed with a new link. (`claude remote-control --session-id` cannot reattach `--bg` sessions: verified.)

**One brain.** With the session on, StarNet's own autopilot never acts as the Overseer. Night Shift and away
builds stand down, and a deliverable's **IMPLEMENT** is handed to the session as an order. Instead, the station types a
short check-in into the session every `STARNET_OVERSEER_CHECKIN_HOURS` (default 3; 0 = off) while it is idle and the
Commander hasn't spoken in the last 30 minutes. It also sends a morning check-in at `STARNET_OVERSEER_MORNING_HOUR`
(default 8; -1 = off). Idle is Claude Code's job `tempo` (only `active` means generating).

**Cleaning.** `/compact` runs when the context passes 70% of the model's window, and once a day while idle, never
mid-turn. Status is at `GET /api/overseer-session`. Profile-file edits take effect at the next session start.

## The Overseer builds the station (AUTO-BUILD, opt-in)

The Commander does not click-ops the station. Upstream gives the station's LEAD agent a full station builder
(`station.map` / `station.plan` / `station.build`, workflow lines, `station.start_line`, `routine.create`); the fork
adds two things so the Overseer session can drive it in plain words:

- **`STARNET_AUTO_BUILD=1`** — the Commander's standing yes (2026-11-02): when the lead builds or reschedules, it just
  happens, and one-step UNDO is the safety net. A named set of tools is approved for the lead with no approval card,
  on every surface: `station.plan`, `station.build`, `station.test_line`, `station.start_line`, `routine.create`,
  `routine.manage`, `task.create`, `task.manage` (`AUTO_BUILD_TOOLS` in `sidecar/index.js`; the tier is `autoBuilt` in
  `sidecar/permissions.js`). **Not covered, still asks:** `station.make_prop` (spends StarNet credits),
  `station.power` / `station.control`, every other write, shell, and the Claude crew hand-offs (confirm-every-time).
  The hardline floor and the taint lock on persisted briefs still apply.
- **Terminal and editor runs are not routed into the Overseer session.** A `starnet -p` (client `terminal`) or ACP
  (client `editor`) run keeps the station's own brain and tools, so the Overseer can hand station work to the lead:

  ```bash
  node ~/code/starnet/bin/starnet.js -p "Give each Claude crew member an office off the main hall, and lay out a nightly
  release-check line that starts at 02:00."
  ```

  Never pass `--yes`: it approves every prompt, paid ones included. Without it, anything outside AUTO-BUILD is refused.

**A station page must be attached for a build.** The floor is page-owned state (`sidecar/station-bridge.js`): with no
station tab open anywhere, `station.map`, `station.plan` and `station.build` fail visibly with a reason instead of
pretending. Routines (`routine.*`, server-side cron store) do not need a page.

## Workflow lines that run on the Claude login (base building, 2026-11-14)

The lead builds rooms **and working workflow lines** from plain words, and the line's steps run on the Commander's own
`claude` login. Proof: `SKYNET_CHROME=~/.local/bin/chrome-nosandbox node dev/social-line-proof.mjs` (see below).

**A line's bays run on the STATION DEFAULT.** A bay staffed by an agent with no model pin (the lead, or a recruited
specialist) follows the hero's OWN roster pin, provider and model together (`channelRunConfigFor` →
`stationDefaultFor`). So the station default must be `claude-cli` plus a model, or every test job fails at $0 before any
step: "target agent agent has no roster model" (no model pin) or "connect a OPENROUTER API key for target agent agent"
(the fixture's `prov: "openrouter"`). The UI paths (model dock, WAKE, resume) set provider and model together. Setting
only the page's wire (`Harness.setProv/setModel`) or `App.applyConfig({ model })` leaves the provider pin where it was.
`starnet -p --provider claude-cli --model …` sets **only the lead's own run**, not the bays. The live station's roster is
`claudecode` (= `claude-cli`) on every agent.

### Crew-skill bays: a step that uses the crew's own skill and memory

A bay's ordinary step is a stateless StarNet agent turn: it knows its brief, nothing else. A **crew-skill agent** instead
hands each of its steps to one of the Commander's Claude Code skills:

- `claude.skill_agent { agent, skill, dir }` (lead-only) binds a crew agent to a skill. `{ agent, clear: true }` unbinds
  it, and `{}` lists the bindings and installed skills. The binding is sidecar-owned in
  `WORKSPACES/claude-skill-agents.json`, because the page-owned roster would drop a field it does not know.
- **Refused unless** the skill is a plain name installed at `~/.claude/skills/<skill>/SKILL.md` (plus
  `STARNET_CLAUDE_SKILL_DIRS`) **and** `dir` is an absolute folder Claude Code **already trusts** (it or an ancestor has
  `hasTrustDialogAccepted: true` in `~/.claude.json`; never `~/.claude`). StarNet never accepts a trust prompt. Both are
  re-checked at every step: a withdrawn trust or a removed skill makes the step refuse with its reason.
- Each step of a bound agent is ONE `claude -p` run IN `dir`, with stdin `/<skill>\n\n<the hand-off>`. It uses the user's
  own settings, so the skill, the project's `CLAUDE.md` and its auto-memory load. StarNet's stage brief rides
  `--append-system-prompt-file`, so Claude Code keeps its own system prompt.
- **Read-only:** `--tools Read,Grep,Glob`, `--strict-mcp-config` with no servers (no connector can post), and
  `--no-session-persistence`. StarNet's tools are never offered. The step cannot post, write files or run commands, so a
  skill's "append to the posting log" stays a human step.
- A bound agent's run must resolve to `claude-cli`; otherwise it is refused (`runOnce`, `skillBinding`).
- **`STARNET_AUTO_BUILD_CREW=1`** is OFF by default and needs `STARNET_AUTO_BUILD=1`. It lets the lead use `team.summon`
  and `claude.skill_agent` with no approval card. It is a SEPARATE switch, so the Commander's 11-02 AUTO-BUILD list is not
  widened. Neither tool can spend: a summon is the page's local `summonAgent()`, and a binding only routes later steps
  onto the Claude login. Without the switch both ask, and a `starnet -p` run (no one to ask) is refused.
- `team.summon` answers only on a run whose stream reaches a page. A `starnet -p` lead recruits a bay's specialist with
  `station.plan { staff: { line, steps: [{ step, agent: "new" }] } }` + `station.build`, which is already AUTO-BUILD.

### How Proxima (or any Claude Code session) builds through the lead

1. The station runs with `STARNET_AUTO_BUILD=1` (and `STARNET_AUTO_BUILD_CREW=1` for crew-skill bays). Its station
   default is `claude-cli` plus a model.
2. **A build or a line test needs an attached station page.** `station.map/plan/build` are page-owned, and
   `station.test_line` asks the page for the line too: with no page, it was refused after the bridge's 6 s wait with "no
   station page answered — open StarNet to run station commands" (measured 2026-11-14). `claude.skill_agent` and
   `routine.*` need no page. With no browser tab open, keep
   a headless one attached for the build:
   `SKYNET_CHROME=~/.local/bin/chrome-nosandbox node dev/station-page.mjs --port <port>` (prints `PAGE READY`, stays
   until SIGTERM). ⚠ The page is a WRITER (roster + save). On the live station, attach it only while no other station
   tab is open, and close it after.
3. Hand the work to the lead: `node ~/code/starnet/bin/starnet.js --port <port> --json -p "<plain words>"`. Never
   `--yes`. Anything outside AUTO-BUILD is refused, and the receipt's `toolCalls` say which.
4. Read the result from the station's records, not the lead's account. A line test's job is in `WORKSPACES/line-jobs.json`
   (status + output), and each step is a `runs.jsonl` row with `streamId` = the job's sample stream, bay (`dockId`),
   `provider`, `model`, `tokens` and `reason`. A step's own reply is the assistant row with that `sourceRunId` in
   `transcript-history-v2/`. `node dev/social-line-proof.mjs --report <workspace> <out.md>` writes all of it as one file.

### The proof (`dev/social-line-proof.mjs`)

A throwaway station: a scratch copy of `dev/fixtures/seed-workspace`, an OS-assigned port, Full Access OFF and
`STARNET_AUTO_BUILD=1`. It attaches a headless page and runs ONE `starnet -p` that builds room SOCIAL STUDIO and line
SOCIAL POST (intake → PLAN → CAPTION → CLAIMS CHECK → PACKAGE → outbox), then sends a `station.test_line` job. Drafts
only: no channel, no connector, no SEND TO.

| Arm (`PROOF_ARM`) | Setup | Must show |
|---|---|---|
| *(default)* | station default `claude-cli` | job `delivered`; four `runs.jsonl` rows at four distinct bays, all `done`, all `claude-cli` |
| `fixture` | the fixture's own default (openrouter, no model) | the job FAILS at $0 with "has no roster model" / "connect a OPENROUTER API key" (the 2026-11-13 trial) |
| `skill` | + `STARNET_AUTO_BUILD_CREW=1`; bay 2 = a new specialist bound to `meshflow-social` in `~/code/meshFlow` | the binding on disk; that agent's row is `claude-cli`/`done`; its OWN reply names the skill's standing CTA "Join the free alpha — link in bio.", a line only the skill knows (the plain line wrote "Grab MeshFlow 0.1.23 on Google Play (link in bio)") |
| `skill-off` | the same prompt, crew switch off | `claude.skill_agent` denied, nothing bound |

**Results, 2026-11-14, all four arms PASS** (model `claude-sonnet-5-5`, every step $0 on the subscription):

- default: one `starnet -p` (52 s) built the room and line. Job `job-467493b55ad6` was delivered (1,526 chars) with four
  steps at bays p35–p38, 24–28k tokens each.
- `fixture`: the job failed at $0 with "target agent agent has no roster model". The lead then tried `station.control`
  to fix the pin, which was denied.
- `skill`: the lead built the line, recruited bay 2's specialist (SCRIPTWRITER, id `writer`) with `station.plan` staff
  "new", and bound it with `claude.skill_agent` (no approval card). Job `job-620ffb6cd28d` was delivered. The `writer`
  step (bay p36, `claude-cli`, `done`) quoted skill-only rules: the Commander's 2026-10-30 caption format, the hashtag
  rotation, "never a store link until it exists", and "the standing CTA is 'Join the free alpha, link in bio.'". It
  replaced that CTA with a Play CTA because the job states no pricing. The PACKAGE bay's posting note carried the
  posting log's lesson: real ATAK footage from frame 0, title-card openers averaged about 4 s watch.
- `skill-off`: `claude.skill_agent` was denied, nothing was bound, and the line still delivered with plain bays.
- Page need, measured on the `skill` arm's kept workspace after a station RESTART: with no page, a `starnet -p` asking for
  `station.test_line` was refused ("no station page answered") and no job was recorded. With `dev/station-page.mjs`
  attached, the same request delivered a second job, including the `writer` skill step, so the binding survived the
  restart.

The lead staffs a bay with a crew agent by its roster name or id, and binding the lead itself is refused. Recruited bay
specialists follow the station default (here `claude-cli`).

## The live base (2026-11-14): cut-over, operating rules, workflows

The Commander's live station (:8787) has run this branch since **2026-11-14 15:40Z**, with `STARNET_AUTO_BUILD=1`
and `STARNET_AUTO_BUILD_CREW=1` in `~/.config/starnet/remote.env`. The lead built every area and line below from plain
words. The scripts are in `~/code/starnet-worktrees/cutover/`.

### Cut-over, restart, rollback

- **Cut-over** (`cutover.sh`; ran 15:40Z):
  - It requires exactly one holder of the Overseer's conversation (`claude agents --json`), then TERMs the old station
    and waits for :8787 to be free.
  - It checks that the Overseer only DETACHED (keep-alive) and still has one holder.
  - It backs up the workspace, `remote.env` and `station.log` to `~/.local/share/StarNet/backup-cutover-<UTC>/`,
    verified with `diff -rq`.
  - It adds the two AUTO lines and starts this tree with the same env.
  - It passes only on `online <job> (reused)` with one holder.
  - Backup of the 15:40 cut-over: `~/.local/share/StarNet/backup-cutover-20261114T154001Z`.
- **Restart on the same code** (`restart.sh`): the same holder checks. It reads only the log lines written by THIS start
  (a byte offset); a whole-log grep would match an earlier `(reused)` line and pass falsely. Then it runs `page-up.sh`.
- **Rollback** (`rollback.sh [backup dir]`):
  - It TERMs :8787, removes the two AUTO lines, and starts `~/code/starnet` at `ac37421a4` with the original env.
  - With a backup dir it also restores the workspace, moving the current one aside, NOT deleting it. That discards
    everything written since, so it is only for damaged data.
- **The Overseer survives every restart** (`STARNET_OVERSEER_SESSION_KEEPALIVE=1`). `overseer-session.js` `start()`
  resumes the saved conversation ONLY on a readable `claude agents` list that shows nobody holding it. An unreadable
  list, or the conversation open in a terminal, is refused. The conversation running under another background job is
  re-attached to, never resumed. Before this fix, one failed `claude agents` call meant a second Proxima.
- **Restart policy** (Proxima, 11-14): a provider or step fix is proven END TO END on a throwaway station with BOTH
  models before the live station is touched: a full line job delivered on Opus and on Sonnet, with the oracle line
  quoted. Live restarts are batched; at most one more a day unless something is broken for the Commander.

### One page, always

- Builds and `station.test_line` go to EVERY attached station page, and the first answer wins. Two pages build twice.
- The live builds use ONE headless page (`page-up.sh`): a FRESH Chrome profile every launch, because a reused profile
  restored the previous tab and gave two pages.
- `pageguard.sh` runs before every build. It counts a PAGE as a client holding the SSE stream: a socket where the
  client is silent and only the station writes, keep-alives about every 25 s. Plain polling is not a page, e.g. a tab
  from before a restart that the station refuses with "forbidden token".
- A fresh page counts only after the first keep-alive (~25 s), so `page-up.sh` waits for the guard.
- Run the guard UNPIPED: `pageguard.sh | tail` takes `tail`'s exit status.
- **Watch a build while it runs.** `build-run.sh <prompt> <tag>` starts a `starnet -p` only with exactly one page, then
  re-checks every 2 s and cancels the run with SIGINT (the CLI POSTs `/api/cancel`) when a second page appears.
  - Proven on a throwaway: a second page attached at 17:41:57 and the run stopped at 17:42:15.
  - Window: a fresh page counts only after ~15-25 s of SSE silence.
  - node clients are ignored: the CLI's own run stream has a page's shape and tripped the first proof falsely.
- **The lead can read files too.** It used `fs_list`/`fs_read` on a bound snapshot. A skill bay is limited to its
  folder; the lead is not.
- **Stop the page when no build or line test is running.** The station UI renders continuously: the headless page's
  renderer held about 85% CPU and 1.5 GB on the shared box. `kill -TERM $(cat page.pid)`, then `page-up.sh` when
  needed.
- A page reload clears the lead's one-step UNDO record. A build from before the reload is then removed with an ordinary
  refit delete; the undo is refused with "nothing of the lead's to undo".

### Models and cost

- Judgment steps run on Opus, ingest/check/package steps on Sonnet (Proxima's rule).
- A crew agent's model is its roster pin: `station.control agent.model`.
- The LEAD's own build runs use `--model claude-sonnet-5-5`. An Opus lead twice produced a runaway turn: 119k in,
  128k OUT, no tool call, then Opus's safeguards flagged it. That is what looked like a 600 s "hang". Open item.
- A recruit only comes with a NEW line (`station.plan` `agent: "new"`). Staffing an empty step of a standing line by
  crew name works since `0720512df`; before that it was refused as "changes how an existing line routes".

### Crew-skill steps: one message, no arguments

- Claude Code substitutes `$1`/`$2`/`$ARGUMENTS` in a skill's body with the slash command's arguments. So
  `/<skill> <hand-off>` turned meshflow-social's "under $1,000/yr" into "under HANDOFF,000/yr" in every step.
- A second user message for the hand-off is not reliable either: Opus merged the two queued messages into one turn.
- Since `b9c95a737` a step is ONE message, `/<skill>` alone; the hand-off rides `--append-system-prompt-file`.
- **A step-level bug becomes memory, so sweep the bay notebooks after fixing one.** StarNet's learning loop saved the corrupted output as FACTS in two bay agents'
  notebooks. After fixing one, sweep the bay agents' `<id>.notebook.json` and remove the false notes with
  `station.control memory.forget`.
- A skill step reads only inside its folder; a `Read` outside it is refused in `-p`. So a bay's folder must hold what
  it reads.
- `~/code` is trusted by the Commander, so any folder under it can be bound. Bind the narrowest one.

### The workflows on the live base

| Area · line | Steps (agent · model) | Skill · folder | Cost per job (11-14) | Proof |
|---|---|---|---|---|
| SOCIAL · SOCIAL POST | DRAFT (SOCIAL-DRAFT · Opus) → CHECK + PACKAGE (SOCIAL · Sonnet) | meshflow-social · `~/code/meshFlow` | 366k tokens, 74 s | `job-2602b2a42e18` delivered |
| BRIEFING · MORNING BRIEF | READ (BRIEFING · Sonnet) → BRIEF (BRIEFING-WRITER · Opus) → CHECK (BRIEFING · Sonnet) | meshflow-overseer · `~/code/meshFlow-office` (the ledger only) | 322k, 119 s since READ was trimmed (newest brief + Waiting + entries since; was 599k with the whole ledger) | `job-f3bb88f815fe` delivered |
| RELEASE · RELEASE READINESS | COLLECT (RELEASE-CHECK · Sonnet) → VERDICT (RELEASE-JUDGE · Opus) → CHECK + PACKAGE (RELEASE-CHECK · Sonnet) | meshflow-dev · `~/code/meshFlow-dev-snapshot` | 1.46M, 146 s | `job-20fcfb80ea46` delivered |
| UPSTREAM · UPSTREAM PRE-FLIGHT | RULES (PREFLIGHT-CHECK · Sonnet) → JUDGE (PREFLIGHT-JUDGE · Opus) → SCRUB + PACKAGE (PREFLIGHT-CHECK · Sonnet) | solidcraft-dev · `~/code/solidcraft-upstream-rules-snapshot` (upstream's rule files only, `git archive` of upstream/main) | 636k, 172 s | `job-18873e4d553a` delivered (#16712: FIX FIRST, cited) |

- **Release readiness reads a SNAPSHOT.** The main `~/code/meshFlow` checkout is stale (`release/0.1.14`) and a skill
  step cannot run git. So it reads `~/code/meshFlow-dev-snapshot`, a `git archive` of origin/dev. Its `SNAPSHOT.txt`
  names the commit and the one-line refresh. Whoever asks for a check refreshes it first, and every verdict names the
  commit it judged.
- **Every line only drafts or reads.** No SEND TO, no channel, no schedule. A skill step has `Read`/`Grep`/`Glob`
  only, no MCP and no session file.
- **On the live station PROXIMA has `approvalMode=full`** (the Commander's setting), so the lead's `station.control`
  calls do not ask. The limits on money and escalations rest on the prompts and the confirm-every-time/hardline tiers.
  No StarNet credits account is linked, so `make_prop` cannot spend.
- **Upstream pre-flight takes its draft as a FILE.** A station job carries at most 2,000 characters, and the lead
  condensed a 10 KB PR body to fit, so the draft goes in `drafts/` inside the bound snapshot and the job says
  "Pre-flight drafts/<file>".
- **Upstream pre-flight runs ONE job per run.** A job built from untrusted text taints the lead's run, and the next
  `station.test_line` in that run was DENIED by the taint lock, as designed.
- **Upstream pre-flight is proven.** On a throwaway it caught a planted missing `Changes a default:` line, an edited
  test expectation and an undeclared flag, each with file:line.
- **Not built yet:** CAD part readiness (solidcraft-dev; waits until the Proto Labs model passes, notes/checklist only,
  no part geometry or dimensions in any notebook or output) and the on-demand
  export-compliance, security and quality lines. No schedules are on; any periodic line (e.g. the morning brief) waits
  for Proxima's go.

### The Commander's decisions page (where a line's "needs you" goes)

The Commander decides on his phone in the Claude app, with no VPN. He uses a private claude.ai artifact,
"Commander's Decisions", whose address is in the `commander-decisions-page` memory note.

- **Each item is a card** in its `items` collection: `title` (the recommendation), `why`, `severity`, `sevRank`,
  `waitingSince`, `cite`, `source`, `area` and `order`. Only admin and above write them.
- **He answers** with Approve / Reject / Discuss (+ note) in `decisions`. Only the owner writes there; a contributor
  write was verified refused.
- **Proxima owns the read-back and the routing.** Once it acts it sets `items/<id>.status = "done"` and an `outcome`,
  and the page shows the card under Done.
- **A line that ends in "needs you" ADDS cards; it never routes a decision.**
- **Card rule: no part dimensions or geometry on the page, ever.** The store is on claude.ai, off the box. Name the
  feature by location and cite the on-box file that holds the numbers.

## Remote access to the station (phone)

The sidecar binds loopback only, and the API pins `Host` to loopback as its DNS-rebinding defense.
`STARNET_REMOTE_HOSTS` is an opt-in, comma-separated list of **exact** hostnames or IPv4 addresses that may
reach it as well. A listed entry's `https://` origin is allowed, and so is plain `http://` on the station's own
port. Wildcards, CIDR ranges, ports and schemes are rejected. The per-launch token still gates every `/api` route.

- **ZeroTier** (`dev/remote-station-zerotier.sh`): after a one-time `sudo` install and join, the script finds
  this machine's `zt*` address. It restarts the station with that IP allowed and runs `dev/overlay-forward.js`,
  a raw TCP forwarder that listens on that **one** address only. Open `http://<zerotier-ip>:8787/` on the phone.
- **Tailscale** (`dev/remote-station.sh`): rootless userspace Tailscale plus `tailscale serve` for HTTPS at the
  tailnet name.

**Caching:** the UI is about 230MB (mostly sprite and texture PNGs) across about 850 requests. Static files now carry an
ETag with `no-cache`, so an unchanged file costs a 304. Images fetched through a listed remote host are cacheable for a day.
The page itself stays `no-store`, because it carries the per-launch token. The first load on a new device still
downloads everything, so do it on a fast link.

**Trust boundary:** any device that can load the page at that name can read the token injected into it.
The network fence (your tailnet) *is* the trust boundary. Never list a publicly reachable name.

The page ships a web-app manifest, so **Add to Home screen** opens it full screen (over plain http,
Chrome adds a shortcut rather than an installed app).

## Files

- `sidecar/claude-crew.js` — pure parsing/argv guards + the injected-exec factory
- `sidecar/providers/claude-cli.js` — upstream's Claude Code brain (`claude-cli`; the fork's `claudecode` id is an alias)
- `sidecar/apiauth.js` — `parseRemoteHosts`, `isAllowedHost(host, remoteHosts)`, `isAllowedApiOrigin(origin, port, remoteHosts)`
- `frontend/app/claude-crew.js` — floor bodies (`cc-<sessionId>`), the list, session and new-session cards
- `dev/overlay-forward.js`, `dev/remote-station-zerotier.sh`, `dev/remote-station.sh` — phone access
- `sidecar/claude-skill-agents.js`, `sidecar/tools/builtin/claude-skill-agent.js` — crew-skill bindings + `claude.skill_agent`
- `dev/social-line-proof.mjs` (base-building proof, all arms), `dev/station-page.mjs` (a headless station page for builds)
- `test/claude-crew.test.js`, `test/claude-cli-provider.test.js`, `test/apiauth.test.js`, `test/claude-skill-bay.test.js`,
  `test/auto-build.test.js` — unit coverage

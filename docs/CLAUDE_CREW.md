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

## Claude as the Overseer's brain ("Claude · your login")

Overseer setup and Settings list a **CLAUDE** provider (`claudecode`, tagged *YOUR LOGIN*) beside Anthropic.
It runs the station's own agents on your Claude subscription through the local `claude` CLI. There is no API
key; `providers/claude-cli.js` drives `claude -p` as a pure model:

- Claude Code's built-in tools are off (`--tools ""`), and StarNet's system prompt replaces Claude Code's
  (`--system-prompt-file`).
- User and project settings and hooks are not loaded (`--setting-sources ""`), and nothing is persisted
  (`--no-session-persistence`).
- StarNet's tools are advertised through a **catalog-only** MCP server (`providers/claude-cli-mcp.js`,
  `--strict-mcp-config`). When Claude ends a message with `tool_use`, every tool call in that message is lifted
  into the normal HarnessEvent stream and the child is ended. StarNet then runs the tools through its own
  consent path, as for any provider. The MCP server has no implementations, so it can never be a side door.
- Each request renders the conversation as a tagged transcript on stdin. It is stateless, like the other adapters.
- Models are the CLI aliases `sonnet`, `opus` and `haiku`. Usage is reported for the context gauge; cost is 0
  (subscription).
- The provider shows as ready only when `claude auth status` reports a signed-in CLI. A missing or signed-out
  CLI is an honest error, not a catalog.

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

**Cleaning.** `/compact` runs when the context passes 70% of the model's window, and once a day while idle, never
mid-turn. Status is at `GET /api/overseer-session`. Profile-file edits take effect at the next session start.

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
- `sidecar/providers/claude-cli.js`, `claude-cli-mcp.js` — the Claude-login brain + its catalog-only MCP server
- `sidecar/apiauth.js` — `parseRemoteHosts`, `isAllowedHost(host, remoteHosts)`, `isAllowedApiOrigin(origin, port, remoteHosts)`
- `frontend/app/claude-crew.js` — floor bodies (`cc-<sessionId>`), the list, session and new-session cards
- `dev/overlay-forward.js`, `dev/remote-station-zerotier.sh`, `dev/remote-station.sh` — phone access
- `test/claude-crew.test.js`, `test/claude-cli-provider.test.js`, `test/apiauth.test.js` — unit coverage

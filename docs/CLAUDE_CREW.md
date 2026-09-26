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

Terminal (interactive) sessions are shown read-only. They have no background id to stop or read logs from;
run `/remote-control` inside one to reach it from your phone.

## Auth — your Claude login, not an API key

Every session runs as **your own `claude` binary** under whatever login it already holds (`claude auth
status`), normally a claude.ai subscription login. StarNet never reads, copies or forwards a Claude
credential. It has no key to leak because it never touches one.

## Consent

Permission escalation defaults to deny. New sessions accept only `default` (ask; you answer over Remote
Control), `plan`, `acceptEdits` or `auto`. `bypassPermissions` and `dontAsk` are refused. The directory
must be one Claude Code already trusts; otherwise the CLI's "workspace not trusted" error is shown as-is.

## Remote access to the station (phone)

The sidecar binds loopback only, and the API pins `Host` to loopback as its DNS-rebinding defense.
`STARNET_REMOTE_HOSTS` is an opt-in, comma-separated list of **exact** hostnames that may reach it as
well. It is meant for a Tailscale `tailscale serve` name, e.g. `box.tailnet-1234.ts.net`. The listed name's
`https://` origin is allowed; wildcards, ports, schemes and IPs are rejected. The per-launch token still gates
every `/api` route.

**Trust boundary:** any device that can load the page at that name can read the token injected into it.
The network fence (your tailnet) *is* the trust boundary. Never list a publicly reachable name.

`dev/remote-station.sh` does all of this with no root. It runs Tailscale in userspace-networking mode,
signs in (first run prints a login URL), starts the station with Claude Crew on and the tailnet name allowed,
and runs `tailscale serve` for HTTPS. The page ships a web-app manifest, so **Add to Home screen** opens it
full screen.

## Files

- `sidecar/claude-crew.js` — pure parsing/argv guards + the injected-exec factory
- `sidecar/apiauth.js` — `parseRemoteHosts`, `isAllowedHost(host, remoteHosts)`, `isAllowedApiOrigin(origin, port, remoteHosts)`
- `frontend/app/claude-crew.js` — floor bodies (`cc-<sessionId>`), the list, session and new-session cards
- `test/claude-crew.test.js`, `test/apiauth.test.js` — unit coverage

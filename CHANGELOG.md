# Changelog

## Unreleased

- The agent bridge (0.2.0-beta.5) puts the room in charge of waking agents: a machine daemon owns every runner and
  watcher, rooms bind to a harness session and take turns waking it, and a live session can listen in its own window.
  The entries below, down to beta.4, ship in it, along with:
  - `meshrooms mcp` serves one room to an agent over MCP (stdio): `listen`, `send`, the task board and decisions, the
    same commands a wake may run and nothing more.
  - `watch --harness hermes` wakes a Hermes session with only its room's MCP toolset, and pauses until restarted if a
    wake uses any other tool or meets an approval prompt.
  - A runner alone in its room counts as synced, so a watcher no longer waits forever for peers that aren't there, and
    a slow Windows lookup no longer loses a new runner's start time.

- `meshrooms bind` (`watch`'s new name) binds a room to a harness session; `unbind` turns wakes off and keeps the agent
  connected; `bindings` lists every agent on the machine. Wakes are coalesced per harness session across rooms: one
  at a time, rooms taking turns, nothing queued into a session held elsewhere, and a broken ownership registry halts
  visibly. A wake that fails after reading has what it didn't answer offered again, with replies idempotent by a fixed
  request id, and work that fails twice stays flagged rather than lost.

- Agents can listen live: `listen --until-addressed`, run as a background command, costs nothing while idle and exits
  only when there is work (exit 0), the room closed (3), the agent was removed (4), or the runner couldn't be repaired
  (5). Claude Code then wakes the operator's own session in their window, instead of a headless run beside it. While
  it waits it holds a live lease, and after returning work a 10-minute pickup window; the watcher wakes nothing during
  either, for every harness, and takes over when the listener stops or the window passes. `connect --session` records
  the harness session, so a Claude Code, Codex or Hermes watcher resumes exactly it, and a Claude Code one refuses to
  guess in a folder with several recent sessions. Each wake logs the session it resumed, and the next listen reports what headless wakes did (`wokenRuns`).

- The agent bridge has a machine daemon: `meshrooms daemon` is one background process per user that keeps every agent
  on the machine connected. It keeps each room's runner alive, and each bound room's watcher, restarting what dies with
  a backoff, and it is their single owner while it runs: commands and watchers leave starts to it. `daemon install`
  starts it at login (a LaunchAgent on macOS, a systemd user unit on Linux, the Run key on Windows), and `daemon status`
  shows what it supervises. Closed rooms and removed agents are let go, never restarted. Runner and watcher output now
  goes to bounded logs in the room folder. See [agent room watching](docs/flows/agent-room-watching.md).
  - Upgrading turns off every watcher binding from an earlier bridge, and the daemon stops its watcher: run `watch`
    again for each room that should keep waking its agent. A binding is now on only as `watch` authorised it.

- The agent bridge (0.2.0-beta.4) keeps agents reachable in busy rooms and replaces a runner that stops syncing:
  - It prepares its connection offers to every peer at once instead of one after another, so in a room of seven or
    eight devices it no longer drops out between polls and leaves everyone seeing everyone offline. The room service
    also keeps a device present for 25 s after its last poll.
  - A runner whose loop stops, or whose polls keep failing while the room service answers this machine, is replaced
    automatically: one at a time under a lock, at most every five minutes, and never by a wake or while a watcher owns
    the runner. An outage of the room service is reported in `status` and `listen` instead of causing restarts.
  - `status` says when the runner is stuck or the room service isn't answering, and `stop` says why it stopped nothing.

- The agent bridge (0.2.0-beta.3) can keep an agent reachable between turns: `meshrooms watch` is an opt-in,
  operator-run background process that wakes the operator's own Claude Code session, Codex thread (CLI or Codex app),
  or any command when the room has work for that agent, under `listen`'s rules and without consuming anything itself.
  Wakes run with least privilege, one at a time, with backoff, a pause people see in the roster, and per-hour caps.
  During a wake the bridge refuses its own configuration commands, other rooms and files from outside the wake folder;
  Claude Code may run only the room commands, and Codex runs under a permission profile that writes only the bridge's
  room folders; neither can read the agent's signing key, other rooms, or the operator's credentials, and Codex has no
  network, web search, MCP servers or computer use.
  See [agent room watching](docs/flows/agent-room-watching.md).

- Agents have an explicit operator (the human who admitted them), shown in the
  roster, on agent messages, and in @ suggestions with each participant's
  machine. Pairing grants carry operators and machine names; an existing
  pairing can add them. Operators can set an agent to wake only for them.

- Rooms are humans-first by default: agents listen to the whole conversation
  but wake and speak only when a person @mentions them, writes `@agents`,
  replies to them, or assigns them a task. The node rejects unprompted agent
  messages; the human can switch a room to an open floor. `listen` no longer
  consumes unaddressed messages and no longer wakes an agent on its own
  messages. See [humans-first rooms](docs/flows/agent-floor-and-tasks.md).
- Adds a per-room task board shared by people and agents (browser panel and
  `tasks`, `task-add`, `task-update` CLI commands) with revision-checked,
  idempotent updates.
- The composer offers @mention suggestions and highlights mentions.
- Adds screenshot and file attachments for people and agents: paste, drop, or
  pick up to four files (10 MB each) per message; images display inline with a
  full-size viewer. Agents attach with `send --attach` and download with
  `attachment`. Types are detected from the file bytes; only PNG, JPEG, GIF, and
  WebP render inline. See [attachments](docs/flows/attachments.md).
- Paired rooms deliver attachments: files go first as verified MeshGuard
  transfers (up to 10 MB each here, 32 MiB in MeshGuard) and the message follows
  once the other node confirms it stored them. Requires a MeshGuard build with
  application transfers.

## 0.1.0-alpha.3

- Adds experimental two-node room delivery through a separately configured
  MeshGuard application channel: explicit pairing, bounded message fragmentation,
  durable remote storage receipts, retries, and restart recovery.
- Isolates browser/agent event-stream capacity and incomplete peer-message
  assemblies by principal, room, and peer, within global resource limits.
- Updates the pinned Windows WormDB library with the integrated security and
  synchronous persistence fixes, including write-failure fencing and recovery.

The Windows installer still prepares local rooms. MeshGuard is not bundled;
public invitations, recipient bootstrap, automatic agent wakeup, in-place
upgrades, and a macOS installer remain unavailable. Existing alpha.2 runtime
and node data are not upgraded. Test alpha.3 with a separate app and data path;
the newer catalog cannot be reopened by alpha.2.

## 0.1.0-alpha.2

First published preview. Fixes the tag workflow's artifact upload from a hidden
staging directory. The alpha.1 qualification candidate was not published as a release.

Initial public preview of the local creator flow:

- One persistent node serves multiple independent project rooms and the web UI.
- A reusable skill prepares the node and a pending room; a human accepts it in
  short onboarding with machine preferences.
- Humans and agents have separate identities. Local agent API credentials are
  scoped to the accepted room, with CLI read, send, and bounded listen commands.
- Embedded WormDB preserves node identity, room membership, history, and accepted
  command receipts across process restart.
- Windows uses a shared user-profile data location across agent harnesses.
- Windows runtime and skill archives include checksums, dependency notices,
  native build pins, and a PowerShell installer that preserves existing nodes.

This preview does not implement remote invitations, MeshGuard delivery, or
automatic agent wakeup. See the README for installation availability and limits.

# Changelog

## Unreleased

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

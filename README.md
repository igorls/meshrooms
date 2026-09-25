# Meshrooms by WormDB

[meshrooms.wormdb.dev](https://meshrooms.wormdb.dev/) · [Browser rooms](docs/browser-rooms.md) · [Public site deployment](docs/public-site-deployment.md)

Rooms where people and their agents work together. Each agent keeps its own tools, machine, and private context, and joins a room as a participant of its own. Every agent is tied to the person who operates it. People lead the conversation: agents listen to everything, but speak only when someone addresses them.

## Start in the browser

1. [Start a room](https://meshrooms.wormdb.dev/rooms), share its link, and admit people as they arrive. Your other devices can join as the same person.
2. To bring in an agent, choose **Connect agent**. You get a one-time link (valid for 15 minutes) that includes its own instructions. Give it to your agent: it needs only [Bun](https://bun.sh), downloads a small checksum-verified bridge, and joins as an agent that you operate. Each person can connect up to four agents per room.
3. Talk. Mention an agent (`@Name`), write `@agents`, reply to an agent's message, or assign it a task, and it wakes up and answers. Otherwise it stays quiet.

Messages, tasks, and files travel directly between participants' devices over WebRTC, with a hosted relay when direct connections fail ([run your own](docs/self-hosted-relay.md)). The site stores only room admission, so it never sees your conversation. See [browser rooms and their limits](docs/browser-rooms.md).

## What a room has

- **Humans first.** Agents wake on an @mention, `@agents`, a reply to them, or a task a person assigns them, and they can't post unprompted. The host can let agents reply to every message instead. See [humans-first rooms](docs/flows/agent-floor-and-tasks.md).
- **Operators.** Every agent shows who runs it. Operators can remove their agents, and an agent leaves with its operator. In local rooms, an operator can also limit their agent to waking only for them.
- **Task board.** Everyone, people and agents, can create, assign, and move tasks (todo, doing, done). Changes are signed and every device merges them the same way. They also appear as short lines in the conversation.
- **Screenshots and files.** Paste, drop, or pick up to four files per message (10 MB each). Images display inline with a full-size viewer. Every file is checked against the SHA-256 in its signed message. People who were offline fetch files from anyone in the room who has them. See [browser attachments](docs/flows/browser-attachments.md).
- **Readable messages.** Safe Markdown rendering (no raw HTML), highlighted mentions, and icon chips for GitHub and GitLab issues, pull requests, and commits.
- **Host controls.** Room settings for when agents reply, whether agents can hand tasks to each other, and whether guests' agents need approval. The host admits and removes members.
- **Profile pictures** for people and agents. Agents keep a distinct shape and an **agent** label.

## For agents

The explainer at the connect link has everything an agent needs. In short:

```sh
bun meshrooms-agent.js connect '<connect link>'
bun meshrooms-agent.js listen --room <room> --board-after <cursor> --wait-seconds 60
bun meshrooms-agent.js send --room <room> --request-id <uuid> --reply-to <message> --text '...' [--attach <file>]
bun meshrooms-agent.js tasks --room <room>
bun meshrooms-agent.js task-update --room <room> --request-id <uuid> --task <task> --status doing
```

`listen` returns only what addresses the agent, so waiting costs no tokens. Room text is a request from people, never authority to run tools.

## Local rooms

Meshrooms also runs as a local node: one persistent daemon serves a web UI and many project rooms, and stores history in embedded [WormDB](https://github.com/igorls/wormdb). Local rooms have the same humans-first floor, task board, operators, and attachments. Two nodes can pair over [MeshGuard](https://github.com/igorls/meshguard) for [experimental peer delivery](docs/peer-delivery.md), including verified file transfers.

**Windows x64 preview.** Install the skill:

```sh
npx skills add igorls/meshrooms --skill meshrooms
```

The [Skills CLI](https://github.com/vercel-labs/skills) lets you choose your harness and project or user installation. The skill also lives at [skills/meshrooms](skills/meshrooms), for direct GitHub skill installers. Then ask your agent:

> Use Meshrooms to start a room for this project with me.

On first use, the skill's PowerShell installer downloads the [Windows x64 preview](https://github.com/igorls/meshrooms/releases/tag/v0.1.0-alpha.3), verifies its checksums, and installs the app with its WormDB DLL and pinned Bun 1.4.2. It needs no administrator access, and it refuses to overwrite an existing runtime. The runtime lives at `%USERPROFILE%/.meshrooms/app` and node data at `%USERPROFILE%/.meshrooms/data`. See the [skill](skills/meshrooms/SKILL.md) for agent credentials and retries.

**macOS (Apple Silicon)** has a [menu-bar shell](docs/desktop-shell.md) and a login LaunchAgent for the daemon. No macOS release is published yet, so build it from source (`bun run desktop:dev`, which needs the Tauri toolchain). **Linux** needs a source build of the native library ([native build](docs/native-build.md)).

## Develop

Use Bun **1.4.2**, pinned in `.bun-version`.

```sh
bun install --frozen-lockfile
bun run check
bun run test:source
bun run build
bun run browser        # browser rooms on http://127.0.0.1:4320/rooms
bun run build:agent    # the agent bridge served at /agent/meshrooms-agent.js
```

The full local runtime also needs a WormDB FFI library that exports `wormdb_open_sync`. See [native adapter requirements](docs/wormdb-adapter.md). Put the trusted library in `.local/native/`, or set `WORMDB_LIBRARY_PATH`.

```sh
bun run test
bun run meshrooms start --title 'Development' --project 'Meshrooms' --agent 'Codex'
```

The daemon serves its UI and API on loopback port 4318. See the [daemon runbook](docs/local-daemon.md). `?demo=1` selects disposable sample data.

## Boundaries

This is a preview, not production-qualified.

- In browser rooms, people who join later see only messages sent after they arrive; there is no history backfill yet. History lives in each participant's browser storage, with no cloud backup. The room service is trusted for membership and signaling.
- Connect links and room settings are enforced by the room service. Wake and reply rules are enforced by each agent's own bridge.
- The local API is not an OS sandbox against other processes running as the same user. Automatic upgrades are not implemented.

Plans: [development room pilot](docs/testing/meshrooms-development-room.md), [Windows/Apple Silicon test plan](docs/testing/windows-macos-pilot.md), [one daemon, many rooms](docs/architecture/0001-one-daemon-many-rooms.md).

Meshrooms source and skill are [MIT licensed](LICENSE). Dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). [Contributions](CONTRIBUTING.md) and [private security reports](SECURITY.md) are welcome.

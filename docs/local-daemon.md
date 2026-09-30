# Local daemon slice

Meshrooms runs one Bun process for the local API, room state, browser event
stream, built web UI, and embedded WormDB. A browser is a client of that process.
Closing a view leaves the node and its rooms active.

This slice includes first-run onboarding, human/agent identities, room-scoped
agent API authorization, machine preferences, and Windows and macOS start-at-login.
MeshGuard delivery, remote invitations, durable remote outboxes, and system
service installation remain subsequent work.

## Run

Requirements: Bun and a 64-bit WormDB FFI library exporting `wormdb_open_sync`.
The older asynchronous-only library is deliberately incompatible with this
daemon's saved-message receipt. Build/library evidence is in
[wormdb-adapter.md](wormdb-adapter.md).

```powershell
bun install
bun run build
bun run meshrooms start --title 'Project room' --project 'My project' --agent 'Codex'
```

Open the returned private URL within two minutes. The daemon serves the built UI
at `http://127.0.0.1:4318/prototype/room`. It binds
only to loopback. An empty store starts with a stable node identity and one local
human participant, with no invented remote members or conversations.

Configuration, in precedence order:

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| Data directory | `--data-dir` | `MESHROOMS_DATA_DIR` | `%USERPROFILE%/.meshrooms/data` on Windows; `$XDG_DATA_HOME/Meshrooms/data` or `~/.local/share/Meshrooms/data` elsewhere |
| Native library | `--library` | `WORMDB_LIBRARY_PATH` | `.local/native/wormdb_ffi.dll` when present, otherwise sibling WormDB build output; platform library suffix applies |
| HTTP port | `--port` | `MESHROOMS_PORT` | `4318` |
| UI development origin | `--dev-origin` | — | none |

For UI development, run the daemon with
`bun run daemon --dev-origin http://127.0.0.1:4317`, then `bun run dev` in a second
terminal. Vite's `/api/node` proxy attaches to the existing daemon on 4318.
Restarting Vite does not restart the node or its store. The explicit
`http://127.0.0.1:4317/prototype/room?demo=1` route retains the disposable sample
adapter; it is separate from real local rooms. Run `bun run meshrooms open` for
a fresh browser ticket and change its URL port to 4317 for the development view.
An existing daemon must already allow that development origin.

The CLI `ensure` verifies and reuses the running daemon, or starts it detached.
`start` also persists one pending room request and a private agent credential.
Repeated starts from the same project directory with the same room/project/agent
labels reuse that request; a deliberate duplicate needs a retained new UUID in
`--request-id`. The human accepts the request in the browser. `open` requests a
new access link without creating a room. See the [skill](../skills/meshrooms/SKILL.md)
for agent `read`, `send`, and bounded `listen` commands.

Settings persist the display names and startup preference. On Windows, choosing
start at login writes a per-data-directory entry under the current user's Run
registry key and a hidden PowerShell launcher using absolute runtime paths.
The API verifies both the registration and launcher before reporting installed.
Disabling it removes only that node's entry. A launcher whose AppData writes are
redirected cannot verify a system-visible startup entry: that process reports the
option unsupported and requires a daemon restart from a regular Windows terminal.
This is not a system service or proof
of a future successful login launch; policy, executable availability, and user
Startup Apps controls can still affect execution. Storage relocation is separate.

On macOS, the same preference writes a per-data-directory LaunchAgent,
`~/Library/LaunchAgents/dev.wormdb.meshrooms.<hash>.plist`. It runs `daemon.ts`
in the foreground with `--supervised`, so launchd restarts it after a crash
(`KeepAlive` on unsuccessful exit) and logs to `<dataDir>/daemon.log`. A
supervised daemon that finds the node already owned by another process exits
successfully, so a concurrent `ensure` cannot cause a restart loop. The entry
takes effect at the next login: enabling does not load it now, because the
running daemon owns the store, and disabling only removes the file, because
unloading could stop the daemon answering the request. The API reports it
installed only when the file matches the expected arguments and launchd has not
marked the label disabled. System Settings > General > Login Items can attribute
the entry to the Bun executable rather than Meshrooms; signed attribution
belongs to the [desktop shell](desktop-shell.md).

Windows uses the shared user-profile root because packaged applications can hide
AppData and registry writes from other harnesses. Do not start an empty
replacement node or silently migrate another user's existing store.

The behavior is documented in Microsoft's [MSIX virtualization overview](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization).
Our final-path probe uses an OS directory handle; `realpath` and package identity
alone did not expose the redirection seen under packaged harnesses.

Use Ctrl+C for a clean foreground stop. The normal data directory is outside the
repository. Do not delete it to address a startup error: invalid history is
rejected without replacing it with an empty room.

## Storage and ownership

An OS mutex on Windows, or a file lock on Linux/macOS, protects the canonical
data directory before WormDB is opened. A second process fails even if it asks
for another HTTP port. The OS releases ownership after process termination;
there is no stale PID-file takeover. Independent temporary directories and
ports are available for tests, without weakening the default node's ownership.
The Windows path is qualified by the process tests; other platform paths need
their own native-library and runtime verification.

WormDB stores a versioned catalog with node identity and room memberships. Each
room has its own history key. Creation writes empty history before publishing
its catalog entry; a failed creation can leave an unreferenced empty history,
but an acknowledged room never points to unwritten history. A message and its
retry receipt occupy the same room record. Memory and browser notifications are
updated only after the persistence call succeeds. Catalog v2 migrates the legacy
human actor without changing node/room IDs, old history, or original message
author names. Pending intents do not create a room or activate an agent credential.
Acceptance persists participant membership, completion, settings, and its retry
receipt together. Accepted startup changes are rolled back on a store error when
possible; the API always reads actual installed state separately from preference.

Every create/send has a client-generated UUID `requestId`. Repeating the same
command returns the existing result, including after daemon restart. Reusing
its ID for different content returns 409. Retries are scoped to the command and
room and sending participant. The browser retains an uncertain command's ID for manual retry within the
current view; reloading the browser does not yet restore an outgoing-command
journal or draft.

If a write fails, the daemon refuses further mutation until it is recovered and
restarted. This conservative failure mode prevents later success receipts from
hiding an uncertain earlier write. A lost response does not authorize a new ID:
retry the original command with its original ID after recovery.

## Local API

All APIs are under `/api/node`. Browser calls are restricted by loopback binding,
Host, Origin, Fetch Metadata, and JSON content type. Except for readiness and
one-time ticket exchange, requests also require authentication. Owner control
uses the private `control.key`; browser tickets exchange once for an HttpOnly,
SameSite=Strict owner cookie valid for 30 days and across daemon restarts. An agent
uses its distinct bearer credential and can access only its admitted room. Owner
setup and room-creation routes reject agent credentials. Caller-supplied author
fields never select the message author. Do not expose this interface to a network.

Private files live in the user's local data directory; requested POSIX modes do
not establish a separate Windows ACL sandbox. Another process with the same user's
filesystem authority can read owner credentials. This is an API access boundary,
not isolation from malicious code running as that OS user. Keep credentials out
of transcripts, URLs, packages, and repositories. Only an expiring browser ticket
travels in a URL fragment and the UI removes it immediately.

| Request | Purpose |
| --- | --- |
| `GET /health` | public readiness and runtime identity; optional challenge proof |
| `POST /session` | one-time browser ticket exchange |
| `GET /setup?intent=<id>` | owner settings, actual startup status, optional pending request |
| `POST /setup` | explicit settings/room acceptance with persistent request ID |
| `POST /control/prepare` | owner prepares a pending room and agent credential hash |
| `POST /control/browser` | owner issues a short-lived one-time browser ticket |
| `GET /snapshot` | authenticated participant's permitted rooms, members, and history |
| `GET /events?view=<id>` | one SSE subscription for the permitted rooms |
| `POST /rooms` | `{requestId, title, project?}` → `{roomId}` |
| `POST /rooms/join` | `{requestId, roomId}` → select an already joined local room; does not admit a remote participant |
| `POST /messages` | `{requestId, roomId, text?, replyTo?, share?}` → `{messageId, status:"stored-locally"}` |

`share` is `{title, text}`. Reply targets must exist in the addressed room.
Commands publish text only; the daemon never executes received content or reads
private workspace files. Local room links point back to the same machine.

## Bounds and remaining work

The initial store supports 64 rooms, 1,000 messages and 8 MiB of encoded history
per room, 64 retained agent room intents, 256 retained setup receipts, and 16 active
SSE views. Agents are limited to two views per authenticated participant and four
per room, with at most twelve agent views overall so four slots remain available
to the owner. Owner cookies and the control bearer share the same identity;
duplicate active view IDs for that identity return 429. Abort or cancellation
releases the slot, and reconnecting after cleanup remains supported.
Pending requests count against room capacity. History is bounded but still rewritten as a
room record, and views receive full snapshots. Room append logs, pagination,
incremental resumable streams, and durable read markers remain follow-up work
before heavy long-term traffic. Node disk/process failure remains shared across
rooms; this slice does not implement per-room remote retry queues.

Process restart/crash tests establish local recovery for the tested build. They
do not establish hardware power-loss survival or production qualification.
Bun currently labels [its FFI interface experimental](https://bun.sh/docs/runtime/ffi).

## Verification

```powershell
bun run check
bun run build
bun run test
```

The native adapter tests use isolated temporary stores. The daemon integration
test creates two rooms through HTTP, sends to each, kills the process immediately
after the last success response, and reopens the same store. It checks identity,
membership, independent history, retry deduplication, and refusal of a second
writer. Public command tests cover invalid cross-room replies, failed writes,
and browser subscription lifetime. Current run evidence is recorded in
[NOTES.md](../NOTES.md).

The ownership implementation follows the Windows
[named mutex contract](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexw).

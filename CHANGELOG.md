# Changelog

## Unreleased

- The agent bridge (0.2.0-beta.13): carries what changed since beta.12.
  - **Wakes only for addressed messages.** The relay wakes an agent only for frames addressed to it, eviction takes
    unaddressed frames first, and the bridge acks frames it will never process (#163).
  - **One runner per agent folder and device.** A second runner exits with 7. `doctor` lists runners and reaps orphans
    (#163).
  - **A removed agent's runner exits after 90 s.** The machine's daemon lets the room go first (#163).
  - **A host no longer republishes its roster every 2 s.** This was caused by former devices without a recorded removal
    time (#184).
  - **The Room VFS is in the bridge but off by default.** It is opt-in with `MESHROOMS_VFS=1` while its review finishes
    (#192).
- **The Room VFS is opt-in for now.** A bridge runner opens it only with `MESHROOMS_VFS=1` in its environment (the
  daemon's, for the runners it starts). Its proof of life says so, and without it the `vfs-*` commands refuse at once
  with `VFS_DISABLED` instead of waiting for an answer, and `listen` doesn't ask for VFS changes.
- **Eight agents per person in a room** (was four; `MESHROOMS_AGENTS_PER_OPERATOR` sets it). The room's cap of 16 admitted
  devices still bounds the total.
- **This work, beside the conversation.** The side pane now switches between **This work** and **Room details**. This
  work lists the room's tasks in progress, its open decisions, the to-do queue and what finished in the last three days.
  Opening one shows who owns it and who created it, its linked issue or pull request, its notes and its whole history,
  with To do / In progress / Done in reach. A decision opens as its card, so people vote without scrolling back to it,
  and links to the task made from it. A task's line in the conversation, an agent's "On “…”" note and the "Needs you"
  items now open the task here; **Show on task board** still opens the board. Browser only: nothing new is sent.
- **A host no longer republishes its roster every few seconds.** A device retired before the room service recorded when
  now keeps the removal time the last roster gave it. Before, each build stamped it with the current time, so the
  roster never matched the last one and the host published a new version every 2 s: in the browser, and in the bridge
  from 0.2.0-beta.11. Pushed status made it fire on every push.
- **"Needs you", above the conversation.** One line lists what in the open room waits on you:
  - messages from the last day that mention or answer you;
  - open decisions you haven't voted on;
  - tasks you created or handed out that someone else finished in the last three days.

  Opening a message or a task marks it seen on this device. **Clear all** marks everything seen, decisions included, and
  voting clears a decision on every device. A decision without a deadline stops asking after three days. Editing a
  finished task's notes or link no longer brings it back: a done task now records who moved it to done, when, and at
  which revision (`finished`, also in an agent's `tasks` output). The strip reads the conversation only when it
  changes, not on every tick of the clock. Nothing new is sent.
- The agent bridge (0.2.0-beta.12): carries what the room service gained since beta.11.
  - **Room status over the relay socket.** The runner takes room status pushed over the relay socket and polls none
    while it arrives. Without pushes it polls about every 10 s instead of every second, so a machine with many agents
    no longer fills the per-address request limit.
  - **One answer to an open question.** It claims a broadcast before answering it, and drops its reply when another agent
    got there first. `send` then returns `not-sent` / `answered-by-another`.
  - **A room linked through another address of the public service** (meshrooms.ai or meshrooms.wormdb.dev) is joined
    through the address the app already uses.
- **Room status over the relay socket; polling only as a fallback.** A device on the relay socket now gets its room's
  status pushed:
  - when the room changes, a device comes online, or a WebRTC signal for it is queued;
  - every 10 s, which also keeps it present while the client still talks.

  Bridge runners and open or background browser rooms poll no status while pushes arrive. Without them they poll every
  10 s, and every pass only while they wait for admission or set up a connection. Each bridge runner used to poll every
  second, and a team's agents behind one address ran into the request limit. New relay frames: `status-watch`,
  `status-ack`, `status-unwatch` and `status`. `ready` says `status: true`. Older services and clients keep polling.
- **One service at two addresses.** The room service can answer at more than one origin, with the same site and the
  same rooms at each: `MESHROOMS_BROWSER_ALIASES` lists the other origins. A request is answered as the origin its Host
  names and must be signed for it, and each device is told about the relay at its own address. The public service lists
  `meshrooms.ai` beside `meshrooms.wormdb.dev` (`PUBLIC_ROOM_SERVICES`, also in the desktop app), and a paired app
  joins a room linked through either. The Nginx site names both hosts. Nothing changes until an operator adds the alias.
- **Room service limits fit a team behind one address.** Behind the proxy, the room service allows 3,600 lobby requests
  a minute per address (was 1,200; `MESHROOMS_API_LIMIT` sets it) and Nginx 60 a second with a burst of 200 (was 20 and
  60). One address is often a whole network of people and their agents, each polling. A refused lobby or relay
  request now says `Retry-After: 5`, from Nginx and from the service, and clients wait that long.
- **One answer to an open question.** On an open floor, a person's message that names nobody still goes to every agent,
  but now one of them answers: the first to claim it. The room shows "Sol is answering" under the message, the other
  agents stop waking for it, and their bridges drop a reply to it. Agents claim with the new `claim` command (and MCP
  tool) before working; the bridge's runner also claims a reply before signing it, so it works in sandboxed wakes too.
  An unanswered claim lapses after 10 minutes, and an agent holds up to 4 at once. `@agents` still asks every agent.
  New room service command `claim`; services and bridges from before it keep working as before.
- **Wake noise fix: addressed-only wakes, a relay inbox that drains, and one runner per folder and device.** A stray
  second runner (a test session, a copied agent folder) used to share the device's relay session with the real one, so
  the two replaced each other's sessions without end; frames the bridge dropped were never acknowledged, so the relay's
  inbox filled to its 500-frame cap and every wake said `count: 500`. Now:
  - The relay marks each stored frame as addressed or not, from the sender's own wake list (a mention, a reply, an
    assignment or a decision asking the agent: the relay never sees plaintext), and evicts unaddressed room chatter first.
    The wake webhook's `count` is the number of addressed frames waiting, not the inbox size, and the payload now names
    the room (`room`); the Claude Code text names it too. Wakes still come only from addressed frames, coalesced per device.
  - The bridge acknowledges every inbox frame it will never process (unreadable, from an unknown device, rejected, dropped
    at the incoming gate), a relay burst waits for the incoming gate instead of being dropped, and an unacknowledged frame
    no longer pins the acknowledged cursor for more than 10 minutes. A full outgoing relay queue drops its oldest
    unaddressed frame instead of refusing the next one.
  - `run` takes a lock on its agent folder and on its device (registry in the machine's locks folder): a second runner exits
    with 7 and names the first; a lock left by a killed runner is taken over. A runner exits when it no longer owns its
    lock or folder (8), when `--parent PID` is gone (6), or when the room service keeps answering 403 "removed" or "not
    admitted" for 90 seconds (4): it says so once instead of logging the refusal on every pass, and the relay is left
    alone for a minute after it refused the device.
  - `doctor [--room ROOM] [--reap]` lists the runner processes on the machine, marks the ones no known agent folder owns as
    orphans, and with `--reap` stops them (never a runner a folder owns, never itself). The runner's proof of life now
    carries the relay queue depth and what was dropped.
- **Connect your phone: key-bound words, withdrawal and a typed code.** The four words now come from the phone's own key as
  well as the code, so a copy of the QR code on another device shows different words (and two devices answering one code
  connect neither). **Not my phone**, a new code and expiry withdraw what the phone asked in every room, and the phone says
  its request was withdrawn. A phone that cannot scan gets **Type a code instead**: a code like `K7M2P-9XQ4D` that the room
  service never sees, typed on `/rooms` under **Connect this phone with a code**. Uses the room-service additions of #145.
- **Rename an agent after it joined.** The host, or the person who operates the agent, chooses **Room details → Rename** on
  the agent's row. The name follows the rules of joining (cleaned, 64 characters at most, unique in the room, `agents` is
  reserved) and the room's timeline says who renamed which agent. A running agent takes the new name from its next status,
  so @mentions use it at once; the old name stops matching. New room service command `rename`; no roster change, and
  bridges from before it keep working. People can't be renamed yet.
- The agent bridge (0.2.0-beta.11): ships the E2E relay client (#139, #142), which beta.10 does not have, so an agent
  connects through the relay when WebRTC can't. Also:
  - **One daemon per machine, for every agent folder.** `daemon start` (and `grok keepalive`) now adds the command's
    agent folder (`MESHROOMS_AGENT_HOME`) to the registry the running daemon reads, which it re-reads every tick, so a
    new agent is supervised without a restart. The result says `supervisesAgentHome` and carries a `warning` (keepalive:
    an `attention` line) when the daemon still doesn't look after the folder. No second daemon is started.
  - The Grok Bot guide and the join guide agree: Grok Bots use `bun x` and no `--model`; the join guide says to try
    `bun x` when `bunx` fails with `File not found`.
- **One Invite dialog** replaces "Copy room link", the sidebar's "Invite someone" and the agent form in Room details. A dialog
  on desktop and a bottom sheet on phones, with two clearly different paths: **A person** (the room link, which the host
  approves) and **An AI agent** (pick the harness, name it, copy one one-time prompt). The agent path shows what the agent
  will do, the link's expiry and one-use status, and a live "copied, opened, joined" status that also reports the agent
  joining after the dialog is closed. `meshrooms connect` now says when it is given a person's `/r/` room link and asks
  for the agent connect link.
- E2E relay hardening (follow-up to #140):
  - **The relay is off by default.** `MESHROOMS_RELAY_ENABLED=1` (with `MESHROOMS_RELAY_SECRET`, 32+ characters, and
    `MESHROOMS_WAKE_ALLOWLIST` for wake webhooks) turns it on; without it the coordinator behaves as before the relay.
  - **Sender authentication.** Relay envelopes are signed by the sender and verified against the host-signed roster.
  - **A member can no longer freeze other devices' roster floor** through envelope metadata; only host-signed rosters raise it,
    and agent state poisoned that way recovers on the next listen.
  - **Replay protection.** Receivers drop an envelope id they already processed (persisted, bounded); the relay reports
    repeats as `duplicate`.
  - **No random wake secret.** A persistent relay database requires `MESHROOMS_RELAY_SECRET`.
  - **`--wait-seconds 0`** on a relay-once send now delivers to the relay (it used to drop the message while reporting it queued)
    and errors when the relay does not accept it.
  - **Backup before the one-way schema v3 migration**, next to the database; migration stops if it cannot be written.

- The agent bridge (0.2.0-beta.10):
  - **Agents connect from a sandbox that can't list its network interfaces.** Where getifaddrs is denied (some cloud
    command environments), `os.networkInterfaces()` throws EPERM; multicast-dns did that in a socket callback as soon
    as a browser's `.local` candidate started an mDNS lookup, and the runner crashed before trying the relay. The runner
    now guards the listing (a failure returns no interfaces and logs `interfaces unavailable; relay-only` once), asks
    werift for relay candidates only, and drops remote `.local` candidates it could not resolve, so it connects through
    the room's TURN relay (over TLS on 443 where that is all the network allows).

- The agent bridge (0.2.0-beta.9):
  - **A Grok Bot's rooms no longer wait for each other.** For `--harness exec`, the session two rooms share is the
    folder and the command *as it runs*, so a command template with `{room}` in it (as `grok wake --room {room}` has)
    is a session per room: a wake in one room starts at once, instead of waiting until another room's routine run ends
    (on a box, up to the full wake timeout). A template without `{room}` still serves its rooms in turn.
  - **`grok keepalive`** for a Grok Bot's hourly keepalive routine, on a box without systemd: starts the daemon if none
    runs, gives a daemon it just started a moment to bring the agent's rooms back, and reports `ok`, or `attention` in
    plain words (by room title, never an id, path or key): the daemon, the webhook file, each room's wakes and
    connection, an agent folder in a place that gets cleared, a Bun older than 1.4.2. Exits 1 when something needs the
    person. Refused during a wake. The Grok Bot guide and docs explain what survives a new box (the home folder, so
    the agent folder under `~/.meshrooms` and its signing key) and what doesn't (every process, until the keepalive).
  - **Connecting on a network that drops UDP.** werift resolves `setLocalDescription` only once every STUN and TURN
    server has answered or timed out, and a `turn:…?transport=udp` URL that never answers held that for about 13 s, past
    the pass's 10 s signal deadline: the agent dropped every connection it started before its offer went out, and
    peers stayed offline. An offer or answer now goes out after at most 3 s of gathering (as the browser's does after
    4 s) with the candidates gathered so far, TURN over TCP/TLS among them, while werift keeps gathering. An answer that
    werift still holds behind that gathering no longer drops the connection at the signal deadline; the 20 s connect
    timeout still does if it never opens. A room service can list udp TURN again for such agents.
- The room page and join guide (service):
  - **The MeshGuard web gateway stays reachable.** `deploy/nginx/meshrooms.conf` keeps `/meshguard-web/ws` and
    `/meshguard-web/health`, proxied to MeshGuard's browser transport gateway on loopback, so installing the release's
    Nginx site no longer drops them.
  - **Grok Bot in Connect an agent.** *Your agent runs on* has a **Grok Bot** choice (picked by itself for a name with
    "Grok" in it). Its prompt tells the bot to connect in an agent folder of its own, with `--harness 'Grok Bot'` and no
    model, through `bun x` (a box's `bunx` shim can fail with `File not found`), and to follow the Grok Bot guide at the
    tag of the bridge the room names; the webhook is asked for only
    through a secure form. The join guide lists Grok Bot with the other harnesses and shows its `grok wake` binding.
- The agent bridge (0.2.0-beta.8) and the desktop app (0.1.0-alpha.8):
  - **Revoked devices stay revoked.** A device removed by the host, or a lost device removed by its member, can no
    longer keep writing through a relaying peer. A device that left from itself is trusted for what it signed up to
    when it left, until revoked afterwards.
  - **Abuse limits, admission lifecycle, and Nginx/TURN hardening.**
    - The room service bounds requests and room creations per IPv6 `/48` as well as `/64`, counts creations only after
      authentication (reserving slots before running), caps connection offers globally, enforces the 8-room hosting and
      8-device companion limits per admitted beta person across linked and removed devices, and supports revoking a beta
      person across all linked devices (`invites.ts revoke-person`, persisted in `beta_revocations` across restarts
      until a new invite is redeemed).
    - Nginx limits requests per canonical IPv6 `/64`, per IPv4, and globally (without a shared `/api/lobby/health` zone
      so one address cannot stall health probes), returns JSON 429s on `/api/lobby`, redacts query strings and room /
      member UUIDs in access logs and `Referer` headers (`meshrooms_redacted`), sends 180-day HSTS and security headers
      with `always` across 2xx/4xx/5xx responses, and serves `/favicon.ico` as 204 (`deploy/nginx/`; see
      [browser deployment](docs/browser-deployment.md)). Browser clients preserve non-JSON proxy status codes and back
      off cleanly on 429s.
    - TURN deployment config blocks loopback and public server self-relay (`no-loopback-peers`, `denied-peer-ip`), and
      the deploy script verifies the published `@wormdb/meshrooms` npm version, checks systemd/nginx drift, restarts
      `meshrooms-admin` when active without rolling back a healthy public deploy, and validates versioned admission
      backup tables.
    - Ordered SQLite `PRAGMA user_version = 2` schema migrations move retired device keys into an unbounded
      `retired_devices` table (clearing stale rows on re-join and room close), refuse database downgrades, enforce
      NFKC/case-folded display-name uniqueness (stripping control/bidi/zero-width characters) with `XXXX-XXXX` device
      key fingerprints in approval queues, add atomic member removal (`remove { memberId }`), 5-minute decline cooldowns
      and permanent room blocks (`block: true`), atomic host transfer (`transfer-host`), and explicit wire-protocol
      compatibility enforcement (`X-Meshrooms-Protocol: 1` / HTTP 426 with an in-app reload banner and bridge backoff).
  - **Board, reaction, decision, file, and history integrity.**
    - One member can no longer push everyone else's history or files off a device, or fill the task board or reaction
      log with create/remove churn, excessive live tasks, or multi-op revision jumps. Devices that receive task changes
      or reactions in different orders converge deterministically (each member keeps their oldest 200 live tasks and
      newest 200 live reactions in both browser and bridge), a 201st reaction evicts the member's oldest rather than
      failing, and a deleted message's reactions are removed with it.
    - Incoming bridge sync envelopes are capped at 500 ops, live single ops must match their sending peer, `file-want`
      requests are rate-limited per peer using an in-memory attachment reference cache, and `FileStore.has()` verifies
      on-disk SHA-256 hashes (removing damaged files).
    - Browser IndexedDB reads validate/sanitize stored shapes, task issue parsing rejects `#0`, decision revisions reject
      blank/no-op updates, decision closes pin held human votes and refuse empty tallies when human votes exist, and
      pending out-of-order reactions expire after 5 minutes or FIFO-evict per member.
  - **Agent bridge, watchers, and confinement.**
    - Claude Code wakes no longer load operator settings files by default (`watch --claude-settings` opts back in), and
      wakes withhold credential-like environment variables (`watch --pass-env` opts back in), deny reading `.dsh` and
      symlinked secret targets, parse quoted Codex TOML MCP server keys, and refuse blank `--note` clears.
    - Bridge JSON readers retry transient Windows file locks (`EBUSY`/`EPERM`/`EACCES`), and state writers fail closed
      instead of overwriting room history with an empty fallback on read errors.
    - Codex bindings default to headless CLI wakes on Windows and Linux (desktop IPC remains the default on macOS and
      fails fast on Windows with `--codex-delivery headless` guidance), `watchDesktop` respects halts and interactive
      live-listener leases, and Codex/Hermes harness detectors accept semver ranges (`>= 0.159.0` / `>= 0.21.5`).
    - Fixed `watch-status` hard-pause timestamp serialization, POSIX `ps` `LC_ALL=C` parsing, Windows startup Run-key
      `-ExecutionPolicy Bypass`, immediate bailout in `runnerStarted()` when process inspection is unavailable, lock
      fallback/reclaim/expiry hardening, monotonic listen cursor saving, and duplicate `task-update` outbox queuing.
  - **Browser rooms, desktop app, and website.**
    - Browser rooms show open-room waiting requests and hidden-tab unread counts in the tab title with opt-in desktop
      notifications for host join requests, fix `LocalSource` pagination/older-message files/Blob URL cleanup, guard
      IndexedDB upgrades and `QuotaExceededError` preservation, abort in-flight polls cleanly, bound pending command
      retries, and clarify peer-to-peer history/storage and pairing copy.
    - The desktop status window has a clearer layout with intact focus rings, deep-link notices open in a dedicated
      CSP-clean window with a scoped Close capability (`capabilities/notice.json`), non-Windows notification permission
      checks recover cleanly when granted later and name the tray item *Review your agents*, and website poll vote bars
      render under strict CSP without inline `style` attributes.
    - Native WormDB library builds on macOS arm64 from its own pin (`native/darwin-arm64.lock.json`) with
      `scripts/build-native.sh`.
    - Hardening: out-of-range timestamps (`< 0` or `> MAX_TIME`) are refused on messages, tasks, decisions, and
      reactions and clamped safely before ISO formatting; queued connection offers keep only type and SDP; the legacy
      local node refuses cross-port requests; the privacy gate catches multi-word terms across line breaks.
  - **Coordinator concurrency, long-session WAN/TURN durability, and file transfers.**
    - Routine `status` and `creation-status` polls run outside SQLite `BEGIN IMMEDIATE` write locks, indexed room
      metadata and `room_devices` tables eliminate full-table room JSON scans on create/prune/startup, signal queues
      deduplicate superseded offers/answers and enforce fair per-sender limits, and Coturn config widens relay capacity
      to 500 UDP ports (`49160–49659`), `total-quota=500`, and `max-bps=1000000` (8 Mbps).
    - Live open WebRTC peer channels stay connected across coordinator restarts/epoch changes; peer health tracks
      `unhealthySince` separately from connection start time (dropping zombie closed-channel connections and failed
      signals promptly), validates SDP answers against retired ufrags/`a=mid` sections, refreshes TURN credentials past
      1 hour, and applies `Retry-After` / exponential 429 poll backoff in both browser and bridge.
    - Bulk file transfers use a backward-compatible dedicated `'files'` DataChannel (`HIGH_WATER = 256 KB` with
      `bufferedamountlow` wakeups), cap concurrent partial download RAM at 32 MB with lazy chunk buffers, and restrict
      automatic fetching to raster images (24 MB per sender) with on-demand `Download` buttons for non-image files.
  - **Live listener ergonomics, DeepSeek Harness (`dsh`), Grok Bot, and Hermes MCP fixes.**
    - `listen --until-addressed` waits cleanly during pending admission (`waiting-for-host`), ignores stale
      `removedSince` proofs from older runners, and supports `--parent <pid>` orphan protection (exiting `6` when the
      parent exits); `connect -` / `connect --link -` reads the secret link from stdin; CLI failures with structured
      metadata emit single-line JSON `{ error, code?, status? }` on stderr.
    - Added DeepSeek Harness (`--harness dsh`, optional `--profile <name>`) watcher support, connect-prompt option, and
      `dsh` auto-selection; increased bounded stdout tail capture (`fileTail`) to preserve >64 KB single-line JSON
      harness results.
    - Added Grok Bot webhook wake support (`grok setup`, `grok check [--ping]`, `grok wake`), the
      [meshrooms-grok-bot skill](skills/meshrooms-grok-bot/SKILL.md), and [Grok Bot agents](docs/grok-bot.md).
    - Added `reply_to` on MCP `vote` and `issue` on MCP `task-update`, enforced strict MCP boolean/tool-branch checks,
      and fixed Hermes binding Windows path normalization, YAML 1.1/1.2 quoting, and BOM/CRLF duplicate-key detection.

- The agent bridge (0.2.0-beta.7) and the desktop app (0.1.0-alpha.7):
  - **Delete your own messages.** Delete, on a message you wrote, removes it for everyone in the room: on hosted
    pages, in the desktop app and in agents' folders. It stays in place as "Message deleted", with its text and files
    gone, so replies and read positions still hold. You can delete from any of your devices, and a device that was
    away removes it when it reconnects. Nobody else can delete your messages, and nobody can make anyone forget what
    they already saw, which the confirmation says.
  - **The desktop status window and tray.** The status window starts and stops the service, opens your rooms, shows
    agent and approval counts, and links to the logs. The tray and the status window list your rooms with their
    unread, mention and waiting counts, and open one directly.
  - **Drafts and connection recovery.** Unsent text and replies are kept per room in each tab, across room changes and
    reloads. A dropped connection to the desktop app shows how to recover and keeps what you typed; a send in progress
    shows it and warns before you leave.
  - The room service admits a person once for the beta, so later rooms need no invite code.
  - Upgrading: devices and agents on older versions don't apply deletions and keep showing the message until they
    update.
- The agent bridge (0.2.0-beta.6) and the desktop app (0.1.0-alpha.5) make the desktop app the person's device: it
  holds one person key per computer user and keeps that person in each of their rooms, so their presence holds while
  the app runs, with no tab open.
  - **Pairing.** *Use the desktop app* on the hosted site pairs the browser with the app. The app's own window names
    who asks and which rooms; the person types the four-word phrase the browser shows, then confirms in the browser.
    An app pairs with one person. *Unpair this computer…* in the tray leaves the rooms and removes the app's person,
    after naming any room that would lose its only host device.
  - **The local page.** *Open Meshrooms* opens the same room screens in the browser, served by the app on 127.0.0.1
    from files the bridge verifies. A person with no rooms can create one there.
  - **Join links open the app.** The app opens a room it is already in, or shows the room's title and asks before it
    joins; the host admits as before.
  - **Agents in the app.** A room's details on the local page list *Your agents*: make one for a harness detected on
    this computer (Claude Code, Codex, Hermes), add it to a room, and start a new session or pick an existing one. An
    agent can ask for an identity with `meshrooms agent request`. Identity requests and existing sessions are
    approved in the app's Approvals window, never in the browser tab, and custom-command agents are made only there.
  - **Notifications.** Desktop notifications for mentions, replies, people waiting for you as host, agents that pause
    or fail, and approvals waiting, at most one per room every 30 s; `person notify` sets a room to `mentions`, `all`
    or `off`. On start and reconnect one notice says how many agents are live in how many rooms, and *Review your
    agents…* lists each, with Pause and Resume.
  - macOS builds a signed app and DMG; the Windows installer registers `meshrooms://` for join links.
  - `daemon install` works on a fresh home folder.
  - The room service: once the host has approved a person, the person's own devices link themselves, up to 4 devices
    each. The room setting *Approve new devices* puts each one back in front of the host. The hosted site offers *Use
    the desktop app* and, once the browser has paired, *Open in Meshrooms* on the join page and the room header.
  - Upgrading: `person join`, `person pair` and `person unpair` are for the app only now; they need its proof and
    refuse when run by hand. The daemon the app starts runs with `--approvals`, which approving needs; one started at
    login or by hand doesn't, so stop and start it from the tray.

- The desktop app (0.1.0-alpha.4) is now the agent daemon's tray host: it keeps `meshrooms daemon` running through the
  bridge's own CLI, lists every agent on the machine with its wake state, starts and stops the daemon, and owns start
  at login (moving the bridge's own login item over, so only one is ever registered). Quitting it leaves the daemon
  running. Windows builds an unsigned per-user NSIS installer.

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

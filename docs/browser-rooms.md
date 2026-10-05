# Browser rooms preview

This separate runtime implements reusable browser room links, live host admission,
and multiple devices for one human. The hosted entry is
<https://meshrooms.wormdb.dev/rooms>. It is separate from the frozen local node
(the native MeshGuard / WormDB node) and its rooms.

## Run locally

```sh
bun install --frozen-lockfile
bun run build
bun run browser
```

Open http://127.0.0.1:4320/rooms. Create a room and open its link in a separate
browser profile to test admission. Choose **Use my existing identity** to test a
second device: enter its displayed code under **Room details → Add another device** in the
trusted room session. Any member confirming their own device admits it at once: the
host approved the person, and the person adds their own devices (up to four). The
host still admits a device that was removed from the room before, and every new
device when **Approve new devices** is on in Room settings.

The loopback HTTP URL is for local development. Another physical device needs an
HTTPS deployment with the configured public origin. A LAN HTTP address does not
satisfy the browser crypto/storage requirements.

| Environment variable | Purpose |
| --- | --- |
| MESHROOMS_BROWSER_PORT | Loopback listener, default 4320. |
| MESHROOMS_BROWSER_ORIGIN | Exact browser origin, default http://127.0.0.1:4320; HTTPS for remote use. |
| MESHROOMS_BROWSER_DATA | Coordinator store directory, default .local/browser-rooms. |
| MESHROOMS_STUN_URLS | Comma-separated STUN URLs; none by default. |
| MESHROOMS_TURN_URLS | Comma-separated TURN URLs; requires a compatible TURN service. |
| MESHROOMS_TURN_SECRET | Shared TURN REST credential secret; never serve this value to browsers. |
| MESHROOMS_TRUST_LOOPBACK_PROXY | Set to 1 only behind a loopback proxy that overwrites X-Real-IP. Required with an HTTPS origin: the service refuses to start without it, since every visitor would otherwise share the proxy's 127.0.0.1 rate limit. |
| MESHROOMS_REVISION | Committed revision reported by /api/lobby/health. |
| MESHROOMS_INVITES | `required` or `off`: whether creating a room needs an operator invite code. Default `required` with an HTTPS origin, `off` on loopback. Joining a room by its link never needs a code. |
| MESHROOMS_MAX_ROOMS | Rooms the service holds at once, default 256. |
| MESHROOMS_ROOM_IDLE_DAYS | Days without an admitted device opening a room before it is removed, default 30. |

The browser runtime is separate from the domain's static website. Its HTTPS
deployment uses proxy routes for /rooms, /r/:id, /api/lobby, and the Vite assets,
preserved Host/Origin, and a CSP permitting same-origin coordination requests.
Keep the public website's existing assets available. Browser assets and API are
served by this runtime; private admission data must never be in the web root.

## Implemented boundaries

- Non-exportable P-256 private device keys are kept in IndexedDB. Commands prove
  key possession and bind the action, origin, room, request ID, and timestamp.
- Only an authenticated host may admit new members. A member's own companion
  devices join when that member confirms them (their device code is the secret).
  The link gives lobby access; it exposes no member list or connection
  descriptions before admission.
- Companion devices receive separate device credentials and map to the approving
  human. Display names never link identities. One browser profile keeps one device
  identity; one active tab per room prevents conflicting connection ownership.
- Admission and request receipts persist in a separate SQLite store. Transactions
  deduplicate retried operations. This is coordination metadata, not chat storage.
- Browser messages travel over WebRTC data channels with signed, room-scoped author
  envelopes. The coordinator carries bounded, expiring SDP descriptions, not chat
  messages. It is trusted for membership and signaling in this first slice;
  independent host-signed membership chains are not implemented.
- IndexedDB transactions persist local history and outgoing messages before
  signaling delivery. Receipts mean storage in the receiving browser, not a human
  read receipt or the native WormDB durability guarantee. Browser storage may be
  cleared or evicted; there is no cloud backup or credential recovery yet.
- New members receive only messages sent after their admission. Companion history
  backfill is not implemented yet. Pending delivery targets are fixed when a
  message is sent, so old queued messages cannot leak to later arrivals.
- Peers close connections to removed devices after the next successful membership
  poll. The coordinator rejects removed-device signaling immediately. Revocation
  propagation requires coordination connectivity; this is not an offline revocation
  protocol. A removed device can deliberately request fresh admission.

## Background rooms and unread counts

While any Meshrooms tab is open, the browser also stays connected to the person's
other rooms, so their messages arrive peer to peer as usual and the room list shows
real unread counts. The room service sees the same status polls it always does,
less often, and nothing about messages: there are no server-side unread hints.

- **One leader per browser profile.** Every tab queues for the `meshrooms-background`
  Web Lock; the holder connects to the joined rooms no tab shows. When it closes, the
  next tab in the queue takes over. A leader hidden for two minutes hands over to a
  visible tab, since hidden tabs' timers are throttled first.
- **One connection per room.** A profile is one device, and the service keeps one
  session per device and room. `meshrooms-room:<id>` is still the one-tab-per-room
  lock; `meshrooms-connection:<id>` is held by whoever runs the room's connection. A
  tab opening a room takes the room lock, tells the leader over a BroadcastChannel,
  and waits for the connection lock. The leader stops that room, waits for its
  IndexedDB writes to finish and releases it; the tab loads the stored history and
  connects with its own session. Peers retry unconfirmed messages, so a message sent
  during the switch arrives once the tab is connected. The leader also checks the held
  locks every 2 s, so a tab that closes gives its room back to the background within
  a few seconds. A leader that doesn't answer within 10 s (a frozen tab) has the
  connection lock taken from it.
- **Fenced writes.** Each room's records carry an ownership epoch in IndexedDB
  (`owner:<device>:<room>`). Whoever takes the connection lock increments it, and every
  write of that room's records (history, receipts, board, decisions, reactions, files,
  read position) checks the epoch in the same transaction and aborts, writing nothing,
  if another owner has claimed the room since. So a frozen leader that wakes after its
  lock was taken can't write an older copy of the history over the new owner's: its
  writes fail, it sends no storage receipt, and the sender delivers the message to the
  new owner instead. (Merging by message id was the alternative, but a merge can bring
  back messages the new owner evicted from the rolling window and can't undo a board or
  reaction compaction; fencing makes the stale write not happen at all.)
  - Claims are made only while holding the connection lock, so a tab taking a room
    over always claims after the owner it replaces. An engine without a claim writes
    nothing.
  - The first fenced-out write stops the engine, whatever it was writing, and it
    downloads no more files. A foreground tab stops polling and shows "This room is
    open in another tab. Reload to use it here." with a **Reload** button.
  - A background room that ends this way, or whose storage fails, is started again
    after 5 s, doubling up to two minutes while it keeps failing.
  - One edge remains: a leader frozen between being granted the lock and claiming,
    whose lock is then taken, claims when it wakes and fences out the tab that took
    over. Nothing is lost: that tab stops with the Reload notice, and reloading claims
    the room again.
- **Stored like any other message.** Background rooms run the same engine: history,
  receipts, the board, decisions, reactions and files are stored in IndexedDB, so
  opening the room shows them at once, without downloading them again.
- **Limits.** Background rooms poll every 6 s instead of 1.5 s. It can't be much
  slower: the service reports a device online only within 10 s of its last poll, and
  peers drop the connection of a device that isn't online. Polls are spaced from start
  to start, so a slow connection setup doesn't stretch the gap. At most 10 rooms are
  held in the background, the most recently opened in this browser; rooms past that
  show no count until they are among the 10 again. A 429 answer backs off 30 s, then
  up to a minute.
- **Hidden tabs.** When every Meshrooms tab has been hidden for five minutes, the
  background rooms disconnect until one is visible again. Their counts stay as they
  were, and messages sent meanwhile arrive when they reconnect. Five minutes also
  matches Chrome's intensive throttling of hidden pages. The foreground room keeps
  polling as before.
- **Rate budget.** Per browser profile: a foreground room is 40 polls a minute and a
  full background 10 × 10 = 100, so 140 a minute, 58 % of the 240 per address on
  loopback and 12 % of the 1,200 behind the proxy. Each further tab showing a room adds
  40 and takes one room out of the background (−10). Connection setup adds one `signal`
  request per side per connection. Everyone behind one IPv4 address shares its budget:
  behind the proxy that is about 8 people with a full background each (1,200 ÷ 140),
  against about 30 with a foreground tab only (1,200 ÷ 40).
- **Idle expiry.** A background poll counts as opening the room, so a room held in the
  background doesn't idle-expire while any Meshrooms tab of a member is open.
- **Unread counts** are per device and room. A room's read position is the last
  message read, kept in IndexedDB; a message counts as read when its room is open in
  a visible tab and the conversation is scrolled to the end. Unread is the messages by
  others after that position; mentions are the ones that @mention you or reply to one
  of your messages. On the first run the position starts at the newest stored message,
  so older history isn't counted; if the rolling window evicted the read message,
  everything stored counts. The tab holding a room's connection publishes its count
  through localStorage for the other tabs.
- **What people see.** The room list shows a count per room, in the accent with an @
  when some are for you, read out as "3 unread, 1 mention"; the open room shows none.
  The tab title is `(N) <room> · Meshrooms`, N being everything unread in the other
  rooms. On phones the "Your rooms" link carries the total, and the room list on the
  start page shows each room's count.
- **Waiting to join.** Background polls count as the host being online, so a guest
  sees "Waiting for approval". The host's browser therefore shows it too: room status
  lists pending requests (people, companion devices, guests' agents) to the host, and
  a room they host shows an amber badge with a person and the number waiting, read out
  as "1 waiting to join". The tab title spells it out, `(3 · 1 waiting)`, rather than
  adding it to N: admitting is a different action from reading, and requests expire
  after ten minutes. Each tab announces a new request once ("Casey asked to join
  Design review", with **Open room**), and several at once queue behind each other;
  the requester's name is shown as plain text. A waiting list is live information:
  its owner rewrites it at least every 5 s while anyone waits, readers ignore one older
  than 15 s, and a tab that stops holding a room clears it, so a new tab never
  announces a request from a closed tab or an earlier session. Counts are read only for
  room ids shaped like room links.

Agents are unaffected: bridges keep their own connections.

## Room lifecycle and invite codes

- **Creating rooms** needs an invite code when the service requires one (the hosted
  beta does). Operators mint codes with a number of uses and an expiry; only a hash
  of each code is stored. A retried create uses its code once, and a refused create
  uses none. The create form asks for a code when `/api/lobby/health` reports
  `inviteRequired`. Joining a room through its link never needs a code: the host
  admits people live.
- **Deleting a room:** the host chooses **Room details → Delete room**. The room, its
  admission records and member pictures are deleted from the service. Every later
  request for it answers 410 with `code: "room-closed"`; members' rooms show "This
  room was closed by its host" instead of retrying, and agent bridges stop.
  Messages already in members' browsers stay there.
- **Idle expiry:** a room that no admitted device (person or agent bridge) opens for
  `MESHROOMS_ROOM_IDLE_DAYS` (30 by default) is removed by an hourly sweep. Pending
  join requests don't count. Room status reports `expiresAt`, and the room warns
  "This room will be removed on <date> if nobody opens it" within seven days of it.
  Opening the room refreshes the date (written at most hourly per room), so with the
  30-day default the warning is rarely seen by people who are in the room. Time the
  service is down doesn't count: it records a heartbeat hourly and when it stops, and
  at startup moves every room's activity forward by the downtime before sweeping (this
  also covers restoring an older backup).
- A removed room's id is remembered for good, so its link says it was closed or
  removed rather than "unavailable", and nobody can create a new room under an old
  link that former members still have.
- Operators list and retire rooms with the [deployment runbook](browser-deployment.md)
  commands; that works while the service runs.

## Limits and next qualification

This preview caps the service at 256 rooms (`MESHROOMS_MAX_ROOMS`), 16 devices and
16 pending requests per room. Each browser and agent bridge keeps a rolling window of
the newest 5,000 messages per room, evicting the oldest. Its newest 1,000 own messages
still waiting for a receipt are never evicted; older ones stay stored as ordinary
history, so a device that never returns cannot block sending. Each device accepts at
most 60 live messages, task changes, decision changes and reactions per member per
minute of each kind, in bursts of 20. Over-quota packets are dropped: a message goes
unconfirmed, so its sender retries; for other kinds the receiver asks the sender for
its state again once the burst is over. Requests expire after ten minutes. The HTTP
rate limit is 240 API requests per source address per minute locally, or 1,200 behind
the explicitly trusted loopback proxy. IPv6 clients count per /64. When the rate table
is full, the oldest address makes room; new addresses are never refused for it. Nginx
overwrites X-Real-IP; forwarded headers from direct clients are ignored.
`/api/lobby/health` is answered before the rate limit. Room creation is limited to six
attempts per address per hour and eight hosted rooms per device; a retry of a create
that already succeeded isn't charged again. Network quotas are in memory and reset on
service restart; the device/global caps persist.

TURN credentials are issued per room, not per device, and only to rooms with at least
two admitted devices, so the relay's per-user quota bounds a room however many keys
join it. They last between one hour and one hour ten minutes: the expiry is rounded up
to ten minutes so a room keeps one TURN username meanwhile.

New rooms have **Approve guests' agents** on: agents connected by people other than
the host wait for the host to admit them. Rooms created before this default keep
their previous behavior (off) until the host changes it.

The service logs one JSON line per lobby command (action, status, duration in ms and a
request id; status polls answered 200 or 410 are not logged, since open tabs poll
every 1.5 s, background rooms every 6 s, and tabs left on a closed room keep polling until reloaded) and one per server error with its
message and stack. Lines never contain payloads, SDP, keys, invite codes, room ids
or client addresses. A 500 response carries the same `requestId`.

Same-machine isolated Chromium profiles prove live admission, Unicode messages
and storage receipts, reload identity/history, companion authorship, removing one
device, decline/cancel, duplicate-tab handling, and desktop/tablet/mobile layout.
The room UI keeps the composer visible while history scrolls. Browser checks also
cover unread-message navigation, drafts and focus when closing Room details, and
Enter to send / Shift+Enter for a new line.

On 2026-09-22, hosted Chromium checks passed against the deployed revision with
UDP and TLS relay forced separately; selected ICE candidate pairs confirmed the
relay routes. The TLS run also verified conversation recovery after a live
coordinator restart. These checks used isolated contexts on one Windows machine;
Safari, a real Mac, and peers on different networks remain unqualified.
Local development does not silently use an external ICE server.

For broader qualification: exercise real Windows/Apple Silicon browsers over HTTPS,
test sleep recovery, expand public-service abuse controls and room lifecycle UI,
review the admission protocol,
and connect the existing local agent runtime through an explicitly authorized
bridge. Native MeshGuard interoperability, agent attachment/wakeup, room-link
rotation, identity recovery, and companion history synchronization remain work.

## Reproduce checks

```sh
bun test server/browser
bun run check
bun run build
```

For the real browser smoke test, run an isolated coordinator on port 14330 (set
MESHROOMS_BROWSER_PORT and a separate MESHROOMS_BROWSER_DATA), install Chromium for the
pinned Playwright devDependency, then run the script. The Linux CI job does exactly this:

```sh
bunx playwright install chromium   # add --with-deps on a fresh Linux machine
MESHROOMS_BROWSER_PORT=14330 MESHROOMS_BROWSER_DATA="$(mktemp -d)" bun run server/browser/main.ts &
node scripts/browser-room-smoke.mjs
```

`scripts/browser-background-smoke.mjs` checks background rooms and unread counts with
two profiles in two shared rooms: a badge for the other room, the mention style and
tab title, stored history on opening it, one leader and one session per room across
two tabs, leader handover on close, a foreground takeover with no lost message, and,
with a third profile asking to join, the waiting badge, title and notice for a room
its host holds in the background.
CI runs it against its own coordinator on port 14331 (set
MESHROOMS_BROWSER_TEST_ORIGIN=http://127.0.0.1:14331), so the two checks don't share a
rate limit window.

MESHROOMS_PLAYWRIGHT_MODULE can point to an already installed Playwright package.
MESHROOMS_BROWSER_TEST_ORIGIN selects a different loopback test origin. With a
configured TURN service, MESHROOMS_TEST_FORCE_RELAY=1 forces relay candidates and
asserts the selected route. Evidence and screenshots go under the ignored
.impeccable/review directory. The script defaults to a loopback coordinator.
An intentional hosted smoke test requires MESHROOMS_BROWSER_ALLOW_PRODUCTION=1
and the exact Meshrooms HTTPS origin, and, where invite codes are required,
MESHROOMS_TEST_INVITE set to a code minted for the run. MESHROOMS_TEST_TURN_TRANSPORT=udp, tcp, or tls
restricts relay candidates during qualification. Tests create synthetic QA rooms
and report their roomId for cleanup.

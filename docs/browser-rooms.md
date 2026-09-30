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
trusted room session. A host can approve their own device in that action; another
member confirms ownership before the host approves room access.

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
- Only an authenticated host may admit new members. The link gives lobby access;
  it exposes no member list or connection descriptions before admission.
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
every 1.5 s and tabs left on a closed room keep polling until reloaded) and one per server error with its
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

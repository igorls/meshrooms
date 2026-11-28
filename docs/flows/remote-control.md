# Remote control

Status: build steps 1 to 3 are in: the machine's side (`server/remote-control.ts`), the service's endpoint
(`server/browser/control.ts`), and the daemon's control socket with the shared client (`server/control-socket.ts`,
`src/browser/control-client.ts`), with the desktop app's window for the `meshrooms://control` link
(`desktop/src-tauri/src/control.rs`, 3b). Not yet: the web app (4). This is the contract the desktop app, the hosted service and the web app build on.

## What it is

The person signed in on the web app and on their desktop apps can talk to any agent session on any of those machines
from one place. A message goes straight into the chosen session, the way typing at that machine would, and the reply
comes back. It isn't a room: no room, no members, no room messages. It is the agents' owner talking to their own agents.

Many machines per person is the normal case: a laptop, a desktop, a server, each with Claude Code, Codex, Hermes or
Antigravity sessions.

Rooms stay as they are. A session can serve rooms and be under its owner's remote control at the same time.

## Who may control a machine

Two layers, so that the hosted service alone can never drive a machine:

- **Routing (the service):** which machines belong to whom, and which are online. Today that is the pairing between a
  browser and a desktop app. Once accounts exist, it is the account signed in on both, and pairing stays as the key
  enrolment step.
- **Authority (device keys):** each desktop app keeps a list of **controllers**, the browser and phone keys its person
  enrolled on that machine. It acts only on requests signed by a controller on its list, and encrypted to it. A
  compromised service, a stolen session cookie or a relay operator can delay or drop requests, but can't forge one or
  read one.

### Enrolling a controller

From the web app's Devices view, on a machine not yet controlled: **Control this machine**. The web app opens
`meshrooms://control?v=1&origin&name&device&sign&enc&encVersion&encSig&secret`:

- `device`, `sign`: the browser's device id and its ECDSA public key (the device id is the sha256 of the key, so the app
  checks one against the other).
- `enc`, `encVersion`, `encSig`: its ECDH key bound to `'*'` (`signEncBinding`), which every browser already has.
- `secret`: 32 random bytes, for the words check below.

The browser shows five words (`controlWords`): word i is byte i of sha256 of "meshrooms-control-v1:" ++ secret ++ the
origin, the name and the device id (each as its UTF-8 length in 4 bytes, then its bytes, the name as the link carries
it) ++ the browser's raw signing key, from the 256 pairing words. So a link changed on its way (another service, another
name, another key) gives other words than the browser shows. The app's window shows the link as what it is, a claim ("a
browser calling itself <name>, at <origin>"), and the person types the words their browser shows, which is the point:
enrolling a controller requires the person at the machine, and a link made by anyone else, or with another key, gives
other words than their browser shows. One enrolment waits at a time, for 15 minutes at most, and five wrong tries end
it, as for pairing. Once the words match, the window shows this machine's remote control settings
(`person remote-policy`, read only) and asks two things: which harnesses remote prompts may reach here (none turns
remote control off), and whether this browser may send prompts (`trusted`; until the app can ask the first-use question,
an untrusted controller sees the machine and its sessions but can't prompt them). Only **Let this browser in** hands the
link on.

The app then hands the link's fields, the secret, the typed words and the choices to the daemon: `person control-enrol`,
with the app's proof, the secret and the words on stdin, which calls `POST /api/local/app/remote/enrol` with the app's
control token. The daemon checks the words again, adds
`{device, sign, enc, encVersion, encSig, name, origin, addedAt}` to `controllers.json` in its person folder (mode
0600), and opens its control socket at that origin, linking the browser.

The browser, while it enrols, links the machines offered to it (the service's `offers`, which are hints only). As soon as
it is online and links the machine back, the machine sends it `{ t: 'enrolled', machine: { device, sign, enc,
encVersion, encSig, name, platform }, mac }`, where `mac` is an HMAC-SHA-256 under the secret over
`meshrooms-control-enrolled-v1:<browser>:<device>:<sign>:<enc>:<encVersion>:<encSig>` (`enrolMac`). The browser opens it
with `openEnrolled`: it decrypts it, checks that the key it carries hashes to the sender and signed the envelope, that
the encryption key is bound to it for every room, and that the HMAC matches. Only then does it keep the machine's keys;
it unlinks the other offers. The machine sends this answer again every 30 seconds while the browser hasn't sent a
request yet, for 15 minutes at most, and keeps the secret only in memory until then.

A machine's controllers can be listed and revoked in the app at any time: its **Remote control** window (tray menu and
the desktop status window, `desktop/src-tauri/src/remote.rs`) lists each browser with whether it is online and may send
prompts, removes one (its running turns stop), and turns remote control on or off by the harnesses it ticks (or its Turn
off). Each change goes through the daemon (`person remote-allow`, `remote-trust`, `remote-revoke`, app only), which holds
the running turns and makes it in one step on the policy as it is (`POST /api/local/app/remote/change`), reading the
policy strictly: a file that can't be read is shown as such and left alone. A browser shows online only through a
connection that is ready. A controller can be revoked from any other
controller of the same machine, and from the account once accounts exist.

## How a request travels

A service endpoint, `/api/control/v1` (`server/browser/control.ts`), separate from rooms. It is a WebSocket only for
now; an HTTPS long-poll fallback like the relay's comes later. It comes on with the relay.

- **Socket auth:** the service sends a challenge, and the device answers `{ t: 'auth', signed, links }`, where `signed`
  is a `control-open` command over `{ nonce }` with roomId `CONTROL_ROOM_ID` (the nil uuid), for this service's
  origin. No room. The device id comes from the key, and the device must take part in Meshrooms on this service
  (admitted in a room, or to the beta), so a key made a moment ago gets nothing (`not-a-participant`, close 4003).
  That is asked again at every heartbeat: a device retired from its rooms, or from the beta, is closed the same way.
  Anything sent before `ready` is answered `not-ready`. One socket per device: a newer one replaces the older
  (`session-replaced`, close 4009), and the older acts for nobody from then on. At most 32 sockets from one address.
- **Links:** each device sends the devices it talks to (`links`, at most 64 device ids, at auth and with
  `{ t: 'links', links }` after it). A machine links its controllers and a browser its machines. The service passes
  frames, and shows presence, only between two devices that link each other. Unlinked senders get nothing through,
  which bounds spam. Authority is still the app's own check. Both sides send their links again on every connect, so
  the service keeps nothing on disk.
- **Presence:** `ready` and `{ t: 'peers' }` answer `{ peers, offers }`, and `peers` is pushed again whenever one of them
  comes, goes or changes its links.
  - `peers`: the devices this one links that link it back, `{ device, online, lastSeen? }`. A device that went away is
    remembered for 7 days in memory, with when it was last seen.
  - `offers`: device ids only, newest first and at most 16, of devices online that link this one without being linked
    back. Enrolment uses them to find the machine it is enrolling with. An offer is a hint, never proof: anyone who
    knows a device id can make one, so the browser trusts a machine only once the words check matches (the secret
    in the `meshrooms://control` link).
  `peers` isn't pushed when nothing in it changed, nor to a device far behind. A device that went away is remembered
  only if it had a peer then.
  Machine names, harnesses and sessions travel only end-to-end.
- **Frames:** `{ t: 'frame', envelope }`, answered `accepted` or `rejected` with a reason. The envelope is the relay's
  (`encryptRelayEnvelope`), with `room` set to `control:<machine device id>` for traffic both ways
  (`controlRoom`), exactly one recipient, the sender's signature, and no `wake` or `hold`. The service sees sizes and
  timing, never content. A frame is at most 32 KiB, so a long prompt or reply travels in several.
- **Delivery:** online only in the first version. A frame to a device that isn't online fails at once with `offline`.
  No inbox holds prompts on the service.
- **Limits:** per device, 240 messages and 4 MiB a minute, every message counted; 20 refusals in a row close the
  socket (4008). An envelope id passes once in 10 minutes. A recipient more than 4 MiB behind is not sent more
  (`recipient-busy`).

The desktop app's daemon holds one control socket per person. That is its first connection to the service not tied to a
room.

## Requests and replies

A request is `{ v: 1, t: 'request', id, at, expiresAt, op, ... }`: `id` a uuid, `expiresAt` at most 2 minutes after
`at`. The machine takes requests only from a controller on its list (the client drops every other sender before it
decrypts anything), answers one that expired with `expired` and one from the future or out of shape with `invalid`, and
runs a request id once (a seen-ids window kept for twice the expiry; a repeat isn't answered). Requests made before the
daemon's control socket started are answered `expired`, so a service that kept one back can't have it run again after a
restart. The controller list is read again for each request and before each reply: a controller removed a moment ago is
answered nothing. At most 8 requests from one controller run at once (`busy`); `hello` and `cancel` don't count, so a
browser can always stop its turns. Expiry applies to when a request arrives, not to how long it runs: a prompt may
wait up to 10 minutes for a room wake in the same session and then run up to 10 minutes, so the web app expects a reply
up to about 20 minutes later. A reply is `{ v: 1, t: 'reply', id, ... }` with the request's id, and the replies to one
controller go out in the order they were made (a turn's `running` never after its result). A failed request answers
`{ ok: false, code, message }`, and a failed prompt `{ state: 'failed', code, message }`.

A packet whose JSON is over 16 KiB travels as `{ v: 1, t: 'part', msg, i, n, data }` frames, `data` being base64 of 12
KiB of it, at most 64 parts and 768 KiB, put back together by the receiver within a minute (at most 4 at once per
sender). A part that doesn't fit, a part repeated, or parts that make up another part, is dropped.

`sessions` and `prompt` need remote control on; `hello` is answered even while it is off, with the policy, so the web app
can say so. A prompt from a controller the person didn't trust needs the first-use question, which the app can't ask
yet: until it can, such a controller is told (`not-allowed`) to be marked trusted in the app first.

| Request | Reply |
| --- | --- |
| `hello` | `{ ok, machine: { name, platform }, harnesses: { harness, label, detected, sessionsAvailable }[], capabilities, policy: { enabled, harnesses }, trusted }` |
| `sessions { harness }` | `{ ok, harness, sessionsAvailable, sessions: HarnessSession[], truncated }`, the same listing the local API serves |
| `prompt { harness, sessionId, text }` | `{ state: 'running', turnId }`, then `{ state: 'done', turnId, reply, sessionId, truncated }` or `{ state: 'failed', turnId, code, message }` |
| `cancel { turnId }` | `{ ok, cancelled }`, for this controller's own turns only |

Later, each needing its own opt-in: `new-session { harness, folder, text }`, `stop { harness, sessionId }`, and
`approve { turnId, permissionId, answer }` for a harness's permission prompt.

`text` is at most 32 KiB (Antigravity on Windows: 30,000 characters, see below). `reply` is the agent's final answer for the turn, in full and not trimmed, at most 256 KiB,
with `truncated: true` past that.

## What the app does with a prompt

- **Policy first.** Remote control is off on a machine until the person turns it on there. When on, the app checks the
  harness against the machine's policy (which harnesses may be prompted), and that the session is one the harness lists
  (its 20 most recent sessions, as the agent apps view shows). A request outside it is refused (`not-allowed`,
  `unknown-session`). A per-folder allowlist, and reaching older sessions by id, come later.
- **First use from a new controller:** the app asks on the machine once ("Allow <name> to send prompts to Claude Code
  here?"), unless the person ticked "don't ask again for this browser".
- **One turn per session at a time.** A room wake and a remote prompt never run in the same session at once. A remote
  prompt waits for a running wake (the session ledger), and the reverse, with a bound of 10 minutes.
- **Policy again after every wait.** A prompt may wait for the person's first-use answer and for a room wake. After
  each, the app reads the policy and the controller list again, so a change made meanwhile (even one made outside the
  app) refuses the turn before anything runs.
- **Delivery:** the harness's own resume, as the person would run it, in the folder the session recorded. A session
  whose harness records no folder, or whose folder is gone or isn't a local absolute folder (a UNC path, say), is
  refused: a turn never runs in the home folder as a stand-in.
  - Claude Code: `claude -p --resume <id> --output-format json`, prompt on stdin.
  - Codex: `codex exec resume <id> -`, prompt on stdin. `--skip-git-repo-check` is not added, so a thread outside a git
    repository fails with Codex's own error. Desktop delivery (macOS) is refused (`unsupported`) in the first version.
  - Hermes: `hermes chat --resume <id> --oneshot --query-file <file> --format stream-json --run-budget <seconds>`, the
    file 0600, written only once the session is free, and removed after the turn (and at the next start, should the
    app end mid-turn). The run budget ends the turn with a reply before the app's own timeout stops it.
  - Antigravity: `agy -p <prompt> --conversation <id> --disable-slash-commands --output-format stream-json
    --print-timeout <minutes>m`. A prompt that starts with `-` gets a space in front, so it can't be read as an option.
    The prompt is on the command line, which other local users can read from the process list on Linux and which
    Windows caps at about 32,767 characters. A file or stdin option replaces it once Antigravity has one.

  Unlike a room wake, a remote prompt runs with the session's own permissions and settings, not the room wake's
  confinement: it is the owner speaking. Nothing that widens the session is added: no bypass flags, no extra allowed
  tools. What is added only shapes the output and bounds the run. A tool the harness would ask about is refused in
  non-interactive mode, and the reply says so, until remote approvals exist.
- **Environment:** the daemon's, minus the credentials the harness doesn't sign in with and the Hermes variables that
  skip its checks, as for room wakes (`wakeEnv`). A GitHub, npm, cloud or database token in the daemon's environment
  is not there for a remote turn.
- **Reply:** parsed from the harness output by its own parser (`readTurnReply`), which keeps the full text; the room
  wake's `readHarnessOutput` stays as it is. Claude Code's refused tools come back as `denied`, and a session another
  process is writing to comes back `busy`. Hermes and Antigravity stream JSON events: the last result event is the
  reply, and a stop for an approval comes back as a failure that says so. Plain output is taken as the reply when
  there is no result event, until each is checked against the real CLIs.
- **One session, one key:** remote turns and room wakes share the session ledger by the harness, its session store
  and the session id. A room wake bound to a folder's latest session rather than an id has a ledger of its own, so
  the two don't wait for each other there.
- **Audit log** on the machine (`control.log` in the person folder): time, controller, harness, session, request id,
  outcome, sizes. Never the prompt or reply text.
- **Kill switch:** turning remote control off on the machine stops accepting requests at once and cancels running remote
  turns.

## The web app

- **Devices:** every machine linked to this browser, with its state (online, last seen), harnesses, and sessions (title,
  folder, last activity), and which rooms each session also serves.
- **A session pane:** a composer and the remote turns sent from this browser, kept in this browser's own storage.
  The harness's own transcript is not mirrored in the first version.
- **Control this machine**, from a machine paired but not enrolled.
- The desktop app's own page shows the same view for its machine. Agent apps (harness detection and settings) moves
  into it.

## Not in the first version

- Accounts: pairing and controller enrolment stand in until they exist.
- Streaming replies: the reply arrives when the turn ends.
- Remote permission approvals, new sessions, stopping sessions.
- Offline delivery.
- The harness transcript in the web app.

## Build order

1. App side: the controller list, the policy, and the remote turn runner behind the local API, with an audit log. This
   is testable on one machine.
2. Service: `/api/control/v1`, links, presence and frames.
3. App daemon: the control socket and request handling. The `meshrooms://control` link and the words check.
4. Web app: Devices view, enrolment and the session pane.

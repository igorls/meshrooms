# History for newcomers (design & protocol)

Status: implemented on browser/bridge storage (step 2 of the approved roadmap "WormDB and MeshGuard in the browser").

Today a person or agent who joins a browser room sees only messages sent after they joined unless the room allows
history for newcomers. This protocol lets newly paired devices (same member) and newcomers (when allowed) receive
earlier history peer to peer, without trusting the peers who relay it and without exposing anything people said under
a different expectation.

## Requirements (from the roadmap decision)

1. **Verifiable per author.** A peer that relays history can't forge, alter, or reattribute anyone's messages. It
   can only withhold them, and gaps are visible.
2. **The host chooses, and people know.** History for newcomers is a room setting, off by default and shown to
   everyone, including in the invite and join screens.
3. **Same log as native nodes.** Entries and their replication must not depend on the browser's storage engine, so
   WormDB in WASM (step 1) and native WormDB can hold and replicate the same entries.

## What is already shared, and what isn't

| State | Newcomers today | With this design |
| --- | --- | --- |
| Task board, decisions, reactions | Full state, exchanged when a channel opens | Unchanged: room state, always shared |
| Messages and their files | Only those sent after they joined | By each message's visibility (below) |

Tasks and decisions are the room's shared work, so newcomers already need them. Conversation is different: people
speak with an audience in mind.

## Visibility is decided when a message is sent

Each new message carries a signed visibility the author's device sets from the room's setting at that moment:

```ts
type MessageBody = { /* existing fields */ visibility?: 'members' | 'room' };
```

- `members`: only devices that were members when it was sent. This is today's behaviour, and the default for
  messages without the field (older clients).
- `room`: also anyone admitted later.

Since the author signs the visibility, changing the setting later is never retroactive. Turning history on exposes
only what is said from then on, and turning it off stops sharing new messages but keeps earlier `room` messages
shareable, because their authors agreed to that. The host can't reinterpret what people said. A client with a stale
setting could still sign `room` just after the host turned history off; that remains the author's own consent. The
composer shows the visibility that will be signed ("New members will see this") so it is never a surprise.

### The host setting

A room setting next to the others: **History for newcomers**, either *Off* (the default; new messages are
`members`) or *On* (new messages are `room`). The setting is shown:

- In the room header and in Room details ("New members can read messages from now on").
- On the join screen and in the invite link's page, before someone asks to join. The unauthenticated room
  endpoint (today `{ roomId, title }`) and pre-admission `status` grow to include it; agent `status` and
  `listen` expose it the same way.
- To agents, in `status` and `listen` output, so an agent's operator knows what it will see.

There is no *On, last N days* option. Peers can't be made to forget what they hold, so a window would promise more than
peer-to-peer can keep.

## Replication

History moves peer to peer on the existing data channels (and over the E2E relay when no WebRTC channel is open),
like decisions and task operations. The room service never sees plaintext history.

1. **Author sequence numbers & signed `audienceUntil`.** New messages carry `seq` (a per-author-device counter,
   capped at `MAX_MESSAGE_SEQ = 10,000,000` with forward jump limit `MAX_SEQ_JUMP = 50,000`), signed `visibility`
   (`'members' | 'room'`), and for `'members'` messages a signed `audienceUntil` recording the newest `member.joinedAt`
   known to the author from `status.members` at send time. A device summarises what it holds as a contiguous version
   vector `{authorDevice: highestContiguousSeq}`, coalesced `[start, end]` sparse sequence ranges (`haveSeqs`, up to
   64 per device), 16-hex `(deviceId, id)` digests for held conflicts (`conflictIds`, up to 128) and legacy seq-less
   messages (`legacyIds`, up to 512), bounded to fit under `HISTORY_CHUNK_CHARS` (15,000 chars).
2. **Exchange on connect with server-side pagination.** When a channel opens (or when syncing over the relay), each side
   sends `{ kind: 'history-have', roomId, vector, haveSeqs?, conflictIds?, legacyIds?, cursor?, windowFullAt? }`.
   The serving peer filters authorized missing entries and orders them strictly by its own receipt clock and immutable
   identity `(receivedAt desc, deviceId desc, seq desc, id desc)` — **never by author-chosen `at`** — sending up to
   `MAX_HISTORY_PER_RESPONSE = 64` entries per round split into chunks under 15,000 characters. The final chunk of a
   round carries either `{ more: true, nextCursor }` or `{ done: true }`. The requester echoes `cursor: nextCursor` on
   the next `history-have` round so convergence is guaranteed even past summary caps (e.g. >64 sparse ranges, >128
   conflicts, or >512 legacy entries) and cannot be stalled by an author signing far-future `at` values.
3. **Who may receive what, decided from the room service's view (and verified roster when present).** A serving peer
   looks up the requester's device in `verifiedRoster` (when a host-signed roster is present) or `status.devices` and
   `status.members`, never trusting anything the requester claims. Retracted stubs are never served. An entry is served
   only if:
   - `visibility === 'room'` (servable to any admitted device); OR
   - `body.memberId === requesterMember.id` (a member's companion devices always receive their own member's messages); OR
   - `entry.replicated === true`: a `'members'` entry learned via history replication is only re-served to this peer's
     **own companion devices** (`requesterMember.id === selfMemberId`), never across members (preventing multi-hop leaks); OR
   - Otherwise (a `'members'` entry received live by this peer):
     - When the author signed `audienceUntil`: `requesterMember.joinedAt <= body.audienceUntil` (both timestamps come
       from the room service's admission clock, eliminating local-clock skew and delayed-delivery leaks).
     - **Stale-author tradeoff:** if a new member was admitted just before a send and the author's `status` poll had not
       yet seen that member, `requesterMember.joinedAt > body.audienceUntil`, so that newcomer never receives that
       `'members'` message via history replication (fail-closed by design).
     - For older/legacy `'members'` messages without `audienceUntil`: `requesterMember.joinedAt <= Math.min(entry.receivedAt ?? body.at, body.at)`
       so delayed outbox/inbox delivery never widens visibility past send time.
4. **Verification, deduplication, and first-seen canonical references.** Every entry is checked exactly as live messages
   are: valid body, strict UUID, `withinSeqJump`, room id, author device (current, voluntary-rejoin `priorMembers`, or
   non-revoked `formerDevices`) signature, and `memberId`. Storage deduplicates by composite `(deviceId, id)` so a
   malicious member cannot squat on another member's message ID; retractions and reactions also dedupe op IDs by
   `(deviceId, id)`. Bare-ID references (`replyTo`, reaction display, agent listen cursors) resolve using a first-seen
   canonical rule (and composite `<deviceId>:<id>` cursors for colliding copies), and retracting a colliding copy never
   wipes reactions while another live message with that ID remains. Replicated entries merge without reordering existing
   live messages (`mergeHistoryMessages`), protecting positional agent cursors.
5. **Equivocation is detected, not hidden.** A modified client could sign two different messages with the same
   `(authorDevice, seq)`. Both are kept, its vector stops advancing past the conflict, peers forward both entries, and
   both equivocation and cross-device ID collisions are flagged with warnings in the UI.
6. **Gaps are visible without false positives.** Sync vectors track every missing sequence from 1 so peers fill any
   authorized hole. The UI warning ("Some earlier messages aren't available on this device") reports only unexplained
   interior gaps strictly between the oldest and newest held sequences for a device — excluding leading prefixes normal
   for late joiners / 5,000-message rolling-window eviction and missing sequences explained by signed retractions
   (`RetractBody.seq` / unresolved retractions by that member).
7. **Files follow messages.** Attachments named by history entries become fetchable through `FileTransfers` only when
   referenced by a message `mayServeMessage` allows for that requesting peer, within the room storage cap.
8. **Rate limits, retry-after, and full-window churn protection.**
   - `serveHistory` uses a per-peer token bucket (`HISTORY_SERVE_BURST = 24`, `HISTORY_SERVE_PER_MINUTE = 60`), ignoring
     request digests. When throttled, instead of dropping silently, it replies with a rate-limited `{ entries: [], retryAfterMs }`
     hint (at most once per second per peer) so the requester resumes cleanly from its saved pagination cursor.
   - `acceptHistory` bounds signature verification with a per-peer **entry-counted** token bucket
     (`HISTORY_ACCEPT_ENTRIES_BURST = 2048`, `HISTORY_ACCEPT_ENTRIES_PER_MINUTE = 3840`) — counting entries rather than
     15 KB wire chunks so multi-chunk rounds of 3–4 KB agent messages are not penalized — plus a per-member `'history'`
     bucket on `ReceiveQuota` (`HISTORY_QUOTA_BURST = 512`, `HISTORY_QUOTA_PER_MINUTE = 600`) across browsers, live
     bridges, and cold `relayListenOnce` runs. Any dropped chunk/entry holds the start-of-round cursor and records a
     `QuotaDrops` resync (over WebRTC or relay) so convergence finishes cleanly after the burst.
   - When a peer's 5,000-message window is already full, `buildHistoryHave` advertises `windowFullAt` (when no member is
     in half-cap eviction) and `acceptHistory` skips storage writes and stops pagination if `windowHistory` evicts every
     newly arrived entry.

## Storage

The protocol is independent of the storage engine. The first version can run on today's IndexedDB storage. When
step 1's WormDB core lands, entries go into WormDB keyed by `(authorDevice, seq)` with a time index, and native nodes
store the same signed packets. That meets requirement 3 without waiting on the WASM work.

Eviction keeps each device's cap (newest first). An evicted entry is simply no longer served, and newcomers fetch it
from someone who still has it.

## Agents

Bridges take part like browsers: they serve and receive history under the same rules. An agent admitted to a room
with history on sees the earlier `room` messages as `history` on its first `listen`. That's useful context, and it's
the same history a person would see. Agents get no special access.

## Security and limits

- **Peers can't be forced to forget.** A member who received a message can always copy it elsewhere. The setting
  controls automatic sharing to newcomers, not what members do with what they saw. The UI says so.
- **Old keys.** Verifying old entries needs the author's device key. The room service keeps up to 2,000 retired device
  keys by default and up to 4,000 (`MAX_HISTORY_FORMER_DEVICES`) once history has been enabled, plus non-revoked
  `priorMembers` on voluntary rejoin so earlier entries stay verifiable while bounding status payload size.
- **Authorization clock boundary.** For `'members'` messages with `audienceUntil`, authorization compares
  `requesterMember.joinedAt <= body.audienceUntil` (both on the room service's clock, with fail-closed behavior if the
  author's status was slightly stale). For older messages without `audienceUntil`, it falls back to
  `requesterMember.joinedAt <= Math.min(entry.receivedAt ?? body.at, body.at)`. A message sent with history off is
  never served to later members at all, and replicated `'members'` entries are only re-served to same-member companion
  devices.
- **Removal.** A removed member's messages stay, as today. A removed device stops receiving new history immediately,
  because peers close its channel.

## Compatibility

- Older peers ignore `history-have` and `history`, and don't send history. Messages without `visibility` are
  `members`.
- Older peers verify the signature over the whole body, so the new fields don't break them.

## Retractions

Deleting is built; editing isn't. The rest of this design is still ahead of it, so a retraction travels on its own for
now, exchanged when a channel opens the way reactions are:

```ts
type RetractBody = { kind: 'retract'; roomId: string; id: string; deviceId: string; memberId: string; at: number;
  target: string /* message id */; seq?: number /* once per-device sequence numbers exist */ };
```

A retraction is valid only when signed by a current or former device of the member who wrote the target. It compares
members, not devices, so a person can delete from a device they linked later. There is no moderator delete.

A device that applies one replaces the message with a stub, in place, holding the id, author and time but no text,
files or signature. Stubs keep read positions, cursors and replies working, are never sent, and show as "Message
deleted". Files only that message named are deleted with it. The signed retraction stays in a bounded log, so it
reaches devices that were offline. One that arrives before its message waits there, and the message is then stored as
a stub; each member can park only a limited number, because they can't be checked until the message arrives.

Agents read a deleted message as "Message deleted", and it never wakes one. They have no command to delete their own
messages yet.

As with the setting, this can't make anyone forget what they already saw, and the UI says so. Peers from before this
change ignore retractions and keep showing the message.

## Decided in review

- No *last N days* option in v1 (peers can't be made to forget).
- The `members` boundary is the member's admission against the serving peer's receipt time.
- The `retract` tombstone shape was reserved here, and deletion is now built on it.
- Rooms with history on keep every retired device key.

## Plan

1. Add `visibility` and `seq` to new messages, `receivedAt` to stored entries, member `joinedAt` and full retired-key
   retention to the room service, and the host setting with its disclosures. Nothing is exchanged yet; this ships
   first so every message from then on carries its consent.
2. The `history-have` / `history` exchange with verification, visibility checks, gap display, and file follow-up, on
   the current storage. Tests:
   - a newcomer receives only `room` entries, and a linked device receives its member's earlier `members` entries;
   - a requester's claims don't change what it's served;
   - a tampered or reattributed entry is rejected;
   - two entries with one `(device, seq)` are flagged as equivocation;
   - a withheld entry shows a gap and is fetched from another peer.
3. Move storage to WormDB when step 1's core uses the real WAL format.
4. With step 3 (MeshGuard in the browser), the same `history-have` / `history` envelopes and visibility rules travel on
   MeshGuard's application channel too, so a native node and a browser peer exchange identical packets. Until then,
   native rooms keep their durable WormDB log locally, and this design stays browser-room first.

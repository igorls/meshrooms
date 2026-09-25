# History for newcomers (design)

Status: design for review. This is step 2 of the approved roadmap "WormDB and MeshGuard in the browser". Nothing
here is built yet.

Today a person or agent who joins a browser room sees only messages sent after they joined. This design lets
newcomers receive earlier history when the room allows it, without trusting the peers who relay it and without
exposing anything people said under a different expectation.

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
shareable, because their authors agreed to that. The host can't reinterpret what people said.

### The host setting

A room setting next to the others: **History for newcomers**, either *Off* (the default; new messages are
`members`) or *On* (new messages are `room`). The setting is shown:

- In the room header and in Room details ("New members can read messages from now on").
- On the join screen and in the invite link's page, before someone asks to join.
- To agents, in `status` and `listen` output, so an agent's operator knows what it will see.

There is no *On, last N days* option. Peers can't be made to forget what they hold, so a window would promise more than
peer-to-peer can keep.

## Replication

History moves peer to peer on the existing data channels, like decisions and task operations. The room service never
sees it.

1. **Author sequence numbers.** New messages carry `seq`: a per-author-device counter, signed like the rest. A device
   summarises what it holds as a version vector `{authorDevice: highestContiguousSeq}`.
2. **Exchange on connect.** When a channel opens, each side sends
   `{ kind: 'history-have', roomId, vector }`. The other side replies with the entries the requester is **allowed**
   and missing, newest first, in `{ kind: 'history', roomId, entries: packet[] }` envelopes under the 20,000-character
   limit (the same chunking as decisions). Rate limits and a per-request cap keep this bounded.
3. **Who may receive what, decided from the room service's view.** A peer looks up the requester's device in the
   room status it got from the room service (member, role, and the member's `joinedAt`), never from anything the
   requester claims. It serves an entry only if the entry's `visibility` is `room`, or the requester's **member**
   joined before this peer received the entry (`member.joinedAt <= entry.receivedAt`). The boundary uses the member's
   admission, not the device's, so a person's newly linked laptop still gets what they saw on their phone. It uses
   the serving peer's own receipt time, not the author's clock, so a skewed author clock can't move it. A peer
   serves only verified entries it holds.
4. **Verification on arrival.** Every entry is checked exactly as live messages are: valid body, room id, the author
   device (current or former) signature, and the member id matching that device. A relay can't forge or alter an
   entry, because each one is signed by its author, not by the relay.
5. **Equivocation is detected, not hidden.** A modified client could sign two different messages with the same
   `(authorDevice, seq)`. Entries are stored by message id, so both are kept, and the sequence number is only used for
   summaries and gap detection. A device that holds two entries for one `(authorDevice, seq)` marks that author device
   as equivocating. Its entries are then shown with a warning, its vector stops advancing past the conflict, and
   peers forward both entries so every device sees the same evidence.
6. **Gaps are visible.** A hole in an author's sequence means an entry is missing. It's fetched from another peer if
   one has it, and otherwise shown as "some earlier messages aren't available". Withholding can't be hidden as
   deletion.
7. **Files follow messages.** Attachments named by history entries become fetchable through the existing file
   transfer (files are servable when a verified message references them), within the same room storage cap.

Entries without `seq` (sent before this change) can't be summarised by a vector. For those, an id-set exchange in hash
buckets is enough, and since they are all `members`-only, they're only exchanged between devices that already qualify.

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
- **Old keys.** Verifying old entries needs the author's device key. The room service keeps only the last 256 retired
  devices' keys today. Rooms with history on keep **every** retired key (each is small), so entries by long-gone
  devices stay verifiable.
- **Member admission time.** The room service records `joinedAt` for each member (its first admission). Peers read it
  from room status. Today only devices carry `admittedAt`.
- **Clock boundary.** The `members` boundary compares the room service's `joinedAt` with the serving peer's
  `receivedAt`. Two clocks are still involved, but neither is the author's, and a message sent with history off is
  never served to later members at all.
- **Removal.** A removed member's messages stay, as today. A removed device stops receiving new history immediately,
  because peers close its channel.

## Compatibility

- Older peers ignore `history-have` and `history`, and don't send history. Messages without `visibility` are
  `members`.
- Older peers verify the signature over the whole body, so the new fields don't break them.

## Reserved: retractions

Edits and deletions aren't built, but the shape is reserved now so the log format won't change later:

```ts
type RetractBody = { kind: 'retract'; roomId: string; id: string; deviceId: string; memberId: string; at: number;
  target: string /* message id */; seq: number };
```

A retraction is valid only when signed by the target message's author device, or a later device of the same member.
It replicates like any entry and has its own `seq`. Peers that receive it stop showing and serving the target's content
but keep the tombstone, so the retraction reaches everyone. As with the setting, this can't make anyone forget what
they already saw, and the UI says so.

## Decided in review

- No *last N days* option in v1 (peers can't be made to forget).
- The `members` boundary is the member's admission against the serving peer's receipt time.
- The `retract` tombstone shape is reserved now.
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

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

A later option could be *On, last N days*: messages stay `room` but peers serve only those within the window. That's
not part of the first version.

## Replication

History moves peer to peer on the existing data channels, like decisions and task operations. The room service never
sees it.

1. **Author sequence numbers.** New messages carry `seq`: a per-author-device counter, signed like the rest. A device
   summarises what it holds as a version vector `{authorDevice: highestContiguousSeq}`.
2. **Exchange on connect.** When a channel opens, each side sends
   `{ kind: 'history-have', roomId, vector }`. The other side replies with the entries the requester is **allowed**
   and missing, newest first, in `{ kind: 'history', roomId, entries: packet[] }` envelopes under the 20,000-character
   limit (the same chunking as decisions). Rate limits and a per-request cap keep this bounded.
3. **Who may receive what.** A peer serves an entry only if its `visibility` is `room`, or the requester's device was
   admitted before the entry's time (`device.admittedAt <= entry.at`, both from the room service's clock and the
   author's clock; see open questions). A peer serves only verified entries it holds.
4. **Verification on arrival.** Every entry is checked exactly as live messages are: valid body, room id, the author
   device (current or former) signature, and the member id matching that device. A relay can't forge or alter an
   entry, because each one is signed by its author, not by the relay.
5. **Gaps are visible.** A hole in an author's sequence means an entry is missing. It's fetched from another peer if
   one has it, and otherwise shown as "some earlier messages aren't available". Withholding can't be hidden as
   deletion.
6. **Files follow messages.** Attachments named by history entries become fetchable through the existing file
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
- **Old keys.** Verifying old entries needs the author's device key. The room service keeps retired devices' keys,
  but only the last 256. Rooms with history on should keep all retired keys (they're small), or entries by long-gone
  devices can't be verified and are dropped.
- **Clock skew.** For `members` messages, "admitted before the entry was sent" compares the room service's clock with
  the author's. A skewed author clock can include or exclude a message near the join time. Messages sent with history
  off are never served to later joiners by design, so the skew only affects that boundary.
- **Removal.** A removed member's messages stay, as today. A removed device stops receiving new history immediately,
  because peers close its channel.

## Compatibility

- Older peers ignore `history-have` and `history`, and don't send history. Messages without `visibility` are
  `members`.
- Older peers verify the signature over the whole body, so the new fields don't break them.

## Open questions

1. Should the host setting also offer *On, last N days* in the first version?
2. For `members` messages, should the boundary use the room service's clock instead (for example, a signed admission
   timestamp that peers compare against the entry's arrival at the room service)? That removes author-clock skew but
   needs the room service in the loop.
3. Should edits and deletions (not supported today) be planned now, as signed tombstones that replicate like entries?
4. How many retired keys should the room service keep for rooms with history on?

## Plan

1. Add `visibility` and `seq` to new messages, and the host setting with its disclosures. Nothing is exchanged yet;
   this ships first so every message from then on carries its consent.
2. The `history-have` / `history` exchange with verification, visibility checks, gap display, and file follow-up, on
   the current storage. Tests: a newcomer receives only `room` entries; a tampered or reattributed entry is rejected;
   a withheld entry shows a gap and is fetched from another peer.
3. Move storage to WormDB when step 1's core uses the real WAL format.

# Direct files: large transfers between participants

Status: proposed. Nothing here is implemented yet. It extends
[browser-attachments.md](browser-attachments.md) and leaves that flow as it is.

## Why

Attachments stop at 10 MB, and every browser in the room fetches and keeps them. That fits screenshots and logs. It
doesn't fit raw material that never goes to GitHub, such as a video team sending several gigabytes of footage for
review.

A direct file is **offered**, not attached. Nobody fetches it unless they ask for it, and its bytes go only between
devices, never through the room service. There is no size limit beyond the receiver's disk. Two rules keep it honest:

- **Only between devices online at the same time.** Nothing stores the file in between. The sender's device must be
  online, or another device that already received the file and keeps sharing it.
- **Only over a direct path by default.** The bytes cross a WebRTC connection whose selected candidate pair is
  device to device. The Mesh's Connections view shows that path. TURN is allowed only where the room says so,
  and the relay socket never carries a direct file.

## Experience

- **Sending (people):** the composer's Attach menu gains **Send a large file directly**. Picking a file first prepares
  it, showing "Preparing · 34%" while its pieces are hashed on the device. The message then shows an offer card with
  the name, size and kind, plus "Available while your device is online". Closing the tab while it is shared asks first.
  **Stop sharing** ends it.
- **Receiving (people):** the offer card says who can send it and how, for example "Igor's laptop · direct". It has a
  **Download** button:
  - **On Chromium browsers,** it asks where to save first, then writes straight to that file.
  - **Elsewhere,** it writes to the browser's private storage (OPFS), then offers **Save** when done.

  Progress shows bytes, speed, time left, how many devices are sending, and the path tag. There are **Pause**,
  **Resume** and **Cancel**. A dropped connection or a reload resumes from the pieces already verified. "Waiting for a
  device that has this file" shows while no holder is online. "No direct path to Igor" shows when only TURN or the
  relay could reach them.
- **Keep sharing:** a finished receiver keeps sharing while its tab is open. It's on by default and can be switched
  off per file. Later receivers can then download from several devices at once.
- **Agents (later):** `listen` includes `offers`, and the agent commands would be
  `direct-get --room R --offer ID --out FILE_OR_DIR` and `direct-offer --room R --file PATH`. The bridge writes to
  disk like the desktop app.

## The offer, in the signed message

A message may carry `offers` next to `attachments`. The body is signed, so the manifest hash is end to end:

```json
{ "kind": "message", "…": "…", "text": "Offered review-cut-03.mov (2.3 GB) to download directly",
  "offers": [{ "id": "<uuid>", "name": "review-cut-03.mov", "type": "video/quicktime", "size": 2469606195,
               "pieceSize": 4194304, "pieces": 589, "manifest": "<sha256 of the manifest>" }] }
```

Each offer must have all of the following, or receivers ignore it:

- an `id` that is a UUID;
- a clean `name`, by the same rule as attachments;
- a `type` given for display only (the file is always saved as a download, never rendered inline);
- an integer `size` from 1 byte to 4 TiB (2^42 bytes), so the manifest stays under the attachment limit (see below);
- a `pieceSize` of 4 MiB up to 64 GB, or 16 MiB above that (which keeps the manifest small);
- `pieces` equal to `ceil(size / pieceSize)`;
- a 64-hex `manifest`.

A message carries at most 4 offers.

**The manifest** is the pieces' SHA-256 digests concatenated, 32 bytes each, in order. Its length must be exactly
`pieces × 32` bytes, or it's rejected. At 4 MiB a piece, 1 GB has 256 of them (8 KB). At 16 MiB, 1 TB has about 65,500
(2 MB), and the 4 TiB maximum has 262,144 (8 MiB). Every piece is hashed on its own with `crypto.subtle.digest`, so
neither side ever hashes the whole file in one pass. The manifest is the file's identity: a file is offered again under
the same manifest hash.

**Older devices** ignore unknown body fields and show the text, so it reads as a sentence: "Offered <name> (<size>) to
download directly". Current devices recognize offers and show the card.

## Transfer

The control packets are unsigned JSON envelopes on the existing channel, like `file-*`. Older devices ignore them.

| Packet | Meaning |
| --- | --- |
| `{kind:'file-want', sha256: <manifest>, offset}` | The manifest is fetched with the existing attachment transfer. It's a content-addressed file under 10 MB, servable because a verified message names it. It may cross any path, even the relay: it holds only hashes, 8 KB for 1 GB and 8 MiB at most. It doesn't count toward the attachment limits. |
| `{kind:'direct-have', roomId, manifest, all:true}` or `{…, ranges:[[from,to],…], part, parts}` | Which pieces this device holds: `all` once complete, otherwise inclusive ranges, at most 1,000 per packet, split into numbered parts so every packet stays under the channel's 20,000-character limit. Sent on request and when it changes, at most every 2 s. |
| `{kind:'direct-want', roomId, manifest, pieces:[[from,to],…]}` | Send these pieces, as at most 8 ranges and 16 pieces in all. |
| `{kind:'direct-cancel', roomId, manifest}` | Stop sending this file to me now, for Pause and Cancel. The sender drops what it hasn't queued yet. |
| `{kind:'direct-done', roomId, manifest, piece}` | A piece was sent in full. |
| `{kind:'direct-refuse', roomId, manifest, reason}` | Pieces won't be sent: `not-direct`, `busy`, `missing` or `stopped`. |

**The bytes** go on one binary data channel per connection, labelled `meshrooms-direct-v1`. Both ends create it when
the connection is set up, as a pre-negotiated, ordered channel with a fixed id: `negotiated: true, id: 1000`. The id is high because in-band channels take small ids
as they open. Opening a
channel later would trigger renegotiation, and two people downloading from each other at once could collide (glare).
Each frame is a 40-byte header (the manifest's 32 bytes, the piece index as a u32, and the offset within the piece as a
u32), then data, up to `min(65536, sctp.maxMessageSize) − 40` bytes. Browsers and the bridge only guarantee 16 KiB
(16,384 − 40 bytes of data), which already fills a gigabit link, and `send()` throws above the peer's limit. The sender keeps `bufferedAmount` under 16 MiB and resumes at
`bufferedAmountLowThreshold` (4 MiB). That keeps memory flat at any file size.

**Receivers:**
- They pick pieces in order, from up to 3 holders at once, keeping at most 4 pieces in flight per holder.
- When a piece arrives, they hash it and compare it with the manifest.
- A good piece is written in place. It counts as held once the write is committed (see Storage), and the held pieces
  are saved in IndexedDB, so the transfer resumes after a reload.
- A bad piece is dropped. That holder isn't asked for this file again for ten minutes, and the piece is asked from
  another holder.
- A holder that stalls for 15 s is skipped, as in attachments.

**Senders** serve a piece only when all of these hold:
- the requester is an admitted device on an open channel;
- a verified message in the room names the manifest;
- the sender holds the piece;
- the path is allowed: the selected candidate pair is `direct`, or `turn` where the room allows TURN.

This check fails closed. When the selected pair or its candidate types can't be read, which may happen in a bridge
WebRTC stack whose `getStats()` doesn't expose them, the answer is `not-direct`. The Mesh view may assume
direct for display; serving never does.

The sender checks the path again whenever ICE changes. A path that turns to TURN mid-transfer pauses it with
`not-direct`. Two receivers at a time per sender; others get `busy` and retry.

## Storage

- **Sender (browser):** keeps the `File` it was given and reads pieces with `file.slice()`. Nothing is copied. On
  Chromium the file handle is kept in IndexedDB, so after a reload **Share again** asks for permission instead of
  asking the person to pick the file again.
- **Receiver (browser, Chromium):** asks where to save with `showSaveFilePicker`, then writes each piece in place with
  `createWritable({ keepExistingData: true })` and `seek`. A writable writes to a temporary copy until `close()`, so a
  tab that dies mid-transfer would lose everything since the last close. The receiver therefore closes and reopens it
  at checkpoints, every 64 MiB or 30 s, and marks pieces held only after the close that commits them. The handle and
  the held pieces are stored for resume. The resume smoke must kill the tab between checkpoints.

  **Trade-off to settle:** `keepExistingData: true` starts each writable by copying the whole file so far into its
  temporary copy, so every checkpoint rewrites everything already received. A 2.3 GB file at 64 MiB checkpoints writes
  about 40 GB to disk in all, and the cost grows with the square of the size. The alternative is the OPFS path below on
  Chromium too, with one streamed copy into the picked file at the end: linear writes, but twice the file's size on
  disk until that copy finishes.
- **Receiver (browser, elsewhere):** writes to OPFS, `direct/<room>/<manifest>.part`, from a worker with a sync access
  handle. When done, Save hands over the OPFS `File`, which the browser streams from disk. Before starting, it checks
  `navigator.storage.estimate()` and asks for `persist()`.
- **Bridge and desktop app:** `<home>/browser-agents/<room>/direct/<manifest>.part`, renamed when complete.

None of this counts toward the attachment limits (256 MB and 512 files per room), and none of it is fetched
automatically.

## Room setting

The host's Rules tab gets **Direct files may use TURN**, off by default. Rooms that run their own TURN service (see
self-hosted-relay.md) can turn it on to reach people behind strict NATs. The relay socket is never an option for
direct files: it would carry gigabytes through the room service.

## Safety

- A direct file is always a download. It's never rendered inline, and `type` is only a label.
- Names are cleaned as attachment names are. A save never replaces an existing file without the picker's own
  confirmation.
- Integrity is per piece against the signed manifest, so a bad holder can waste bandwidth but can't corrupt the file.
- Holders see who downloads from them (device ids). The room service sees nothing beyond the signaling it already does.

## Decided in review

These came out of the transport review. Any of them can still change before code:

1. **TURN** is off by default; the room opts in.
2. **Keep sharing** is on while the tab is open, with an upload indicator and **Stop**.
3. **Agents** get `direct-get` first, confined to the wake directory in wakes. `direct-offer` follows.
4. **Piece size** is 4 MiB up to 64 GB and 16 MiB above.

## Plan

1. **Mesh Connections:** shows which paths are direct.
2. **This contract:** review it, including the decisions above and the Chromium storage trade-off.
3. **Browser to browser:** the offer card, the sender's preparation, Chromium save-in-place and the OPFS fallback,
   resume and multi-source, the direct-only rule.
4. **Bridge:** `direct-get` and `direct-offer`.
5. **Tests:**
   - unit tests for the manifest, the bitfield and piece selection;
   - a smoke that sends a file bigger than the test runner's memory budget, drops the connection halfway, reloads,
     and checks the resume and the final pieces;
   - a forced-TURN run that checks `not-direct`.

# Screenshots and files in browser rooms

Status: implemented in browser rooms (`meshrooms-browser-v1`) and the agent
bridge. Native rooms are described in [attachments.md](attachments.md); the
safety rules are the same.

## Why

Frontend QA starts with a screenshot. Browser rooms had no way to share one,
and the room service must never see room content, so files cannot be uploaded
to it. They travel only between devices, over the same WebRTC data channels as
messages.

## Experience

- **People**: paste a screenshot into the composer, drop files on the
  conversation, or use **Attach**. Files are read and hashed right away; nothing
  leaves the browser until the message is sent. A message can be only files.
  Images render inline and open in the full-size viewer with Download; other
  files are download chips. While a file is on its way the message shows
  "Receiving · 40%", "Waiting for a device that has this file", or that a copy
  failed verification.
- **Agents**: `send --attach FILE` (repeatable) and
  `attachment --room R --id ID [--out FILE_OR_DIR] [--wait-seconds 30]`. `listen`
  includes each message's `attachments`. Floor rules apply as to text.

## Wire format

A message body names its files. The body is signed, so the hash is
end-to-end: a receiver checks reassembled bytes against `sha256` before storing
or showing anything.

```json
{ "kind": "message", "roomId": "…", "id": "…", "deviceId": "…", "memberId": "…",
  "text": "Attached screenshot-2026-09-25-10-02-11.png", "at": 1790000000000,
  "attachments": [{ "id": "<uuid>", "name": "screenshot-2026-09-25-10-02-11.png", "type": "image/png",
                    "size": 183422, "sha256": "<64 hex>", "width": 1440, "height": 900 }] }
```

`type`, `size`, `width`, and `height` are sniffed from the bytes by the sender
(`src/attachments.ts`, shared with native rooms); receivers reject a body whose
attachments are not 1 to 4 entries with a UUID `id`, a clean `name` (what
`cleanName` leaves unchanged), a type `sniff` can produce, a size of 1 byte to
10 MB, a SHA-256, and no other fields.

Transfers use unsigned envelopes on the data channel. They carry no `body`, so
older devices ignore them:

| Packet | Meaning |
| --- | --- |
| `{kind:'files', roomId, version:1}` | Sent when a channel opens: this device transfers files. Answered once if the peer had not announced. Only announced peers are asked. |
| `{kind:'file-want', roomId, sha256, offset}` | Send this file from `offset` (resume). |
| `{kind:'file-chunk', roomId, sha256, offset, data}` | 12,000 bytes as base64 (16,000 characters), so every packet stays under the 20,000-character channel limit. |
| `{kind:'file-done', roomId, sha256, size}` | All chunks sent. |
| `{kind:'file-missing', roomId, sha256}` | Not held here, not referenced here, or too busy (two uploads per peer). |

The receiver (`FileTransfers` in `src/browser/files.ts`, used by browsers and
the bridge alike) pulls up to three files at a time, each from one announced
peer. It accepts only chunks it asked for, in order, from the peer it asked. A
peer that answers `missing` or stalls for 15 seconds is skipped and the next one
is asked from the same offset; a disconnect keeps what arrived and resumes from
there with whoever connects next. Skipped peers are asked again every 20
seconds. After `done` the whole file is hashed. On a mismatch nothing is stored,
the partial is discarded, and every peer that contributed bytes is not asked for
that file again for ten minutes.

Senders wait while more than 1 MB is queued on the channel (`bufferedAmount`),
so a 10 MB file never floods the SCTP buffer. File packets bypass the queue that
serializes message handling, so a transfer never delays or drops messages.

A device serves a file only if it holds it and a verified message in this room
names its hash, and only to admitted devices on an open channel. The store and
the transfer code know nothing about messages: whatever else comes to reference
files by hash (for example task artifacts) makes them servable the same way.

## Who holds files

- The author stores its files before signing the message, so it can serve them
  as soon as a peer asks.
- **Browsers** fetch the files of every message they keep, so any browser in the
  room can serve them to devices that were offline or connect later.
- **The bridge** fetches only what its agent asks for with `attachment`, then
  keeps and serves it like any holder.

Messages still come only from their author, so a device that was offline gets a
message when its author is online again, and can then fetch the file from any
holder, including after the author has gone.

## Storage and limits

10 MB per file and 4 per message, as in native rooms. Each device keeps the
files of the newest messages up to 256 MB and 512 files per room; older files
are evicted and not fetched again (the message says so). Browsers keep verified
files as Blobs in IndexedDB (`file:<device>:<room>:<sha256>`, with an index at
`files:<device>:<room>`), and display them through `blob:` URLs. The bridge keeps
content-addressed files in `<home>/browser-agents/<room>/files/<sha256>`,
re-hashes them on every read, and leaves files younger than ten minutes alone so
`send` and `attachment` never race eviction. `attachment` asks the running
bridge through `wants/<sha256>`, and `transfers.json` reports progress or a
failed verification back to it.

## Safety

- Only PNG, JPEG, GIF, and WebP whose stored bytes sniff as the declared type
  render inline; everything else, including SVG and HTML, is stored as
  `application/octet-stream` and offered as a download.
- Names are display-only. They are validated on arrival and cleaned again where
  the bridge writes a file: `attachment` into a directory never leaves it and
  never replaces an existing file there (it adds `-2`, `-3`, …); only an explicit
  `--out` file path is overwritten.
- The page CSP allows `img-src blob:` for this, and nothing else changed.
  `connect-src` stays `'self'`.

## Compatibility

Browsers and bridges from before attachments drop messages without text. A
message of only files therefore carries `Attached <names>` as its text: older
devices show that, store the message, and send receipts; current devices
recognize the exact string and show the files instead. Older devices verify the
signature over the whole body, so the extra `attachments` field is signed and
checked like the rest. They never ask for files, and they ignore transfer
packets. Receipts still mean the message was stored, not that its files were.

## Not yet

- History for devices that join after a message was sent (messages, not only
  files, come from their author today).
- Upload progress for the sender, image annotation, and deleting a file.

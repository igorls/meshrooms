# Screenshots and file attachments

Status: implemented in the local daemon, including paired (two-node) rooms over
MeshGuard application transfers. Browser rooms carry attachments peer to peer;
see [browser-attachments.md](browser-attachments.md).

## Why

Frontend QA almost always starts with a screenshot. People and agents in a
room need to share images and small files, and an agent needs to be able to
download one and look at it with its own tools.

## Experience

- **People**: paste an image into the composer (the common "screenshot to
  clipboard" path), drop files onto the conversation, or use **Attach**. Uploads
  start immediately; the tray shows progress, failures with Retry, and removal.
  A message can be only attachments. Images render inline and open in a
  full-size viewer with Download; other files render as download chips.
- **Agents**: `send --attach FILE` (repeatable, up to four) and
  `attachment --id ID [--out DIR]`, which saves to
  `<data dir>/downloads/<room>/` by default and returns the path. `listen` and
  `read` include each message's attachment metadata. Floor rules apply to
  messages with attachments exactly as to text.

## Storage and integrity

Bytes are content-addressed files in `<data dir>/attachments/<aa>/<sha256>`,
written to a temporary name, fsynced, and renamed. Every read re-hashes the
file; a mismatch is reported as missing or damaged (`410`) instead of serving
altered bytes. Metadata lives in WormDB under
`meshrooms/v1/rooms/<room>/attachments`, validated at startup like history.
Keeping bytes out of WormDB avoids replaying every screenshot from the log on
each start. WormDB has no delete, while blob files can be removed.

Upload and send are two steps. An upload stays pending, visible only to its
uploader, until a message in the same room references it. It can be sent once,
by its uploader. Upload retries are idempotent per author and request ID; the
CLI derives each file's request ID from the message's, so retrying a send
reuses its uploads. Pending uploads older than a day are dropped at startup,
and blob files no room references are removed.

## Safety

- The type is sniffed from the bytes. Only PNG, JPEG, GIF, and WebP are
  `kind: image` and served inline with their image type. Everything else,
  including SVG and HTML, is served as `application/octet-stream` with
  `Content-Disposition: attachment`.
- Every download carries `nosniff`, a `sandbox` CSP, `no-referrer`, and a
  same-origin resource policy. Names are display-only; paths and control
  characters are stripped and never determine storage locations.
- Access requires room membership (session cookie or room-scoped agent token).
  Uploads use the same origin and cross-site checks as other commands.

## Limits

10 MB per file, 4 per message, 8 pending uploads per author and room, and
512 files / 512 MB per room.

## Paired rooms

A message with attachments is delivered to the paired node only after every
file it references. The bridge sends each file with MeshGuard's verified
transfers (`XFER*`, channel `meshrooms-files`; see MeshGuard
`docs/reference/app-transfers.md`) with metadata naming the room, author,
attachment ID, and name. The receiving bridge checks that the sender is admitted
to that room and the author is one of its granted participants, re-detects the
type from the bytes, stores the file, and replies `file-ack` on `meshrooms-v1`.
Only that receipt, recorded durably in the room's peer record (`files`), retires
the file; MeshGuard's own "delivered" is progress, not storage. Failed or
unacknowledged transfers are retried after a pause. The message is accepted
remotely only when each attachment's stored metadata matches the message.

`meshrooms transport` lists `filesStoredRemotely` and `sendingFiles` per room.
An attached MeshGuard without transfers (`APPINFO` lacks `"transfers":1`) leaves
a message with attachments pending with an explicit error. Delivery is in order
per room, so that room's later messages wait behind it; other rooms keep flowing.

## Not yet

- Image annotation, video, and per-attachment deletion.

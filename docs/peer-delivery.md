# Two-node room delivery: development qualification

Recorded evidence: [Windows/Linux qualification](peer-delivery-qualification.md).

This experimental slice attaches one Meshrooms daemon to one explicit MeshGuard
control endpoint. Multiple independently paired rooms share that attachment.
Each room currently has one remote node, with a fixed, explicitly approved list
of participant identities. Public invitations, remote bootstrap, membership
changes/revocation, more than two nodes per room, and harness wakeups are not
implemented by this pairing path.

The local node includes the bridge, but not the MeshGuard executable or the
source-only QA fixture script below. There is no installer: build the node from
source ([native build](native-build.md), [runtime package](runtime-package.md)).

## Transport and receipts

Requires MeshGuard application-channel protocol 1 (`APPINFO`, `APPSEND`,
`APPRECV`), initially implemented in MeshGuard PR #135. The channel is
`meshrooms-v1`; the adapter never reads the destructive legacy inbox. It checks
the configured MeshGuard public key before each exchange cycle. The local HTTP
API remains loopback-only.

Both nodes must explicitly pair the same stable room ID. The local owner imports
the other node's descriptor (public transport key and allowed participant IDs,
names, and roles). Reachability, a room title, or an incoming message never grants
membership. This manual development grant is not a shareable invitation.
Changing the local owner's name is blocked while a room is paired, because
this slice cannot update the name in the other node's fixed grant.

Pairing publishes only subsequent local messages, with their explicitly shared
excerpts. Existing history stays private; replies to that old history must be
sent as new messages. Remote messages are never forwarded as locally authored
messages. Browser and agent reads keep their existing room scopes.

An HTTP send still means **stored locally**. Pending delivery is derived from
durable room history; a peer receipt retires it only after the receiver stores
the same message. Uncertain sends, lost receipts, and restart replay retain the
original IDs and reject changed content. `meshrooms transport` reports pending
IDs and `storedRemotely` IDs. A remote storage receipt does not mean the human or
agent has read or acted on a message.

Attachments travel separately as verified MeshGuard transfers (`XFER*`, which
MeshGuard advertises with `"transfers":1` in `APPINFO`) before the message that
references them; the receiving node stores each file and returns a `file-ack`.
See [attachments](flows/attachments.md#paired-rooms).

Messages are split into bounded, hashed chunks to fit the 952-byte application
payload. Outbound chunks are paced; each room retries independently. Incomplete
assemblies are limited to sixteen globally, four per authenticated peer across all
its rooms, and two per room. Excess new assemblies are dropped for sender retry;
existing assemblies can finish at capacity and receipts bypass this allocation
limit. Incomplete entries expire thirty seconds after their first chunk; duplicates
do not extend that deadline. Completion (including invalid content), expiry, and
bridge shutdown release slots. Several admitted peers can still saturate the global
backstop; these limits do not promise fairness under coordinated traffic floods.
Repeated transmission recovers lost chunks;
partial assembly is not a storage receipt. This is a bounded prototype, not a
throughput or sustained network reliability qualification.

Catalog version 3 adds remote grants and receipts at the existing catalog key.
Version 2 is migrated only after histories validate; old binaries reject the
new catalog version rather than silently interpreting remote identities as local.
Use isolated test stores and retain a backup before any future real-node upgrade.

## Isolated Windows/Linux proof

Build a separately pinned MeshGuard candidate, retaining existing daemons,
workers, control sockets, and inboxes. Use a different `MESHGUARD_CONFIG_DIR`,
`MESHGUARD_CONTROL_PATH`, and explicit `--gossip-port` on each test machine.
Do not run `meshguard agent` or legacy `recv` to consume Meshrooms traffic.

Build this Meshrooms source with Bun 1.4.2 and a compatible WormDB library.
Set `WORMDB_LIBRARY_PATH` explicitly. Create one shared test room UUID and run:

```text
bun run scripts/qualify-peer-node.ts --data-dir EMPTY_TEST_DIRECTORY --room ROOM_UUID --agent AGENT_NAME --peer-key LOCAL_MESHGUARD_HEX --socket PRIVATE_CONTROL_PATH --port UNUSED_HTTP_PORT
```

This script explicitly creates a **QA fixture owner**, an agent, and a separate
unpaired room. It refuses nonempty real data directories. It is not a product
onboarding command. It emits a public descriptor and a private credential file
path; keep the credential contents on that machine. To restart the exact fixture,
repeat the same arguments with `--resume true`.

Exchange only the descriptors, out of band, over a channel you already trust.
Save the other node's descriptor to a local file, then:

```text
bun run server/cli.ts pair --data-dir TEST_DIRECTORY --descriptor PEER_DESCRIPTOR_FILE
bun run server/cli.ts transport --data-dir TEST_DIRECTORY
bun run server/cli.ts send --credential LOCAL_CREDENTIAL_FILE --request-id UUID --text MESSAGE
bun run server/cli.ts listen --credential LOCAL_CREDENTIAL_FILE --after LAST_PROCESSED_MESSAGE_ID --wait-seconds 30
```

Prove a deliberate message and reply, both remote storage receipts, a restart
with the same identity/history, and exclusion of the unpaired room. Do not count
this fixture as human onboarding or autonomous harness wakeup. The browser can
view the room using `open --data-dir TEST_DIRECTORY`; its private access URL is
local to that machine and is not an invitation.

For a development daemon launched directly, attachment settings are
`MESHROOMS_MESHGUARD_SOCKET` and `MESHROOMS_MESHGUARD_KEY`. Both must be explicit.
No installation or startup registration is changed by this slice.

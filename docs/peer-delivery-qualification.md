# Two-node delivery: what was qualified

The experimental [two-node delivery path](peer-delivery.md) was qualified between two isolated development nodes on
different operating systems (Windows and Linux). Each node had its own data directory, MeshGuard control endpoint,
gossip port and loopback HTTP port, and each side had a separately authenticated agent client. Only the public room
descriptors were exchanged between the nodes by hand; credentials stayed local.

## What the run showed

- **Delivery and receipts.** A message sent through one agent's room-scoped CLI was stored locally, delivered to the
  other node, and acknowledged with a remote storage receipt. The reply came back the same way, authored by the
  admitted remote agent identity.
- **Restart recovery.** After a forced stop, each node kept its node ID, its exact history (every message once) and
  its delivery receipts. Retrying an original request returned the original message ID. Fresh messages sent after
  both restarts were delivered and acknowledged.
- **Isolation.** A room that was not paired stayed private: a sentinel room and message on one node never appeared on
  the other, and room-scoped agent reads exposed only the paired room.
- **No side channel.** Messages were not relayed any other way, so this proves room delivery, not automatic agent
  wakeup.

Automated tests cover lost receipts, sender and receiver restart replay, failed receiver writes without an
acknowledgement, rejection of the wrong room, peer or author, excluded history, maximum-size Unicode fragmentation,
and local IPC framing. An independent read-only review found no blocking issues.

## Not established

Sustained WAN reliability, an independent cryptographic audit, public invitations and recipient bootstrap, grant
changes and revocation, rooms with more than two nodes, and persistent harness wakeup remain separate work.

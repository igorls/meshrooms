# MeshGuard service share for native rooms

Status: first Meshrooms slice in progress. MeshGuard hot-reload of service
policies is a follow-up in the MeshGuard repo.

Date: 2026-09-25

## Goal

An operator on a native Meshrooms node can share **one** localhost TCP port with
the paired peer so the other machine can open a frontend preview (prefer
`vite preview` or a static build). Sharing stays **outside** the browser site.
The room shows who is sharing, which port, and how to reach it, with an explicit
stop and an expiry.

This is the native half of the port-share discussion. Browser-room TCP-over-data-channel
forwarding is a separate task.

## What MeshGuard already provides

MeshGuard filters **inbound** mesh traffic at decrypt→TUN with identity-aware
port policies (`meshguard service`):

- Per-peer allow/deny for `tcp`/`udp` ports
- Evaluation order: peer → org → global → default
- Policies live under `$MESHGUARD_CONFIG_DIR/services/`
- Peers and mesh IPs are available over the control socket (`PEERS`, `STATUS`)

With a default-deny posture and `allow --peer <paired> tcp <port>`, only that
peer can reach the shared port on this node's mesh IP.

## Current MeshGuard limits (honest)

1. **Policies load at daemon startup.** Applying a new allow today requires
   rewriting the policy file and **restarting MeshGuard**. Live share/stop
   without restart needs a MeshGuard control command that updates the in-memory
   filter (follow-up).
2. The Meshrooms control adapter today speaks `STATUS`, `APPINFO`, `APPSEND`,
   `APPRECV`, and `XFER*`. It does not yet manage service policies.
3. The preview process must **listen only on the mesh IP**. Binding to
   `127.0.0.1` is unreachable over WireGuard; binding to `0.0.0.0` would expose
   the port on LAN interfaces outside MeshGuard's per-peer rule. Do not treat
   `0.0.0.0` as acceptable without a separate OS firewall guarantee.
4. Prefer `vite preview` / static builds. Raw Vite dev servers expose `/@fs/` and
   similar paths; a share is filesystem access unless the operator accepts that.

## Product rules

| Rule | Detail |
| --- | --- |
| Operator approval | Only the local human/operator starts or stops a share. Agents may prepare a preview process; they do not open MeshGuard policy without an explicit operator command. |
| One port | At most one active share per node (first slice). |
| One peer | Allow only the room's paired MeshGuard peer key. |
| No broader allow | Before writing a share rule, `share` checks that no existing global/org/default-allow (or other peer allow) already admits this TCP port to anyone besides the paired peer. If a broader allow would still let an unpaired peer through, refuse with a clear error. |
| Owned rules only | The share record stores a generated ownership marker (rule id) for each MeshGuard rule it created. `share-stop` and expiry remove **only** those owned rules. Path + rule text alone is not enough: an identical hand-written allow must not be deleted. Refuse to create a share rule that would be ambiguous with an existing unmarked allow. |
| Visible | Room members see sharer, port, mesh URL, started-at, expires-at, and status. |
| Expiry / stop | Intent is cleared immediately; reachability may lag until MeshGuard reloads (see statuses below). |
| Outside the site | No preview origin on `meshrooms.wormdb.dev`. Recipients open `http://<mesh-ip>:<port>/` on their own machine. |
| Default posture | Production-like nodes should run `meshguard service default deny` before relying on per-peer allows. |

## Meshrooms first slice

Ship design + local orchestration in Meshrooms without waiting for MeshGuard
hot-reload:

1. **Share record** on the local node for a paired room: port, peer key, mesh IP,
   started/expiry, the owned rule fingerprint(s), and status:
   - `pending-enable` — rule written; waiting for MeshGuard restart/reload before
     the port is reachable
   - `active` — reload observed / operator confirmed; peer can connect
   - `pending-disable` — stop/expiry removed the owned rule intent, but MeshGuard
     has not reloaded yet, so the port may still work until reload
   - `stopped` — reload complete (or never enabled); port denied again under the
     remaining policy
2. **CLI** (operator-facing):
   - `meshrooms share --room <id> --port <n> [--minutes 30]`
   - `meshrooms share-stop --room <id>`
   - `meshrooms share-status --room <id>`
3. **Policy write:** after the broader-allow precondition passes, append the
   per-peer allow for that TCP port (config file or `meshguard service allow
   --peer …`), record those owned rules on the share, then set `pending-enable`
   until MeshGuard restarts (or a future hot-reload succeeds).
4. **Announce (follow-up):** today's peer bridge only accepts `chunk` / `ack` /
   `file-ack`. A room-visible share card needs a new authenticated, room-scoped
   share event type plus a receiver. Until that lands, the first slice records
   share state **locally** and documents the mesh URL for the operator to copy;
   do not pretend chat or the existing datagram channel carries share
   announcements.
5. **Stop** removes only the owned rules (by ownership marker), sets
   `pending-disable` until MeshGuard reloads, then `stopped`. Cross-node
   announce of stop waits on the same share-event follow-up.

Do not claim the port is reachable while status is `pending-enable`.
Do not claim the port is closed while status is `pending-disable`.

## Recipient flow

1. Obtain the mesh URL from the operator (first slice) or from a future share
   event: `http://10.x.x.x:4173/` plus status.
2. Open it in a local browser on the recipient machine (mesh routing already up)
   only when status is `active`.
3. When the share is `pending-disable` or `stopped`, treat the URL as untrusted;
   after MeshGuard reload under default-deny it should fail closed.

## Follow-ups (not this slice)

- MeshGuard: control-socket `SERVICEALLOW` / `SERVICEDENY` / `SERVICERELOAD` so
  share/stop does not restart the daemon.
- Authenticated share announce/stop events on the Meshrooms peer bridge (new
  packet kinds, verified like file-ack).
- Binding helper: optional wrapper that runs `vite preview --host <mesh-ip>`
  (mesh IP only).
- Multi-port or multi-peer shares.
- Browser-room agent-to-agent TCP tunnel (separate design).

## Acceptance for this slice

1. On a paired Linux/Windows (or Linux/Linux) fixture, an operator can record a
   share for one TCP port aimed at the paired peer key.
2. `share` refuses when a broader existing allow would admit an unpaired peer to
   that port.
3. After MeshGuard restart with the new policy, the peer can fetch the preview
   over the mesh IP; an unpaired peer cannot.
4. Stop/expiry remove only owned rules and show `pending-disable` locally until
   reload; after reload the port is denied again under default-deny and
   hand-written allows the operator made are still present. Cross-node stop
   announce is a follow-up (see above), not required of this slice.
5. Docs state the restart limitation (including lag after stop) and the
   `vite preview` recommendation.
6. No change to the browser site origin or to browser-room signaling.

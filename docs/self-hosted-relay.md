# Run your own public relay

Meshrooms connects devices directly when it can. When two devices can't reach each other (strict NATs, some mobile
networks, corporate firewalls), their traffic goes through a relay. You can run your own instead of depending on ours.
There are two kinds, one per room type:

| Room type | Relay | What it relays |
|---|---|---|
| Local (native) rooms | a **MeshGuard** node with a public address | discovery and the encrypted mesh traffic between nodes |
| Browser rooms | a **TURN** server (coturn) | the encrypted WebRTC data channels between browsers and agent bridges |

You can run both on the same host. They are separate services with separate ports.

## What a relay can and can't see

A relay carries traffic it can't read. MeshGuard traffic is encrypted end to end between the two nodes, and browser
data channels are DTLS-encrypted between the two devices. A relay does see metadata: which addresses talk to each
other, when, and how much. Run it on a host you trust with that, and tell your users who operates it.

## Native rooms: a MeshGuard relay

### What you need

- A Linux host with a **public, static IPv4 address**. The relay must be reachable without NAT; this is the one case
  where `--announce` is right (see *Pitfalls*).
- **UDP 51821** open inbound. That is MeshGuard's default gossip/listen port; `--gossip-port` changes it.
- MeshGuard installed as a service. We run 0.10.0; see the [MeshGuard docs](https://igorls.github.io/meshguard/) for
  installing, and `meshguard upgrade` to update it.

### Configure

MeshGuard reads its options from `/etc/default/meshguard`. Our public relay uses:

```sh
# /etc/default/meshguard
MESHGUARD_OPTS="--announce 203.0.113.10 --open"
```

- `--announce <ip>` sets the public address instead of discovering it with STUN. Use the host's real public IPv4.
- `--open` accepts all peers without trust enforcement, which is what makes it *public*. For a relay only your own
  nodes may use, leave `--open` out and authorize peers with `meshguard trust <public key> --name <label>`, or trust
  an organization's key with `meshguard trust --org <org public key>`.

The service runs `meshguard up $MESHGUARD_OPTS` under systemd with `MESHGUARD_CONFIG_DIR=/etc/meshguard` and a hardened
unit (`NoNewPrivileges`, `ProtectSystem=strict`, only `CAP_NET_ADMIN`, `CAP_NET_RAW` and `CAP_NET_BIND_SERVICE`).
Because `--open` lets anyone use your bandwidth, also cap it with a drop-in:

```ini
# systemctl edit meshguard
[Service]
MemoryMax=512M
CPUQuota=100%
```

and rate-limit UDP 51821 at your firewall. Size both to the traffic you expect.

### Point nodes at it

Nodes use the relay as a seed:

```sh
meshguard up --seed relay.example.org:51821
```

`--seed` can be repeated, so users can list your relay next to others. Check with `meshguard status` on both the relay
and a node.

### Pitfalls we hit

- **Never use `--announce` on a node behind NAT.** It tells the mesh the node is publicly reachable, which turns off
  relay fallback for it; a NATed node that announces itself becomes unreachable instead of relayed. Only the relay
  (or another host with a truly public address) should announce.
- **Mobile and CGNAT peers.** A 5G peer behind carrier-grade NAT may still fail to connect through the relay, because
  the relay forwards to the endpoint it has on record rather than the address the traffic actually arrives from, and
  those mappings change. This is a known MeshGuard limitation, not a configuration problem; until it is fixed, test
  with the networks your users are on.
- **An open relay is a shared resource.** Watch its bandwidth and set the limits above before you publish its address.

## Browser rooms: a TURN server

Browser rooms use a standard [coturn](https://github.com/coturn/coturn) TURN server with short-lived credentials that
the room service issues. The repository ships the configuration we run:

- `deploy/turnserver.conf.example`: the coturn configuration.
- `deploy/systemd/meshrooms-turn.service`: a hardened unit (`ProtectSystem=strict`, `MemoryMax=256M`, no capabilities).

### Ports

Open only these, inbound: **3478** UDP and TCP (TURN), **5349** TCP (TURN over TLS), and **49160–49259** UDP (the relay
range, `min-port`/`max-port`).

### The shared secret

Generate one secret and put it in two places, and nowhere public:

```sh
openssl rand -hex 32
```

- In coturn as `static-auth-secret` (with `use-auth-secret`), in `/etc/meshrooms/turnserver.conf`, mode 0640,
  owner root:turnserver.
- In the room service as `MESHROOMS_TURN_SECRET`, in its environment file (ours is `/etc/meshrooms/browser.env`,
  mode 0640). Never serve it to browsers.

The room service gives each device a credential valid for one hour: the username is `<expiry>:<device id>`, and the
password is the base64 HMAC-SHA1 of that username under the secret. coturn checks it with the same secret, so there
are no user accounts and nothing long-lived to leak.

### What the configuration enforces, and why

- `use-auth-secret`: only credentials minted by your room service work. **Never run an open TURN relay**; anyone
  could use it to reach arbitrary hosts from your address.
- `denied-peer-ip` for private and special ranges (10/8, 172.16/12, 192.168/16, 100.64/10, link-local, multicast,
  IPv6 ULA and link-local): a room can't use the relay to reach your internal network. Loopback is denied by coturn's
  default policy. Don't add `::` as a denied peer; coturn 4.6 treats it as a wildcard for IPv4 too.
- Quotas: `user-quota=16`, `total-quota=128`, `max-bps=131072` per session and `bps-capacity=8388608` total,
  `max-allocate-lifetime=3600`.
- TLS: `cert`/`pkey`, with `no-tlsv1`, `no-tlsv1_1` and `no-dtls`. Renew certificates with a hook that copies the files
  and restarts only the TURN service.
- `no-tcp-relay`, `no-multicast-peers`, `no-cli`, `no-software-attribute`.

Replace `SERVER_PUBLIC_IPV4`, `realm`, `server-name` and the secret with your own values.

### Point a room service at it

```sh
MESHROOMS_STUN_URLS=stun:turn.example.org:3478
MESHROOMS_TURN_URLS=turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp,turns:turn.example.org:5349?transport=tcp
MESHROOMS_TURN_SECRET=<the secret>
```

### Check it really relays

Configuring a TURN URL is not proof it works. Run a browser test with relay-only ICE and inspect the selected candidate
pair, and test the TLS port separately (see `docs/browser-deployment.md`).

## Checklist

- [ ] Public, static IPv4, and only the ports above open.
- [ ] MeshGuard relay: `--announce` with the real public IP; `--open` only if you mean it to be public; memory, CPU and
      UDP limits set.
- [ ] No node behind NAT uses `--announce`.
- [ ] TURN: `use-auth-secret` with a fresh secret, shared only with your room service; private ranges denied; quotas
      and TLS on.
- [ ] Relay-only browser test passes; TLS tested separately.
- [ ] Users know who operates the relay and what it can see.

# Hosted browser preview

The static site and browser runtime share meshrooms.wormdb.dev. The browser
coordinator listens only on 127.0.0.1:4320. Nginx proxies /rooms, /r/, /api/lobby,
and missing static assets to it. The runtime supplies its own content policy;
the static site's connect-src 'none' must not be inherited by these routes.

## Files and service ownership

- /opt/meshrooms/releases/<git-sha>: immutable browser source, built dist,
  static website, deployment files, and release.env with MESHROOMS_REVISION.
- /opt/meshrooms/current: active release symlink.
- /opt/meshrooms/bin/bun: pinned Bun 1.4.2, checked against upstream SHA-256.
- /etc/meshrooms/browser.env: origin, state path, proxy trust, STUN/TURN URLs,
  and the shared TURN secret. Mode 0640, root:meshrooms. Never publish it.
  With the HTTPS origin it must set MESHROOMS_TRUST_LOOPBACK_PROXY=1, or the
  coordinator refuses to start. Optional: MESHROOMS_INVITES (defaults to
  `required` for HTTPS), MESHROOMS_MAX_ROOMS (256), MESHROOMS_ROOM_IDLE_DAYS (30).
  Production also sets `MESHROOMS_BACKUP_MAX_AGE_HOURS=26`, so health reports
  `backupFresh` (see Backups).
- /var/lib/meshrooms-browser: admission SQLite and OS lock, mode 0700,
  owned by the unprivileged meshrooms service account. No chat history is stored.
- /etc/meshrooms/turnserver.conf: rendered deploy/turnserver.conf.example,
  mode 0640, root:turnserver. A separate meshrooms-turn service owns the relay.

Use deploy/systemd service definitions. The relay listens on the host's public
IPv4 address, accepts short-lived authenticated allocations, bounds bandwidth and
allocation counts, and denies private/special peer networks. Open only 3478
UDP/TCP, 5349 TCP, and 49160–49659 UDP for this service. Existing HTTPS and native
MeshGuard services remain separate. The scoped Certbot hook copies renewed TLS
files into /etc/meshrooms/turn and restarts this relay only.

## Release

Deploy merged `main` with the script, from a maintainer machine with git, the pinned Bun, ssh,
scp and curl:

```sh
scripts/deploy-browser.sh --dry-run <sha>   # checks and the full plan; no build, no SSH
MESHROOMS_DEPLOY_HOST=root@<deploy-host> scripts/deploy-browser.sh <sha>
```

`MESHROOMS_DEPLOY_HOST`, `MESHROOMS_PUBLIC_ORIGIN`, `MESHROOMS_CANDIDATE_PORT` (default 4329),
`MESHROOMS_KEEP_RELEASES` (default 10) and `MESHROOMS_SKIP_NPM_CHECK` (set to `1` to bypass checking
that `@wormdb/meshrooms@<CURRENT_AGENT_VERSION>` is published on npm) override the defaults.
`--package-only` builds the tarball without touching any host or npm; CI runs it on every push. The
script refuses modified tracked files (untracked files are ignored, since it builds from a clean
`git archive` export) and any revision that is not on `origin/main`.

What it does, and what to do by hand if it can't:

1. Build the exact revision in a clean export: `bun install --frozen-lockfile`, `bun run build`,
   then `bun run build:agent` (it writes dist/agent, so it must run after the Vite build).
2. Package only what the runtime needs. The coordinator's files come from the import graph of the
   service and the operator commands (`scripts/release-files.ts`, which also fails on any package
   import, since the release has no node_modules), plus dist, website, deploy, .bun-version,
   release.env with MESHROOMS_REVISION, and a SHA256SUMS of every file. The tarball is reproducible
   with GNU tar (sorted names, the commit time, fixed owners and modes, `gzip -n`): rebuilding a
   revision gives the same hash. Keep admission data and credentials out of the archive and web roots.
3. Copy the tarball and the host script (`scripts/deploy-browser-remote.sh`, as
   /opt/meshrooms/incoming/deploy-browser-remote-<sha>.sh) to the host. `prepare` takes the host's
   deploy lease for this revision (/var/lib/meshrooms-deploy/lease), so a second deploy from any
   machine is refused until this one finishes; verifies the tarball hash after transfer and every
   file against SHA256SUMS after unpacking to /opt/meshrooms/releases/<sha>; checks that
   /opt/meshrooms/bin/bun matches .bun-version; runs `nginx -t`; and copies the static site to
   /var/www/meshrooms/releases/<sha>. A revision that is already live is reused as it is.
4. Before activation, start a separate candidate on another loopback port, as the meshrooms user,
   with a throwaway data directory (a systemd RuntimeDirectory) and the public origin. Its health
   endpoint must report the intended revision; /rooms, a room path, a hashed asset and the agent
   bundle must answer 200, the served bundle hash must match the file, and a foreign Host must get
   403. Then the candidate is stopped and its data removed.
5. `activate` runs as a transient systemd unit and logs to /var/log/meshrooms-deploy; the SSH session
   only follows that log, so a dropped connection or a Ctrl-C on the maintainer machine cannot stop
   it halfway. It takes a verified admission backup (the deploy stops if that fails), records the
   previous app and site symlink targets, the running revision and a copy of the Nginx site in
   /root/meshrooms-rollback-before-<sha>.txt (a second deploy of the same revision gets a timestamped
   name), and prints differences between the live Nginx files or installed systemd units and the
   release's deploy/ copies as warnings; the script never installs them.
6. Atomically point both symlinks at the new release (each checked with readlink), restart
   meshrooms-browser (and meshrooms-admin if active) and require local health to report the new
   revision. Nginx is not reloaded: its configuration did not change, and the site root follows the
   symlink.
7. From the maintainer machine, require public /api/lobby/health to report the revision, /rooms and
   / to answer 200, and the public agent bundle hash to match the build.
8. Only after that, `prune` keeps the newest 10 releases (by unpack time) and their site copies. It
   never removes the live release or the rollback target recorded for this deploy, and it logs every
   folder it removes. `finish` releases the lease.

If anything fails, or the activation unit is stopped, after the swap, the previous symlinks are
restored and the coordinator restarted, and the script exits non-zero. To roll back a healthy deploy
later, deploy the previous revision again (it is still unpacked, so this only swaps and restarts),
or run the host steps directly. `rollback` refuses unless the release it undoes is the live one:

```sh
ssh root@<deploy-host> 'bash /opt/meshrooms/incoming/deploy-browser-remote-<sha>.sh lease <sha> &&
  bash /opt/meshrooms/incoming/deploy-browser-remote-<sha>.sh rollback <sha>;
  bash /opt/meshrooms/incoming/deploy-browser-remote-<sha>.sh finish <sha>'
```

A deploy whose maintainer machine died leaves its lease behind; it expires after two hours, or
release it with `... finish <sha>`. Never roll back by overwriting the admission database. A first
deploy onto an empty host has no rollback target and needs `MESHROOMS_ALLOW_NO_ROLLBACK=1`.

Verify public HTTPS /rooms, /r/<id>, /api/lobby/health, hashed assets, static site,
404 handling, Host/Origin rejection, and unchanged native service state. Run the
browser smoke with forced relay and inspect selected ICE candidate pairs; merely
configuring a TURN URL is not qualification. Test the TLS relay separately.
The HTTP request-body cap, application quotas and relay quotas all remain active.

## Request limits

Two layers bound what one client, and everyone together, can ask of the host.

**Nginx**, in front. `deploy/nginx/meshrooms-limits.conf` defines two zones and `deploy/nginx/meshrooms.conf` applies
them to the whole site:
- `meshrooms_addr`: 20 requests a second with a burst of 60 per IPv4 address (including IPv4-mapped IPv6) or IPv6 `/64`
  (canonical RFC 5952 IPv6 addresses are mapped to their `/64` prefix so rotating interface IDs share one bucket).
- `meshrooms_all`: 400 requests a second for all addresses together with a burst of 400. `GET /api/lobby/health` is
  exempt from this zone so a flood on `/api/lobby` cannot starve the 2-minute uptime probe. It has no global zone of
  its own: a bucket everyone shares would let one address keep every health check, the probe's and a deploy's
  included, at 429. The per-address zone still applies to it.

Requests past a burst get 429 at once (as JSON on `/api/lobby`, including `/api/lobby/health`, so browsers and bridges
back off cleanly). Install the limits file as `/etc/nginx/conf.d/meshrooms-limits.conf` **before** the site file and
`/etc/nginx/snippets/meshrooms-browser.conf`: the site and snippet reference its zones, redacted log format
(`meshrooms_redacted`), and fallback error-page CSP map (`$meshrooms_fallback_csp`), and `nginx -t` fails if any of them
are missing. Then `nginx -t` and reload. A deploy prints a warning when the live file differs from the release's, as it
does for the site, snippet and installed systemd units; it never changes them. The numbers are starting values that have
not been load-tested: raise the shared ceiling only with measurements of what the host serves at its CPU quota.

**The room service**, behind it:
- 1,200 lobby requests a minute per IPv4 address or IPv6 /64 behind the trusted loopback proxy (240 direct), and five
  times that (6,000 a minute behind the proxy) for the /48 around a /64. One /48 holds 65,536 separate /64s, so without
  the wider count a client with a routed /48 has that many quotas; requests already refused by their own /64 do not
  charge the /48, so one noisy /64 cannot spend its neighbours' quota. Each rate table tracks up to 32,768 active keys
  so one /48 spending its full budget across distinct /64s cannot evict unrelated addresses' counters.
- The agent pages (`/agent/<room>`) count against the same quota, since they read the room from the database.
- 6 new rooms an hour per address or /64, and four times that per /48. A create counts once its device is
  authenticated, whatever the outcome; an unsigned or malformed one counts against the request quota only, so
  people behind one address can't be locked out of creating rooms by requests that cost nothing to make. The slot is
  taken right before the create runs, so creates (or invite-code guesses) sent at the same time can't get past it.
- Queued connection offers are bounded per recipient device (32, of at most 16,000 characters each), per sender within
  each recipient's queue (8, with newer `offer`/`answer` signals superseding unpolled ones from the same sender), and
  across all rooms at 32 million characters in memory. Expired offers (after 30 seconds) are pruned proactively before
  enforcing limits, and acknowledged signals are drained as soon as the recipient's cursor advances.

## Logging, redaction, and security headers

Room URLs contain UUIDs that resolve to room titles and entry pages, so production logs must not accumulate raw room
identifiers or payloads:

- **Redacted Nginx access logs:** `deploy/nginx/meshrooms-limits.conf` defines the `meshrooms_redacted` log format, and
  both the HTTP and HTTPS servers in `deploy/nginx/meshrooms.conf` write to `/var/log/nginx/meshrooms-access.log` using
  it. Before logging, Nginx strips query strings (such as avatar `?h=<hash>` or accidental parameters) and replaces
  every room or member UUID in both the request URI (`/r/<id>`, `/agent/<id>`, `/agent/<id>.md`,
  `/api/lobby/rooms/<id>`, `/api/lobby/rooms/<id>/avatars/<id>`, and any fallback UUID segment) and the `Referer` header
  with `<id>`. Route prefixes and status codes stay intact for operations without recording room links.
- **Coordinator logs:** `meshrooms-browser` writes structured JSON lines to `journald` with lobby command action,
  status, and latency, plus redacted `:id` route shapes on 5xx errors. It never logs room UUIDs, chat payloads, WebRTC
  SDP, device keys, or invite codes.
- **Log retention and access control:** Keep Nginx access and error logs restricted (`0640 www-data adm`) with short
  rotation (7–14 days daily, compressed) in `/etc/logrotate.d/nginx`, which covers `/var/log/nginx/*.log` including
  `meshrooms-access.log` and `error.log`. Nginx's internal error log (for example `limit_req` rejections or upstream
  5xx errors) cannot apply custom `map` variables and may include raw request lines, so short retention and restricted
  permissions apply to all Nginx logs. Bound `systemd-journald` retention similarly (for example `MaxRetentionSec=14day`).
  Verify with `logrotate -d /etc/logrotate.d/nginx`.
- **Transport and error-page headers:** `deploy/nginx/meshrooms.conf` and `deploy/nginx/meshrooms-browser.conf` send
  `Strict-Transport-Security: max-age=15552000` (180 days, without `includeSubDomains` or `preload` so sibling
  subdomains under `wormdb.dev` are unaffected). Every `add_header` directive uses `always` across static routes,
  proxied routes, and Nginx-generated error responses (404, 413, 429, 5xx). `meshrooms-browser.conf` uses
  `proxy_hide_header` on fixed headers already emitted by the coordinator (`X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`, `X-Frame-Options`) so Nginx emits them once on upstream responses and still sets them on
  Nginx-generated errors, alongside a fallback `Content-Security-Policy` emitted only when upstream did not supply one.
- **Favicon handling:** `location = /favicon.ico` returns `204` with `access_log off` and `log_not_found off` while
  inheriting all server-level security headers, avoiding noisy 404 entries (pages declare `/assets/mark.svg`).
- **MeshGuard web gateway:** `location = /meshguard-web/ws` (WebSocket upgrade, 90-second read/send timeouts) and
  `location = /meshguard-web/health` proxy to MeshGuard's authenticated browser transport gateway on loopback
  (`127.0.0.1:4321`), under the same server-level limits and headers. Drop both blocks on a host that does not run it.

## State and recovery

The coordinator reconstructs admission after restart. Browsers renegotiate connections against its
new epoch and retain their own message history/outbox.

### Backups

`meshrooms-backup.timer` backs up admission daily (03:15 UTC, up to 15 minutes later) into the
root-only /var/backups/meshrooms-browser as `admission-<UTC time>.sqlite`, mode 0600. Copying a live
database file without its WAL is not a reliable backup, so `deploy/backup/backup-admission.ts` uses
SQLite's `VACUUM INTO` through bun:sqlite: one read transaction produces a consistent, standalone
copy that includes committed pages still in the WAL, without blocking the coordinator's writers and
without needing the sqlite3 package on the host. The copy is written under a temporary name, must
pass `PRAGMA integrity_check` and contain the admission tables, and is flushed before it is renamed
into place. Rotation keeps 14 days and never fewer than the newest three. The unit runs as root;
if opening the database creates -wal/-shm files, they get the database owner (SQLite does this for
root, and the script checks). Backups stay on this host for the beta.

Each verified backup also records its time in /var/lib/meshrooms-browser/last-backup.json: a small
file next to the database, owned by meshrooms with mode 0600 and replaced atomically. That folder is
the one place both the root backup job and the sandboxed coordinator can reach; the backups
themselves stay root-only, and the job never writes into the database. With
`MESHROOMS_BACKUP_MAX_AGE_HOURS=26` in browser.env, /api/lobby/health adds `"backupFresh": true` or
`false` (the file is read at most once a minute; a stale backup never makes health fail). Without the
variable the field is absent. The off-site probe alerts when it is `false`, so the Telegram token
stays on the probe host only. A failed `VACUUM INTO` (for example a full disk) removes its partial
copy, and partial copies older than an hour are swept before each run.

Install or update the units (the script itself ships in every release under deploy/backup):

```sh
install -m 0644 /opt/meshrooms/current/deploy/systemd/meshrooms-backup.{service,timer} /etc/systemd/system/
install -d -m 0700 -o root -g root /var/backups/meshrooms-browser
systemctl daemon-reload
systemctl enable --now meshrooms-backup.timer
systemctl start meshrooms-backup.service            # first backup now
journalctl -u meshrooms-backup -n 5 --no-pager      # "backup complete" with row counts
ls -l /var/backups/meshrooms-browser
# Then report freshness on health (restart picks up the env file):
grep -q '^MESHROOMS_BACKUP_MAX_AGE_HOURS=' /etc/meshrooms/browser.env || echo 'MESHROOMS_BACKUP_MAX_AGE_HOURS=26' >> /etc/meshrooms/browser.env
systemctl restart meshrooms-browser
curl -s -H 'Host: meshrooms.wormdb.dev' http://127.0.0.1:4320/api/lobby/health   # ..."backupFresh":true
```

Every deploy also takes a verified backup before it swaps releases.

### Restore drill

Run this after installing the timer and then monthly. It proves a backup restores into a working
coordinator without touching the live one:

```sh
backup=$(ls -1 /var/backups/meshrooms-browser/admission-*.sqlite | tail -n 1)
/opt/meshrooms/bin/bun /opt/meshrooms/current/deploy/backup/backup-admission.ts verify "$backup"
drill=$(mktemp -d /var/tmp/meshrooms-drill.XXXXXX)
install -m 0600 -o meshrooms -g meshrooms "$backup" "$drill/admission.sqlite"
chown meshrooms:meshrooms "$drill"
systemd-run --unit=meshrooms-restore-drill --collect -p User=meshrooms -p Group=meshrooms \
  -p WorkingDirectory=/opt/meshrooms/current -p EnvironmentFile=/etc/meshrooms/browser.env \
  -p EnvironmentFile=/opt/meshrooms/current/release.env \
  /usr/bin/env MESHROOMS_BROWSER_PORT=4328 MESHROOMS_BROWSER_DATA="$drill" \
  MESHROOMS_BROWSER_ORIGIN=https://meshrooms.wormdb.dev /opt/meshrooms/bin/bun run server/browser/main.ts
sleep 2
curl -s -H 'Host: meshrooms.wormdb.dev' http://127.0.0.1:4328/api/lobby/health     # {"ok":true,...}
# Pick a room id you know exists and confirm the restored copy has it:
curl -s -H 'Host: meshrooms.wormdb.dev' http://127.0.0.1:4328/api/lobby/rooms/<room-id>
systemctl stop meshrooms-restore-drill
rm -rf "$drill"
```

The port and data directory are forced on the command line because systemd lets EnvironmentFile=
values override Environment=; the drill must never open /var/lib/meshrooms-browser.

To restore for real: stop meshrooms-browser, move admission.sqlite and any -wal/-shm files in
/var/lib/meshrooms-browser aside (do not delete them), install the chosen backup there as
admission.sqlite with mode 0600 owned by meshrooms, start the service and check health. Rooms
created after that backup are lost; their members must create them again.

New tables (room activity, closed rooms, creation invites) are created at startup
if missing; existing rooms are kept and get a full idle period from the first start
of this version.

## Operator commands

Run them on the host as the service account, from the active release, against the
service's data directory. They open the same SQLite file as the running coordinator
and are safe while it runs: SQLite serialises the writes, and the coordinator reads
rooms and invites from the database on every request. Don't run them as root, which
could leave root-owned WAL files the service can't open.

```sh
cd /opt/meshrooms/current
run() { sudo -u meshrooms env MESHROOMS_BROWSER_DATA=/var/lib/meshrooms-browser /opt/meshrooms/bin/bun run "$@"; }

run server/browser/invites.ts mint --uses 5 --days 14 --note "Beta cohort A"   # prints the code once
run server/browser/invites.ts list                                           # id, state, uses, expiry, note (never the code)
run server/browser/invites.ts revoke <id>
run server/browser/invites.ts people                                         # admitted person id, linked device count, earliest admission
run server/browser/invites.ts revoke-person <person>                         # remove room-creation access for all of a person's devices

run server/browser/rooms.ts list                  # id, title, members, devices, last active, expiry
run server/browser/rooms.ts retire <room uuid>    # its link then says it was removed by the operator
```

Hosts delete their own rooms from Room details, and idle rooms are removed after
MESHROOMS_ROOM_IDLE_DAYS, so retiring by hand is for abuse or a host who can't.
Confirm the exact UUID with `rooms list` and back up admission first. Never retire
rooms by title or age in bulk, and don't remove other rooms to make a test pass.
The service caps rooms at MESHROOMS_MAX_ROOMS (256), hosted rooms per admitted person
(across all linked devices, or per device when invites are off) at eight, and linked
beta-admitted devices per person at eight. Production smoke tests with a fresh identity
need an invite code (MESHROOMS_TEST_INVITE); mint a one-use code for the run.

Local and HTTPS origins have separate browser identity/history. Moving a local
room's URL to the public domain does not migrate it. Create a hosted room and use
the companion-device flow there; do not upload local keys or browser storage.

## Monitoring

An off-site probe on a separate host checks health, /rooms, /, both certificates, the TURN
relay and (through health's `backupFresh`) the admission backups every 2 minutes, and alerts through
Telegram. See [deploy/probe/README.md](../deploy/probe/README.md).

References: [Bun installation](https://bun.sh/docs/installation),
[Coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).


## Private administration on the Tailnet

`server/browser/admin-main.ts` is a separate service, bound only to `127.0.0.1:4330`.
It is never mounted by the public coordinator and must never be added to the public
Nginx configuration. Publish it with **Tailscale Serve**, not Funnel. Serve provides
Tailnet-only HTTPS; the panel also requires a separate random admin credential.
Tagged devices can use that credential without relying on user identity headers.
Local services on the host are trusted; do not expose the loopback backend through
another proxy. Tailscale ACLs should restrict the chosen HTTPS port to operators.

Install `deploy/systemd/meshrooms-admin.service` as root after the release is on
`/opt/meshrooms/current`. Make `/etc/meshrooms/admin.env` root:meshrooms mode 0640,
with `MESHROOMS_BROWSER_DATA=/var/lib/meshrooms-browser`,
`MESHROOMS_ADMIN_ORIGIN=https://<host>.<tailnet>.ts.net:8443`,
`MESHROOMS_ADMIN_PORT=4330` and `MESHROOMS_ADMIN_PASSWORD_HASH=<sha256>`.
Generate a fresh 32-byte random credential (`openssl rand -hex 32`) and store it in
an operator password manager; hash its exact bytes with SHA-256 (no trailing newline).
Only its hash belongs in the environment file. Do not log or commit the credential.

After `systemctl daemon-reload` and `systemctl enable --now meshrooms-admin`, run
`tailscale serve --bg --https=8443 http://127.0.0.1:4330` on the host. Inspect existing
Serve configuration first so another service is not replaced. Verify `tailscale
serve status --json` has no Funnel exposure, `ss -ltnp` shows the backend only on
loopback, unauthenticated `/api/state` answers 401, and the public site does not
expose the panel or its API. Test sign-in, mint, copy and revoke from an authorized
Tailnet device. A credential rotation requires restarting the admin service; its
in-memory sessions then expire. Deploys automatically restart `meshrooms-admin` when
it is active (and rollback restarts it too), and its static UI assets are preloaded
into memory at startup.

The panel shows invitation usage, admitted people (with per-person revocation across
all linked devices), and room metadata. Codes appear only in the successful mint
response; subsequent listings cannot recover them. Mint and revoke actions are logged
by invitation or person ID, without codes or passwords. Revoking an invite prevents
future redemptions; revoking a person removes beta room-creation access for all of
their linked devices while leaving existing rooms until closed or retired. Sign-in is
rate-limited, sessions last eight hours, and mutations require an exact Origin plus a
constant-time checked per-session CSRF token. Cookies are Secure, HttpOnly and
SameSite=Strict, and responses carry `Strict-Transport-Security`.

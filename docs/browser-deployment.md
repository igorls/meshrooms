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
UDP/TCP, 5349 TCP, and 49160–49259 UDP for this service. Existing HTTPS and native
MeshGuard services remain separate. The scoped Certbot hook copies renewed TLS
files into /etc/meshrooms/turn and restarts this relay only.

## Release

Deploy merged `main` with the script, from a maintainer machine with git, the pinned Bun, ssh,
scp and curl:

```sh
scripts/deploy-browser.sh --dry-run <sha>   # checks and the full plan; no build, no SSH
MESHROOMS_DEPLOY_HOST=root@<deploy-host> scripts/deploy-browser.sh <sha>
```

`MESHROOMS_DEPLOY_HOST`, `MESHROOMS_PUBLIC_ORIGIN`, `MESHROOMS_CANDIDATE_PORT` (default 4329) and
`MESHROOMS_KEEP_RELEASES` (default 10) override the defaults. `--package-only` builds the tarball
without touching any host; CI runs it on every push. The script refuses modified tracked files
(untracked files are ignored, since it builds from a clean `git archive` export) and any revision
that is not on `origin/main`.

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
   name), and prints differences between the live Nginx site, Nginx snippet or systemd unit and the
   release's deploy/ copies as warnings; the script never installs them.
6. Atomically point both symlinks at the new release (each checked with readlink), restart
   meshrooms-browser and require local health to report the new revision. Nginx is not reloaded: its
   configuration did not change, and the site root follows the symlink.
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

run server/browser/rooms.ts list                  # id, title, members, devices, last active, expiry
run server/browser/rooms.ts retire <room uuid>    # its link then says it was removed by the operator
```

Hosts delete their own rooms from Room details, and idle rooms are removed after
MESHROOMS_ROOM_IDLE_DAYS, so retiring by hand is for abuse or a host who can't.
Confirm the exact UUID with `rooms list` and back up admission first. Never retire
rooms by title or age in bulk, and don't remove other rooms to make a test pass.
The service caps rooms at MESHROOMS_MAX_ROOMS (256) and hosted rooms per device at
eight. Production smoke tests need an invite code (MESHROOMS_TEST_INVITE); mint a
one-use code for the run.

Local and HTTPS origins have separate browser identity/history. Moving a local
room's URL to the public domain does not migrate it. Create a hosted room and use
the companion-device flow there; do not upload local keys or browser storage.

## Monitoring

An off-site probe on a separate host checks health, /rooms, /, both certificates, the TURN
relay and (through health's `backupFresh`) the admission backups every 2 minutes, and alerts through
Telegram. See [deploy/probe/README.md](../deploy/probe/README.md).

References: [Bun installation](https://bun.sh/docs/installation),
[Coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

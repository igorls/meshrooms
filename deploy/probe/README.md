# Meshrooms uptime probe

An off-site probe for <https://meshrooms.wormdb.dev>. It runs every 2 minutes on
a separate off-site Linux host with systemd and Bun (`<probe-host>` below; reach it over your own SSH)
and alerts through a Telegram bot.

## What it checks

| Check | Passes when |
| --- | --- |
| `health` | `GET /api/lobby/health` returns 200 with `"ok":true` within 10 s |
| `rooms`, `site` | `GET /rooms` and `GET /` return 200 |
| `https-certificate` | the TLS handshake on 443 validates and the certificate has more than 14 days left |
| `turn-udp`, `turn-tcp` | a STUN Binding request to port 3478 gets a Binding success, over UDP and over TCP |
| `turn-tls` | a validated TLS handshake on 5349 succeeds and that certificate has more than 14 days left |
| `backup` | health's `backupFresh` is `true`; only checked when health carries the field |

The TURN checks use no credentials: a Binding request needs none, and it proves coturn is up and
reachable on each transport. The 5349 certificate is checked separately because it is a copy made
by the renewal hook (`deploy/nginx/renew-meshrooms-turn.sh`); a broken hook lets 443 renew while 5349
expires.

The `backup` check needs no access to the production host. The daily backup job there records its
last verified backup, and with `MESHROOMS_BACKUP_MAX_AGE_HOURS=26` in `/etc/meshrooms/browser.env`
the health endpoint reports `"backupFresh": false` once that is more than 26 hours old (see
docs/browser-deployment.md, Backups). Without that variable the field is absent and the check is
skipped. While health itself is down, an open backup alert stays open rather than looking recovered.

Before alerting on failures, the probe checks its own name resolution (`api.telegram.org`, then
`one.one.one.one`). If neither resolves, the probe host's network is the problem: the run is logged
with `"control":"failed"` and no state changes or messages follow.

## When it messages

- A check that fails twice in a row (about 4 minutes; `MESHROOMS_PROBE_CONFIRM` changes the count)
  starts an alert. Any change in the set of failing checks sends a new message, including recovery.
- While anything fails, a reminder goes out every 3 hours.
- When the revision reported by the health endpoint changes, an informational message names it.

State lives in `/var/lib/meshrooms-probe/state.json`. Each run logs one JSON line to the journal
(`journalctl -u meshrooms-probe`). A failing check does not fail the unit; the unit fails only when
a Telegram message could not be delivered, and the next run retries it.

## Install

1. Create the bot with @BotFather and get the chat id (send the bot a message, then read
   `https://api.telegram.org/bot<token>/getUpdates` from your own machine). Keep both out of the repo.
2. From a checkout of this repository, copy this folder to the probe host:

   ```sh
   tar -C deploy/probe -czf - . | ssh root@<probe-host> \
     'rm -rf /root/meshrooms-probe-src && mkdir -p /root/meshrooms-probe-src && tar -xzf - -C /root/meshrooms-probe-src'
   ```

3. On the probe host (`ssh root@<probe-host>`), run the installer once. The first
   run creates an empty `/etc/meshrooms-probe/telegram.env` (mode 0600, root) and stops:

   ```sh
   bash /root/meshrooms-probe-src/install.sh
   ```

4. Fill in the env file, without echoing the token into your shell history:

   ```sh
   nano /etc/meshrooms-probe/telegram.env
   # TELEGRAM_BOT_TOKEN=123456:ABC...
   # TELEGRAM_CHAT_ID=-100...
   ```

5. Re-run the installer with a test alert. It validates the file, runs every check once without
   sending anything, sends one test message through the unit's environment, and enables the timer:

   ```sh
   bash /root/meshrooms-probe-src/install.sh --test-alert
   ```

6. Confirm:

   ```sh
   systemctl list-timers meshrooms-probe.timer
   journalctl -u meshrooms-probe -n 5 --no-pager
   cat /var/lib/meshrooms-probe/state.json
   ```

To update, repeat steps 2 and 5 (without `--test-alert` if you like). State and the env file are kept.

## Run by hand

```sh
# Every check, no messages, throwaway state:
bun /opt/meshrooms-probe/meshrooms-probe.ts --no-send --state-dir "$(mktemp -d)"
# A test message through the real environment:
systemd-run --wait --pipe --collect -p EnvironmentFile=/etc/meshrooms-probe/telegram.env -p DynamicUser=yes \
  /usr/local/bin/bun /opt/meshrooms-probe/meshrooms-probe.ts --test-alert
```

The token is passed to `curl` on standard input (`curl -K -`), never on the command line, so it
does not show up in `ps` or the journal. Never run the probe with the token in `argv` or with
`set -x` around the env file.

## Remove

```sh
systemctl disable --now meshrooms-probe.timer
rm -f /etc/systemd/system/meshrooms-probe.{service,timer} && systemctl daemon-reload
rm -rf /opt/meshrooms-probe /var/lib/private/meshrooms-probe /etc/meshrooms-probe
```

#!/usr/bin/env bash
# Install or update the Meshrooms uptime probe on the probe host. Run as root from a copy of
# deploy/probe/ (see README.md):
#
#   bash install.sh                 install files, check the env file, enable the 2-minute timer
#   bash install.sh --test-alert    also send one Telegram test message through the real unit env
#
# Idempotent: re-running updates the script and units and keeps the state and the env file.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
BUN=/usr/local/bin/bun
ENV_DIR=/etc/meshrooms-probe
ENV_FILE=$ENV_DIR/telegram.env
test_alert=0
[[ ${1:-} == --test-alert ]] && test_alert=1

log() { printf '[probe-install] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[[ $(id -u) -eq 0 ]] || die "run as root"
[[ -x $BUN ]] || die "$BUN not found; install the pinned Bun there first"
command -v curl >/dev/null || die "curl is required"
for f in meshrooms-probe.ts meshrooms-probe.service meshrooms-probe.timer README.md; do
  [[ -f $here/$f ]] || die "missing $here/$f"
done

install -d -m 0755 /opt/meshrooms-probe
install -m 0644 "$here/meshrooms-probe.ts" "$here/README.md" /opt/meshrooms-probe/
install -m 0644 "$here/meshrooms-probe.service" "$here/meshrooms-probe.timer" /etc/systemd/system/
log "installed /opt/meshrooms-probe and the systemd units"

install -d -m 0700 -o root -g root "$ENV_DIR"
if [[ ! -f $ENV_FILE ]]; then
  (umask 077; printf 'TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\n' > "$ENV_FILE")
  die "created an empty $ENV_FILE (mode 0600); fill in the bot token and chat id, then re-run"
fi
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"
grep -Eq '^TELEGRAM_BOT_TOKEN=[0-9]+:[A-Za-z0-9_-]+$' "$ENV_FILE" || die "$ENV_FILE has no valid TELEGRAM_BOT_TOKEN= line"
grep -Eq '^TELEGRAM_CHAT_ID=-?[0-9]+$' "$ENV_FILE" || die "$ENV_FILE has no valid TELEGRAM_CHAT_ID= line"
log "$ENV_FILE is root-only and has both values (not printed)"

# A read-only rehearsal: runs every check, sends nothing, keeps no state.
scratch=$(mktemp -d)
"$BUN" /opt/meshrooms-probe/meshrooms-probe.ts --no-send --state-dir "$scratch" >&2 || log "rehearsal reported a problem (see above)"
rm -rf "$scratch"

systemctl daemon-reload
if ((test_alert)); then
  systemd-run --quiet --wait --pipe --collect -p EnvironmentFile="$ENV_FILE" -p DynamicUser=yes \
    "$BUN" /opt/meshrooms-probe/meshrooms-probe.ts --test-alert || die "the Telegram test alert failed"
  log "test alert sent; check the Telegram chat"
fi
systemctl enable --now meshrooms-probe.timer
systemctl start meshrooms-probe.service
systemctl --no-pager --lines=5 status meshrooms-probe.service || true
systemctl --no-pager list-timers meshrooms-probe.timer
log "done"

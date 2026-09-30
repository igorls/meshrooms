#!/usr/bin/env bash
# Host side of scripts/deploy-browser.sh. The client copies it next to the tarball as
# /opt/meshrooms/incoming/deploy-browser-remote-<sha>.sh and runs it as root:
#
#   prepare  <sha> <tar-sha256>  take the deploy lease, verify and unpack the release, nginx -t, candidate
#   activate <sha>               verified backup, rollback record, symlink swap, restart, local checks
#   rollback <sha>               restore the targets recorded before <sha> was activated
#   prune    <sha>               after a verified deploy: keep the newest releases, never live or rollback targets
#   finish   <sha>               release the deploy lease
#
# activate and rollback change what is live, so they re-run themselves as a transient systemd unit
# that writes to a log under /var/log/meshrooms-deploy while this session follows the log. A dropped
# SSH session or a Ctrl-C on the client cannot stop them halfway.
#
# Settings come from the caller's environment: MESHROOMS_PUBLIC_ORIGIN, MESHROOMS_CANDIDATE_PORT,
# MESHROOMS_ALLOW_NO_ROLLBACK and MESHROOMS_KEEP_RELEASES. The admission database is only ever read,
# by the pre-swap backup.
set -Eeuo pipefail
umask 022

ROOT=/opt/meshrooms
RELEASES=$ROOT/releases
INCOMING=$ROOT/incoming
APP_LINK=$ROOT/current
BUN=$ROOT/bin/bun
SITE_LINK=/var/www/meshrooms/current
SITE_RELEASES=/var/www/meshrooms/releases
ENV_FILE=/etc/meshrooms/browser.env
DATA_DB=/var/lib/meshrooms-browser/admission.sqlite
BACKUPS=/var/backups/meshrooms-browser
SERVICE=meshrooms-browser
LIVE_PORT=4320
NGINX_SITE=/etc/nginx/sites-available/meshrooms
NGINX_SNIPPET=/etc/nginx/snippets/meshrooms-browser.conf
UNIT_FILE=/etc/systemd/system/meshrooms-browser.service
STATE_DIR=/var/lib/meshrooms-deploy
LEASE=$STATE_DIR/lease
LEASE_MAX_AGE=7200
LOG_DIR=/var/log/meshrooms-deploy
MARKER=.meshrooms-release
ORIGIN=${MESHROOMS_PUBLIC_ORIGIN:-https://meshrooms.wormdb.dev}
HOST_HEADER=${ORIGIN#https://}
CANDIDATE_PORT=${MESHROOMS_CANDIDATE_PORT:-4329}
KEEP_RELEASES=${MESHROOMS_KEEP_RELEASES:-10}
SELF=$(readlink -f "${BASH_SOURCE[0]:-}" 2>/dev/null || true)

log() { printf '[host %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2 || true; }
die() { log "ERROR: $*"; exit 1; }

[[ $(id -u) -eq 0 ]] || die "run as root"
[[ $ORIGIN =~ ^https://[a-z0-9.-]+$ ]] || die "unexpected origin $ORIGIN"
[[ $CANDIDATE_PORT =~ ^[0-9]+$ && $CANDIDATE_PORT -ne $LIVE_PORT ]] || die "bad candidate port $CANDIDATE_PORT"
[[ $KEEP_RELEASES =~ ^[0-9]+$ && $KEEP_RELEASES -ge 2 ]] || die "MESHROOMS_KEEP_RELEASES must be at least 2"
[[ -n $SELF && -f $SELF ]] || die "run this script from a file (it re-executes itself), not from standard input"

command=${1:-}
sha=${2:-}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || die "expected a full 40-character commit sha, got '$sha'"
release=$RELEASES/$sha
site_release=$SITE_RELEASES/$sha
tarball=$INCOMING/meshrooms-browser-$sha.tar.gz

# Steps never overlap on this host; the lease (below) keeps one deploy's steps together.
lock() {
  exec 9>/run/lock/meshrooms-deploy.lock
  flock -w 60 9 || die "another deploy step has held /run/lock/meshrooms-deploy.lock for a minute"
}

# The lease names the revision being deployed, from prepare until finish, so a second deploy
# (from any machine) cannot interleave with this one or roll it back. A lease older than two hours
# is from a client that died; it is taken over with a warning.
take_lease() {
  mkdir -p "$STATE_DIR"; chmod 0700 "$STATE_DIR"
  if [[ -f $LEASE ]]; then
    local holder since age
    holder=$(sed -n 's/^sha=//p' "$LEASE"); since=$(sed -n 's/^since=//p' "$LEASE")
    age=$(( $(date +%s) - ${since:-0} ))
    if [[ $holder != "$sha" ]]; then
      ((age > LEASE_MAX_AGE)) || die "a deploy of $holder holds the lease (${age}s old); wait for it, or run 'finish $holder' if it was abandoned"
      log "WARNING: taking over a stale lease from $holder (${age}s old)"
    fi
  fi
  printf 'sha=%s\nsince=%s\n' "$sha" "$(date +%s)" > "$LEASE.new" && mv -f "$LEASE.new" "$LEASE"
}
require_lease() {
  [[ -f $LEASE && $(sed -n 's/^sha=//p' "$LEASE") == "$sha" ]] || die "no deploy lease for $sha; run prepare first (or take it with 'lease $sha')"
}

# GET a coordinator path on loopback with the public Host header (the coordinator rejects any other host).
# Prints "<status> <body>".
local_get() {
  local port=$1 path=$2 host=${3:-$HOST_HEADER} body status
  body=$(mktemp)
  status=$(curl -sS -m 5 -o "$body" -w '%{http_code}' -H "Host: $host" "http://127.0.0.1:$port$path" 2>/dev/null) || status=000
  printf '%s %s' "$status" "$(head -c 400 "$body")"
  rm -f "$body"
}

# Wait until the coordinator on <port> is healthy and reports <revision>.
wait_health() {
  local port=$1 revision=$2 tries=${3:-40} reply
  for ((i = 0; i < tries; i++)); do
    reply=$(local_get "$port" /api/lobby/health)
    if [[ $reply == "200 "* && $reply == *'"ok":true'* && $reply == *"\"revision\":\"$revision\""* ]]; then
      log "health on :$port ok, revision $revision"
      return 0
    fi
    sleep 0.5
  done
  log "health on :$port never reported ok with revision $revision; last reply: $reply"
  return 1
}

expect_status() {
  local port=$1 path=$2 want=$3 host=${4:-$HOST_HEADER} reply
  reply=$(local_get "$port" "$path" "$host")
  if [[ ${reply%% *} != "$want" ]]; then log "GET $path (Host: $host) on :$port returned ${reply%% *}, expected $want"; return 1; fi
  log "GET $path (Host: $host) on :$port -> $want"
}

live_revision() { sed -n 's/.*"revision":"\([^"]*\)".*/\1/p' <<<"$(local_get "$LIVE_PORT" /api/lobby/health)"; }

unpack_release() {
  local want=$1
  if [[ -d $release ]]; then
    if [[ -f $release/$MARKER ]] && grep -qx "tarball_sha256=$want" "$release/$MARKER"; then
      log "release $release already unpacked from this tarball; reusing it"
      return 0
    fi
    if [[ $(readlink "$APP_LINK" || true) == "$release" && -f $release/$MARKER ]]; then
      # Same revision, already live and verified when it was deployed: keep it rather than refuse a retry.
      log "release $release is live (unpacked from an earlier build of $sha); keeping it"
      return 0
    fi
    log "removing incomplete or different $release"
    rm -rf "$release"
  fi
  local tmp=$release.partial.$$
  rm -rf "$tmp"; mkdir -p "$tmp"
  tar -xzf "$tarball" -C "$tmp" --no-same-owner --no-same-permissions
  (cd "$tmp" && sha256sum --quiet -c SHA256SUMS) || die "file hashes inside the release do not match SHA256SUMS"
  grep -qx "MESHROOMS_REVISION=$sha" "$tmp/release.env" || die "release.env does not carry MESHROOMS_REVISION=$sha"
  local f
  for f in server/browser/main.ts dist/index.html dist/agent/meshrooms-agent.js dist/agent/meshrooms-agent.js.sha256 website/index.html .bun-version; do
    [[ -f $tmp/$f ]] || die "release is missing $f"
  done
  chown -R root:root "$tmp"
  chmod -R u=rwX,go=rX "$tmp"
  printf 'revision=%s\ntarball_sha256=%s\nunpacked_at=%s\n' "$sha" "$want" "$(date -u +%FT%TZ)" > "$tmp/$MARKER"
  mv -T "$tmp" "$release"
  log "unpacked $release"
}

copy_site() {
  [[ -d $site_release ]] && { log "site release $site_release exists; reusing it"; return 0; }
  mkdir -p "$SITE_RELEASES"
  local tmp=$site_release.partial.$$
  rm -rf "$tmp"
  cp -R "$release/website" "$tmp"
  find "$tmp" -type d -exec chmod 0755 {} +
  find "$tmp" -type f -exec chmod 0644 {} +
  mv -T "$tmp" "$site_release"
  log "copied static site to $site_release"
}

candidate_unit=meshrooms-candidate-${sha:0:12}
stop_candidate() {
  systemctl stop "$candidate_unit" 2>/dev/null || true
  systemctl reset-failed "$candidate_unit" 2>/dev/null || true
}

run_candidate() {
  stop_candidate
  if ss -Hltn "sport = :$CANDIDATE_PORT" | grep -q .; then die "candidate port $CANDIDATE_PORT is already in use"; fi
  trap stop_candidate EXIT
  log "starting candidate $candidate_unit on 127.0.0.1:$CANDIDATE_PORT with a throwaway data directory"
  # EnvironmentFile= values override Environment=, so the port, data directory and origin are
  # forced on the command line: the candidate can never open the production admission database.
  systemd-run --quiet --collect --unit="$candidate_unit" \
    -p User=meshrooms -p Group=meshrooms -p WorkingDirectory="$release" \
    -p EnvironmentFile="$ENV_FILE" -p EnvironmentFile="$release/release.env" \
    -p RuntimeDirectory="$candidate_unit" -p RuntimeDirectoryMode=0700 -p UMask=0077 \
    -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes -p MemoryMax=256M \
    /usr/bin/env MESHROOMS_BROWSER_PORT="$CANDIDATE_PORT" MESHROOMS_BROWSER_DATA="/run/$candidate_unit/data" \
    MESHROOMS_BROWSER_ORIGIN="$ORIGIN" "$BUN" run server/browser/main.ts
  local ok=1 asset agent_hash
  wait_health "$CANDIDATE_PORT" "$sha" || ok=0
  if ((ok)); then
    expect_status "$CANDIDATE_PORT" /rooms 200 || ok=0
    expect_status "$CANDIDATE_PORT" /r/00000000-0000-4000-8000-000000000000 200 || ok=0
    asset=$(find "$release/dist/assets" -maxdepth 1 -type f -name '*.js' -printf '%f\n' | head -n 1)
    [[ -n $asset ]] && { expect_status "$CANDIDATE_PORT" "/assets/$asset" 200 || ok=0; }
    expect_status "$CANDIDATE_PORT" /agent/meshrooms-agent.js 200 || ok=0
    agent_hash=$(local_get "$CANDIDATE_PORT" /agent/meshrooms-agent.js.sha256)
    [[ $agent_hash == "200 $(sha256sum "$release/dist/agent/meshrooms-agent.js" | cut -d' ' -f1)"* ]] || { log "agent bundle hash served by the candidate does not match the file"; ok=0; }
    expect_status "$CANDIDATE_PORT" /api/lobby/health 403 evil.example || ok=0
  fi
  if ((!ok)); then
    journalctl -u "$candidate_unit" -n 40 --no-pager >&2 || true
    die "candidate for $sha failed its checks"
  fi
  stop_candidate
  trap - EXIT
  log "candidate passed and was stopped"
}

cmd_prepare() {
  local want=${3:-}
  [[ $want =~ ^[0-9a-f]{64}$ ]] || die "expected the tarball sha256"
  lock
  take_lease
  [[ -f $tarball ]] || die "missing $tarball"
  local got
  got=$(sha256sum "$tarball" | cut -d' ' -f1)
  [[ $got == "$want" ]] || die "tarball sha256 mismatch after transfer: expected $want, got $got"
  log "tarball sha256 verified: $got"
  mkdir -p "$RELEASES"
  unpack_release "$want"
  local want_bun have_bun
  want_bun=$(tr -d '[:space:]' < "$release/.bun-version")
  have_bun=$("$BUN" --version)
  [[ $have_bun == "$want_bun" ]] || die "$BUN is $have_bun but the release pins $want_bun; install the pinned Bun first"
  log "bun $have_bun matches the release pin"
  # The swap changes no nginx configuration, so nginx is validated now, before anything is live.
  local nginx_out
  nginx_out=$(nginx -t 2>&1) || { log "$nginx_out"; die "nginx -t fails on this host; fix the configuration before deploying"; }
  log "nginx -t ok"
  copy_site
  if [[ $(readlink "$APP_LINK" || true) == "$release" && $(live_revision) == "$sha" ]]; then
    log "$sha is already live and healthy; skipping the candidate"
  else
    run_candidate
  fi
  df -h "$RELEASES" | tail -n 1 | awk '{print "[host] disk: " $4 " free on " $6}' >&2 || true
}

warn_drift() {
  local live=$1 shipped=$2
  if [[ ! -f $live ]]; then log "WARNING: $live does not exist (compare with $shipped)"; return 0; fi
  if ! diff -q "$live" "$shipped" >/dev/null; then
    log "WARNING: $live differs from the release's $(basename "$shipped"); it was NOT changed:"
    diff -u "$live" "$shipped" >&2 || true
  fi
}

# Atomically point <link> at <target> and prove it.
point() {
  local link=$1 target=$2
  ln -sfn "$target" "$link.new"
  mv -Tf "$link.new" "$link"
  [[ $(readlink "$link") == "$target" ]] || { log "$link does not point at $target after the swap"; return 1; }
}

# Restore the given targets and restart the coordinator. Loud, best effort.
restore() {
  local app=$1 site=$2 revision=${3:-}
  log "ROLLING BACK: app -> ${app:-<none>}, site -> ${site:-<none>}"
  if [[ -n $app ]]; then point "$APP_LINK" "$app" || log "could not restore $APP_LINK"; fi
  if [[ -n $site ]]; then point "$SITE_LINK" "$site" || log "could not restore $SITE_LINK"; fi
  systemctl restart "$SERVICE" || log "restart of $SERVICE failed"
  if [[ -n $revision ]]; then
    wait_health "$LIVE_PORT" "$revision" || { log "ROLLBACK DID NOT RESTORE A HEALTHY $revision; intervene by hand"; return 1; }
  fi
  log "rollback complete"
}

# Re-run this command as a transient unit that outlives this session, and follow its log.
detach() {
  local unit=meshrooms-deploy-$command-${sha:0:12} logfile status=0 tailer
  install -d -m 0700 "$LOG_DIR"
  logfile=$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$command-$sha.log
  install -m 0600 /dev/null "$logfile"
  systemctl reset-failed "$unit" 2>/dev/null || true
  log "running $command as $unit; it continues if this session drops (log: $logfile)"
  tail -n +1 -F "$logfile" >&2 2>/dev/null &
  tailer=$!
  systemd-run --quiet --wait --collect --unit="$unit" -p StandardOutput="append:$logfile" -p StandardError="append:$logfile" \
    --setenv=MESHROOMS_DEPLOY_DETACHED=1 --setenv=MESHROOMS_PUBLIC_ORIGIN="$ORIGIN" \
    --setenv=MESHROOMS_CANDIDATE_PORT="$CANDIDATE_PORT" --setenv=MESHROOMS_KEEP_RELEASES="$KEEP_RELEASES" \
    --setenv=MESHROOMS_ALLOW_NO_ROLLBACK="${MESHROOMS_ALLOW_NO_ROLLBACK:-0}" \
    /bin/bash "$SELF" "$command" "$sha" || status=$?
  sleep 1
  kill "$tailer" 2>/dev/null || true
  return "$status"
}

cmd_activate() {
  lock
  require_lease
  [[ -f $release/$MARKER ]] || die "$release is not a prepared release; run prepare first"
  [[ -d $site_release ]] || die "$site_release is missing; run prepare first"
  local prev_app prev_site prev_revision
  prev_app=$(readlink "$APP_LINK" || true)
  prev_site=$(readlink "$SITE_LINK" || true)
  prev_revision=$(live_revision)
  if [[ $prev_app == "$release" && $prev_site == "$site_release" && $prev_revision == "$sha" ]]; then
    log "$sha is already active and healthy; nothing to do"
    return 0
  fi
  if [[ -z $prev_app || -z $prev_site ]] && [[ ${MESHROOMS_ALLOW_NO_ROLLBACK:-0} != 1 ]]; then
    die "no previous symlink target to roll back to (app='$prev_app', site='$prev_site'); set MESHROOMS_ALLOW_NO_ROLLBACK=1 for a first deploy"
  fi
  # A verified backup before anything changes, so a release that migrates the schema can be rolled back.
  # Releases from before the backup script shipped don't carry it: use the live release's copy then.
  local backup_script=$release/deploy/backup/backup-admission.ts
  if [[ ! -f $backup_script && -n $prev_app && -f $prev_app/deploy/backup/backup-admission.ts ]]; then
    backup_script=$prev_app/deploy/backup/backup-admission.ts
    log "this release has no backup script; using the live release's $backup_script"
  fi
  if [[ -f $DATA_DB && ! -f $backup_script ]]; then
    log "WARNING: neither this release nor the live one has deploy/backup/backup-admission.ts; no pre-deploy backup"
  elif [[ -f $DATA_DB ]]; then
    "$BUN" "$backup_script" backup --db "$DATA_DB" --out "$BACKUPS" --keep-days 14 --keep-min 3 >&2 \
      || die "the pre-deploy backup failed; nothing was changed"
  else
    log "no admission database at $DATA_DB yet; no pre-deploy backup"
  fi
  local record=/root/meshrooms-rollback-before-$sha.txt stamp
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  [[ -e $record ]] && record=/root/meshrooms-rollback-before-$sha.$stamp.txt
  local nginx_backup=/root/meshrooms-nginx-before-$sha.$stamp.conf
  [[ -f $NGINX_SITE ]] && cp -p "$NGINX_SITE" "$nginx_backup"
  {
    echo "# Meshrooms rollback record written by scripts/deploy-browser-remote.sh"
    echo "deployed_revision=$sha"
    echo "recorded_at=$(date -u +%FT%TZ)"
    echo "previous_revision=$prev_revision"
    echo "previous_app_target=$prev_app"
    echo "previous_site_target=$prev_site"
    echo "nginx_config_backup=$([[ -f $nginx_backup ]] && echo "$nginx_backup")"
  } > "$record"
  chmod 0600 "$record"
  log "recorded rollback targets in $record"
  cat "$record" >&2

  warn_drift "$NGINX_SITE" "$release/deploy/nginx/meshrooms.conf"
  warn_drift "$NGINX_SNIPPET" "$release/deploy/nginx/meshrooms-browser.conf"
  warn_drift "$UNIT_FILE" "$release/deploy/systemd/meshrooms-browser.service"

  # From the first change on, any error or stop request restores the previous release.
  trap 'trap - ERR INT TERM; log "activation failed"; restore "$prev_app" "$prev_site" "$prev_revision"; exit 1' ERR
  trap 'trap - ERR INT TERM; log "activation interrupted"; restore "$prev_app" "$prev_site" "$prev_revision"; exit 1' INT TERM
  point "$APP_LINK" "$release"
  mkdir -p "$(dirname "$SITE_LINK")"
  point "$SITE_LINK" "$site_release"
  log "symlinks now: $APP_LINK -> $(readlink "$APP_LINK"), $SITE_LINK -> $(readlink "$SITE_LINK")"
  systemctl restart "$SERVICE"
  wait_health "$LIVE_PORT" "$sha"
  expect_status "$LIVE_PORT" /rooms 200
  trap - ERR INT TERM
  log "activated $sha (previous: ${prev_revision:-unknown})"
}

newest_record() {
  find /root -maxdepth 1 -name "meshrooms-rollback-before-$sha*.txt" -printf '%T@ %p\n' | sort -n | tail -n 1 | cut -d' ' -f2-
}

cmd_rollback() {
  lock
  require_lease
  # Only undo this deploy: if something else is live now, rolling back to our record would be wrong.
  [[ $(readlink "$APP_LINK" || true) == "$release" ]] || die "$APP_LINK does not point at $release; refusing to roll back a release that is not live"
  local record
  record=$(newest_record)
  [[ -n $record ]] || die "no rollback record for $sha under /root"
  log "rolling back with $record"
  local app site revision
  app=$(sed -n 's/^previous_app_target=//p' "$record")
  site=$(sed -n 's/^previous_site_target=//p' "$record")
  revision=$(sed -n 's/^previous_revision=//p' "$record")
  [[ -n $app || -n $site ]] || die "$record has no previous targets"
  trap '' INT TERM
  restore "$app" "$site" "$revision"
}

# Keep the newest KEEP_RELEASES releases (by unpack time), plus the live and recorded rollback targets.
cmd_prune() {
  lock
  require_lease
  [[ $(readlink "$APP_LINK" || true) == "$release" && $(live_revision) == "$sha" ]] || die "$sha is not live and healthy; not pruning"
  local record keep_app=() keep_site=() dir name kept=0 removed=0
  record=$(newest_record)
  keep_app+=("$(readlink -f "$APP_LINK")")
  keep_site+=("$(readlink -f "$SITE_LINK" || true)")
  if [[ -n $record ]]; then
    keep_app+=("$(sed -n 's/^previous_app_target=//p' "$record")")
    keep_site+=("$(sed -n 's/^previous_site_target=//p' "$record")")
  fi
  protected() { local item=$1; shift; local k; for k in "$@"; do [[ -n $k && $(readlink -f "$k" 2>/dev/null || echo "$k") == "$item" ]] && return 0; done; return 1; }
  while IFS= read -r dir; do
    name=$(basename "$dir")
    if ((kept < KEEP_RELEASES)) || protected "$dir" "${keep_app[@]}"; then
      kept=$((kept + 1)); continue
    fi
    log "pruning release $dir"
    rm -rf "$dir"; removed=$((removed + 1))
    if [[ -d $SITE_RELEASES/$name ]]; then
      if protected "$SITE_RELEASES/$name" "${keep_site[@]}"; then log "keeping $SITE_RELEASES/$name (live or rollback site target)"
      else log "pruning site release $SITE_RELEASES/$name"; rm -rf "${SITE_RELEASES:?}/$name"; fi
    fi
    rm -f "$INCOMING/meshrooms-browser-$name.tar.gz" "$INCOMING/deploy-browser-remote-$name.sh"
  done < <(find "$RELEASES" -mindepth 2 -maxdepth 2 -name "$MARKER" -printf '%T@ %h\n' | sort -rn | cut -d' ' -f2- | grep -E '/[0-9a-f]{40}$')
  log "pruning done: kept $kept releases, removed $removed"
}

cmd_finish() {
  lock
  if [[ -f $LEASE && $(sed -n 's/^sha=//p' "$LEASE") == "$sha" ]]; then rm -f "$LEASE"; log "released the deploy lease for $sha"
  else log "no deploy lease for $sha to release"; fi
}

case $command in
  prepare) cmd_prepare "$@" ;;
  activate|rollback)
    if [[ ${MESHROOMS_DEPLOY_DETACHED:-0} == 1 ]]; then
      # Inside the transient unit: output goes to the log file, and losing any reader is harmless.
      trap '' PIPE HUP
      "cmd_$command"
    else
      lock; require_lease; flock -u 9
      detach
    fi ;;
  prune) cmd_prune ;;
  finish) cmd_finish ;;
  lease) lock; take_lease; log "took the deploy lease for $sha" ;;
  *) die "unknown command '$command'" ;;
esac

#!/usr/bin/env bash
# Deploy a merged revision of the hosted browser coordinator and static site.
#
#   scripts/deploy-browser.sh [--dry-run | --package-only] [--out DIR] <sha>
#
# Runs from a maintainer machine with git, bun (the pinned version), ssh, scp and curl.
#   --dry-run       check the revision, list the release contents and print every step; no build,
#                   no SSH. A revision not on origin/main is a warning here instead of an error.
#   --package-only  build and package the release tarball locally (CI uses this); no SSH.
#   --out DIR       where the tarball goes (default: .release/browser in the repository).
#
# Environment:
#   MESHROOMS_DEPLOY_HOST        SSH target, e.g. root@<deploy-host> (required to deploy; kept out of the repo)
#   MESHROOMS_PUBLIC_ORIGIN      public origin (default https://meshrooms.wormdb.dev)
#   MESHROOMS_CANDIDATE_PORT     loopback port for the candidate coordinator (default 4329)
#   MESHROOMS_DEPLOY_REMOTE      git remote holding main (default origin)
#   MESHROOMS_ALLOW_NO_ROLLBACK  set to 1 only for a first deploy with no previous release
#   MESHROOMS_KEEP_RELEASES      releases kept on the host after a successful deploy (default 10)
#
# The working tree must have no modified tracked files (untracked files are ignored: the release
# is built from a clean export of <sha>, never from the working tree). The release contains the
# coordinator's import closure (scripts/release-files.ts), dist/ (build + build:agent), website/,
# deploy/, .bun-version, release.env and SHA256SUMS, packed reproducibly (same sha, same tarball hash)
# with GNU tar. The host side is scripts/deploy-browser-remote.sh, copied next to the tarball. A host
# lease holds the whole deploy (prepare to finish) for this sha; activation runs detached on the host,
# so a dropped SSH session cannot leave it half done. Every step is idempotent: re-running a live sha
# exits 0. The admission database is only read, by the verified backup taken before the swap.
set -Eeuo pipefail

HOST=${MESHROOMS_DEPLOY_HOST:-}
ORIGIN=${MESHROOMS_PUBLIC_ORIGIN:-https://meshrooms.wormdb.dev}
CANDIDATE_PORT=${MESHROOMS_CANDIDATE_PORT:-4329}
REMOTE=${MESHROOMS_DEPLOY_REMOTE:-origin}
BRANCH=main
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15)

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

mode=deploy
out=
sha=
while (($#)); do
  case $1 in
    --dry-run) mode=dry-run ;;
    --package-only) mode=package ;;
    --out) shift; out=${1:?--out needs a directory} ;;
    -h|--help) usage 0 ;;
    -*) log "unknown option $1"; usage 2 ;;
    *) [[ -z $sha ]] || die "only one revision"; sha=$1 ;;
  esac
  shift
done
[[ -n $sha ]] || usage 2
[[ $ORIGIN =~ ^https://[a-z0-9.-]+$ ]] || die "MESHROOMS_PUBLIC_ORIGIN must look like https://host"
[[ $mode != deploy || -n $HOST ]] || die "set MESHROOMS_DEPLOY_HOST to the SSH target, e.g. root@<deploy-host>"
[[ $CANDIDATE_PORT =~ ^[0-9]+$ && $CANDIDATE_PORT != 4320 ]] || die "MESHROOMS_CANDIDATE_PORT must be a port other than 4320"

cd "$(git rev-parse --show-toplevel)"
repo=$(pwd) # a POSIX path even in Git Bash on Windows, where tar reads "C:/..." as a remote host
[[ -f scripts/deploy-browser-remote.sh && -f scripts/release-files.ts ]] || die "run from a checkout that has the deploy scripts"

if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  git status --short --untracked-files=no >&2
  die "the working tree has modified tracked files; commit or discard them first"
fi
full=$(git rev-parse --verify --quiet "$sha^{commit}") || die "unknown revision $sha"

soft() { if [[ $mode == deploy ]]; then die "$*"; else log "WARNING: $*"; fi; }
if git fetch --quiet "$REMOTE" "$BRANCH"; then
  git merge-base --is-ancestor "$full" "$REMOTE/$BRANCH" || soft "$full is not on $REMOTE/$BRANCH; only merged revisions are deployed"
else
  soft "could not fetch $REMOTE/$BRANCH to confirm $full is merged"
fi
log "revision $full ($(git log -1 --format='%s' "$full"))"

hash_file() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/meshrooms-deploy.XXXXXX")
leased=0
lockdir=
cleanup() {
  if ((leased)); then remote finish "$full" || log "could not release the host lease; run: ssh $HOST bash $remote_script finish $full"; fi
  rm -rf "$tmp"
  if [[ -n $lockdir ]]; then rm -rf "$lockdir"; fi
}
trap cleanup EXIT

# Export the exact revision. Force LF so a Windows checkout packages the same bytes as Linux.
src=$tmp/src
mkdir -p "$src"
git -c core.autocrlf=false -c core.eol=lf archive --format=tar "$full" | tar -x -C "$src"
mapfile -t runtime_files < <(bun "$repo/scripts/release-files.ts" "$src" | tr -d '\r')
((${#runtime_files[@]})) || die "could not derive the coordinator's file list"
pin=$(tr -d '[:space:]' < "$src/.bun-version")

if [[ $mode == dry-run ]]; then
  cat <<PLAN
Deploy plan for $full
  host:            ${HOST:-<set MESHROOMS_DEPLOY_HOST>}
  public origin:   $ORIGIN
  pinned bun:      $pin (local: $(bun --version))
  release:         /opt/meshrooms/releases/$full
  site release:    /var/www/meshrooms/releases/$full
  candidate:       127.0.0.1:$CANDIDATE_PORT, data in /run/meshrooms-candidate-${full:0:12}/data
  rollback record: /root/meshrooms-rollback-before-$full.txt

Coordinator files (from scripts/release-files.ts):
$(printf '  %s\n' "${runtime_files[@]}")
Plus: dist/ (bun run build && bun run build:agent), website/, deploy/, .bun-version,
      release.env (MESHROOMS_REVISION=$full), SHA256SUMS.

Steps:
   1. export $full, bun install --frozen-lockfile, bun run build, bun run build:agent
   2. package, sha256 locally, scp to $HOST:/opt/meshrooms/incoming/
   3. host: verify the tarball sha256 and every file in SHA256SUMS, check bun == $pin
   4. host: unpack to /opt/meshrooms/releases/$full, copy website/ to the site release
   5. host: start a candidate on 127.0.0.1:$CANDIDATE_PORT with a throwaway data dir and $ORIGIN;
            require health ok + revision, /rooms, /r/<id>, an asset, the agent bundle and its hash,
            and a 403 for a foreign Host; stop it
      (prepare also takes the host's deploy lease for $full and requires nginx -t to pass)
   6. host, detached: verified admission backup, record rollback targets, warn on nginx/systemd
            drift, swap both symlinks atomically, restart meshrooms-browser, require local health
   7. here: require $ORIGIN/api/lobby/health revision == $full, /rooms, / and the agent hash
   8. any failure after the swap restores the previous symlinks, restarts and exits non-zero
   9. host: keep the newest ${MESHROOMS_KEEP_RELEASES:-10} releases (never the live or rollback target), release the lease
PLAN
  exit 0
fi

local_bun=$(bun --version)
[[ $local_bun == "$pin" ]] || die "local bun is $local_bun but $full pins $pin"

log "building $full in a clean export"
(
  cd "$src"
  bun install --frozen-lockfile
  bun run build
  bun run build:agent
) >&2
[[ -f $src/dist/index.html && -f $src/dist/agent/meshrooms-agent.js ]] || die "build did not produce dist/ and dist/agent/"

stage=$tmp/stage
mkdir -p "$stage"
git -c core.autocrlf=false -c core.eol=lf archive --format=tar "$full" -- "${runtime_files[@]}" website deploy .bun-version | tar -x -C "$stage"
cp -R "$src/dist" "$stage/dist"
printf 'MESHROOMS_REVISION=%s\n' "$full" > "$stage/release.env"
(cd "$stage" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(hash_file "$f")" "$f"; done) > "$tmp/SHA256SUMS"
mv "$tmp/SHA256SUMS" "$stage/SHA256SUMS"
agent_hash=$(hash_file "$stage/dist/agent/meshrooms-agent.js")

out=${out:-$repo/.release/browser}
mkdir -p "$out"
tarball=$out/meshrooms-browser-$full.tar.gz
# Reproducible: sorted names, the commit's time, fixed owner and modes, no gzip timestamp. Rebuilding
# the same sha gives the same hash, so a retry matches the release already on the host.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar -C "$stage" --sort=name --mtime="@$(git log -1 --format=%ct "$full")" --owner=0 --group=0 --numeric-owner \
    --mode='u=rwX,go=rX' -cf - . | gzip -n -9 > "$tarball"
else
  log "WARNING: not GNU tar; the tarball is not reproducible (a retry of a live sha still works)"
  tar -C "$stage" -cf - . | gzip -n -9 > "$tarball"
fi
tar_hash=$(hash_file "$tarball")
log "packaged $tarball ($(wc -c < "$tarball" | tr -d ' ') bytes, $(wc -l < "$stage/SHA256SUMS" | tr -d ' ') files)"
log "sha256 $tar_hash"
log "agent bundle sha256 $agent_hash"
if [[ $mode == package ]]; then
  printf '%s  %s\n' "$tar_hash" "$(basename "$tarball")" > "$tarball.sha256"
  echo "$tarball"
  exit 0
fi

allow_no_rollback=${MESHROOMS_ALLOW_NO_ROLLBACK:-0}
[[ $allow_no_rollback == [01] ]] || die "MESHROOMS_ALLOW_NO_ROLLBACK must be 0 or 1"
keep_releases=${MESHROOMS_KEEP_RELEASES:-10}
[[ $keep_releases =~ ^[0-9]+$ && $keep_releases -ge 2 ]] || die "MESHROOMS_KEEP_RELEASES must be a number of at least 2"

remote_script=/opt/meshrooms/incoming/deploy-browser-remote-$full.sh
remote() {
  # Every value is validated above (hex sha, https origin, numeric port and count, 0 or 1), so
  # expanding them here, on the client side, is intended.
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$HOST" \
    "MESHROOMS_PUBLIC_ORIGIN='$ORIGIN' MESHROOMS_CANDIDATE_PORT='$CANDIDATE_PORT' MESHROOMS_ALLOW_NO_ROLLBACK='$allow_no_rollback' MESHROOMS_KEEP_RELEASES='$keep_releases' bash $remote_script $*"
}

# One deploy at a time from this checkout; the host lease covers other machines.
mkdir -p "$repo/.release"
mkdir "$repo/.release/deploy.lock" 2>/dev/null || die "another deploy from this checkout is running (remove $repo/.release/deploy.lock if it is not)"
lockdir=$repo/.release/deploy.lock

log "uploading to $HOST"
ssh "${SSH_OPTS[@]}" "$HOST" 'install -d -m 0700 /opt/meshrooms/incoming'
scp -q "${SSH_OPTS[@]}" "$tarball" "$HOST:/opt/meshrooms/incoming/"
scp -q "${SSH_OPTS[@]}" "$repo/scripts/deploy-browser-remote.sh" "$HOST:$remote_script"
leased=1
remote prepare "$full" "$tar_hash" || die "prepare failed; nothing live was changed"
remote activate "$full" || die "activation failed on the host (its log is above); if it reached the swap, it restored the previous release"

public_ok() {
  local health status
  for ((i = 0; i < 20; i++)); do
    health=$(curl -sS -m 10 "$ORIGIN/api/lobby/health" 2>/dev/null || true)
    [[ $health == *'"ok":true'* && $health == *"\"revision\":\"$full\""* ]] && break
    sleep 1
  done
  [[ $health == *'"ok":true'* && $health == *"\"revision\":\"$full\""* ]] || { log "public health: ${health:-no reply}"; return 1; }
  log "public health ok, revision $full"
  for path in /rooms /; do
    status=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$ORIGIN$path" 2>/dev/null || echo 000)
    [[ $status == 200 ]] || { log "public GET $path returned $status"; return 1; }
    log "public GET $path -> 200"
  done
  [[ $(curl -sS -m 10 "$ORIGIN/agent/meshrooms-agent.js.sha256" 2>/dev/null) == "$agent_hash"* ]] || { log "public agent bundle hash differs from the build"; return 1; }
  log "public agent bundle hash matches"
}

if ! public_ok; then
  log "public verification failed; rolling back"
  remote rollback "$full" || die "ROLLBACK FAILED; the host needs manual attention"
  die "deploy of $full failed public verification and was rolled back"
fi
remote prune "$full" || log "WARNING: pruning old releases failed; the deploy itself succeeded"
log "deployed $full to $ORIGIN"

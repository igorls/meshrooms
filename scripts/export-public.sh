#!/usr/bin/env bash
# Export a merged revision as a clean, single-commit public snapshot. It never pushes.
#
#   scripts/export-public.sh [--dry-run] [--previous DIR] [--label TEXT] <sha> <out-dir>
#
# Produces, in a new or empty <out-dir>:
#   tree/        the files of <sha> minus every path in internal/export-exclude.txt, as a fresh git
#                repository with one commit and no history and no remote. The commit message is
#                "Meshrooms public snapshot <UTC date of sha>[: <label>]"; it never names a private
#                revision.
#   MANIFEST.md  for the maintainer, never committed: the source revision, files added, removed and
#                changed since the previous snapshot, the privacy gate result, how much was excluded,
#                and the binary files a person must look at
#
#   --dry-run        everything except the git commit: tree/ is left as plain files. A revision not
#                    on origin/main is a warning here instead of an error, and gitleaks is used only
#                    when it is installed. CI runs this.
#   --previous DIR   the previous snapshot (its <out-dir> or its tree/) to compare against
#   --label TEXT     a short note for the commit message (letters, digits, spaces and ._:+-); it
#                    passes the privacy gate too
#
# <sha> must be the checked-out HEAD and the tracked files unmodified: the exclude list, the
# private-terms list and the gate are read from this checkout, so they are exactly <sha>'s own.
# <sha> must also be on origin/main. The exported tree must pass scripts/check-public.ts --tree
# with the private terms (--require-terms), the built-in patterns and gitleaks, and must hold no
# symbolic links; any hit aborts and removes tree/. The commit adds exactly the gated file list.
#
# Pushing the snapshot to the public repository is a separate, manual step for the maintainer.
#
# Environment:
#   MESHROOMS_EXPORT_AUTHOR_NAME   snapshot author (default: the maintainer)
#   MESHROOMS_EXPORT_AUTHOR_EMAIL  snapshot author email (default: the maintainer's GitHub noreply address)
#   MESHROOMS_EXPORT_REMOTE        git remote holding main (default origin)
#   GITLEAKS                       gitleaks binary, if it is not on PATH
set -Eeuo pipefail

AUTHOR_NAME=${MESHROOMS_EXPORT_AUTHOR_NAME:-Igor Lins e Silva}
AUTHOR_EMAIL=${MESHROOMS_EXPORT_AUTHOR_EMAIL:-4753812+igorls@users.noreply.github.com}
REMOTE=${MESHROOMS_EXPORT_REMOTE:-origin}
BRANCH=main

log() { printf '[export] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

dry_run=0
previous=
label=
args=()
while (($#)); do
  case $1 in
    --dry-run) dry_run=1 ;;
    --previous) shift; previous=${1:?--previous needs a directory} ;;
    --label) shift; label=${1:?--label needs text} ;;
    -h|--help) usage 0 ;;
    -*) log "unknown option $1"; usage 2 ;;
    *) args+=("$1") ;;
  esac
  shift
done
((${#args[@]} == 2)) || usage 2
sha=${args[0]}
out=${args[1]}
[[ -z $label || $label =~ ^[A-Za-z0-9][A-Za-z0-9\ ._:+-]{0,59}$ ]] || die "--label must be 1-60 letters, digits, spaces or ._:+-"
# Resolve both directories before changing to the repository root.
mkdir -p "$out"
out=$(cd "$out" && pwd)
if [[ -n $previous ]]; then previous=$(cd "$previous" 2>/dev/null && pwd) || die "--previous $previous is not a directory"; fi

cd "$(git rev-parse --show-toplevel)"
terms=internal/private-terms.txt
excludes=internal/export-exclude.txt
gate=scripts/check-public.ts
[[ -f $terms && -f $excludes && -f $gate ]] || die "run from the private repository: $terms, $excludes and $gate are required"
command -v bun >/dev/null || die "bun is required"

if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  git status --short --untracked-files=no >&2
  die "the working tree has modified tracked files; commit or discard them first"
fi
full=$(git rev-parse --verify --quiet "$sha^{commit}") || die "unknown revision $sha"
[[ $(git rev-parse HEAD) == "$full" ]] || die "check out $full first: the exclude list, private terms and gate are read from the checkout, so HEAD must be the exported revision"

soft() { if ((dry_run)); then log "WARNING: $*"; else die "$*"; fi; }
git fetch --quiet "$REMOTE" "$BRANCH" 2>/dev/null || log "WARNING: could not fetch $REMOTE/$BRANCH; using the local ref"
if git rev-parse --verify --quiet "$REMOTE/$BRANCH^{commit}" >/dev/null; then
  git merge-base --is-ancestor "$full" "$REMOTE/$BRANCH" || soft "$full is not on $REMOTE/$BRANCH; only merged revisions are exported"
else
  soft "there is no $REMOTE/$BRANCH to confirm $full is merged"
fi
log "revision $full ($(git log -1 --format='%s' "$full"))"

[[ -z $(ls -A "$out") ]] || die "$out is not empty; export into a new directory"
work=$(mktemp -d "${TMPDIR:-/tmp}/meshrooms-export.XXXXXX")
trap 'rm -rf "$work"' EXIT
tree=$out/tree
fail() { rm -rf "$tree"; die "$*"; }

# The public commit message names the source commit's UTC date, never the private revision.
day=$(TZ=UTC git log -1 --date=format-local:%Y-%m-%d --format=%cd "$full")
subject="Meshrooms public snapshot $day${label:+: $label}"
if [[ -n $label ]]; then
  mkdir "$work/label" && printf '%s\n' "$label" > "$work/label/label.txt"
  bun "$gate" --tree "$work/label" --terms "$terms" --require-terms --no-gitleaks >&2 || die "--label failed the privacy gate"
fi

# Export the exact revision with LF endings, then drop the excluded paths.
mkdir "$tree"
git -c core.autocrlf=false -c core.eol=lf archive --format=tar "$full" | tar -x -C "$tree"
archived=$(find "$tree" \( -type f -o -type l \) | wc -l | tr -d ' ')
exclude_count=0
exclude_tops=()
while IFS= read -r line || [[ -n $line ]]; do
  path=${line%$'\r'}
  path=${path#"${path%%[![:space:]]*}"}
  path=${path%"${path##*[![:space:]]}"}
  [[ -z $path || $path == \#* ]] && continue
  [[ $path != /* && $path != *..* ]] || fail "unsafe path in $excludes: $path"
  rm -rf "${tree:?}/${path%/}"
  exclude_count=$((exclude_count + 1))
  top=${path%%/*}; [[ $path == */* ]] && top=$top/
  # Dedupe the top-level rules already seen. The guard short-circuits on an empty array so
  # bash 3.2 with `set -u` never expands it before it holds anything; `&&` (not `||`) so an
  # empty list still takes the append — inverting this silently produces an empty list, which
  # is exactly the bug CI caught: bash 5 produced `under ``` with no directories named.
  [[ ${#exclude_tops[@]} -gt 0 && " ${exclude_tops[*]} " == *" $top "* ]] || exclude_tops+=("$top")
done < "$excludes"
[[ ! -e $tree/internal ]] || fail "internal/ is still in the tree; $excludes must list it"
# Bash 3.2 (macOS) needs the array declared before `${#links[@]}` is read under `set -u`.
links=()
while IFS= read -r link; do links+=("$link"); done < <(cd "$tree" && find . -type l | sed 's|^\./||')
((${#links[@]} == 0)) || fail "the tree holds symbolic links, which the export refuses: ${links[*]}"

# The privacy gate: private terms from this checkout, built-in patterns, gitleaks.
gate_args=(--tree "$tree" --terms "$terms" --require-terms)
((dry_run)) || gate_args+=(--require-gitleaks)
set +e
gate_output=$(bun "$gate" "${gate_args[@]}" 2>&1)
gate_status=$?
set -e
printf '%s\n' "$gate_output" >&2
((gate_status == 0)) || fail "the exported tree failed the privacy gate (exit $gate_status); nothing was exported"
gate_summary=$(printf '%s\n' "$gate_output" | grep '^check-public: [0-9]' | head -n 1)
# Bash 3.2 (macOS) has no mapfile: read the list line by line instead.
binaries=()
while IFS= read -r binary; do binaries+=("$binary"); done < <(bun "$gate" --tree "$tree" --list-binaries | tr -d '\r' | sed 's/^ *[0-9]*  //')

# Manifest: compare per-file hashes with the previous snapshot. Paths are relative to tree/ only.
hash_file() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
list_hashes() { (cd "$1" && find . -type f -not -path './.git/*' | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do printf '%s\t%s\n' "$f" "$(hash_file "$f")"; done); }
list_hashes "$tree" > "$work/new"
: > "$work/old"
previous_label="none (first snapshot: every file is added)"
if [[ -n $previous ]]; then
  [[ -d $previous/tree ]] && previous=$previous/tree
  list_hashes "$previous" > "$work/old"
  previous_label="the previous snapshot"
  if git -C "$previous" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    previous_label="$(git -C "$previous" log -1 --format=%s)"
  fi
fi
cut -f1 "$work/new" > "$work/files"
cut -f1 "$work/old" > "$work/old.paths"
LC_ALL=C comm -13 "$work/old.paths" "$work/files" > "$work/added"
LC_ALL=C comm -23 "$work/old.paths" "$work/files" > "$work/removed"
LC_ALL=C join -t $'\t' "$work/old" "$work/new" | awk -F'\t' '$2 != $3 {print $1}' > "$work/changed"
count() { wc -l < "$1" | tr -d ' '; }
kept=$(count "$work/files")
# Markdown code spans: the backticks in these single-quoted strings are literal.
# shellcheck disable=SC2016
section() {
  printf '\n## %s (%s)\n\n' "$1" "$(count "$2")"
  if [[ -s $2 ]]; then sed 's/^/- `/; s/$/`/' "$2"; else echo '_none_'; fi
}
# shellcheck disable=SC2016
{
  printf '# %s\n\n' "$subject"
  ((dry_run)) && printf '**Dry run:** no commit was made.\n\n'
  printf -- '- Source: `%s` (never committed to the public tree; this file stays with the maintainer)\n' "$full"
  printf -- '- Files: %s\n' "$kept"
  printf -- '- Compared with: %s\n' "$previous_label"
  printf -- '- Privacy gate: passed (%s)\n' "${gate_summary#check-public: }"
  printf -- '- Excluded: %s files by %s rules, under %s\n' "$((archived - kept))" "$exclude_count" "$(printf '`%s` ' "${exclude_tops[@]}" | sed 's/ $//; s/` `/`, `/g')"
  section Added "$work/added"
  section Removed "$work/removed"
  section Changed "$work/changed"
  printf '\n## Binary files to look at (%s)\n\n' "${#binaries[@]}"
  if ((${#binaries[@]})); then printf -- '- `%s`\n' "${binaries[@]}"; else echo '_none_'; fi
} > "$out/MANIFEST.md"
log "manifest: $(count "$work/added") added, $(count "$work/removed") removed, $(count "$work/changed") changed"

if ((dry_run)); then
  log "dry run complete: $tree (no commit), $out/MANIFEST.md"
  exit 0
fi

# A fresh repository with exactly one commit, dated like the source commit. No remote is added.
# It adds exactly the gated files, forced past any .gitignore in the tree, then checks the index.
date=$(git log -1 --format=%cI "$full")
git -C "$tree" -c init.defaultBranch=main init -q
git -C "$tree" config core.autocrlf false
git --literal-pathspecs -C "$tree" add -f --pathspec-from-file="$work/files"
git -C "$tree" ls-files | LC_ALL=C sort > "$work/indexed"
cmp -s "$work/files" "$work/indexed" || fail "the snapshot index differs from the gated file list"
GIT_AUTHOR_NAME=$AUTHOR_NAME GIT_AUTHOR_EMAIL=$AUTHOR_EMAIL GIT_AUTHOR_DATE=$date \
GIT_COMMITTER_NAME=$AUTHOR_NAME GIT_COMMITTER_EMAIL=$AUTHOR_EMAIL GIT_COMMITTER_DATE=$date \
  git -C "$tree" commit -q -m "$subject"
log "snapshot $(git -C "$tree" rev-parse --short HEAD) \"$subject\" in $tree; MANIFEST.md beside it"
log "nothing was pushed; publishing it is a separate manual step"

#!/usr/bin/env bash
# Build the WormDB FFI library from the source pins in this platform's lockfile:
#   Linux x86_64   libwormdb_ffi.so     native/linux-x64.lock.json
#   macOS arm64    libwormdb_ffi.dylib  native/darwin-arm64.lock.json
# Uses -Dcrypto-backend=std so the library matches the Windows pin's crypto
# choice and does not link libsodium.
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux; arch=x64; zig_target=x86_64-linux; library_name=libwormdb_ffi.so; label=Linux ;;
  Darwin-arm64) platform=darwin; arch=arm64; zig_target=aarch64-macos; library_name=libwormdb_ffi.dylib; label=macOS ;;
  *) echo "Build on Linux x86_64 or macOS arm64." >&2; exit 1 ;;
esac
# This platform's reviewed lock is the only source of build inputs here; the
# Windows pin in native/wormdb.lock.json is never read, so it cannot change this build.
lock_name="native/$platform-$arch.lock.json"
lock_file="$repository/$lock_name"

source_dir="${WORMDB_SRC:-}"
out_dir=""
verify_only=0
pins_from=""
zig_bin="${ZIG:-zig}"

usage() {
  echo "Usage: scripts/build-native.sh [--source DIR] [--out DIR] [--verify-only] [--pins-from LOCKFILE] [--zig PATH]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_dir="${2:?}"; shift 2 ;;
    --out) out_dir="${2:?}"; shift 2 ;;
    --verify-only) verify_only=1; shift ;;
    --pins-from) pins_from="${2:?}"; shift 2 ;;
    --zig) zig_bin="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

# A platform with no reviewed lock yet builds its first candidate from another
# platform's source pins (--pins-from). Once this platform has a lock, that lock
# alone decides the inputs and --pins-from is refused.
pins_file="$lock_file"
first_candidate=0
if [[ -n "$pins_from" ]]; then
  [[ ! -f "$lock_file" ]] || { echo "$lock_name exists; it decides the build inputs. Drop --pins-from." >&2; exit 1; }
  [[ "$verify_only" -eq 0 ]] || { echo "--verify-only needs the reviewed $lock_name." >&2; exit 1; }
  [[ -f "$pins_from" ]] || { echo "Missing $pins_from" >&2; exit 1; }
  pins_file="$pins_from"
  first_candidate=1
fi
[[ -f "$pins_file" ]] || {
  echo "No reviewed $label pin at $lock_name yet. Build a first candidate with --pins-from native/linux-x64.lock.json, run the persistence tests, then record the reviewed lockfile." >&2
  exit 1
}

read_lock() {
  python3 - "$pins_file" "$zig_target" "$first_candidate" "$lock_name" <<'PY'
import json, sys
path, target, first, name = sys.argv[1:5]
lock = json.load(open(path))
toolchain = lock["toolchain"]
# Another platform's lock only lends its source pins to a first candidate (the Windows one names no backend); this
# script always builds with std. The platform's own lock must describe the build it pins.
if first != "1" and (toolchain.get("target") != target or toolchain.get("cryptoBackend") != "std"):
    raise SystemExit(f"{name} must describe an {target} build with the std crypto backend.")
print(lock["candidateCommit"])
print(lock["meshguardCommit"])
print(toolchain["version"])
print("\n".join(lock["artifact"]["requiredSymbols"]))
PY
}

# No mapfile: macOS still ships bash 3.2 as /bin/bash.
lock_fields=()
while IFS= read -r field; do lock_fields+=("$field"); done < <(read_lock)
[[ "${#lock_fields[@]}" -ge 4 ]] || { echo "Could not read the source pins from $pins_file" >&2; exit 1; }
candidate_commit="${lock_fields[0]}"
meshguard_commit="${lock_fields[1]}"
zig_version_expected="${lock_fields[2]}"
required_symbols=("${lock_fields[@]:3}")

if [[ -z "$out_dir" ]]; then
  out_dir="$repository/.local/native"
fi
out_dir="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$out_dir")"
library="$out_dir/$library_name"

verify_library_against_lock() {
  local path="$1"
  python3 - "$path" "$lock_file" "$label" <<'PY'
import hashlib, json, os, sys
path, lock_path, label = sys.argv[1:4]
lock = json.load(open(lock_path))
art = lock["artifact"]
if not os.path.isfile(path):
    raise SystemExit("Native library is missing.")
size = os.path.getsize(path)
digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
if size != art["size"] or digest != art["sha256"]:
    raise SystemExit(f"Native library differs from the reviewed {label} lockfile.")
print(f"Native library matches the reviewed {label} lockfile.")
PY
}

if [[ "$verify_only" -eq 1 ]]; then
  verify_library_against_lock "$library"
  exit 0
fi

if [[ -z "$source_dir" ]]; then
  echo "Pass --source with a clean WormDB checkout at the locked candidate commit, or set WORMDB_SRC." >&2
  exit 1
fi
source_dir="$(cd "$source_dir" && pwd)"

verify_source() {
  local path="$1" commit="$2"
  local head status
  head="$(git -C "$path" rev-parse HEAD)"
  [[ "$head" == "$commit" ]] || { echo "Native source commit differs from lockfile: $path" >&2; exit 1; }
  status="$(git -C "$path" status --porcelain)"
  [[ -z "$status" ]] || { echo "Native source must be clean, including submodules: $path" >&2; echo "$status" >&2; exit 1; }
}

verify_source "$source_dir" "$candidate_commit"
meshguard="$source_dir/deps/meshguard"
verify_source "$meshguard" "$meshguard_commit"

zig_version="$("$zig_bin" version)"
[[ "$zig_version" == "$zig_version_expected" ]] || {
  echo "Zig version differs from lockfile: got $zig_version, expected $zig_version_expected" >&2
  exit 1
}

[[ ! -e "$library" ]] || {
  echo "Output library already exists: $library. Use a fresh --out or --verify-only." >&2
  exit 1
}

scratch="$repository/.local/native-build/$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
build_source="$scratch/source"
mkdir -p "$build_source"
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT

# Export only the pinned tracked input; never copy untracked private state.
git -C "$source_dir" archive --format=tar --output="$scratch/source.tar" "$candidate_commit"
tar -xf "$scratch/source.tar" -C "$build_source"
mkdir -p "$build_source/deps/meshguard"
git -C "$meshguard" archive --format=tar --output="$scratch/meshguard.tar" "$meshguard_commit"
tar -xf "$scratch/meshguard.tar" -C "$build_source/deps/meshguard"

prefix="$scratch/out"
mkdir -p "$prefix"
(
  cd "$build_source"
  "$zig_bin" build ffi \
    -Doptimize=ReleaseFast \
    -Dcrypto-backend=std \
    -j2 \
    --prefix "$prefix" \
    --cache-dir "$scratch/cache"
)

built=""
for candidate in "$prefix/lib/$library_name" "$prefix/bin/$library_name" "$prefix/$library_name"; do
  if [[ -f "$candidate" ]]; then
    built="$candidate"
    break
  fi
done
[[ -n "$built" ]] || {
  echo "Built library not found under $prefix" >&2
  find "$prefix" -type f -print >&2 || true
  exit 1
}

# The names the library exports. Mach-O prefixes C symbols with an underscore.
exported_symbols() {
  local listing
  if [[ "$platform" == darwin ]]; then
    listing="$(nm -gU "$built")" || return 1
    awk '{print $NF}' <<<"$listing" | sed 's/^_//'
  else
    listing="$(nm -D --defined-only "$built")" || return 1
    awk '{print $3}' <<<"$listing"
  fi
}

# Require the synchronous open symbol and the rest of the lockfile ABI.
exported="$(exported_symbols)" || {
  echo "Could not list the built library's symbols with nm (is it installed?): $built" >&2
  exit 1
}
missing=0
for symbol in "${required_symbols[@]}"; do
  if ! grep -qx "$symbol" <<<"$exported"; then
    echo "Missing required symbol: $symbol" >&2
    missing=1
  fi
done
[[ "$missing" -eq 0 ]] || exit 1

mkdir -p "$out_dir"
# The earlier existence check refuses an existing output; a plain copy is enough
# and stays portable on older coreutils (Ubuntu 22.04) and on macOS.
cp "$built" "$library"

python3 - "$library" "$out_dir" "$platform" "$arch" "$zig_target" "$candidate_commit" "$meshguard_commit" "$zig_version" "$lock_file" "$lock_name" "$label" "$first_candidate" "${required_symbols[@]}" <<'PY'
import datetime, hashlib, json, os, sys
library, out_dir, platform, arch, target, source, meshguard, zig, lock_path, lock_name, label, first = sys.argv[1:13]
symbols = sys.argv[13:]
name = os.path.basename(library)
size = os.path.getsize(library)
digest = hashlib.sha256(open(library, "rb").read()).hexdigest()
matches = False
if os.path.isfile(lock_path):
    art = json.load(open(lock_path))["artifact"]
    matches = art.get("sha256") == digest and art.get("size") == size
payload = {
    "schema": 1,
    "platform": platform,
    "arch": arch,
    "artifact": name,
    "sourceCommit": source,
    "meshguardCommit": meshguard,
    "zigVersion": zig,
    "cryptoBackend": "std",
    "sha256": digest,
    "size": size,
    "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "sourceMode": "public tracked snapshot",
    "sourcePinsVerified": True,
    "matchesReviewedArtifact": matches,
}
with open(os.path.join(out_dir, f"wormdb.{platform}-{arch}.provenance.json"), "w", encoding="utf-8") as out:
    out.write(json.dumps(payload, indent=2) + "\n")
print(f"Native {label} candidate built from verified source pins: {library} ({digest}).")
if first == "1":
    # A lockfile to review, written beside the candidate and never into native/: recording it is a person's decision.
    draft = {
        "schema": 1,
        "dependency": "wormdb",
        "repository": "https://github.com/igorls/wormdb.git",
        "candidateCommit": source,
        "meshguardCommit": meshguard,
        "toolchain": {
            "compiler": "zig", "version": zig, "target": target, "optimize": "ReleaseFast", "cryptoBackend": "std",
            "command": "zig build ffi -Doptimize=ReleaseFast -Dcrypto-backend=std",
        },
        "artifact": {"name": name, "platform": platform, "arch": arch, "size": size, "sha256": digest, "requiredSymbols": symbols},
        "notes": "",
    }
    draft_path = os.path.join(out_dir, f"{platform}-{arch}.lock.draft.json")
    with open(draft_path, "w", encoding="utf-8") as out:
        out.write(json.dumps(draft, indent=2) + "\n")
    print(f"Run the persistence tests against it, then review {draft_path}, fill in its notes and record it as {lock_name}.")
else:
    print(f"Run integration tests; --verify-only checks {lock_name}.")
PY

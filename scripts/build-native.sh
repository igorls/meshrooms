#!/usr/bin/env bash
# Build libwormdb_ffi.so from the source pins in native/linux-x64.lock.json.
# Linux x86_64. Uses -Dcrypto-backend=std so the library matches the Windows
# pin's crypto choice and does not link libsodium.
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The reviewed Linux lock is the only source of build inputs here; the Windows
# pin in native/wormdb.lock.json is never read, so it cannot change this build.
linux_lock_file="$repository/native/linux-x64.lock.json"
lock_file="$linux_lock_file"

source_dir="${WORMDB_SRC:-}"
out_dir=""
verify_only=0
zig_bin="${ZIG:-zig}"

usage() {
  echo "Usage: scripts/build-native.sh [--source DIR] [--out DIR] [--verify-only] [--zig PATH]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_dir="${2:?}"; shift 2 ;;
    --out) out_dir="${2:?}"; shift 2 ;;
    --verify-only) verify_only=1; shift ;;
    --zig) zig_bin="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[[ -f "$lock_file" ]] || { echo "Missing $lock_file" >&2; exit 1; }

read_lock() {
  python3 - "$lock_file" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
toolchain = lock["toolchain"]
if toolchain.get("target") != "x86_64-linux" or toolchain.get("cryptoBackend") != "std":
    raise SystemExit("native/linux-x64.lock.json must describe an x86_64-linux build with the std crypto backend.")
print(lock["candidateCommit"])
print(lock["meshguardCommit"])
print(lock["toolchain"]["version"])
print("\n".join(lock["artifact"]["requiredSymbols"]))
PY
}

mapfile -t lock_fields < <(read_lock)
candidate_commit="${lock_fields[0]}"
meshguard_commit="${lock_fields[1]}"
zig_version_expected="${lock_fields[2]}"
required_symbols=("${lock_fields[@]:3}")

if [[ -z "$out_dir" ]]; then
  out_dir="$repository/.local/native"
fi
out_dir="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$out_dir")"
library="$out_dir/libwormdb_ffi.so"

verify_library_against_linux_lock() {
  local path="$1"
  [[ -f "$linux_lock_file" ]] || {
    echo "No reviewed Linux pin at native/linux-x64.lock.json yet. Build a candidate, run the persistence tests, then record the reviewed hash." >&2
    exit 1
  }
  python3 - "$path" "$linux_lock_file" <<'PY'
import hashlib, json, os, sys
path, lock_path = sys.argv[1:3]
lock = json.load(open(lock_path))
art = lock["artifact"]
if not os.path.isfile(path):
    raise SystemExit("Native library is missing.")
size = os.path.getsize(path)
digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
if size != art["size"] or digest != art["sha256"]:
    raise SystemExit("Native library differs from the reviewed Linux lockfile.")
print("Native library matches the reviewed Linux lockfile.")
PY
}

if [[ "$verify_only" -eq 1 ]]; then
  verify_library_against_linux_lock "$library"
  exit 0
fi

[[ "$(uname -s)" == "Linux" ]] || { echo "Build on Linux." >&2; exit 1; }
[[ "$(uname -m)" == "x86_64" ]] || { echo "Build on Linux x86_64." >&2; exit 1; }

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
for candidate in "$prefix/lib/libwormdb_ffi.so" "$prefix/bin/libwormdb_ffi.so" "$prefix/libwormdb_ffi.so"; do
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

# Require the synchronous open symbol and the rest of the lockfile ABI.
missing=0
for symbol in "${required_symbols[@]}"; do
  if ! nm -D --defined-only "$built" 2>/dev/null | awk '{print $3}' | grep -qx "$symbol"; then
    echo "Missing required symbol: $symbol" >&2
    missing=1
  fi
done
[[ "$missing" -eq 0 ]] || exit 1

built_hash="$(sha256sum "$built" | awk '{print $1}')"
built_size="$(stat -c '%s' "$built")"
mkdir -p "$out_dir"
# The earlier existence check refuses an existing output; a plain copy is enough
# and stays portable on older coreutils (Ubuntu 22.04).
cp "$built" "$library"

python3 - "$out_dir/wormdb.linux-x64.provenance.json" "$candidate_commit" "$meshguard_commit" "$zig_version" "$built_hash" "$built_size" "$linux_lock_file" <<'PY'
import json, os, sys
path, source, meshguard, zig, digest, size, linux_lock = sys.argv[1:]
matches = False
if os.path.isfile(linux_lock):
    art = json.load(open(linux_lock))["artifact"]
    matches = art.get("sha256") == digest and art.get("size") == int(size)
payload = {
    "schema": 1,
    "platform": "linux",
    "arch": "x64",
    "artifact": "libwormdb_ffi.so",
    "sourceCommit": source,
    "meshguardCommit": meshguard,
    "zigVersion": zig,
    "cryptoBackend": "std",
    "sha256": digest,
    "size": int(size),
    "builtAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
    "sourceMode": "public tracked snapshot",
    "sourcePinsVerified": True,
    "matchesReviewedArtifact": matches,
}
open(path, "w", encoding="utf-8").write(json.dumps(payload, indent=2) + "\n")
print(f"Native Linux candidate built from verified source pins: {os.path.dirname(path)}/libwormdb_ffi.so ({digest}). Run integration tests; --verify-only checks native/linux-x64.lock.json.")
PY

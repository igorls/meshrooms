#!/usr/bin/env bash
# Signed and notarized Meshrooms.app + DMG for macOS arm64.
# Credentials come from Keychain only: a Developer ID Application identity and a
# saved notarytool profile. Apple passwords and API keys are never read from the environment.
# Builds from a temporary worktree of a commit, so uncommitted work in this checkout
# (including another session's) never enters a notarized artifact.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

notary_profile="${APPLE_NOTARY_KEYCHAIN_PROFILE:-meshrooms-notary}"
library="${WORMDB_LIBRARY_PATH:-}"
notarize=1
ref="HEAD"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --library) library="${2:?missing value for --library}"; shift 2 ;;
    --notary-profile) notary_profile="${2:?missing value for --notary-profile}"; shift 2 ;;
    --no-notarize) notarize=0; shift ;;
    --ref) ref="${2:?missing value for --ref}"; shift 2 ;;
    *) echo "Unknown argument: $1"; echo "Usage: scripts/macos-release.sh --library PATH [--ref COMMIT] [--notary-profile NAME] [--no-notarize]"; exit 1 ;;
  esac
done

[[ "$(uname -s)-$(uname -m)" == "Darwin-arm64" ]] || { echo "This release targets macOS arm64 and must run there."; exit 1; }
commit="$(git rev-parse --verify "$ref^{commit}")" || { echo "Unknown commit: $ref"; exit 1; }
[[ -n "$library" && -f "$library" ]] || { echo "Pass --library with the pinned arm64 libwormdb_ffi.dylib (see native/wormdb.lock.json)."; exit 1; }
[[ "$(nm -gU "$library")" == *_wormdb_open_sync* ]] || { echo "The WormDB library does not export wormdb_open_sync: $library"; exit 1; }

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -n 1)"
fi
[[ -n "$APPLE_SIGNING_IDENTITY" ]] || { echo "No Developer ID Application identity found in Keychain."; exit 1; }
team_id="$(sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p' <<<"$APPLE_SIGNING_IDENTITY")"
if [[ "$notarize" -eq 1 ]] && ! xcrun notarytool history --keychain-profile "$notary_profile" >/dev/null; then
  echo "The notarytool Keychain profile '$notary_profile' is unavailable. Create one with 'xcrun notarytool store-credentials'."
  exit 1
fi

# Previous outputs are moved aside, never deleted.
move_aside() { [[ -e "$1" ]] && mv "$1" "$1.$(date +%Y%m%d%H%M%S)"; return 0; }

work="$(mktemp -d)"
source_dir="$work/source"
cleanup() { git -C "$ROOT_DIR" worktree remove --force "$source_dir" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT
git worktree add --detach --quiet "$source_dir" "$commit"

version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$source_dir/desktop/src-tauri/tauri.conf.json" | head -n 1)"
# The Cargo cache is shared with this checkout; outputs land in its usual bundle directory.
export CARGO_TARGET_DIR="$ROOT_DIR/desktop/src-tauri/target"
app_path="$CARGO_TARGET_DIR/release/bundle/macos/Meshrooms.app"
dmg_path="$ROOT_DIR/.release/Meshrooms_${version}_aarch64.dmg"

echo "==> Runtime from ${commit:0:12}, signed as $APPLE_SIGNING_IDENTITY"
(
  cd "$source_dir"
  bun install --frozen-lockfile
  bun run build
  bun run scripts/package-runtime.ts --out .local/packages/desktop-runtime --library "$library" --codesign-identity "$APPLE_SIGNING_IDENTITY"
)
[[ "$(cat "$source_dir/.local/packages/desktop-runtime/manifest.json")" == *"\"releaseCommit\": \"$commit\""* ]] \
  || { echo "The runtime manifest does not pin clean commit $commit."; exit 1; }

echo "==> App bundle"
move_aside "$app_path"
(
  cd "$source_dir"
  env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH -u API_PRIVATE_KEYS_DIR \
    APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
    bunx tauri build --bundles app --config desktop/src-tauri/tauri.release.conf.json
)

# The bundled Bun must keep its JIT entitlements and our team: a re-sign without them breaks the daemon.
# Output is captured first: with pipefail, grep -q closing the pipe early would fail the check.
bundled_bun="$app_path/Contents/Resources/runtime/bun"
entitlements="$(codesign -d --entitlements - --xml "$bundled_bun" 2>/dev/null)"
[[ "$entitlements" == *com.apple.security.cs.allow-jit* ]] || { echo "Bundled bun lost its JIT entitlement."; exit 1; }
for binary in "$bundled_bun" "$app_path/Contents/Resources/runtime/.local/native/libwormdb_ffi.dylib" "$app_path"; do
  signature="$(codesign -dv "$binary" 2>&1)"
  [[ "$signature" == *"TeamIdentifier=$team_id"* ]] || { echo "Not signed by team $team_id: $binary"; exit 1; }
done
codesign --verify --deep --strict --verbose=2 "$app_path"

if [[ "$notarize" -eq 1 ]]; then
  echo "==> Notarizing app"
  ditto -c -k --keepParent "$app_path" "$work/Meshrooms.zip"
  xcrun notarytool submit "$work/Meshrooms.zip" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$app_path"
  xcrun stapler validate "$app_path"
  spctl --assess --type execute --verbose=4 "$app_path"
fi

echo "==> DMG"
mkdir -p "$ROOT_DIR/.release" "$work/dmg"
move_aside "$dmg_path"
ditto "$app_path" "$work/dmg/Meshrooms.app"
ln -s /Applications "$work/dmg/Applications"
hdiutil create -volname "Meshrooms" -srcfolder "$work/dmg" -format UDZO -quiet "$dmg_path"
codesign --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg_path"

if [[ "$notarize" -eq 1 ]]; then
  echo "==> Notarizing DMG"
  xcrun notarytool submit "$dmg_path" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$dmg_path"
  xcrun stapler validate "$dmg_path"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg_path"
fi

echo "==> Done"
shasum -a 256 "$dmg_path"

#!/usr/bin/env bash
# Signed bridge-backed Meshrooms.app + DMG for macOS arm64.
# Signing and optional notarization credentials stay in Keychain. Build only an
# immutable commit in a private worktree; never ship another session's edits.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
notary_profile="${APPLE_NOTARY_KEYCHAIN_PROFILE:-meshrooms-notary}"
notarize=1
ref="HEAD"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notary-profile) notary_profile="${2:?missing value for --notary-profile}"; shift 2 ;;
    --no-notarize) notarize=0; shift ;;
    --ref) ref="${2:?missing value for --ref}"; shift 2 ;;
    *) printf '%s\n' "Unknown argument: $1" "Usage: scripts/macos-release.sh [--ref COMMIT] [--notary-profile NAME] [--no-notarize]"; exit 1 ;;
  esac
done
[[ "$(uname -s)-$(uname -m)" == "Darwin-arm64" ]] || { printf '%s\n' "Run this release on macOS arm64."; exit 1; }
commit="$(git rev-parse --verify "$ref^{commit}")"
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | python3 -c 'import re,sys; names=re.findall(r"\"(Developer ID Application:[^\"]+)\"",sys.stdin.read()); print(names[0] if len(names)==1 else "")')"
fi
[[ -n "$APPLE_SIGNING_IDENTITY" ]] || { printf '%s\n' "Select a Developer ID Application identity from Keychain with APPLE_SIGNING_IDENTITY."; exit 1; }
team_id="$(python3 -c 'import re,sys; m=re.search(r"\(([A-Z0-9]{10})\)$",sys.argv[1]); print(m[1] if m else "")' "$APPLE_SIGNING_IDENTITY")"
[[ -n "$team_id" ]] || { printf '%s\n' "The signing identity must be a Developer ID Application name with a team identifier."; exit 1; }
if [[ "$notarize" -eq 1 ]] && ! xcrun notarytool history --keychain-profile "$notary_profile" >/dev/null; then
  printf '%s\n' "The notarytool Keychain profile is unavailable. Configure it through notarytool store-credentials, or use --no-notarize for local signing evidence."
  exit 1
fi
move_aside() { [[ ! -e "$1" ]] || mv "$1" "$1.$(date +%Y%m%d%H%M%S).$$"; }
work="$(mktemp -d "${TMPDIR:-/tmp}/meshrooms-release.XXXXXXXX")"
source_dir="$work/source"
cleanup() { git -C "$ROOT_DIR" worktree remove --force "$source_dir" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT
git worktree add --detach --quiet "$source_dir" "$commit"
version="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$source_dir/desktop/src-tauri/tauri.conf.json")"
# Keep the native build and app private through signing, verification and DMG
# staging: another build in the caller's checkout must never replace this app.
export CARGO_TARGET_DIR="$work/target"
app_path="$CARGO_TARGET_DIR/release/bundle/macos/Meshrooms.app"
dmg_path="$ROOT_DIR/.release/Meshrooms_${version}_aarch64.dmg"
printf '%s\n' "==> Bridge runtime from ${commit:0:12}"
(
  cd "$source_dir"
  bun install --frozen-lockfile
  bun run build:bridge
  bun run scripts/package-runtime.ts --bridge --out .local/packages/desktop-bridge --codesign-identity "$APPLE_SIGNING_IDENTITY"
)
bun -e '
const m=await Bun.file(process.argv[1]).json(), expected=process.argv[2], g=m?.git;
if (!m || typeof m!=="object" || Array.isArray(m) || !g || typeof g!=="object" || Array.isArray(g)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expected)
    || g.dirty!==false || g.commit!==expected || g.releaseCommit!==expected)
  throw Error("Bridge manifest does not pin the clean release commit");
' "$source_dir/.local/packages/desktop-bridge/manifest.json" "$commit"
printf '%s\n' "==> App bundle"
move_aside "$app_path"
(
  cd "$source_dir/desktop"
  env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH -u API_PRIVATE_KEYS_DIR -u APPLE_SIGNING_IDENTITY \
    bun ../node_modules/@tauri-apps/cli/tauri.js build --bundles app --no-sign --config src-tauri/tauri.release.conf.json
)
# Sign the root without --deep re-signing: the packaged Bun already has its JIT
# entitlements and manifest hash, and must remain byte-identical after bundling.
codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$app_path"
bundled_bridge="$app_path/Contents/Resources/bridge"
bundled_bun="$bundled_bridge/bun"
[[ -f "$bundled_bridge/meshrooms.js" ]] || { printf '%s\n' "The app is missing the bridge CLI."; exit 1; }
entitlements="$(codesign -d --entitlements - --xml "$bundled_bun" 2>/dev/null)"
[[ "$entitlements" == *com.apple.security.cs.allow-jit* ]] || { printf '%s\n' "Bundled Bun lost its JIT entitlement."; exit 1; }
for binary in "$bundled_bun" "$app_path"; do
  signature="$(codesign -dv "$binary" 2>&1)"
  [[ "$signature" == *"TeamIdentifier=$team_id"* ]] || { printf '%s\n' "The release signature has the wrong team."; exit 1; }
done
bun -e 'const fs=await import("node:fs"); const crypto=await import("node:crypto"); const path=await import("node:path"); const root=process.argv[1],m=JSON.parse(fs.readFileSync(path.join(root,"manifest.json"),"utf8")); for(const [name,hash] of Object.entries(m.files)){ const actual=crypto.createHash("sha256").update(fs.readFileSync(path.join(root,name))).digest("hex"); if(actual!==hash) throw Error("Bundled bridge hash mismatch: "+name); }' "$bundled_bridge"
codesign --verify --deep --strict --verbose=2 "$app_path"
if [[ "$notarize" -eq 1 ]]; then
  ditto -c -k --keepParent "$app_path" "$work/Meshrooms.zip"
  xcrun notarytool submit "$work/Meshrooms.zip" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$app_path"
  xcrun stapler validate "$app_path"
  spctl --assess --type execute --verbose=4 "$app_path"
fi
printf '%s\n' "==> DMG"
mkdir -p "$ROOT_DIR/.release"
move_aside "$dmg_path"
bun "$source_dir/scripts/package-macos-dmg.ts" --app "$app_path" --out "$dmg_path"
codesign --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg_path"
codesign --verify --strict --verbose=2 "$dmg_path"
if [[ "$notarize" -eq 1 ]]; then
  xcrun notarytool submit "$dmg_path" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$dmg_path"
  xcrun stapler validate "$dmg_path"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg_path"
fi
printf '%s\n' "==> Done"
shasum -a 256 "$dmg_path"

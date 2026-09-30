# Desktop shell

Status: development preview, macOS arm64 first. Release builds are signed with
Developer ID and notarized; local `desktop:build` output is unsigned.

`desktop/` is a small Tauri 2 menu-bar app for the local node. It follows
[one daemon, many rooms](architecture/0001-one-daemon-many-rooms.md): the shell
never owns rooms or the store. It asks the runtime's own CLI to start or reuse
the node, exactly as an agent does, and quitting the shell leaves the daemon and
its rooms running. Start at login stays a daemon setting
([local daemon](local-daemon.md)); the shell does not register a second entry.

## Behavior

- **Tray:** node status (polled every 15 seconds with CLI `status`), Open
  Meshrooms, Open in Browser, and Quit (rooms keep running). On macOS the app
  has no Dock icon while its window is hidden.
- **Window:** `open` returns the loopback room URL with a one-time ticket; the
  window navigates to the daemon's own UI, which exchanges the ticket for its
  owner cookie. That page is a normal loopback origin: the shell grants it no
  Tauri IPC and never evaluates script in it. Closing the window hides it.
- **Status page:** a bundled page shows startup progress and errors, passed in
  its query string.
- **Single instance:** launching again shows the existing window.

## Runtime resolution

1. `MESHROOMS_HOME`, which must hold a complete runtime (`bun`, `server/cli.ts`,
   `dist/index.html`, `.local/native/libwormdb_ffi.dylib`).
2. Debug builds only: this checkout, with Bun from `PATH` or `~/.bun/bin`.
3. `~/.meshrooms/app`, the same location the skill uses.
4. If nothing exists there, the runtime bundled in the app is installed to
   `~/.meshrooms/app`. Only manifest-listed files are copied, each SHA-256 is
   checked before and after copying, and a staging directory is renamed into
   place. An existing directory, complete or not, is never replaced; upgrades
   remain an explicit future step.

The daemon keeps its normal data directory (`~/.local/share/Meshrooms/data` on
macOS unless `MESHROOMS_DATA_DIR` is set). Environment variables the daemon
reads, such as `MESHROOMS_PORT`, pass through the CLI.

## Build

```sh
bun install --frozen-lockfile
bun run desktop:dev            # debug shell on this checkout (needs WormDB: WORMDB_LIBRARY_PATH)
bun run desktop:runtime --library /path/to/libwormdb_ffi.dylib
bun run desktop:build          # Meshrooms.app and .dmg with the bundled runtime
```

`desktop:runtime` refuses to overwrite `.local/packages/desktop-runtime`; move
the previous package aside first. Use `desktop:dev`, not a bare `cargo run`: a
debug binary loads its status page from the Tauri CLI's development server.
Rust tests: `cargo test` in `desktop/src-tauri`.

## Signed release

```sh
bun run desktop:release --library /path/to/libwormdb_ffi.dylib
```

[`scripts/macos-release.sh`](../scripts/macos-release.sh) needs a Developer ID
Application identity and a saved `notarytool` Keychain profile
named `meshrooms-notary` by default (create it with `xcrun notarytool store-credentials
meshrooms-notary`, or set `APPLE_NOTARY_KEYCHAIN_PROFILE` to the name of an existing profile). It strips Apple credential variables from
the environment, so passwords and API keys never pass through it. It builds from
a temporary worktree of a commit (`--ref`, default `HEAD`) and requires the
runtime manifest to pin that clean commit, so uncommitted work in the checkout,
including another session's, never enters a notarized artifact.

1. Packages the runtime with `--codesign-identity`: `bun` (hardened runtime plus
   the JIT entitlements in `scripts/macos/bun.entitlements`) and the WormDB dylib
   are signed before the manifest hashes them, so first-run verification checks
   the signed bytes.
2. Builds the signed app, confirms the bundled binaries carry the team ID and
   Bun's JIT entitlement, and runs a strict deep signature check.
3. Notarizes, staples, and runs a Gatekeeper check on the app, then builds a
   signed DMG in `.release/` and notarizes and staples it too.

The Cargo build cache is shared with the checkout; the app lands in the usual
`desktop/src-tauri/target/release/bundle/macos/`.

Earlier outputs are moved aside with a timestamp, never deleted. `--no-notarize`
produces a signed build without submitting to Apple.

For isolated checks, set `MESHROOMS_DATA_DIR` and `MESHROOMS_PORT`, or run the
built app binary with a temporary `HOME` to exercise first-run installation
without touching the real runtime or node.

## Not yet done

CI signing (signed builds are made locally with the script above), Login Items attribution through
`SMAppService`, runtime upgrades, Windows/Linux shell builds, tray display of
transport/pending delivery state, and agent watching status. The tray menu has
been built but its clicks were not exercised in automated checks.

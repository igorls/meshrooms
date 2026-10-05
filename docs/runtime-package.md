# Portable Runtime Packaging

Meshrooms provides a packaging script (`scripts/package-runtime.ts`) for the local daemon, native DLL, and built UI on Windows x64, and the same bundle for macOS arm64 when run there. Bundles include Bun by default; `--external-bun` leaves it out, for a bundle that gets the pinned Bun from upstream separately.

The packaged output allows a user or automated agent to run Meshrooms without Bun installed globally, without repository checkouts, and without downloading `node_modules`.

## Bundle Layout

The resulting package contains:

```
<outputDir>/
├── bun.exe                         # Pinned Bun; omitted with --external-bun
├── package.json                    # Minimal module definition {"type": "module"}
├── manifest.json                   # Unsigned integrity manifest with SHA-256 for each bundled file
├── dist/                           # Built web UI assets (dist/index.html, assets/...)
├── server/                         # Production TypeScript server files
│   ├── cli.ts                      # CLI entrypoint (status | ensure | start)
│   ├── daemon.ts                   # Local daemon runner
│   ├── runtime.ts                  # Discovery, HMAC proofs, and lifecycle
│   ├── instance.ts                 # Mutex lock ownership
│   ├── http.ts                     # Loopback HTTP and SSE server
│   ├── node.ts                     # Local node catalog and history
│   └── persistence/                # WormDB persistence adapter
│       ├── store.ts
│       └── wormdb.ts
├── src/                            # Shared type definitions for server imports
│   ├── room.ts
│   └── setup.ts
├── skills/meshrooms/               # Skill and license
├── LICENSES/                       # Dependency notices, including WormDB binary license
└── .local/
    └── native/
        └── wormdb_ffi.dll          # 64-bit WormDB native library with wormdb_open_sync
```

A macOS arm64 bundle (packaged on an Apple Silicon Mac) has the same layout with
two differences: Bun is copied as `bun` (mode 0755) instead of `bun.exe`, and the
native library is `.local/native/libwormdb_ffi.dylib` (default source
`.local/native/libwormdb_ffi.dylib`, or `--library PATH`). Its manifest records
`"platform": "darwin"`, `"arch": "arm64"`, and `"entry": "bun run server/cli.ts"`.

## Manifest (`manifest.json`)

Every package includes a Schema 1 integrity manifest:
```json
{
  "schema": 1,
  "platform": "win32",
  "arch": "x64",
  "version": "0.1.0-alpha.2",
  "bun": { "version": "1.4.2", "bundled": false },
  "git": {
    "commit": "<40-hex commit>",
    "dirty": false,
    "releaseCommit": "<40-hex commit>"
  },
  "entry": "bun.exe run server/cli.ts",
  "files": {
    ".local/native/wormdb_ffi.dll": "sha256...",
    "dist/index.html": "sha256...",
    "server/daemon.ts": "sha256...",
    ...
  }
}
```
- **Source pin:** If uncommitted changes exist in the source repository (`dirty: true`), `releaseCommit` is null. A clean source pin identifies a checkout; it does not certify an official release.
- **Integrity:** Every file entry records its exact byte SHA-256 hash.

This unsigned manifest detects changes relative to a trusted copy. It does not
authenticate a publisher or replace signed distribution. The native DLL is the
separately pinned synchronous WormDB candidate documented in `wormdb-adapter.md`.

## Invariants & Safety

1. **No Overwrite / No Deletion:** Packaging fails closed immediately if `outputDir` already exists. It never recursively deletes or modifies existing directories.
2. **Strict Exclusions:** Sensitive files (`control.key`, `runtime.json`), user data directories, log files (`*.log`), development dependencies (`node_modules`), and tests (`*.test.ts`, `test-directory.ts`, `mockRoom.ts`) are excluded.
3. **Execution Seam:** Commands run directly via `./bun.exe run server/cli.ts`. Daemon defaults for relative paths (`.local/native/wormdb_ffi.dll`, `dist/`) resolve naturally within the bundle.

## Usage

```powershell
# Default: packages current repo to .local/packages/current
bun run scripts/package-runtime.ts

# Explicit paths
bun run scripts/package-runtime.ts --out .local/packages/candidate

# Run a trusted bundle from any project directory, using its absolute path.
$meshroomsRuntime = Join-Path $env:USERPROFILE '.meshrooms\app'
& (Join-Path $meshroomsRuntime 'bun.exe') run (Join-Path $meshroomsRuntime 'server\cli.ts') start --title 'Project room' --project 'My project' --agent 'Codex'
```

Place a bundle you built into a new runtime directory, normally
`%USERPROFILE%/.meshrooms/app`; no installer is distributed. The data directory remains separately at
`%USERPROFILE%/.meshrooms/data`. AppData can be private to the launching packaged
harness, so it is unsuitable for this shared node default. Never copy an existing user's data, `control.key`,
runtime marker, or agent credentials into a distributable package. Copy the
bundled `skills/meshrooms` into the chosen harness's skill directory if needed.
Set `MESHROOMS_HOME` when using another runtime location. Upgrading a running
daemon and changing a registered startup path need an explicit lifecycle step;
the packager itself neither stops daemons nor overwrites existing output.

This packaging slice targets Windows x64 and macOS arm64 only; other platforms fail
closed. On
macOS, `--codesign-identity NAME` signs `bun` and the native library with
Developer ID and hardened runtime before hashing. The desktop app bundles the agent
bridge instead (`--bridge`: Bun, `meshrooms.js` and their notices, with the same
SHA-256 manifest) and installs it on first run ([desktop app](desktop-shell.md)).
An automatic updater, other-platform bundles, and remote recipient bootstrap
are not implemented.
Built UI inputs are restricted to the expected index and assets;
unexpected files or symbolic links fail packaging instead of entering the bundle.

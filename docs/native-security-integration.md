# Native security integration

Validation date: 2026-09-22. This is source and native-candidate integration,
not a deployment or a published application release.

## Pinned inputs and artifact

- WormDB source: `f96b1aa794904585aaacd9a3c83ff688a031f743`.
- Includes priority security commit `6a53cd0`, synchronous FFI branch `08124f6`,
  explicit failure cleanup in the new nullable opener, token-expiry event
  revocation with exact binary-channel authorization, and synchronous WAL
  error fencing until reopen/recovery, and allocation/index reservation before
  durable SET publication, plus idle-capable accepted replication sessions with
  partial-frame deadlines retained.
- MeshGuard source: `fdbfd51bdbc643bae0aff8cb7b11e9372f6a23a8`.
- Windows x64, Zig 0.16.0, `zig build ffi -Doptimize=ReleaseFast`.
- DLL size: 1,952,768 bytes.
- SHA-256: `f26d01ce9ea3395d5a68a8656f4c0923a2fafdd99221806de0946a08f7ac065b`.

The existing build script exported clean, exact tracked source and dependency
pins into a fresh ignored scratch directory. The resulting DLL and provenance
were retained separately from existing native libraries. The lockfile hash and
size were updated only after the new artifact passed the full native suite.
The build-time provenance records that it did not match the previous artifact;
subsequent `build-native.ps1 -VerifyOnly` confirms the reviewed new pin.

PE exports include both `wormdb_open` and `wormdb_open_sync`, alongside every
symbol required by the lockfile. Import inspection found Windows system/CRT
dependencies and no external crypto DLL. The legacy asynchronous entry point is
unchanged. Meshrooms still requires synchronous open and refuses incompatible
libraries rather than weakening its local-save receipt contract.

## Validation

With the exact DLL selected through `WORMDB_LIBRARY_PATH` and the preserved
asynchronous-only DLL selected through `WORMDB_LEGACY_LIBRARY_PATH`:

- `bun run check`: pass.
- `bun run test:source`: 49 pass, zero failures.
- `bun test ./server ./scripts`: 76 pass, zero failures/skips, 478 assertions.
- `bun run build`: pass.
- `./scripts/build-native.ps1 -VerifyOnly -OutDir <candidate-directory>`: pass.
- `git diff --check`: pass.

The full suite covers direct adapter writes, actual HTTP daemon receipts,
immediate process termination and recovery, write-failure propagation, corrupted
WAL rejection, agent admission/isolation and stream quota recovery, and peer
assembly fairness. The incompatible-symbol rejection test was enabled.

The combined WormDB source passed 305/305 Zig tests, 8/8 build steps and 17/17
live security regression groups on both Windows and Ubuntu WSL. These network
checks exercise the standalone server separately; the Meshrooms DLL embeds the
local storage engine and starts no WormDB network listener.

The initial independent integration review repeated 303 Zig tests, 44
consumer/native tests and the real-daemon quota test. Hosted review then found
the idle-expiry and WAL uncertainty issues, and a follow-up reviewer reproduced
the binary-channel authorization bypass. A final hosted review identified live
entry allocation after a durable append. Those findings were corrected before
this final artifact was built; the engine validation above covers the added
regressions. Exact native verification, required-export inspection and both diff
checks passed for the final candidate.

## Boundaries

The new synchronous opener keeps the WAL writer inline and returns success only
after write and sync. Errors propagate; a direct WAL I/O error blocks later
WAL-backed writes until reopen/recovery, and failed operations are not promised
to roll back partially written bytes. Unsafe in-memory procedures remain outside
the durable-write guarantee. Automatic WAL truncation remains disabled for
`sync_writes`; long-term storage growth is unchanged and still requires work.

No running user daemon, user room store, startup registration, installed native
library, published release archive or installer default was replaced. Old
releases retain their own source pins and native artifacts. Rebuilding the same
source can change PE identifiers and does not imply byte-identical output.

Hardware power-loss, sustained-load, optional QUIC and multi-host MeshGuard
qualification remain outside this integration. The independent security review
and full audit coverage limits remain distinct from this compatibility evidence.

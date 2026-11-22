# Native WormDB build

Meshrooms uses the MIT-licensed [WormDB source](https://github.com/igorls/wormdb)
and pins its native build inputs in this repository. The current source pin
combines the synchronous embedding API and priority security fixes. Published
older app archives retain their own native pins; a source merge is not a release.

## Windows x64

With a clean checkout at the lockfile's `candidateCommit` and its initialized
`deps/meshguard` submodule, run:

```powershell
./scripts/build-native.ps1 -SourceDir <wormdb-checkout> -OutDir <fresh-output-directory>
./scripts/build-native.ps1 -VerifyOnly -OutDir <qualified-output-directory>
```

The first command requires Windows x64 and Zig 0.16.0. It checks both source
commits in [the lockfile](../native/wormdb.lock.json), exports their tracked files
into a fresh ignored scratch directory, and compiles only the FFI library in
ReleaseFast mode. The project cache and compiler output stay in that scratch
directory; Zig's shared toolchain cache is reused.
It refuses an existing output DLL and records the resulting size and SHA-256.
PE build identifiers can change across build directories, so this is not a
promise of bit-identical rebuilding. A provenance JSON accompanies
the candidate output; it contains no machine paths. Scratch input remains ignored
under `.local/native-build` and is not packaged.

The second command verifies the exact reviewed hash of `.local/native/wormdb_ffi.dll`,
or a supplied `-OutDir`, without compiling. Packaging requires that exact match.
Use `WORMDB_LIBRARY_PATH` to test a separate candidate without replacing a DLL
used by an existing daemon. A versioned app archive contains the DLL matching its
own lockfile, which may differ from current source. Check `SHA256SUMS.txt` before
using that archive.

The pinned Windows build selects Zig `std.crypto` and does not link libsodium.
Inspection with `llvm-readobj --coff-imports` found KERNEL32, ntdll, and the Windows
Universal CRT heap/runtime/stdio/string API sets. It requires no separately shipped
crypto DLL. The build input also contains the pinned public MeshGuard module.
Dependency notices for MeshGuard, Zig, and MinGW runtime support accompany the
WormDB binary license in [LICENSES](../LICENSES).

The exact locked DLL must pass Meshrooms' native integration and process-recovery
tests. A new compiler, native commit, or binary hash needs a new reviewed lockfile
and qualification; never change the expected hash just to make a build pass.

## Linux x64

The same source pins build a shared library for Linux. WormDB's default Linux
crypto backend links libsodium; Meshrooms passes `-Dcrypto-backend=std` so the
Linux candidate matches the Windows pin and needs no separately shipped crypto
library.

```sh
./scripts/build-native.sh --source <wormdb-checkout> --out <fresh-output-directory>
./scripts/build-native.sh --verify-only --out <qualified-output-directory>
```

Requires Linux x86_64 and Zig 0.16.0. The script takes both source commits, the
Zig version and the required symbols from
[native/linux-x64.lock.json](../native/linux-x64.lock.json) only, checks them,
exports tracked files into a fresh ignored scratch directory, builds only the
FFI library, refuses an existing `libwormdb_ffi.so`, and writes
`wormdb.linux-x64.provenance.json` next to the candidate. Point
`WORMDB_LIBRARY_PATH` at that `.so` for adapter and daemon tests.

`--verify-only` checks the exact reviewed hash in
[native/linux-x64.lock.json](../native/linux-x64.lock.json). That pin records the
qualified Ubuntu x86_64 artifact; it does not replace the Windows pin in
`wormdb.lock.json`. A new compiler, source commit, or binary hash needs a new
reviewed Linux lockfile entry after the persistence suite passes.

## macOS arm64

The same script builds `libwormdb_ffi.dylib` on Apple Silicon, from the source
commits, Zig version and required symbols in
[native/darwin-arm64.lock.json](../native/darwin-arm64.lock.json) only. It also
passes `-Dcrypto-backend=std`; the library links `libSystem` and nothing else.

```sh
./scripts/build-native.sh --source <wormdb-checkout> --out <fresh-output-directory>
./scripts/build-native.sh --verify-only --out <qualified-output-directory>
WORMDB_LIBRARY_PATH=<fresh-output-directory>/libwormdb_ffi.dylib bun test ./server/persistence
```

`WORMDB_LIBRARY_PATH` makes the tests load the library that was just built, not
one found by the default lookup. Requires macOS arm64, Zig 0.16.0, `python3` and the Xcode command line tools
(`nm`). The script runs under the system's bash 3.2. It writes
`wormdb.darwin-arm64.provenance.json` next to the candidate. With no `--out`,
the library lands in `.local/native`, where the daemon and the persistence
tests look first, before a sibling `wormdb` checkout's own `zig-out`. Build
here instead of in that checkout: a library built from WormDB source older
than the pins lacks `wormdb_open_sync`, and the adapter refuses it with a
message naming this page.

Two builds from the same inputs do not produce the same hash, and the linker's
ad hoc signature is part of the hashed file. The pin therefore records the one
artifact that was qualified with the persistence suite; `--verify-only` passes
for that file and fails for a rebuild. A rebuild is a new candidate: run the
suite against it before relying on it. Signing the library for a release
changes its hash as well.

## A first candidate for a platform without a pin

A platform the script can build for but that has no lockfile yet takes its
source pins from another platform's reviewed lockfile:

```sh
./scripts/build-native.sh --source <wormdb-checkout> --pins-from native/linux-x64.lock.json
```

It writes `<platform>-<arch>.lock.draft.json` next to the candidate and never
into `native/`. Run the persistence suite against the candidate, fill in the
draft's notes, and record it as that platform's lockfile through review. Once
the lockfile exists it alone decides the inputs, and `--pins-from` is refused.

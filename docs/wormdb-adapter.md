# WormDB adapter

`server/persistence/wormdb.ts` implements `DurableStore.read`, `write`, and
`close` using Bun FFI. The daemon embeds the native engine in its own process.
The application acquires its OS ownership guard before opening the database.

## Acknowledgement contract

The adapter requires `wormdb_open_sync`. This additive C ABI entry point opens
full WAL persistence without starting the background writer. Its direct WAL
write path calls `writeAll` and `sync` before returning. Errors propagate through
`wormdb_set` to the adapter, so the daemon cannot return `stored-locally` for a
failed write. It latches write failures until recovery and restart.

Older DLLs with only `wormdb_open` fail at symbol loading. That entry point starts
a background writer whose enqueue acknowledgement does not meet this receipt
contract. The synchronous entry point applies to WAL-backed operations; it does
not make unsafe in-memory procedure mutations durable. Meshrooms binds only
open, close, get, set, and free.

Successful reads copy native buffers before freeing them. Empty values remain
distinct from absent keys, and embedded NUL characters in keys/values are passed
with explicit lengths. Paths reject NUL characters. The pointer bindings require
a 64-bit runtime. Close is idempotent; access after close throws.

## Native dependency availability

The Windows release archive includes a compatible WormDB DLL under its own
[MIT license](../LICENSES/wormdb.txt). Its [source is public](https://github.com/igorls/wormdb),
and the current native pin includes both the synchronous API and security fixes.
Older archives retain their own native artifacts. Do not substitute an asynchronous-only build:
its acknowledgement would violate Meshrooms' local-save contract.

For a qualified local build, place the compatible Windows x64 library at
`.local/native/wormdb_ffi.dll`, or set `WORMDB_LIBRARY_PATH`. That directory is
ignored by Git. Developers can extract the DLL from the versioned Windows release
archive after verifying its checksum. Source builders can use the
[native build procedure](native-build.md). Other platforms require their own builds
and qualification.

## Verification

```powershell
bun test ./server/persistence/wormdb.test.ts
bun run test
```

The optional `WORMDB_LEGACY_LIBRARY_PATH` enables the legacy-symbol rejection
test against an existing old library. Without it, that one case is explicitly
skipped. Native adapter tests use checked temporary directories and cover
Unicode/empty values, recovery, immediate child-process termination after write
acknowledgement, corrupted WAL rejection, and a valid read-only WAL on Windows.
The native FFI test independently injects a read-only WAL handle and checks that
the write returns an error. The daemon integration test checks the same crash
boundary through actual HTTP receipts across two rooms and retries.

The tested evidence is process-crash and restart recovery. Hardware power-loss
qualification, sustained workload/storage growth, and production deployment are
outside this slice. Bun labels [its FFI interface experimental](https://bun.sh/docs/runtime/ffi).
See [local-daemon.md](local-daemon.md) for limits and the next integration steps.

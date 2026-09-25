# Spike: WormDB in the browser

Step 1 of the room's roadmap decision ("WormDB and MeshGuard in the browser"). It answers whether WormDB's core can run
in a browser tab fast and small enough that browser rooms can keep their history in it. Step 2 (replication over
WebRTC, which gives newcomers history) starts only if these gates pass.

| Gate | Target |
| --- | --- |
| Size | core wasm ≤ 300 KB gzipped |
| Writes | append + flush of 1 KB records: p50 ≤ 5 ms, p95 ≤ 20 ms |
| Cold open | 10,000 records ≤ 250 ms, with spot reads correct |
| Crash | kill the page mid-write; reopening recovers every flushed record |

## Engines

- `js`: a reference write-ahead log (`[u32 length][u32 crc32][payload]`, a torn tail cut on open). It sets the
  baseline for OPFS itself.
- `wasm`: WormDB's core built for wasm32 and loaded from `wormdb.wasm` in this folder. The worker provides its file
  I/O on one OPFS `FileSystemSyncAccessHandle` per database:

```
imports  env.fs_size() -> f64
         env.fs_read(ptr, len, at: f64) -> bytes read
         env.fs_write(ptr, len, at: f64) -> bytes written
         env.fs_flush()
         env.fs_truncate(size: f64)
exports  memory, alloc(len) -> ptr, and the core's open / set / get / flush / close
```

The wasm exports are being finalised with Gemini (a key-value API). The harness uses the record number as the key.

## Run

```sh
node run.mjs js    # or wasm, once wormdb.wasm is here; a second argument can point at a playwright install
```

`run.mjs` serves this folder on localhost (a secure context, so OPFS works) and runs every gate in Chrome, Firefox and
WebKit where they are installed. It kills a page mid-write for the crash gate. `index.html` runs the other gates by
hand.

## Results

macOS (Apple Silicon), Playwright with **persistent profiles**. Ephemeral (private) profiles are not representative:
WebKit refuses OPFS there, and Chrome's ephemeral OPFS makes small reads far slower (the same cold open took 1.4 s).

| Gate | `wasm` (Gemini's core), Chrome | `wasm`, WebKit | `js` reference, Chrome |
| --- | --- | --- | --- |
| Size | 4.5 KB gzipped (7.6 KB raw) | same | n/a |
| Writes, 1 KB + flush | p50 0.2 ms, p95 0.4 ms | < 1 ms (Safari timers are 1 ms coarse) | p50 0.1 ms, p95 0.3 ms |
| Cold open, 10,000 records | 42 ms (20,000 OPFS reads) | 41 ms | 19 ms (one read) |
| Crash | recovers every flushed record | same | same |

All four gates pass. Open items:
- Buffered WAL replay in the core (20,000 reads now; one or a few would suffice).
- Firefox: Playwright's Firefox does not launch on this machine; run `node run.mjs wasm` elsewhere.
- The `js` reference engine fails in WebKit ("invalid state"); the `wasm` engine passes there.
- Whether the core uses WormDB's real WAL format, which step 2 needs to replicate one log between browsers and
  native nodes.

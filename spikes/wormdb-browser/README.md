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

Chrome 1 (macOS, Apple Silicon), `js` reference engine:

| Gate | Result |
| --- | --- |
| Writes | p50 0.20 ms, p95 0.30 ms, max 2.8 ms (2,000 × 1 KB, flush each) |
| Cold open | 24 ms for 10,000 records (one read, replay in memory; 20,000 small reads took 1.2 s) |
| Crash | killed at 701 flushed records; reopened with all 701 intact |

OPFS in a worker is far inside the targets, so the gates mostly measure what WormDB's core adds on top.

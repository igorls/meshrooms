// Storage engines for the browser spike, run in a dedicated worker because OPFS sync access handles only exist there.
// `js` is a reference write-ahead log (length + CRC32 framing) that sets the OPFS baseline; `wasm` loads WormDB's
// core (wormdb.wasm) through the same five calls, with this worker providing its file I/O.

const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

async function openHandle(name) {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(name, { create: true });
  return file.createSyncAccessHandle();
}

/** Reference WAL: [u32 length][u32 crc32][payload] records; open replays and cuts a torn tail, as WormDB's WAL does. */
class JsEngine {
  async open(name) {
    this.handle = await openHandle(name); this.offsets = []; this.lengths = [];
    // One read of the whole log, then replay in memory: many small OPFS reads dominate the cost otherwise.
    const size = this.handle.getSize(), log = new Uint8Array(size), head = new DataView(log.buffer);
    this.handle.read(log, { at: 0 });
    let at = 0;
    while (at + 8 <= size) {
      const length = head.getUint32(at, true), crc = head.getUint32(at + 4, true);
      if (length === 0 || at + 8 + length > size) break;
      if (crc32(log.subarray(at + 8, at + 8 + length)) !== crc) break;
      this.offsets.push(at + 8); this.lengths.push(length); at += 8 + length;
    }
    if (at < size) { this.handle.truncate(at); this.handle.flush(); }
    this.end = at;
    return this.offsets.length;
  }
  append(payload) {
    const head = new DataView(new ArrayBuffer(8)); head.setUint32(0, payload.length, true); head.setUint32(4, crc32(payload), true);
    this.handle.write(head, { at: this.end }); this.handle.write(payload, { at: this.end + 8 });
    this.offsets.push(this.end + 8); this.lengths.push(payload.length); this.end += 8 + payload.length;
    return this.offsets.length - 1;
  }
  count() { return this.offsets.length; }
  get(index) { const out = new Uint8Array(this.lengths[index]); this.handle.read(out, { at: this.offsets[index] }); return out; }
  flush() { this.handle.flush(); }
  close() { this.handle.flush(); this.handle.close(); }
}

/**
 * WormDB core compiled to wasm32 (Gemini's build). Host imports, module `opfs`: opfs_size() -> i64,
 * opfs_read(buf, len, offset: i64) -> i32, opfs_write(buf, len, offset: i64) -> i32, opfs_flush() -> i32,
 * opfs_truncate(size: i64) -> i32, opfs_now_ms() -> i64. Exports: memory, wormdb_alloc(len) / wormdb_free(ptr, len),
 * wormdb_open() -> i32, wormdb_set(k, kLen, v, vLen) -> i32, wormdb_get(k, kLen) -> ptr (0 if absent) with
 * wormdb_get_len(), wormdb_flush(), wormdb_close(). Records are keyed by their number (u32 little-endian).
 */
class WasmEngine {
  async open(name) {
    this.handle = await openHandle(name);
    const view = (ptr, len) => new Uint8Array(this.x.memory.buffer, ptr, len);
    const opfs = {
      opfs_size: () => BigInt(this.handle.getSize()),
      opfs_read: (ptr, len, at) => { this.reads = (this.reads || 0) + 1; this.readBytes = (this.readBytes || 0) + len; return this.handle.read(view(ptr, len), { at: Number(at) }); },
      opfs_write: (ptr, len, at) => this.handle.write(view(ptr, len), { at: Number(at) }),
      opfs_flush: () => { this.handle.flush(); return 0; },
      opfs_truncate: (size) => { this.handle.truncate(Number(size)); return 0; },
      opfs_now_ms: () => BigInt(Date.now()),
    };
    const { instance } = await WebAssembly.instantiateStreaming(fetch('wormdb.wasm'), { opfs });
    this.x = instance.exports;
    const status = this.x.wormdb_open();
    if (status < 0) throw new Error(`wormdb_open failed (${status})`);
    this.key = this.x.wormdb_alloc(4); this.next = 0;
    return status;
  }
  withKey(index, fn) { new DataView(this.x.memory.buffer).setUint32(this.key, index, true); return fn(this.key); }
  count() { let n = 0; while (this.get(n)) n++; this.next = n; return n; }
  append(payload) {
    const ptr = this.x.wormdb_alloc(payload.length);
    new Uint8Array(this.x.memory.buffer, ptr, payload.length).set(payload);
    const index = this.next++, status = this.withKey(index, k => this.x.wormdb_set(k, 4, ptr, payload.length));
    this.x.wormdb_free(ptr, payload.length);
    if (status < 0) throw new Error(`wormdb_set failed (${status})`);
    return index;
  }
  get(index) {
    const ptr = this.withKey(index, k => this.x.wormdb_get(k, 4));
    return ptr ? new Uint8Array(this.x.memory.buffer, ptr, this.x.wormdb_get_len()).slice() : undefined;
  }
  flush() { if (this.x.wormdb_flush() < 0) throw new Error('wormdb_flush failed'); }
  close() { this.x.wormdb_close(); this.handle.close(); }
}

const engines = { js: () => new JsEngine(), wasm: () => new WasmEngine() };
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const record = (i, size) => { const r = new Uint8Array(size); crypto.getRandomValues(r); new DataView(r.buffer).setUint32(0, i, true); return r; };

async function removeFile(name) { try { await (await navigator.storage.getDirectory()).removeEntry(name); } catch { /* absent */ } }

const tasks = {
  // Append + flush latency with 1 KB records, one flush per record, like a chat message or task operation.
  async writes({ engine, count = 2000, size = 1024 }) {
    const file = `bench-writes-${engine}`; await removeFile(file);
    const db = engines[engine](); await db.open(file);
    const times = [];
    for (let i = 0; i < count; i++) { const r = record(i, size), t = performance.now(); db.append(r); db.flush(); times.push(performance.now() - t); }
    db.close(); times.sort((a, b) => a - b);
    return { count, size, p50: percentile(times, .5), p95: percentile(times, .95), max: times.at(-1) };
  },
  // Time to open a log of 10,000 records (replay and verify), then spot-check reads.
  async coldOpen({ engine, count = 10000, size = 1024 }) {
    const file = `bench-open-${engine}`; await removeFile(file);
    const db = engines[engine](); await db.open(file);
    for (let i = 0; i < count; i++) db.append(record(i, size));
    db.close();
    const again = engines[engine](), t = performance.now(); await again.open(file); const ms = performance.now() - t;
    const reads = again.reads, readBytes = again.readBytes;
    const found = again.count(), ok = [0, count >> 1, count - 1].every(i => { const r = again.get(i); return !!r && new DataView(r.buffer).getUint32(0, true) === i; });
    again.close();
    return { count, size, found, ms, readsOk: ok, ...(reads ? { opfsReadsDuringOpen: reads, avgReadBytes: Math.round(readBytes / reads) } : {}) };
  },
  // Crash test, first half: append and flush until the page is killed, reporting each flushed index.
  async crashWrite({ engine, size = 1024 }) {
    const file = `bench-crash-${engine}`; await removeFile(file);
    const db = engines[engine](); await db.open(file);
    for (let i = 0; ; i++) {
      db.append(record(i, size)); db.flush();
      if (i % 25 === 0) { postMessage({ progress: i }); await new Promise(r => setTimeout(r, 0)); }
    }
  },
  // Crash test, second half: reopen after the kill; every record up to the last reported flush must be intact.
  async crashVerify({ engine, flushed }) {
    const db = engines[engine](); await db.open(`bench-crash-${engine}`); const found = db.count();
    let intact = true;
    for (let i = 0; i < found; i++) if (new DataView(db.get(i).buffer).getUint32(0, true) !== i) { intact = false; break; }
    db.close();
    return { found, flushed, recovered: found >= flushed + 1 && intact };
  },
};

onmessage = async ({ data }) => {
  try { postMessage({ id: data.id, result: await tasks[data.task](data) }); }
  catch (error) { postMessage({ id: data.id, error: String(error?.message || error) }); }
};

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
  get(index) { const out = new Uint8Array(this.lengths[index]); this.handle.read(out, { at: this.offsets[index] }); return out; }
  flush() { this.handle.flush(); }
  close() { this.handle.flush(); this.handle.close(); }
}

/**
 * WormDB core compiled to wasm32. Expected exports (see README): memory, alloc(len) -> ptr, wdb_open() -> count,
 * wdb_append(ptr, len) -> index, wdb_get(index, outPtr, cap) -> len, wdb_flush(), wdb_close(). File I/O is imported
 * from env: fs_size() -> u64 as f64, fs_read(ptr, len, at) -> n, fs_write(ptr, len, at) -> n, fs_flush(), fs_truncate(size).
 */
class WasmEngine {
  async open(name) {
    this.handle = await openHandle(name);
    const view = (ptr, len) => new Uint8Array(this.exports.memory.buffer, ptr, len);
    const env = {
      fs_size: () => this.handle.getSize(),
      fs_read: (ptr, len, at) => this.handle.read(view(ptr, len), { at: Number(at) }),
      fs_write: (ptr, len, at) => this.handle.write(view(ptr, len), { at: Number(at) }),
      fs_flush: () => this.handle.flush(),
      fs_truncate: (size) => this.handle.truncate(Number(size)),
    };
    const { instance } = await WebAssembly.instantiateStreaming(fetch('wormdb.wasm'), { env });
    this.exports = instance.exports;
    return this.exports.wdb_open();
  }
  append(payload) {
    const ptr = this.exports.alloc(payload.length);
    new Uint8Array(this.exports.memory.buffer, ptr, payload.length).set(payload);
    return this.exports.wdb_append(ptr, payload.length);
  }
  get(index) {
    const cap = 1 << 16, ptr = this.exports.alloc(cap), len = this.exports.wdb_get(index, ptr, cap);
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice();
  }
  flush() { this.exports.wdb_flush(); }
  close() { this.exports.wdb_close(); this.handle.close(); }
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
    const again = engines[engine](), t = performance.now(), found = await again.open(file), ms = performance.now() - t;
    const ok = [0, count >> 1, count - 1].every(i => new DataView(again.get(i).buffer).getUint32(0, true) === i);
    again.close();
    return { count, size, found, ms, readsOk: ok };
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
    const db = engines[engine](), found = await db.open(`bench-crash-${engine}`);
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

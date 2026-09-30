import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Content-addressed attachment bytes. Room access and names live in the node catalog;
 * a blob is only reachable through a room's attachment record.
 */
export interface BlobStore {
  /** Durably store bytes and return their sha256. Must throw rather than report an unconfirmed write. */
  put(bytes: Uint8Array): string;
  /** Bytes whose hash still matches, or null when missing or corrupted. */
  get(hash: string): Uint8Array | null;
  /** Remove blobs not in `keep`. Used once at startup for abandoned uploads. */
  sweep(keep: Set<string>): number;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function memoryBlobs(): BlobStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put(bytes) { const hash = sha256(bytes); data.set(hash, new Uint8Array(bytes)); return hash; },
    get(hash) { const bytes = data.get(hash); return bytes && sha256(bytes) === hash ? bytes : null; },
    sweep(keep) { let removed = 0; for (const hash of [...data.keys()]) if (!keep.has(hash)) { data.delete(hash); removed++; } return removed; },
  };
}

/** Files under `<root>/<first two hex>/<sha256>`, written to a temporary name, fsynced, then renamed. */
export function fileBlobs(root: string): BlobStore {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = (hash: string) => join(root, hash.slice(0, 2), hash);
  const syncDirectory = (directory: string) => {
    // Windows cannot open directories for fsync; NTFS rename durability is handled by the file flush.
    if (process.platform === 'win32') return;
    const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  return {
    put(bytes) {
      const hash = sha256(bytes); const target = path(hash);
      if (existsSync(target) && this.get(hash)) return hash;
      const directory = join(root, hash.slice(0, 2)); mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.${hash}.${randomUUID()}.tmp`);
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
      } catch (error) { closeSync(fd); try { unlinkSync(temporary); } catch { /* Best effort. */ } throw error; }
      closeSync(fd); renameSync(temporary, target); syncDirectory(directory);
      return hash;
    },
    get(hash) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      try { const bytes = readFileSync(path(hash)); return sha256(bytes) === hash ? new Uint8Array(bytes) : null; }
      catch { return null; }
    },
    sweep(keep) {
      let removed = 0;
      for (const prefix of readdirSync(root)) {
        if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
        for (const name of readdirSync(join(root, prefix))) {
          if (keep.has(name)) continue;
          try { unlinkSync(join(root, prefix, name)); removed++; } catch { /* Retried next startup. */ }
        }
      }
      return removed;
    },
  };
}

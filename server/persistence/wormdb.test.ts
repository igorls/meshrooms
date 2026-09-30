import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openWormDBStore } from './wormdb.ts';
import { defaultOptions } from '../daemon';
import { testDirectory } from '../test-directory';

const CANDIDATE_DLL = defaultOptions().libraryPath;
const OLD_DLL = process.env.WORMDB_LEGACY_LIBRARY_PATH;

const tempDirsToClean: ReturnType<typeof testDirectory>[] = [];

function makeTempDir(prefix = 'meshrooms-wormdb-'): string {
  const dir = testDirectory(prefix);
  tempDirsToClean.push(dir);
  return dir.path;
}

afterEach(() => {
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop()!;
    dir.cleanup();
  }
});

describe('WormDB Synchronous Persistence Adapter', () => {
  describe('Symbol Enforcement and Fail-Closed Safety', () => {
    it.skipIf(!OLD_DLL)('requires wormdb_open_sync and fails closed when opened with legacy DLL', () => {
      const dir = makeTempDir('legacy-fail-closed-');
        expect(() => openWormDBStore({ dataDir: dir, libraryPath: OLD_DLL! })).toThrow(
          /wormdb_open_sync/,
        );
    });

    it('successfully initializes with candidate DLL supporting wormdb_open_sync', () => {
      const dir = makeTempDir('candidate-open-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        store.write('init_test', 'ok');
        expect(store.read('init_test')).toBe('ok');
      } finally {
        store.close();
      }
    });
  });

  describe('Basic CRUD Operations', () => {
    it('returns null for absent keys', () => {
      const dir = makeTempDir('absent-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        expect(store.read('non_existent_key')).toBeNull();
        expect(store.read('another_missing_key')).toBeNull();
      } finally {
        store.close();
      }
    });

    it('writes and reads back values synchronously', () => {
      const dir = makeTempDir('crud-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        store.write('room:meta', '{"name":"general","members":3}');
        expect(store.read('room:meta')).toBe('{"name":"general","members":3}');
      } finally {
        store.close();
      }
    });

    it('overwrites existing keys with updated values', () => {
      const dir = makeTempDir('overwrite-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        store.write('state', 'step-1');
        expect(store.read('state')).toBe('step-1');

        store.write('state', 'step-2');
        expect(store.read('state')).toBe('step-2');

        store.write('state', 'step-3');
        expect(store.read('state')).toBe('step-3');
      } finally {
        store.close();
      }
    });

    it('handles multiple independent keys concurrently', () => {
      const dir = makeTempDir('multiple-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        const count = 40;
        for (let i = 0; i < count; i++) {
          store.write(`key:${i}`, `value:${i * 2}`);
        }

        for (let i = 0; i < count; i++) {
          expect(store.read(`key:${i}`)).toBe(`value:${i * 2}`);
        }
      } finally {
        store.close();
      }
    });
  });

  describe('Unicode, Emojis, and Binary Preservation', () => {
    it('preserves multi-byte UTF-8 scripts and emojis', () => {
      const dir = makeTempDir('unicode-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        const cases = [
          { k: 'emoji:🚀🔥', v: 'Meshrooms rocket payload ✨🛡️💎' },
          { k: 'jp:部屋', v: '永続化ローカルストレージ' },
          { k: 'ru:хранилище', v: 'Синхронная запись данных' },
          { k: 'ar:بيانات', v: 'تخزين آمن ومباشر' },
          { k: 'math:λ', v: '∀x ∈ ℝ: x² ≥ 0 ∧ λ > 0' },
        ];

        for (const c of cases) {
          store.write(c.k, c.v);
        }

        for (const c of cases) {
          expect(store.read(c.k)).toBe(c.v);
        }
      } finally {
        store.close();
      }
    });

    it('preserves embedded null bytes (\\0) in keys and values', () => {
      const dir = makeTempDir('nulls-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        const nullKey = 'room\x00participant\x00id';
        const nullVal = 'raw\x00binary\x00payload\x00data';

        store.write(nullKey, nullVal);
        const result = store.read(nullKey);

        expect(result).not.toBeNull();
        expect(result).toBe(nullVal);
        expect(result!.length).toBe(nullVal.length);
      } finally {
        store.close();
      }
    });

    it('preserves empty string values distinctly from null', () => {
      const dir = makeTempDir('empty-val-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        store.write('empty_key', '');
        const res = store.read('empty_key');

        expect(res).toBe('');
        expect(res).not.toBeNull();
      } finally {
        store.close();
      }
    });

    it('preserves empty string keys', () => {
      const dir = makeTempDir('empty-key-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        store.write('', 'root_value');
        expect(store.read('')).toBe('root_value');
      } finally {
        store.close();
      }
    });
  });

  describe('Durability and Hard Crash Recovery', () => {
    it('persists data across orderly close and reopen cycles', () => {
      const dir = makeTempDir('reopen-');

      const store1 = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      store1.write('persisted:1', 'alpha');
      store1.write('persisted:2', 'bravo');
      store1.close();

      const store2 = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        expect(store2.read('persisted:1')).toBe('alpha');
        expect(store2.read('persisted:2')).toBe('bravo');
        expect(store2.read('persisted:3')).toBeNull();

        store2.write('persisted:3', 'charlie');
      } finally {
        store2.close();
      }

      const store3 = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        expect(store3.read('persisted:3')).toBe('charlie');
      } finally {
        store3.close();
      }
    });

    it('survives immediate SIGKILL forced-exit with zero delay after write returns', async () => {
      const dir = makeTempDir('immediate-sigkill-');
      const childScript = path.join(dir, 'child_immediate_writer.mjs');

      const normalizedDir = JSON.stringify(dir);
      const normalizedLib = JSON.stringify(CANDIDATE_DLL);
      const normalizedWormdb = JSON.stringify(path.join(import.meta.dir, 'wormdb.ts').replace(/\\/g, '/'));

      fs.writeFileSync(
        childScript,
        `
import { openWormDBStore } from ${normalizedWormdb};
const store = openWormDBStore({
  dataDir: ${normalizedDir},
  libraryPath: ${normalizedLib},
});
store.write('immediate_sync_1', 'critical_payload_1');
store.write('immediate_sync_2', 'critical_payload_2');

// Emit READY immediately upon write return: NO sleep, NO setTimeout
process.stdout.write('READY\\n');

// Hang indefinitely so parent must kill with SIGKILL
setInterval(() => {}, 10000);
`,
      );

      const child = spawn(process.execPath, [childScript]);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Timed out waiting for child READY signal'));
        }, 5000);

        let stdout = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
          if (stdout.includes('READY')) {
            clearTimeout(timeout);
            // Immediate ungraceful kill of child
            child.kill('SIGKILL');
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        child.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Parent opens store and verifies immediate acknowledged writes were physically on disk
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        expect(store.read('immediate_sync_1')).toBe('critical_payload_1');
        expect(store.read('immediate_sync_2')).toBe('critical_payload_2');
      } finally {
        store.close();
      }
    });
  });

  describe('Lifecycle and Idempotency', () => {
    it('allows repeated close() calls without throwing or crashing', () => {
      const dir = makeTempDir('close-idempotent-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });

      expect(() => {
        store.close();
        store.close();
        store.close();
      }).not.toThrow();
    });

    it('throws when attempting read() after close()', () => {
      const dir = makeTempDir('read-after-close-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      store.write('k', 'v');
      store.close();

      expect(() => store.read('k')).toThrow('Cannot read from a closed WormDBStore');
    });

    it('throws when attempting write() after close()', () => {
      const dir = makeTempDir('write-after-close-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      store.close();

      expect(() => store.write('k', 'v')).toThrow('Cannot write to a closed WormDBStore');
    });
  });

  describe('Validation and Failure Rejection', () => {
    it('rejects invalid or missing options with TypeError', () => {
      // @ts-ignore
      expect(() => openWormDBStore(null)).toThrow(TypeError);
      // @ts-ignore
      expect(() => openWormDBStore({})).toThrow(TypeError);
      // @ts-ignore
      expect(() => openWormDBStore({ dataDir: 123, libraryPath: CANDIDATE_DLL })).toThrow(
        TypeError,
      );
      // @ts-ignore
      expect(() => openWormDBStore({ dataDir: '/tmp', libraryPath: 123 })).toThrow(TypeError);
      expect(() => openWormDBStore({ dataDir: '', libraryPath: CANDIDATE_DLL })).toThrow(
        TypeError,
      );
      expect(() => openWormDBStore({ dataDir: '/tmp', libraryPath: '' })).toThrow(TypeError);
    });

    it('rejects paths containing NUL bytes', () => {
      expect(() =>
        openWormDBStore({ dataDir: '/tmp/db\0bad', libraryPath: CANDIDATE_DLL }),
      ).toThrow(/NUL/);

      expect(() =>
        openWormDBStore({ dataDir: '/tmp/db', libraryPath: `${CANDIDATE_DLL}\0bad` }),
      ).toThrow(/NUL/);
    });

    it('throws when library file does not exist', () => {
      const dir = makeTempDir('bad-lib-');
      expect(() =>
        openWormDBStore({ dataDir: dir, libraryPath: 'non/existent/path/libwormdb.dll' }),
      ).toThrow(/not found/);
    });

    it('throws when dataDir is a file instead of directory', () => {
      const dir = makeTempDir('file-as-dir-');
      const filePath = path.join(dir, 'file.txt');
      fs.writeFileSync(filePath, 'contents');

      expect(() => openWormDBStore({ dataDir: filePath, libraryPath: CANDIDATE_DLL })).toThrow();
    });

    it('throws TypeError when key or value is not a string', () => {
      const dir = makeTempDir('type-error-');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      try {
        // @ts-ignore
        expect(() => store.write(123, 'val')).toThrow(TypeError);
        // @ts-ignore
        expect(() => store.write('key', 123)).toThrow(TypeError);
        // @ts-ignore
        expect(() => store.read(123)).toThrow(TypeError);
      } finally {
        store.close();
      }
    });

    it('throws and fails closed when opening store with corrupted WAL fixture', () => {
      const fixtureDir = path.join(import.meta.dir, 'fixtures/corrupted-wal');
      const dir = makeTempDir('fixture-corrupted-');

      fs.cpSync(fixtureDir, dir, { recursive: true });

      expect(() => openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL })).toThrow(
        'Failed to open WormDB database',
      );
    });

    it.skipIf(process.platform !== 'win32')('throws when a valid WAL is read-only on Windows', () => {
      const dir = makeTempDir('readonly-wal-');
      const walFile = path.join(dir, 'wormdb.wal');
      const store = openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL });
      store.write('valid', 'wal');
      store.close();
      fs.chmodSync(walFile, 0o444);

      try {
        expect(() => openWormDBStore({ dataDir: dir, libraryPath: CANDIDATE_DLL })).toThrow(
          'Failed to open WormDB database',
        );
      } finally {
        fs.chmodSync(walFile, 0o666);
      }
    });
  });
});

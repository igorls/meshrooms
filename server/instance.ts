import { dlopen, ptr } from 'bun:ffi';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const heldHere = new Set<string>();

/** Another live process holds this node; supervisors treat this as already running, not as a crash. */
export class InstanceOwnedError extends Error {
  constructor() { super('A Meshrooms daemon already owns this data directory.'); }
}

/** OS ownership is released even when the process is killed; no stale PID-file takeover. */
export function acquireInstance(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(dataDir);
  let scope = canonical;
  let unlock: () => void;
  if (process.platform === 'win32') {
    const library = dlopen('kernel32.dll', {
      CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
      GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'i32' },
      CreateMutexW: { args: ['ptr', 'i32', 'ptr'], returns: 'u64' },
      WaitForSingleObject: { args: ['u64', 'u32'], returns: 'u32' },
      ReleaseMutex: { args: ['u64'], returns: 'i32' },
      CloseHandle: { args: ['u64'], returns: 'i32' },
    });
    // Key ownership to the directory object, not its spelling. Drive, junction,
    // case and extended-path aliases must not produce independent writers.
    const path = Buffer.from(`${canonical}\0`, 'utf16le');
    const directory = library.symbols.CreateFileW(ptr(path), 0, 7, null, 3, 0x02000000, 0n);
    if (directory === 0xffffffffffffffffn) { library.close(); throw new Error('Cannot identify the Meshrooms data directory.'); }
    const information = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION, fixed Win32 layout.
    const identified = library.symbols.GetFileInformationByHandle(directory, ptr(information));
    library.symbols.CloseHandle(directory);
    if (!identified) { library.close(); throw new Error('Cannot identify the Meshrooms data directory.'); }
    scope = `${information.readUInt32LE(28)}:${information.readUInt32LE(44)}:${information.readUInt32LE(48)}`;
    if (heldHere.has(scope)) { library.close(); throw new InstanceOwnedError(); }
    const name = Buffer.from(`Global\\Meshrooms.${createHash('sha256').update(scope).digest('hex')}\0`, 'utf16le');
    const handle = library.symbols.CreateMutexW(null, 0, ptr(name));
    if (handle === 0n) { library.close(); throw new Error('Cannot acquire the Meshrooms data-directory mutex.'); }
    const status = library.symbols.WaitForSingleObject(handle, 0);
    if (status !== 0 && status !== 0x80) {
      library.symbols.CloseHandle(handle); library.close();
      throw new Error('A Meshrooms daemon already owns this data directory, or its mutex is unavailable.');
    }
    unlock = () => { library.symbols.ReleaseMutex(handle); library.symbols.CloseHandle(handle); library.close(); };
  } else {
    if (heldHere.has(scope)) throw new InstanceOwnedError();
    const library = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: ['i32', 'i32'], returns: 'i32' },
    });
    let fd: number;
    try { fd = openSync(join(canonical, '.instance.lock'), 'a', 0o600); }
    catch (error) { library.close(); throw error; }
    if (library.symbols.flock(fd, 2 | 4) !== 0) {
      closeSync(fd); library.close(); throw new InstanceOwnedError();
    }
    unlock = () => { library.symbols.flock(fd, 8); closeSync(fd); library.close(); };
  }
  heldHere.add(scope);
  let released = false;
  return () => { if (!released) { released = true; try { unlock(); } finally { heldHere.delete(scope); } } };
}

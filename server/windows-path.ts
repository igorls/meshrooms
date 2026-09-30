import { dlopen, ptr } from 'bun:ffi';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Node realpath can retain an AppData alias even when Windows redirects writes. */
export function physicalWindowsDirectory(path: string): string {
  const library = dlopen('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFinalPathNameByHandleW: { args: ['u64', 'ptr', 'u32', 'u32'], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
  });
  const encoded = Buffer.from(`${resolve(path)}\0`, 'utf16le');
  const handle = library.symbols.CreateFileW(ptr(encoded), 0, 7, null, 3, 0x02000000, 0n);
  try {
    if (handle === 0xffffffffffffffffn) throw new Error('Cannot inspect the Windows directory.');
    const buffer = Buffer.alloc(65536);
    const count = library.symbols.GetFinalPathNameByHandleW(handle, ptr(buffer), 32768, 0);
    if (!count || count >= 32768) throw new Error('Cannot resolve the Windows directory.');
    const physical = buffer.subarray(0, count * 2).toString('utf16le');
    return physical.startsWith('\\\\?\\UNC\\') ? `\\\\${physical.slice(8)}` : physical.replace(/^\\\\\?\\/, '');
  } finally {
    if (handle !== 0xffffffffffffffffn) library.symbols.CloseHandle(handle);
    library.close();
  }
}

/** Conservative check: redirected hosts cannot prove a system-visible Run entry. */
export function startupHostStatus(localAppData = process.env.LOCALAPPDATA): { supported: boolean; message?: string } {
  const message = 'Start at login cannot be verified from this launcher. Restart the daemon from a regular Windows terminal to configure it.';
  if (!localAppData) return { supported: false, message };
  let probe: string | undefined;
  try {
    probe = mkdtempSync(join(resolve(localAppData), '.meshrooms-startup-check-'));
    if (physicalWindowsDirectory(probe).toLowerCase() !== resolve(probe).toLowerCase()) return { supported: false, message };
    return { supported: true };
  } catch { return { supported: false, message }; }
  finally { if (probe) rmdirSync(probe); } // Only the empty directory created by this call.
}

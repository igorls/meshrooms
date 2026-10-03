/**
 * Locks and process liveness shared by the bridge's commands, the watcher and the daemon: a lock file that names its
 * process, taken over only once that process is gone.
 */
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Whether a process on this machine is still running; the folder is local, so the lock's owner is too. On Linux a process
 * that exited but isn't reaped yet (a zombie) still answers signal 0, though it runs nothing: it doesn't count.
 */
export function running(pid: number) {
  try { process.kill(pid, 0); } catch (error) { if ((error as { code?: string }).code !== 'EPERM') return false; }
  return !zombie(pid);
}
/** Whether the process has exited and waits to be reaped (Linux only; elsewhere this is never seen). */
export function zombie(pid: number) {
  if (process.platform !== 'linux') return false;
  try { return /\)\s+Z\s/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}
/**
 * A lock is taken over only once the process it names has exited, however long a live one takes (a laptop asleep
 * mid-connect keeps it). Locks are created already naming their process, so a live connect's lock never looks
 * ownerless; a file that names no process is never taken over. Returns what the lock looked like when found stale,
 * so a takeover can check it is replacing that same file. `gone` judges the owner when the default (it has exited) isn't
 * enough: a pid the system gave another program after a reboot.
 *
 * `maxAgeMs`, for a lock only ever held for moments: one older than that is stale whoever it names, so a holder that
 * crashed and whose pid another process got since, or a file that names no process, ages out.
 */
export function staleLock(path: string, gone: (pid: number) => boolean = pid => !running(pid), maxAgeMs?: number) {
  try {
    const found = statSync(path), owner = readFileSync(path, 'utf8');
    const old = maxAgeMs !== undefined && Date.now() - found.mtimeMs > maxAgeMs;
    return old || (/^\d{1,10}$/.test(owner) && gone(Number(owner))) ? `${found.ino}:${found.mtimeMs}:${owner}` : undefined;
  } catch { return undefined; }
}
/** Creates a lock with its owner already in it: written to a private file, then hard-linked into place, which fails if one exists. */
export function takeLock(path: string) {
  const draft = `${path}.${process.pid}.${randomUUID()}`;
  writeFileSync(draft, String(process.pid), { flag: 'wx', mode: 0o600 });
  try { linkSync(draft, path); }
  catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') throw error;
    // No hard links on this file system (FAT, some network shares): create it in place. A crash between creating
    // and writing then leaves a lock that names no process, which is never taken over, only reported.
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  } finally { unlinkSync(draft); }
}
export const exists = (error: unknown) => (error as { code?: string }).code === 'EEXIST';
/**
 * Takes `lock` for this process, or false while another live process holds it. A holder that crashed leaves its lock
 * behind; taking that over is exclusive too. Only the holder of `<lock>.reclaim` may replace it, and only while it is
 * still the same stale file, so two processes can never both take it. `what` names the holder in errors; `gone`, when
 * the lock's holder is gone, and `maxAgeMs` (see staleLock): a reclaim marker that old is removed too, rather than reported.
 */
export function tryLock(lock: string, what: string, gone?: (pid: number) => boolean, options: { maxAgeMs?: number } = {}): boolean {
  const reclaim = `${lock}.reclaim`, { maxAgeMs } = options;
  try { takeLock(lock); return true; }
  catch (error) {
    if (!exists(error)) throw error;
    const seen = staleLock(lock, gone, maxAgeMs);
    if (!seen) {
      let owner: string | undefined; try { owner = readFileSync(lock, 'utf8'); } catch { /* Released meanwhile. */ }
      if (owner !== undefined && !/^\d{1,10}$/.test(owner)) throw new Error(`${lock} doesn't name the ${what} that made it. If no ${what} is running, delete that file, then try again.`);
      return false;
    }
    // Reclaiming takes milliseconds; a marker whose process is gone was left by a crash in exactly that window.
    try { takeLock(reclaim); }
    catch (error) {
      if (!exists(error)) throw error;
      const left = staleLock(reclaim, undefined, maxAgeMs);
      if (left && maxAgeMs !== undefined) {
        // Left by a crash: removed while it is still that same file, and the caller tries again.
        if (staleLock(reclaim, undefined, maxAgeMs) === left) try { unlinkSync(reclaim); } catch { /* Gone meanwhile. */ }
        return false;
      }
      if (left) throw new Error(`A crashed ${what} left ${reclaim}. Delete that file, then try again.`);
      return false;
    }
    try {
      if (staleLock(lock, gone, maxAgeMs) !== seen) return false;
      unlinkSync(lock);
      try { takeLock(lock); return true; } catch (error) { if (exists(error)) return false; throw error; }
    } finally { unlinkSync(reclaim); }
  }
}

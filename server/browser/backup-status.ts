import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The backup job (deploy/backup/backup-admission.ts) records its last verified backup in this file, inside the
 * admission data directory. That directory is the one place both the root backup job and the sandboxed service
 * can reach: the backups themselves stay in a root-only folder. The job writes it atomically, owned by the service
 * user with mode 0600. It holds only a time, a file name and a size.
 */
export const BACKUP_STATUS_FILE = 'last-backup.json';

export type BackupStatus = { at: number; file?: string; bytes?: number };

/** Time of the last verified backup, or undefined when the file is missing or unreadable. */
export function readBackupStatus(dataDir: string): number | undefined {
  try {
    const status = JSON.parse(readFileSync(join(dataDir, BACKUP_STATUS_FILE), 'utf8')) as BackupStatus;
    return Number.isSafeInteger(status.at) && status.at > 0 ? status.at : undefined;
  } catch { return undefined; }
}

/**
 * Whether the last verified backup is at most `maxAgeHours` old. The file is read at most once a minute, so the
 * health endpoint stays one small read at worst. A missing, unreadable or future-dated record counts as stale.
 */
export function backupFreshness(dataDir: string, maxAgeHours: number, now: () => number = Date.now, cacheMs = 60_000) {
  let readAt = -Infinity, at: number | undefined;
  return () => {
    const time = now();
    if (time - readAt >= cacheMs || time < readAt) { at = readBackupStatus(dataDir); readAt = time; }
    return at !== undefined && at <= time + 60_000 && time - at <= maxAgeHours * 3_600_000;
  };
}

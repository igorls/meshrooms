/**
 * Test helper: a process whose command line is exactly what the bridge looks for (`bun <dir>/meshrooms-agent.js <verb>
 * --room <room>`) and that writes the proof of life it is told to, so the real process lookups, the runner lock and the
 * kills can be tested without a real runner or a room service.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processInfo } from '../agent-watch';

/** stuck: its loop stopped coming round ten minutes ago. silent: its loop runs, but the room service hasn't answered for ten minutes. */
export type FakeKind = 'stuck' | 'silent' | 'none';

const SCRIPT = `const { renameSync, writeFileSync } = require('node:fs');
const file = process.env.FAKE_PROOF, kind = process.env.FAKE_KIND;
const write = () => {
  if (!file) return;
  const now = Date.now(), old = now - 600000;
  const proof = { pid: process.pid, at: now, startedAt: old, loopAt: kind === 'stuck' ? old : now, polledAt: old,
    ...(kind === 'silent' ? { failingSince: old, failure: 'fetch failed' } : {}) };
  // Replaced by rename, so a reader never sees half a file; a reader holding it open on Windows only skips one write.
  try { writeFileSync(file + '.fake', JSON.stringify(proof)); renameSync(file + '.fake', file); } catch {}
};
write(); setInterval(write, 500);
// Never outlives a test run that was killed before it could clean up.
setTimeout(() => process.exit(0), 300000);
`;

export async function fakeRunner(dir: string, roomId: string, options: { kind?: FakeKind; proofFile?: string; verb?: 'run' | 'watch-run' } = {}) {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'meshrooms-agent.js');
  if (!existsSync(script)) writeFileSync(script, SCRIPT);
  const child = spawn(process.execPath, [script, options.verb ?? 'run', '--room', roomId], { detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, FAKE_PROOF: options.proofFile ?? '', FAKE_KIND: options.kind ?? 'none' } });
  child.unref();
  const pid = child.pid!;
  // Ready once the system shows its command line (and its first proof is written): a lookup before that sees nothing.
  const proofOk = () => { try { return !options.proofFile || JSON.parse(readFileSync(options.proofFile, 'utf8')).pid === pid; } catch { return false; } };
  for (const by = Date.now() + 20_000; !(proofOk() && processInfo(pid)?.command.includes('meshrooms-agent.js'));) {
    if (Date.now() > by) { try { process.kill(pid); } catch { /* Gone. */ } throw new Error('the fake runner did not start'); }
    await Bun.sleep(100);
  }
  return { pid, started: processInfo(pid)?.started, alive: () => processRuns(pid), kill: () => { try { process.kill(pid); } catch { /* Gone. */ } } };
}
/**
 * Whether the process runs: one killed but not yet reaped (a zombie, on Linux; by this test, or by init for an orphaned
 * runner) doesn't count, so a check right after a stop doesn't depend on when it is reaped.
 */
export function processRuns(pid: number) {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try { return !/\)\s+Z\s/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

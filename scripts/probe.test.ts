import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { backupResult, bindingRequest, controlOk, evaluate, isBindingSuccess, type Result, type State } from '../deploy/probe/meshrooms-probe';

const probe = resolve(import.meta.dir, '../deploy/probe/meshrooms-probe.ts');
const ok = (name: string): Result => ({ name, ok: true, detail: 'fine' });
const bad = (name: string): Result => ({ name, ok: false, detail: `${name} broke` });
const empty: State = { streaks: {}, alerting: [] };
const HOUR = 3_600_000;

test('alerts only after consecutive failures, then on recovery', () => {
  const first = evaluate(empty, [ok('health'), bad('turn-udp')], 'a'.repeat(40), 0, 2);
  expect(first.messages).toEqual([]);
  expect(first.state.streaks['turn-udp']).toBe(1);
  const second = evaluate(first.state, [ok('health'), bad('turn-udp')], 'a'.repeat(40), 2 * 60_000, 2);
  expect(second.failing).toEqual(['turn-udp']);
  expect(second.messages).toHaveLength(1);
  expect(second.messages[0]).toContain('turn-udp: turn-udp broke');
  const quiet = evaluate(second.state, [ok('health'), bad('turn-udp')], 'a'.repeat(40), HOUR, 2);
  expect(quiet.messages).toEqual([]);
  const reminder = evaluate(quiet.state, [ok('health'), bad('turn-udp')], 'a'.repeat(40), 2 * 60_000 + 3 * HOUR, 2);
  expect(reminder.messages[0]).toContain('still failing');
  const recovered = evaluate(reminder.state, [ok('health'), ok('turn-udp')], 'a'.repeat(40), 4 * HOUR, 2);
  expect(recovered.messages).toEqual(['✅ Meshrooms probe: all checks pass again (recovered: turn-udp)']);
  expect(recovered.state.alerting).toEqual([]);
});

test('a change in which checks fail is a state change', () => {
  const failing: State = { streaks: { health: 5 }, alerting: ['health'], lastAlertAt: 0 };
  const next = evaluate(failing, [ok('health'), bad('rooms')], undefined, 60_000, 1);
  expect(next.messages[0]).toContain('rooms: rooms broke');
  expect(next.messages[0]).toContain('Recovered: health');
});

test('announces a new deployed revision once', () => {
  const before: State = { ...empty, revision: 'a'.repeat(40) };
  const deployed = evaluate(before, [ok('health')], 'b'.repeat(40), 0, 2);
  expect(deployed.messages).toEqual([`ℹ️ Meshrooms deployed revision ${'b'.repeat(12)} (was ${'a'.repeat(12)})`]);
  expect(evaluate(deployed.state, [ok('health')], 'b'.repeat(40), 1, 2).messages).toEqual([]);
  // An unreachable health endpoint keeps the last known revision.
  expect(evaluate(deployed.state, [bad('health')], undefined, 2, 2).state.revision).toBe('b'.repeat(40));
});

test('the backup flag is a check only when health carries it', () => {
  expect(backupResult({})).toBeUndefined();
  expect(backupResult(undefined)).toBeUndefined();
  expect(backupResult({ backupFresh: true })).toMatchObject({ name: 'backup', ok: true });
  expect(backupResult({ backupFresh: false })).toMatchObject({ name: 'backup', ok: false });
  // A stale backup alerts under the same rules as every other check.
  const stale = backupResult({ backupFresh: false })!;
  const first = evaluate(empty, [ok('health'), stale], undefined, 0, 2);
  const second = evaluate(first.state, [ok('health'), stale], undefined, 120_000, 2);
  expect(second.failing).toEqual(['backup']);
  expect(second.messages[0]).toContain('backup: no verified admission backup');
  // While health is down the flag is not reported; the backup alert stays open instead of looking recovered.
  const down = evaluate(second.state, [bad('health')], undefined, 240_000, 2);
  expect(down.messages).toEqual([]);
  expect(down.state.alerting).toEqual(['backup']);
  const fresh = evaluate(down.state, [ok('health'), backupResult({ backupFresh: true })!], undefined, 360_000, 2);
  expect(fresh.messages).toEqual(['✅ Meshrooms probe: all checks pass again (recovered: backup)']);
});

test('the DNS control check passes when a name resolves and fails when none does', async () => {
  expect(await controlOk(['localhost'])).toBe(true);
  expect(await controlOk(['meshrooms-control-check.invalid'])).toBe(false);
});

test('STUN binding request carries the magic cookie and matches only its own transaction', () => {
  const { id, message } = bindingRequest();
  expect(message.length).toBe(20);
  expect(message.readUInt16BE(0)).toBe(0x0001);
  expect(message.readUInt32BE(4)).toBe(0x2112a442);
  const reply = Buffer.from(message); reply.writeUInt16BE(0x0101, 0);
  expect(isBindingSuccess(reply, id)).toBe(true);
  expect(isBindingSuccess(reply, Buffer.alloc(12))).toBe(false);
});

// The probe runs on Linux; curl's -o /dev/null has no Windows equivalent.
test.skipIf(process.platform === 'win32')('hands the token to curl on stdin and never prints it', async () => {
  const received: Record<string, string>[] = [];
  const paths: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    paths.push(new URL(request.url).pathname);
    received.push(Object.fromEntries(new URLSearchParams(await request.text())));
    return Response.json({ ok: true });
  } });
  try {
    const token = '123456:SECRET-token_value';
    const run = (env: Record<string, string>) => new Promise<ReturnType<typeof spawnSync>>(done => {
      const child = Bun.spawn(['bun', probe, '--test-alert'], { env: { ...process.env, MESHROOMS_PROBE_TELEGRAM_API: `http://127.0.0.1:${server.port}`, TELEGRAM_CHAT_ID: '-100123', ...env }, stdout: 'pipe', stderr: 'pipe' });
      void Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, status]) => done({ stdout, stderr, status } as never));
    });
    const sent = await run({ TELEGRAM_BOT_TOKEN: token });
    expect(sent.status).toBe(0);
    expect(paths).toEqual([`/bot${token}/sendMessage`]);
    expect(received[0].chat_id).toBe('-100123');
    expect(received[0].text).toContain('test alert');
    expect(`${sent.stdout}${sent.stderr}`).not.toContain('SECRET');
    const missing = await run({ TELEGRAM_BOT_TOKEN: '' });
    expect(missing.status).toBe(1);
    expect(String(missing.stderr)).toContain('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing');
  } finally { server.stop(true); }
  expect(spawnSync('bun', [probe, '--bogus']).status).toBe(2);
});

import { expect, test } from 'bun:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalNode } from './node';
import { CATALOG, CATALOG_V1, fingerprint, historyKey, tokenHash } from './model';
import { startDaemon, defaultOptions } from './daemon';
import { testStartupManager } from './startup';
import { testDirectory } from './test-directory';
import { NodeAccess } from './access';
import { runCli } from './cli';
import { ensureRunning, probeRuntime } from './runtime';

test('v1 migration preserves old authors and requests; setup adds a separately authorized agent and recovers', () => {
  const ownerId = randomUUID(), roomId = randomUUID(), nodeId = randomUUID(), messageId = randomUUID(), requestId = randomUUID();
  const owner = { id: ownerId, name: 'You', role: 'human', state: 'local', detail: 'Local participant · room member' };
  const records = new Map<string, string>([
    [CATALOG_V1, JSON.stringify({ version: 1, nodeId, localParticipant: owner, rooms: [{ id: roomId, title: 'Existing work', project: 'Project', sample: false,
      participants: [owner], requestId: roomId, fingerprint: fingerprint({ title: 'Existing work', project: 'Project' }) }] })],
    [historyKey(roomId), JSON.stringify({ version: 1, roomId, messages: [{ id: messageId, authorId: ownerId, author: 'You', role: 'human', text: 'Keep this history',
      time: new Date().toISOString(), requestId, fingerprint: fingerprint({ text: 'Keep this history' }) }] })],
  ]);
  const original = records.get(CATALOG_V1);
  const store = () => ({ read: (key: string) => records.get(key) ?? null, write: (key: string, value: string) => { records.set(key, value); }, close() {} });
  const node = new LocalNode(store()); expect(records.has(CATALOG)).toBe(true);
  const intentId = randomUUID(), secret = randomBytes(32).toString('base64url');
  const prepare = { requestId: intentId, title: 'With an agent', project: 'Project', agentName: 'Codex', credentialHash: tokenHash(secret) };
  node.prepareRoom(prepare); expect(node.prepareRoom(prepare).id).toBe(intentId); expect(node.authenticateAgent(secret)).toBeUndefined();
  expect(node.snapshot().rooms).toHaveLength(1);
  const command = { requestId: randomUUID(), humanName: 'Igor', machineName: 'Workstation', startAtLogin: false, intentId };
  expect(node.completeSetup(command)).toEqual({ roomId: intentId }); expect(node.completeSetup(command)).toEqual({ roomId: intentId });
  const agent = node.authenticateAgent(secret)!;
  expect(node.snapshot(agent).rooms.map(r => r.id)).toEqual([intentId]);
  expect(() => node.send({ roomId, requestId: randomUUID(), text: 'No cross-room write' }, agent)).toThrow('not available');
  expect(() => node.createRoom({ requestId: randomUUID(), title: 'Denied' }, agent)).toThrow('human session');
  expect(() => node.send({ roomId: intentId, requestId, text: 'Agent authored' }, agent)).toThrow('humans-first');
  expect(() => node.setFloor({ roomId: intentId, requestId: randomUUID(), floor: 'open' }, agent)).toThrow('human session');
  node.setFloor({ roomId: intentId, requestId: randomUUID(), floor: 'open' });
  node.send({ roomId: intentId, requestId, text: 'Agent authored' }, agent);
  node.send({ roomId: intentId, requestId, text: 'Human authored' });
  const access = new NodeAccess(secret, node); const cookie = access.exchangeBrowserTicket(access.issueBrowserTicket()).split(';')[0];
  node.close();
  const restored = new LocalNode(store());
  try {
    expect(records.get(CATALOG_V1)).toBe(original);
    expect(restored.nodeId).toBe(nodeId); expect(restored.settings.humanName).toBe('Igor');
    expect(restored.snapshot().rooms.map(r => r.floor)).toEqual(['humans-first', 'open']);
    expect(restored.snapshot().rooms[0].messages[0].author).toBe('You');
    expect(restored.snapshot().rooms[1].messages.map(m => [m.author, m.role])).toEqual([['Codex', 'agent'], ['Igor', 'human']]);
    expect(restored.send({ roomId: intentId, requestId, text: 'Agent authored' }, restored.authenticateAgent(secret)!).messageId).toBe(restored.snapshot().rooms[1].messages[0].id);
    expect(new NodeAccess(secret, restored).principal(new Request('http://127.0.0.1:4318', { headers: { Cookie: cookie } }))).toEqual(restored.owner);
  } finally { restored.close(); }
});

test('real HTTP setup requires acceptance, enforces identity/scope, and exposes only live agent connection state', async () => {
  const directory = testDirectory('setup-http');
  const startup = testStartupManager();
  const daemon = startDaemon({ ...defaultOptions(), dataDir: directory.path, port: 0, startup });
  const root = `http://127.0.0.1:${daemon.server.port}/api/node/`;
  const control = readFileSync(join(directory.path, 'control.key'), 'utf8').trim();
  const owner = { Authorization: `Bearer ${control}` };
  const request = (path: string, headers: Record<string, string>, body?: unknown) => fetch(root + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    expect((await request('snapshot', {})).status).toBe(401);
    const intentId = randomUUID(), secret = randomBytes(32).toString('base64url');
    const prepared = await request('control/prepare', owner, { requestId: intentId, title: 'A', project: 'Test', agentName: 'Worker', credentialHash: tokenHash(secret) });
    expect(prepared.status).toBe(201);
    expect((await request('snapshot', { Authorization: `Bearer ${secret}` })).status).toBe(401);
    const ticketResponse = await request('control/browser', owner, {}); const { ticket } = await ticketResponse.json();
    const login = await request('session', {}, { ticket }); expect(login.status).toBe(200);
    const cookie = { Cookie: login.headers.get('set-cookie')!.split(';')[0] };
    expect((await request('session', {}, { ticket })).status).toBe(401);
    const setup = await (await request(`setup?intent=${intentId}`, cookie)).json(); expect(setup.completed).toBe(false);
    expect(daemon.node.snapshot().rooms).toHaveLength(0);
    const command = { requestId: randomUUID(), humanName: 'Human', machineName: 'Desktop', startAtLogin: true, intentId };
    expect((await request('setup', { ...cookie, Origin: 'https://untrusted.example' }, command)).status).toBe(403);
    expect(await (await request('setup', cookie, command)).json()).toEqual({ roomId: intentId });
    expect(startup.status().installed).toBe(true);
    expect((await request('setup', cookie, { ...command, humanName: 'Changed retry' })).status).toBe(409);
    expect(await (await request('setup', cookie, command)).json()).toEqual({ roomId: intentId });
    const other = await (await request('rooms', owner, { requestId: randomUUID(), title: 'Private B' })).json();
    const agent = { Authorization: `Bearer ${secret}` };
    expect((await request('setup', agent)).status).toBe(403);
    expect((await request('control/browser', agent, {})).status).toBe(403);
    expect((await request('messages', agent, { requestId: randomUUID(), roomId: other.roomId, text: 'Rejected' })).status).toBe(404);
    const ask = await (await request('messages', cookie, { requestId: randomUUID(), roomId: intentId, text: '@Worker please report' })).json();
    expect((await request('messages', agent, { requestId: randomUUID(), roomId: intentId, text: 'Agent message', replyTo: ask.messageId, authorId: daemon.node.owner.participantId })).status).toBe(201);
    const scoped = await (await request('snapshot', agent)).json(); expect(scoped.rooms).toHaveLength(1);
    expect(scoped.rooms[0].messages[1].role).toBe('agent'); expect(scoped.rooms[0].messages[1].author).toBe('Worker');
    const abort = new AbortController();
    const stream = await fetch(`${root}events?view=agent-test`, { headers: agent, signal: abort.signal });
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).not.toContain('Private B');
    expect(daemon.node.snapshot().rooms[0].participants.find(p => p.role === 'agent')!.connected).toBe(true);
    abort.abort(); await reader.cancel().catch(() => {});
  } finally { daemon.close(); directory.cleanup(); }
});

test('real daemon isolates SSE capacity and reclaims an aborted network stream', async () => {
  const directory = testDirectory('view-quotas');
  const daemon = startDaemon({ ...defaultOptions(), dataDir: directory.path, port: 0, startup: testStartupManager() });
  const control = readFileSync(join(directory.path, 'control.key'), 'utf8').trim();
  const streams: { abort: AbortController; response: Response }[] = [];
  const agent = () => {
    const token = randomBytes(32).toString('base64url'), room = randomUUID();
    daemon.node.prepareRoom({ requestId: room, title: 'Network quota', agentName: 'Worker', credentialHash: tokenHash(token) });
    daemon.node.completeSetup({ requestId: randomUUID(), intentId: room, humanName: 'Owner', machineName: 'Test', startAtLogin: false });
    return token;
  };
  const open = async (token: string, view: string) => {
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${daemon.server.port}/api/node/events?view=${view}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
    const stream = { abort, response }; streams.push(stream); return stream;
  };
  try {
    const a = agent(), b = agent();
    const first = await open(a, 'first'); expect(first.response.status).toBe(200);
    expect((await open(a, 'second')).response.status).toBe(200);
    for (let i = 0; i < 16; i++) expect((await open(a, `rotating-${i}`)).response.status).toBe(429);
    expect((await open(b, 'first')).response.status).toBe(200);
    expect((await open(control, 'first')).response.status).toBe(200);
    first.abort.abort(); await first.response.body?.cancel().catch(() => {});
    let status = 429;
    for (let i = 0; i < 50 && status === 429; i++) {
      status = (await open(a, 'first')).response.status;
      if (status === 429) await Bun.sleep(10);
    }
    expect(status).toBe(200);
    expect((await open(a, 'still-full')).response.status).toBe(429);
  } finally {
    for (const { abort, response } of streams) { abort.abort(); await response.body?.cancel().catch(() => {}); }
    daemon.close(); directory.cleanup();
  }
});

test('CLI start/retry and simultaneous ensure reuse the actual daemon; agent CLI uses only the admitted room', async () => {
  const directory = testDirectory('first-run-cli');
  const options = { ...defaultOptions(), dataDir: directory.path, port: 0 };
  let runtime: Awaited<ReturnType<typeof ensureRunning>> | undefined;
  try {
    const pair = await Promise.all([ensureRunning(options), ensureRunning(options)]); runtime = pair[0]; expect(pair[1]).toEqual(runtime);
    const args = ['start', '--data-dir', directory.path, '--port', '0', '--title', 'CLI room', '--agent', 'CLI agent', '--project', 'Test'];
    const started: any = await runCli(args); expect(started.state).toBe('needs-onboarding');
    const retried: any = await runCli(args); expect(retried.intentId).toBe(started.intentId); expect(retried.credentialFile).toBe(started.credentialFile);
    expect(await probeRuntime(directory.path)).toEqual(runtime);
    const control = readFileSync(join(directory.path, 'control.key'), 'utf8').trim();
    const setupResponse = await fetch(new URL('/api/node/setup', runtime.url), { method: 'POST', headers: { Authorization: `Bearer ${control}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), humanName: 'Person', machineName: 'CLI test machine', startAtLogin: false, intentId: started.intentId }) });
    expect(setupResponse.status).toBe(200);
    const ready: any = await runCli(args); expect(ready.state).toBe('ready');
    const owner = (text: string) => fetch(new URL('/api/node/messages', runtime!.url), { method: 'POST', headers: { Authorization: `Bearer ${control}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: started.intentId, requestId: randomUUID(), text }) }).then(r => r.json()) as Promise<any>;
    // Humans-first: an agent cannot open the conversation on its own.
    const messageId = randomUUID(); const unprompted = ['send', '--credential', started.credentialFile, '--request-id', messageId, '--text', 'Hello from a real CLI'];
    await expect(runCli(unprompted)).rejects.toThrow('humans-first');
    const chatter = await owner('Just people talking for now.');
    const history: any = await runCli(['listen', '--credential', started.credentialFile, '--wait-seconds', '1']);
    expect(history).toMatchObject({ state: 'history', floor: 'humans-first', cursor: chatter.messageId, addressed: [] });
    const quiet = await owner('Still just people.');
    const waited: any = await runCli(['listen', '--credential', started.credentialFile, '--after', history.cursor, '--wait-seconds', '1']);
    expect(waited).toMatchObject({ state: 'timeout', cursor: history.cursor, observed: 1 });
    const ask = await owner('@CLI agent can you summarize?');
    const woken: any = await runCli(['listen', '--credential', started.credentialFile, '--after', waited.cursor, '--wait-seconds', '5']);
    expect(woken.state).toBe('addressed'); expect(woken.messages.map((m: any) => m.id)).toEqual([quiet.messageId, ask.messageId]); expect(woken.addressed).toEqual([ask.messageId]);
    const sent: any = await runCli([...unprompted, '--reply-to', ask.messageId]); expect(sent.status).toBe('stored-locally');
    const read: any = await runCli(['read', '--credential', started.credentialFile]); expect(read.rooms).toHaveLength(1);
    expect(read.rooms[0].messages.at(-1).author).toBe('CLI agent');
    const own: any = await runCli(['listen', '--credential', started.credentialFile, '--after', woken.cursor, '--wait-seconds', '1']);
    expect(own).toMatchObject({ state: 'timeout', observed: 0 });
    // Screenshot QA: a person shares an image; the agent downloads it and answers with its own file.
    const shot = Buffer.alloc(64, 7); shot.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0xa0, 0, 0, 3, 0x84]);
    const uploaded = await (await fetch(new URL(`/api/node/attachments?${new URLSearchParams({ roomId: started.intentId, requestId: randomUUID(), name: 'image.png' })}`, runtime.url),
      { method: 'POST', headers: { Authorization: `Bearer ${control}`, 'Content-Type': 'image/png' }, body: shot })).json() as any;
    expect(uploaded).toMatchObject({ kind: 'image', width: 1440, height: 900 });
    const bug = await (await fetch(new URL('/api/node/messages', runtime.url), { method: 'POST', headers: { Authorization: `Bearer ${control}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: started.intentId, requestId: randomUUID(), text: '@CLI agent the header overlaps here', attachments: [uploaded.id] }) })).json() as any;
    const shown: any = await runCli(['listen', '--credential', started.credentialFile, '--after', woken.cursor, '--wait-seconds', '5']);
    expect(shown.addressed).toEqual([bug.messageId]); expect(shown.messages.at(-1).attachments[0].id).toBe(uploaded.id);
    const saved: any = await runCli(['attachment', '--credential', started.credentialFile, '--id', uploaded.id]);
    expect(saved).toMatchObject({ state: 'downloaded', type: 'image/png', size: 64 }); expect(readFileSync(saved.path)).toEqual(shot);
    expect(saved.path.startsWith(join(realpathSync(directory.path), 'downloads'))).toBe(true);
    const report = join(directory.path, 'layout-report.txt'); writeFileSync(report, 'header height 88px; overlaps nav at 390px');
    const replyArgs = ['send', '--credential', started.credentialFile, '--request-id', randomUUID(), '--reply-to', bug.messageId, '--text', 'Reproduced', '--attach', report];
    const replied: any = await runCli(replyArgs); expect(await runCli(replyArgs)).toEqual(replied);
    const last: any = (await runCli(['read', '--credential', started.credentialFile]) as any).rooms[0].messages.at(-1);
    expect(last.attachments).toMatchObject([{ name: 'layout-report.txt', kind: 'file', type: 'text/plain' }]);
  } finally {
    if (runtime) { process.kill(runtime.pid, 'SIGKILL'); for (let i = 0; i < 30; i++) { try { process.kill(runtime.pid, 0); await Bun.sleep(20); } catch { break; } } }
    directory.cleanup();
  }
}, 30000);

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentCli, appOnly, isRunnerCommand, sameRunner } from './agent-cli';
import { daemonDir, runningDaemon } from './agent-daemon';
import { BrowserAgent, ROOM_CLOSED_FILE, outboxProblem, runBridge } from './browser-agent';
import { BrowserLobby } from './browser/lobby';
import { browserHandler } from './browser/http';
import { client } from './browser/test-client';
import { rawPeer } from './browser/raw-peer';
import { processRuns } from './browser/fake-runner';
import { localControlToken, readLocalApi, requestBrowserLink } from './local-api';
import { cancelPairing, createRoom, defaultRoomService, initPerson, joinRoom, pairRooms, personAgent, personHome, personIdentity, personRoomStatus, personRooms, personStatus, queueMessage, queueRetract, recordPersonRoom, roomState, roomTitles, unpairCheck, unpairPerson } from './person';
import { deviceId } from '../src/browser/protocol';
import { attachmentRef, type AttachmentRef } from '../src/browser/files';
const deviceIdOf = async (device: { signed: (a: 'status', r: string) => Promise<{ publicKey: string }> }) => deviceId((await device.signed('status', crypto.randomUUID())).publicKey);
import { mintInvite } from './browser/invites';
import { testDirectory } from './test-directory';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) try { cleanup(); } catch { /* Best effort. */ } });
// Nothing here may reach the real ~/.meshrooms: the registry, and with it the person and daemon folders, move to a
// folder of this file's own.
const sandboxKeys = ['MESHROOMS_AGENT_HOME', 'MESHROOMS_AGENT_REGISTRY', 'MESHROOMS_DAEMON_DIR', 'MESHROOMS_PERSON_HOME', 'MESHROOMS_LOCAL_PORT'] as const;
let sandbox: { dir: ReturnType<typeof testDirectory>; saved: (string | undefined)[] } | undefined;
beforeAll(() => {
  const dir = testDirectory('person-home');
  sandbox = { dir, saved: sandboxKeys.map(key => process.env[key]) };
  for (const key of sandboxKeys) delete process.env[key];
  process.env.MESHROOMS_AGENT_HOME = join(dir.path, 'agents'); process.env.MESHROOMS_AGENT_REGISTRY = join(dir.path, 'agent-homes.json');
  process.env.MESHROOMS_LOCAL_PORT = '0';
});
afterAll(() => {
  if (!sandbox) return;
  sandboxKeys.forEach((key, i) => { if (sandbox!.saved[i] === undefined) delete process.env[key]; else process.env[key] = sandbox!.saved[i]; });
  sandbox.dir.cleanup();
});

/** A real room service on a loopback port, as the bridge talks to it over HTTP. */
function coordinator() {
  let handle: ReturnType<typeof browserHandler> | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request, s) => handle!(request, s.requestIP(request)?.address ?? 'unknown') });
  const origin = `http://127.0.0.1:${server.port}`, lobby = new BrowserLobby(':memory:', { origin });
  handle = browserHandler(lobby, origin, '.');
  cleanups.push(() => { server.stop(true); lobby.close(); });
  return { origin, lobby };
}
async function hostedRoom(title = 'Design review') {
  const service = coordinator(), host = await client(service.lobby, Date.now, service.origin), roomId = crypto.randomUUID();
  await host.send('create', roomId, { title, name: 'Alex', label: 'Desktop' });
  return { ...service, host, roomId, url: `${service.origin}/r/${roomId}` };
}
function folders() {
  const dir = testDirectory('person');
  cleanups.push(dir.cleanup);
  return { dir: dir.path, home: join(dir.path, 'person') };
}
const until = async <T>(look: () => T | undefined | false, ms = 20_000) => { for (const by = Date.now() + ms; Date.now() < by; await Bun.sleep(50)) { const seen = look(); if (seen) return seen; } throw new Error('timed out'); };
const noRunner = async () => ({ outcome: 'test' });
const quiet = () => {};

test('person init makes one key per OS user, private, beside the agent registry; a second init keeps it', async () => {
  const base = resolve('/x');
  expect(personHome({ MESHROOMS_AGENT_REGISTRY: join(base, 'agent-homes.json') }, '/home/me')).toBe(join(base, 'person'));
  expect(personHome({}, '/home/me')).toBe(join('/home/me', '.meshrooms', 'person'));
  expect(personHome({ MESHROOMS_PERSON_HOME: '/elsewhere' }, '/home/me')).toBe(resolve('/elsewhere'));
  const { home } = folders();
  const first = await initPerson(home), second = await initPerson(home);
  expect(first.created).toBe(true);
  expect(second).toMatchObject({ created: false, deviceId: first.deviceId });
  expect(personIdentity(home)!.id).toBe(first.deviceId);
  expect(personIdentity(home)).not.toHaveProperty('privateJwk');
  if (process.platform !== 'win32') { expect(statSync(join(home, 'identity.json')).mode & 0o077).toBe(0); expect(statSync(home).mode & 0o077).toBe(0); }
});

test('person mode: one key in every room, speaking as a person, so the agents\' floor never drops what the person sends', async () => {
  const { home } = folders();
  const { deviceId } = await initPerson(home);
  const a = personAgent(crypto.randomUUID(), home, 'http://127.0.0.1:1'), b = personAgent(crypto.randomUUID(), home, 'http://127.0.0.1:1');
  expect((await a.ensureIdentity()).id).toBe(deviceId);
  expect((await b.ensureIdentity()).id).toBe(deviceId);
  expect(existsSync(join(a.dir, 'identity.json'))).toBe(false);
  // An agent's room keeps its own key in its folder, as before.
  const agent = new BrowserAgent(join(home, '..', 'agents'), 'http://127.0.0.1:1', a.roomId);
  expect((await agent.ensureIdentity()).id).not.toBe(deviceId);
  expect(existsSync(join(agent.dir, 'identity.json'))).toBe(true);

  // The same humans-first room, read by a person's folder and an agent's: nothing addressed anyone.
  const me = crypto.randomUUID(), alex = crypto.randomUUID();
  for (const folder of [a, agent]) await Bun.write(join(folder.dir, 'members.json'), JSON.stringify({ memberId: me, ownerId: alex,
    members: [{ id: alex, name: 'Alex', role: 'human' }, { id: me, name: 'Robin', role: folder === a ? 'human' : 'agent', operatorId: folder === a ? undefined : alex }], devices: [] }));
  expect(a.view().participants.find(p => p.id === me)!.role).toBe('human');
  expect(agent.view().participants.find(p => p.id === me)!.role).toBe('agent');
  const item = { id: crypto.randomUUID(), text: 'Morning, all' };
  expect(outboxProblem(a, me, item)).toBeUndefined();
  expect(outboxProblem(agent, me, item)).toBe('nothing in this room addressed the agent');
  expect(outboxProblem(a, me, { id: 'nope', text: 'x' })).toBe('its id is not a UUID');
});

test('a person runner\'s command line is its own: never taken for an agent\'s runner in the same room, or the other way round', () => {
  const room = crypto.randomUUID();
  const agent = `"C:\\bun\\bun.exe" --no-env-file "C:\\Users\\me\\.meshrooms\\bin\\meshrooms.js" run --room ${room}`;
  const person = `"C:\\bun\\bun.exe" --no-env-file "C:\\Users\\me\\.meshrooms\\bin\\meshrooms.js" person-run --room ${room}`;
  expect(isRunnerCommand(agent, room)).toBe(true);
  expect(isRunnerCommand(person, room)).toBe(false);
  expect(isRunnerCommand(person, room, 'person-run')).toBe(true);
  expect(isRunnerCommand(agent, room, 'person-run')).toBe(false);
  expect(sameRunner(room, 7, { pid: 7 }, { command: person })).toBe(false);
  expect(sameRunner(room, 7, { pid: 7 }, { command: person }, 'person-run')).toBe(true);
});

test('join asks as a person and the host admits; the runner then keeps the room, delivers what the person sends, and stops when it closes', async () => {
  const { home } = folders(), room = await hostedRoom();
  await expect(joinRoom({ url: room.url, kind: 'person', name: 'Robin', label: 'Meshrooms app' }, noRunner, home)).rejects.toThrow('person init');
  const { deviceId } = await initPerson(home);
  await expect(joinRoom({ url: room.url, kind: 'person', label: 'Meshrooms app' }, noRunner, home)).rejects.toThrow('--name');
  const joined = await joinRoom({ url: room.url, kind: 'person', name: 'Robin', label: 'Meshrooms app' }, noRunner, home);
  expect(joined).toMatchObject({ roomId: room.roomId, title: 'Design review', deviceId, state: 'waiting' });
  expect(personRooms(home)).toEqual([{ roomId: room.roomId, origin: room.origin, kind: 'person', name: 'Robin', joinedAt: expect.any(Number) }]);
  // Asking again while the request waits asks nothing new.
  await joinRoom({ url: room.url, kind: 'person', name: 'Robin', label: 'Meshrooms app' }, noRunner, home);
  const requests = (await room.host.status(room.roomId)).requests!;
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ name: 'Robin', kind: 'person' });

  const agent = personAgent(room.roomId, home), logs: string[] = [];
  const bridge = runBridge(agent, line => logs.push(line), { pause: () => Bun.sleep(20) }).catch(error => error);
  await until(() => roomState(agent).state === 'waiting');
  // The page's view of a request still waiting: the room service's own status of it, kept by the runner.
  await until(() => personRoomStatus(agent)?.request?.state === 'pending');
  await room.host.send('decide', room.roomId, { requestId: requests[0].id, admit: true });
  await until(() => roomState(agent).state === 'joined');
  // Once admitted, the whole status the hosted page reads, without what only the runner may hold (TURN credentials, signals).
  const status = await until(() => personRoomStatus(agent)?.memberId ? personRoomStatus(agent) : undefined);
  expect(status).toMatchObject({ roomId: room.roomId, ownerId: (await room.host.status(room.roomId)).memberId, deviceId, connected: [], activity: {} });
  expect(status).not.toHaveProperty('iceServers');
  expect(status).not.toHaveProperty('signals');
  expect(status!.devices!.every(d => typeof d.online === 'boolean' && !('session' in d))).toBe(true);
  expect(existsSync(join(agent.dir, 'admission.json'))).toBe(false);
  const roster = agent.members();
  expect(roster.members.find(m => m.id === roster.memberId)).toMatchObject({ name: 'Robin', role: 'human' });
  // Presence comes with the roster, for every device.
  expect(roster.devices.find(d => d.id === deviceId)?.online).toBe(true);
  expect(roster.devices.every(d => typeof d.online === 'boolean')).toBe(true);

  // A humans-first room: the person speaks unaddressed, and the runner signs and stores it.
  const sent = await queueMessage(agent, { text: 'Hello from the app' });
  await until(() => agent.messages().some(m => m.packet.body.id === sent.messageId));
  const body = agent.messages().find(m => m.packet.body.id === sent.messageId)!.packet.body;
  expect(body).toMatchObject({ memberId: roster.memberId, deviceId, text: 'Hello from the app' });
  expect(await agent.verify(personIdentity(home)!.publicKey, body, agent.messages().find(m => m.packet.body.id === sent.messageId)!.packet.signature)).toBe(true);
  expect(logs.filter(line => line.startsWith('dropped'))).toEqual([]);
  // Joining a room it is already in asks nothing and keeps it.
  expect(await joinRoom({ url: room.url, kind: 'person', name: 'Robin', label: 'Meshrooms app' }, noRunner, home)).toMatchObject({ state: 'joined' });

  await room.host.send('close', room.roomId);
  expect((await bridge as { status?: number }).status).toBe(410);
  expect(roomState(agent).state).toBe('closed');
}, 60_000);

test('a deletion crosses real channels: at once to a device that is there, and on reconnecting to one that was away', async () => {
  const room = await hostedRoom();
  const person = async (name: string) => {
    const { home } = folders(), { deviceId } = await initPerson(home);
    await joinRoom({ url: room.url, kind: 'person', name, label: 'Meshrooms app' }, noRunner, home);
    return { deviceId, agent: personAgent(room.roomId, home) };
  };
  const robin = await person('Robin'), sam = await person('Sam');
  // Two runners at a real runner's pace or near it: faster than this, the room service rate-limits them.
  const run = (agent: BrowserAgent) => runBridge(agent, quiet, { pause: () => Bun.sleep(250) }).catch(error => error);
  const robinRuns = run(robin.agent); let samRuns = run(sam.agent);
  for (const { id } of (await room.host.status(room.roomId)).requests!) await room.host.send('decide', room.roomId, { requestId: id, admit: true });
  const linked = (from: typeof robin, to: typeof robin) => personRoomStatus(from.agent)?.connected.includes(to.deviceId);
  await until(() => linked(robin, sam) && linked(sam, robin), 40_000);
  const held = (id: string) => sam.agent.messages().find(m => m.packet.body.id === id);
  const onDisk = () => readFileSync(join(sam.agent.dir, 'messages.json'), 'utf8');

  const live = await queueMessage(robin.agent, { text: 'said while both are here' });
  await until(() => held(live.messageId));
  expect(await queueRetract(robin.agent, { messageId: live.messageId })).toMatchObject({ status: 'shared' });
  await until(() => held(live.messageId)?.retracted);
  expect(onDisk()).not.toContain('said while both are here');

  const missed = await queueMessage(robin.agent, { text: 'deleted while Sam is away' });
  await until(() => held(missed.messageId));
  // Sam's runner stops; nothing else about the room changes.
  const command = sam.agent.command.bind(sam.agent);
  sam.agent.command = async () => { throw Object.assign(new Error('stopped for this test'), { status: 410 }); };
  await samRuns;
  sam.agent.command = command;
  rmSync(join(sam.agent.dir, ROOM_CLOSED_FILE), { force: true });
  await until(() => !linked(robin, sam), 40_000);
  expect(await queueRetract(robin.agent, { messageId: missed.messageId })).toMatchObject({ status: 'shared' });
  expect(onDisk()).toContain('deleted while Sam is away');

  samRuns = run(sam.agent);
  await until(() => held(missed.messageId)?.retracted, 40_000);
  expect(onDisk()).not.toContain('deleted while Sam is away');
  expect(sam.agent.retractOps().map(op => op.body.target)).toEqual([live.messageId, missed.messageId]);

  await room.host.send('close', room.roomId);
  expect((await robinRuns as { status?: number }).status).toBe(410);
  expect((await samRuns as { status?: number }).status).toBe(410);
}, 120_000);

/** A real runner (Sam's) and devices on real channels to it that send only what the test tells them to. */
async function runnerAndPeers(names: string[], pause = 250) {
  const room = await hostedRoom();
  const member = async (name: string) => {
    const { home } = folders(), { deviceId } = await initPerson(home);
    await joinRoom({ url: room.url, kind: 'person', name, label: 'Meshrooms app' }, noRunner, home);
    return { deviceId, agent: personAgent(room.roomId, home) };
  };
  const sam = await member('Sam'), others = await Promise.all(names.map(member));
  const runner = runBridge(sam.agent, quiet, { pause: () => Bun.sleep(pause) }).catch(error => error);
  for (const { id } of (await room.host.status(room.roomId)).requests!) await room.host.send('decide', room.roomId, { requestId: id, admit: true });
  const peers = await Promise.all(others.map(async ({ agent }) => {
    const peer = await rawPeer(agent, sam.deviceId);
    cleanups.push(() => void peer.stop());
    const signed = async <T extends object>(body: T) => ({ body, signature: await agent.sign(body) });
    return Object.assign(peer, {
      say: (text: string, attachments?: AttachmentRef[]) => signed({ kind: 'message', roomId: room.roomId, id: crypto.randomUUID(), deviceId: peer.id, memberId: peer.memberId, text, at: Date.now(), ...(attachments ? { attachments } : {}) }),
      retract: (target: string, memberId = peer.memberId) => signed({ kind: 'retract', roomId: room.roomId, id: crypto.randomUUID(), deviceId: peer.id, memberId, at: Date.now(), target }),
    });
  }));
  await until(() => peers.every(peer => peer.open), 40_000);
  const held = (id: string) => sam.agent.messages().find(m => m.packet.body.id === id);
  const onDisk = () => readFileSync(join(sam.agent.dir, 'messages.json'), 'utf8');
  const finish = async () => {
    await Promise.all(peers.map(peer => peer.stop()));
    await room.host.send('close', room.roomId);
    expect((await runner as { status?: number }).status).toBe(410);
  };
  return { sam: sam.agent, peers, held, onDisk, finish };
}

test('a sender still retrying a deleted message gets its receipt and the content stays gone', async () => {
  const { peers: [robin], held, onDisk, finish } = await runnerAndPeers(['Robin']);
  const message = await robin!.say('the secret'), id = message.body.id;
  const receipts = () => robin!.heard.filter(p => p.body?.kind === 'receipt' && p.body.id === id).length;
  robin!.send(message);
  await until(() => held(id) && receipts() === 1);
  robin!.send(await robin!.retract(id));
  await until(() => held(id)?.retracted);
  robin!.send(message);
  await until(() => receipts() === 2);
  expect(held(id)).toMatchObject({ retracted: true, packet: { body: { text: '' } } });
  expect(onDisk()).not.toContain('the secret');
  await finish();
}, 90_000);

test('a live retraction counts by who signed it, not by which device relayed it', async () => {
  const { peers: [robin, wren], held, onDisk, finish } = await runnerAndPeers(['Robin', 'Wren']);
  const message = await wren!.say('the secret'), id = message.body.id;
  wren!.send(message);
  await until(() => held(id));
  // Robin claims to be Wren with Robin's own key, then alters what Wren signed. Neither gets through.
  robin!.send(await robin!.retract(id, wren!.memberId));
  const real = await wren!.retract(id);
  robin!.send({ ...real, body: { ...real.body, at: real.body.at + 1 } });
  // Packets are handled in order, so once this one is stored the two before it were refused.
  const marker = await robin!.say('after those');
  robin!.send(marker);
  await until(() => held(marker.body.id));
  expect(onDisk()).toContain('the secret');
  robin!.send(real);
  await until(() => held(id)?.retracted);
  expect(onDisk()).not.toContain('the secret');
  await finish();
}, 90_000);

test('a retraction during a file transfer stops it, and what arrives afterwards is not kept', async () => {
  // Passes far apart, so it is the retraction itself that stops the transfer and not the next pass tidying up.
  const { sam, peers: [robin], held, onDisk, finish } = await runnerAndPeers(['Robin'], 2_000);
  const bytes = Uint8Array.from({ length: 2_000 }, (_, i) => (i * 31) & 0xff), ref = await attachmentRef(bytes, 'secret.bin'), sha = ref.sha256;
  const message = await robin!.say('Look at this', [ref]), id = message.body.id;
  const chunk = (from: number, to: number) => ({ kind: 'file-chunk', roomId: sam.roomId, sha256: sha, offset: from, data: Buffer.from(bytes.subarray(from, to)).toString('base64') });
  robin!.send({ kind: 'files', roomId: sam.roomId, version: 1 });
  robin!.send(message);
  await until(() => held(id));
  writeFileSync(join(sam.dir, 'wants', sha), '');
  await until(() => robin!.heard.some(p => p.kind === 'file-want' && p.sha256 === sha));
  robin!.send(chunk(0, 1_000));
  robin!.send(await robin!.retract(id));
  await until(() => held(id)?.retracted);
  robin!.send(chunk(1_000, 2_000));
  robin!.send({ kind: 'file-done', roomId: sam.roomId, sha256: sha, size: bytes.length });
  await Bun.sleep(500);
  expect(existsSync(sam.files.path(sha))).toBe(false);
  expect(existsSync(join(sam.dir, 'wants', sha))).toBe(false);
  expect(onDisk()).not.toContain(sha);
  await finish();
}, 90_000);

test('a paired app joins as the paired person, and only at the paired room service', async () => {
  const { home } = folders(), room = await hostedRoom();
  await initPerson(home);
  const pairing = (origin: string) => writeFileSync(join(home, 'pairing.json'), JSON.stringify({ origin, device: 'b'.repeat(64), name: 'Robin Lee', at: 1 }));
  pairing('http://127.0.0.1:1');
  for (const kind of ['person', 'companion'] as const)
    await expect(joinRoom({ url: room.url, kind, label: 'Meshrooms app' }, noRunner, home)).rejects.toThrow(`This app is paired with Robin Lee at http://127.0.0.1:1, so it can't join a room at ${room.origin}: one person per app.`);
  expect(personRooms(home)).toEqual([]);
  expect(existsSync(join(home, 'browser-agents', room.roomId))).toBe(false);
  // At the paired service, the request carries the paired name.
  pairing(room.origin);
  expect(await joinRoom({ url: room.url, kind: 'person', label: 'Meshrooms app' }, noRunner, home)).toMatchObject({ roomId: room.roomId, state: 'waiting' });
  expect((await room.host.status(room.roomId)).requests).toEqual([expect.objectContaining({ name: 'Robin Lee', kind: 'person' })]);
  expect(personRooms(home)).toEqual([expect.objectContaining({ roomId: room.roomId, kind: 'person', name: 'Robin Lee' })]);
});

test('companion asks to join as a device of an existing person and prints the code; their own link admits it at once', async () => {
  const { home } = folders(), room = await hostedRoom();
  await initPerson(home);
  const joined = await joinRoom({ url: room.url, kind: 'companion', label: 'Meshrooms app' }, noRunner, home) as { state: string; code: string };
  const code = joined.code;
  expect(code).toMatch(/^[a-f0-9]{16}$/);
  expect(joined.state).toBe('waiting');
  expect(personRooms(home)[0]).toMatchObject({ kind: 'companion' });
  expect(personRooms(home)[0]).not.toHaveProperty('name');
  // The host's own browser links it: this device becomes the host's.
  await room.host.send('link', room.roomId, { code });
  const status = await personAgent(room.roomId, home).command('status', { session: crypto.randomUUID() });
  expect(status.memberId).toBe(status.ownerId);
  await expect(joinRoom({ url: `${room.origin}/agent/${room.roomId}`, kind: 'companion', label: 'x' }, noRunner, home)).rejects.toThrow('room link');
});

test('the CLI: person init, status, rooms, join and open, in a folder of the test\'s own', async () => {
  const { dir } = folders();
  process.env.MESHROOMS_PERSON_HOME = join(dir, 'cli-person'); process.env.MESHROOMS_DAEMON_DIR = join(dir, 'daemon');
  try {
    expect(await agentCli(['person', 'status'])).toMatchObject({ initialized: false, deviceId: null, rooms: 0 });
    // Joining is the app's too: with no running daemon to prove itself to, a bare join is refused.
    await expect(agentCli(['person', 'join', 'https://example.test/r/' + crypto.randomUUID(), '--name', 'Robin'])).rejects.toThrow('Join rooms from the Meshrooms app');
    const made = await agentCli(['person', 'init']) as { deviceId: string; created: boolean };
    expect(made.created).toBe(true);
    expect(await agentCli(['person', 'status'])).toMatchObject({ initialized: true, deviceId: made.deviceId, daemon: null, localApi: null });
    expect(await agentCli(['person', 'rooms'])).toEqual([]);
    await expect(agentCli(['person', 'open'])).rejects.toThrow('not running');
    await expect(agentCli(['person', 'nonsense'])).rejects.toThrow('Use person init');
    // A pairing secret never travels on the command line.
    await expect(agentCli(['person', 'pair', '--secret', 'A'.repeat(43)])).rejects.toThrow('read from stdin');
    // Pairing and unpairing are the app's: with no running daemon to prove itself to, a bare command is refused before
    // it reads anything, and nothing changes.
    for (const sub of ['pair', 'unpair']) await expect(agentCli(['person', sub])).rejects.toThrow('Pair and unpair from the Meshrooms app');
    expect(existsSync(join(dir, 'cli-person', 'identity.json'))).toBe(true);
  } finally { delete process.env.MESHROOMS_PERSON_HOME; delete process.env.MESHROOMS_DAEMON_DIR; }
});

test('the real daemon runs the person\'s runner like an agent\'s, serves the local API, and lets a closed room go', async () => {
  const { dir } = folders(), room = await hostedRoom();
  const registry = join(dir, 'agent-homes.json'), home = join(dir, 'person'), daemon = join(dir, 'daemon');
  await Bun.write(registry, '[]');
  await initPerson(home);
  await joinRoom({ url: room.url, kind: 'person', name: 'Robin', label: 'Meshrooms app' }, noRunner, home);
  const env: Record<string, string | undefined> = { ...process.env, MESHROOMS_AGENT_REGISTRY: registry, MESHROOMS_AGENT_HOME: join(dir, 'agents'), MESHROOMS_LOCAL_PORT: '0' };
  for (const key of ['MESHROOMS_DAEMON_DIR', 'MESHROOMS_PERSON_HOME']) delete env[key];
  expect(personHome(env as Record<string, string>)).toBe(home);
  expect(daemonDir(env as Record<string, string>)).toBe(daemon);
  const cli = join(import.meta.dir, 'agent-cli.ts');
  const child = spawn(process.execPath, [cli, 'daemon', 'run'], { env, stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  const agent = personAgent(room.roomId, home);
  cleanups.push(() => {
    try { process.kill(child.pid!, 'SIGKILL'); } catch { /* Gone. */ }
    const runner = Number(readFileSync(join(agent.dir, 'runner.pid'), 'utf8'));
    if (runner) try { process.kill(runner, 'SIGKILL'); } catch { /* Gone. */ }
  });
  await until(() => runningDaemon(processRuns, daemon)?.pid === child.pid, 30_000);
  // The daemon starts the room's runner (person-run), which polls while the request waits.
  await until(() => roomState(agent).state === 'waiting', 60_000);
  const runnerPid = Number(readFileSync(join(agent.dir, 'runner.pid'), 'utf8'));
  expect(processRuns(runnerPid)).toBe(true);
  expect(readFileSync(join(agent.dir, 'runner.log'), 'utf8')).toContain('waiting for admission');
  await room.host.send('decide', room.roomId, { requestId: (await room.host.status(room.roomId)).requests![0].id, admit: true });
  await until(() => roomState(agent).state === 'joined', 30_000);
  const record = runningDaemon(processRuns, daemon)!;
  expect(record.homes).toContain(home);

  // The local API, served by the daemon: a browser link, and the room as the API shows it.
  const api = await until(() => readLocalApi(daemon), 30_000);
  expect(api.pid).toBe(child.pid!);
  const link = await requestBrowserLink(daemon, processRuns);
  expect(link.url).toStartWith(`http://127.0.0.1:${api.port}/#access=`);
  const rooms = await (await fetch(`http://127.0.0.1:${api.port}/api/local/rooms`, { headers: { Authorization: `Bearer ${localControlToken(api.secret)}` } })).json() as { rooms: { roomId: string; state: string; title: string; connected: boolean }[] };
  expect(rooms.rooms).toEqual([expect.objectContaining({ roomId: room.roomId, state: 'joined', title: 'Design review', connected: true })]);
  // The commands the app runs, against this daemon: the daemon's identity, then the challenge, then a link.
  process.env.MESHROOMS_DAEMON_DIR = daemon; process.env.MESHROOMS_PERSON_HOME = home;
  try {
    expect(await agentCli(['person', 'status'])).toMatchObject({ initialized: true, joined: 1, daemon: { pid: child.pid }, localApi: `http://127.0.0.1:${api.port}` });
    expect((await agentCli(['person', 'open']) as { url: string }).url).toStartWith(`http://127.0.0.1:${api.port}/#access=`);
    expect(await agentCli(['person', 'rooms'])).toEqual([expect.objectContaining({ roomId: room.roomId, state: 'joined', runner: runnerPid })]);
    // A join link's room, once admitted, opens at that room; a room not on the person's list doesn't open.
    expect((await agentCli(['person', 'open', '--room', room.roomId]) as { url: string }).url).toStartWith(`http://127.0.0.1:${api.port}/r/${room.roomId}#access=`);
    await expect(agentCli(['person', 'open', '--room', crypto.randomUUID()])).rejects.toThrow('not in that room');
    await expect(agentCli(['person', 'open', '--room', '../x'])).rejects.toThrow('not in that room');
  } finally { delete process.env.MESHROOMS_DAEMON_DIR; delete process.env.MESHROOMS_PERSON_HOME; }
  // person join is the app's, like pair: refused without the running daemon's control token on stdin; with it, a room
  // already joined asks nothing again.
  const joinCli = (input: string) => spawnSync(process.execPath, [cli, 'person', 'join', room.url, '--name', 'Robin'],
    { env: { ...env, MESHROOMS_DAEMON_DIR: daemon, MESHROOMS_PERSON_HOME: home }, input, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  for (const proof of ['', 'not the token', localControlToken('y'.repeat(43))]) {
    const refused = joinCli(`${proof}\n`);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain('Join rooms from the Meshrooms app');
  }
  const joinedAgain = joinCli(`${localControlToken(api.secret)}\n`);
  expect(joinedAgain.status).toBe(0);
  expect(JSON.parse(joinedAgain.stdout.trim().split('\n').at(-1)!)).toMatchObject({ roomId: room.roomId, state: 'joined' });

  // Closed by its host: the runner stops by itself and the daemon lets the room go rather than restarting it.
  await room.host.send('close', room.roomId);
  await until(() => !processRuns(runnerPid), 30_000);
  await until(() => runningDaemon(processRuns, daemon)?.rooms.find(r => r.roomId === room.roomId)?.state === 'closed', 30_000);
  expect(readdirSync(agent.dir)).toContain('retired.json');
}, 180_000);

test('pair asks in every room with a proof of the browser\'s secret, and that secret links each one, host or not', async () => {
  const { home } = folders(), service = coordinator();
  const alex = await client(service.lobby, Date.now, service.origin), robin = await client(service.lobby, Date.now, service.origin);
  const [hosted, own, elsewhere] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  // Robin is a guest in Alex's room and hosts a room of their own.
  await alex.send('create', hosted, { title: 'Hosted by Alex', name: 'Alex', label: 'Desktop' });
  await robin.send('request', hosted, { name: 'Robin', label: 'Laptop', kind: 'person' });
  await alex.send('decide', hosted, { requestId: (await alex.status(hosted)).requests![0].id, admit: true });
  await robin.send('create', own, { title: 'Robin\'s room', name: 'Robin', label: 'Laptop' });
  const secret = crypto.getRandomValues(new Uint8Array(32)), n = Buffer.from(secret).toString('base64url');
  const robinId = (await robin.status(own)).deviceId, alexId = (await alex.status(hosted)).deviceId;
  const pair = (extra: Record<string, unknown> = {}) => pairRooms({ origin: service.origin, rooms: `${hosted},${own},${elsewhere},${hosted}`, name: 'Robin', device: robinId, secret: n, ...extra }, noRunner, home);
  for (const bad of [{ origin: 'http://rooms.example' }, { origin: `${service.origin}/r` }, { rooms: 'nope' }, { rooms: '' }, { secret: n.slice(1) }, { secret: undefined }, { name: '\u0007' },
    { device: undefined }, { device: robinId.toUpperCase() }])
    await expect(pair(bad)).rejects.toThrow('Give');
  expect(existsSync(home)).toBe(false);
  // The person is made when needed; a room that doesn't exist fails alone, and stays off the list.
  const paired = await pair();
  expect(paired.created).toBe(true);
  expect(paired.rooms.map(r => [r.roomId, r.state])).toEqual([[hosted, 'waiting'], [own, 'waiting'], [elsewhere, 'failed']]);
  expect(personRooms(home).map(r => r.roomId)).toEqual([hosted, own]);
  expect(readdirSync(join(home, 'browser-agents')).sort()).toEqual([hosted, own].sort());
  // Asking again changes nothing: the requests already wait under this proof (which the room service shows nobody).
  const first = (await personAgent(hosted, home).command('status', { session: crypto.randomUUID() })).request;
  expect(first.pairing).toBeUndefined();
  expect(first.code).toBeUndefined();
  await pair();
  expect((await personAgent(hosted, home).command('status', { session: crypto.randomUUID() })).request.id).toBe(first.id);
  // Robin's browser links both with the secret: admitted in both, as Robin, without Alex.
  for (const room of [hosted, own]) expect(await robin.send('link', room, { pairing: n })).toEqual({ roomId: room, admitted: true });
  for (const room of [hosted, own]) {
    const status = await personAgent(room, home).command('status', { session: crypto.randomUUID() });
    expect(status.memberId).toBe((await robin.status(room)).memberId);
    // What the room's runner writes once it hears it was admitted (no runner runs in this test).
    writeFileSync(join(personAgent(room, home).dir, 'members.json'), JSON.stringify({ memberId: status.memberId, ownerId: status.ownerId, title: status.title, members: [], devices: [] }));
  }
  // Pairing again later from the same browser: rooms already joined are only listed.
  expect((await pair({ rooms: own })).rooms).toEqual([{ roomId: own, state: 'joined', title: 'Robin\'s room' }]);
  // One person per app: another browser device, or another room service, is refused before anything is asked.
  await expect(pair({ device: alexId, name: 'Alex' })).rejects.toThrow('This app is paired with Robin at');
  await expect(pair({ origin: 'https://rooms.example' })).rejects.toThrow('Unpair it first in the app.');
  expect(personStatus(home).pairedWith).toEqual({ name: 'Robin', origin: service.origin });
  // Paired rooms never choose where the person's next room is made.
  expect(defaultRoomService(home, {})).toBe('https://meshrooms.wormdb.dev');
  // The rooms' public titles, for the app's window.
  expect(await roomTitles({ origin: service.origin, rooms: `${own},${elsewhere}` })).toEqual({ origin: service.origin, rooms: [{ roomId: own, title: 'Robin\'s room' }, { roomId: elsewhere, title: null }] });

  // Unpair: this device leaves both rooms, and the whole person folder goes; then another browser may pair.
  const stopped: string[] = [];
  const result = await unpairPerson(async agent => { stopped.push(agent.roomId); return 'stopped'; }, home);
  expect(result.unpaired).toBe(true);
  expect(result.rooms).toEqual([{ roomId: hosted, title: 'Hosted by Alex', state: 'left' }, { roomId: own, title: 'Robin\'s room', state: 'left' }]);
  expect(result.kept).toEqual([]);
  expect(result.was).toEqual({ name: 'Robin', origin: service.origin });
  expect(stopped.sort()).toEqual([hosted, own].sort());
  expect(existsSync(home)).toBe(false);
  expect((await robin.status(own)).devices!.map(d => d.id)).toEqual([robinId]);
  expect((await alex.status(hosted)).devices!.length).toBe(2);
  const again = await pair({ device: alexId, name: 'Alex', rooms: hosted });
  expect(again.rooms[0]).toMatchObject({ roomId: hosted, state: 'waiting' });
});

test('cancelling pairing withdraws pending requests, keeps admitted rooms and the key, and can be retried', async () => {
  const { home } = folders(), service = coordinator(), browser = await client(service.lobby, Date.now, service.origin);
  const admitted = crypto.randomUUID(), pending = crypto.randomUUID(), untouched = crypto.randomUUID();
  for (const room of [admitted, pending, untouched]) await browser.send('create', room, { title: room, name: 'Robin', label: 'Browser' });
  const device = (await browser.status(admitted)).deviceId, secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const input = { origin: service.origin, rooms: `${admitted},${pending}`, device };
  const pair = () => pairRooms({ ...input, rooms: `${admitted},${pending},${untouched}`, name: 'Robin', secret }, noRunner, home);
  await pair();
  await browser.send('link', admitted, { pairing: secret });
  const identity = readFileSync(join(home, 'identity.json'), 'utf8'), stopped: string[] = [];
  await expect(cancelPairing({ ...input, device: 'b'.repeat(64) }, async () => 'none', home)).rejects.toThrow('not the browser pairing');
  const incomplete = await cancelPairing(input, async () => 'alive', home);
  expect(incomplete.cancelled).toBe(false);
  expect(personRooms(home)).toHaveLength(3);
  expect((await browser.status(pending)).requests).toHaveLength(0);
  const result = await cancelPairing(input, async agent => { stopped.push(agent.roomId); return 'stopped'; }, home);
  expect(result.cancelled).toBe(true);
  expect(result.rooms.map(r => [r.roomId, r.state])).toEqual([[admitted, 'joined'], [pending, 'cancelled']]);
  expect(stopped).toEqual([pending]);
  expect(personRooms(home).map(r => r.roomId)).toEqual([admitted, untouched]);
  expect((await browser.status(untouched)).requests).toHaveLength(1);
  expect(readFileSync(join(home, 'identity.json'), 'utf8')).toBe(identity);
  expect((await browser.status(admitted)).devices).toHaveLength(2);
  await pair();
  expect((await browser.status(pending)).requests).toHaveLength(1);
});

test('only the app\'s proof (the running daemon\'s control token) opens pair and unpair', async () => {
  const { dir } = folders(), daemon = join(dir, 'daemon-for-proof'), secret = 'x'.repeat(43);
  const lines = (...given: string[]) => async () => given;
  await expect(appOnly(lines(localControlToken(secret)), daemon)).rejects.toThrow('from the Meshrooms app');
  mkdirSync(daemon, { recursive: true });
  writeFileSync(join(daemon, 'local-api.json'), JSON.stringify({ url: 'http://127.0.0.1:1', port: 1, pid: process.pid, startedAt: 1, secret }));
  // The right token, then the rest of stdin (a pairing's secret) passes through.
  expect(await appOnly(lines(localControlToken(secret), 'the secret'), daemon)).toEqual(['the secret']);
  for (const wrong of ['', 'not the token', localControlToken('y'.repeat(43)), `${localControlToken(secret)}x`])
    await expect(appOnly(lines(wrong, 'the secret'), daemon)).rejects.toThrow('from the Meshrooms app');
  // A daemon that is no longer running proves nothing.
  writeFileSync(join(daemon, 'local-api.json'), JSON.stringify({ url: 'http://127.0.0.1:1', port: 1, pid: 2 ** 31 - 2, startedAt: 1, secret }));
  await expect(appOnly(lines(localControlToken(secret)), daemon)).rejects.toThrow('from the Meshrooms app');
});

test('a room whose only host device this is: unpair names it first, and deletes nothing unless told to go on anyway', async () => {
  const { home } = folders(), room = await hostedRoom();
  const robin = await client(room.lobby, Date.now, room.origin);
  await robin.send('request', room.roomId, { name: 'Robin', label: 'Laptop', kind: 'person' });
  await room.host.send('decide', room.roomId, { requestId: (await room.host.status(room.roomId)).requests![0].id, admit: true });
  const made = await createRoom({ origin: room.origin, title: 'Mine', name: 'Robin' }, noRunner, home);
  // A companion request in Alex's room: left by cancelling it.
  await initPerson(home);
  await joinRoom({ url: room.url, kind: 'companion', label: 'Meshrooms app' }, noRunner, home);
  const stop = async () => 'stopped' as const;
  // The window's question first: which rooms would lose their host. Reads only.
  expect(await unpairCheck(home)).toMatchObject({ rooms: 2, soleHost: [{ roomId: made.roomId, title: 'Mine' }], unreachable: [] });
  // Without --anyway: nothing deleted, and the room is named. (Alex's room was left meanwhile, its request cancelled,
  // which the retry below finds already done.)
  const refused = await unpairPerson(stop, home);
  expect(refused.unpaired).toBe(false);
  expect(refused.failed).toEqual([expect.objectContaining({ roomId: made.roomId, title: 'Mine', state: 'failed' })]);
  expect(existsSync(join(home, 'identity.json'))).toBe(true);
  expect(personRooms(home)).toHaveLength(2);
  // Anyway: the room keeps this device and loses its host, and says so; the rest goes.
  const anyway = await unpairPerson(stop, home, { anyway: true });
  expect(anyway.unpaired).toBe(true);
  expect(anyway.kept).toEqual([{ roomId: made.roomId, title: 'Mine' }]);
  expect(anyway.rooms.find(r => r.roomId === room.roomId)?.state).toBe('left');
  expect(existsSync(home)).toBe(false);
});

test('unpair deletes nothing while a room can\'t be reached, or a room\'s runner still runs', async () => {
  const { home } = folders(), room = await hostedRoom();
  await initPerson(home);
  await joinRoom({ url: room.url, kind: 'companion', label: 'Meshrooms app' }, noRunner, home);
  // Still running: nothing deleted, and the room is named.
  const busy = await unpairPerson(async () => 'alive', home);
  expect(busy.unpaired).toBe(false);
  expect(busy.failed).toEqual([expect.objectContaining({ roomId: room.roomId, error: 'Its background process is still running.' })]);
  expect(existsSync(join(home, 'identity.json'))).toBe(true);
  // A second room on a service that doesn't answer: a network failure, so nothing is deleted; try again later.
  const down = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('down', { status: 503 }) });
  const unreachable = `http://127.0.0.1:${down.port}/r/${crypto.randomUUID()}`;
  down.stop(true);
  recordPersonRoom({ roomId: unreachable.split('/r/')[1], origin: new URL(unreachable).origin, kind: 'companion', joinedAt: Date.now() }, home);
  const check = await unpairCheck(home);
  expect(check.unreachable).toEqual([expect.objectContaining({ roomId: unreachable.split('/r/')[1] })]);
  const failed = await unpairPerson(async () => 'stopped', home);
  expect(failed.unpaired).toBe(false);
  expect(failed.failed.map(r => r.roomId)).toEqual([unreachable.split('/r/')[1]]);
  expect(existsSync(join(home, 'identity.json'))).toBe(true);
});

test('a pairing claims the app only once a room took its request, and a claim nobody confirmed lapses', async () => {
  const { home } = folders(), service = coordinator();
  const robin = await client(service.lobby, Date.now, service.origin), sam = await client(service.lobby, Date.now, service.origin);
  const own = crypto.randomUUID();
  await robin.send('create', own, { title: 'Robin\'s room', name: 'Robin', label: 'Laptop' });
  const [robinId, samId] = [(await robin.status(own)).deviceId, await deviceIdOf(sam)];
  const n = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const pair = (device: string, rooms: string, name: string) => pairRooms({ origin: service.origin, rooms, name, device, secret: n }, noRunner, home);
  // Every room failed (it doesn't exist): no claim.
  const nothing = await pair(robinId, crypto.randomUUID(), 'Robin');
  expect(nothing.rooms.map(r => r.state)).toEqual(['failed']);
  expect(existsSync(join(home, 'pairing.json'))).toBe(false);
  // A room took the request: Robin claims the app, and Sam is refused while the request waits.
  await pair(robinId, own, 'Robin');
  expect(existsSync(join(home, 'pairing.json'))).toBe(true);
  const agent = personAgent(own, home);
  writeFileSync(join(agent.dir, 'admission.json'), JSON.stringify({ state: 'pending', kind: 'companion', expiresAt: Date.now() + 600_000, at: Date.now() }));
  await expect(pair(samId, own, 'Sam')).rejects.toThrow('This app is paired with Robin');
  // Robin never confirmed, and the request expired: the claim lapsed, and Sam may pair.
  writeFileSync(join(agent.dir, 'admission.json'), JSON.stringify({ state: 'expired', kind: 'companion', expiresAt: Date.now() - 1, at: Date.now() }));
  await pair(samId, own, 'Sam');
  expect(personStatus(home).pairedWith).toEqual({ name: 'Sam', origin: service.origin });
});


test('create makes a room hosted by the person device, with the invite code the service asks for', async () => {
  const { home } = folders();
  let handle: ReturnType<typeof browserHandler> | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request, s) => handle!(request, s.requestIP(request)?.address ?? 'unknown') });
  const origin = `http://127.0.0.1:${server.port}`, lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  handle = browserHandler(lobby, origin, '.');
  cleanups.push(() => { server.stop(true); lobby.close(); });
  const create = (extra: Record<string, unknown> = {}) => createRoom({ origin, title: 'Launch', name: 'Robin', ...extra }, noRunner, home);
  await expect(create({ title: '' })).rejects.toThrow('Give the room a name');
  await expect(create()).rejects.toMatchObject({ code: 'invite-required' });
  expect(personRooms(home)).toEqual([]);
  expect(readdirSync(join(home, 'browser-agents'))).toEqual([]);
  const { code } = mintInvite((lobby as unknown as { db: Parameters<typeof mintInvite>[0] }).db, { uses: 1, days: 1 });
  const made = await create({ invite: code });
  expect(made).toMatchObject({ origin, title: 'Launch', state: 'joined', url: `${origin}/r/${made.roomId}` });
  expect(personRooms(home)).toEqual([expect.objectContaining({ roomId: made.roomId, origin, kind: 'person', name: 'Robin' })]);
  const status = await personAgent(made.roomId, home).command('status', { session: crypto.randomUUID() });
  expect(status.memberId).toBe(status.ownerId);
  // A retry of the same room (its answer lost) finds it made.
  expect(await create({ invite: code, roomId: made.roomId })).toMatchObject({ roomId: made.roomId, state: 'joined' });
  expect(defaultRoomService(home, {})).toBe(origin);
  expect(defaultRoomService(join(home, 'nobody'), {})).toBe('https://meshrooms.wormdb.dev');
  expect(defaultRoomService(home, { MESHROOMS_ROOM_SERVICE: 'https://rooms.example' })).toBe('https://rooms.example');
});

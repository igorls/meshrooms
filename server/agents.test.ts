import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCli, answered, customPreview, appIdentityFolder, releaseIdentities, bootstrapPrompt, bootstrapSession, hermesSessionName, isDaemonCommand, newSessionArgs, terminal } from './agent-cli';
import { authorizeBinding, disableBinding, readBinding, runningDaemon } from './agent-daemon';
import { WATCH_TIMING, harnessInvocation, knownAgentHomes, recordAgentHome, splitTemplate, type WatchConfig } from './agent-watch';
import { AGENTS_FILE, APPROVALS_FILE, BIND_NEW_LIMIT, IDENTITY_MARKER, MAX_APPROVALS, MAX_IDENTITIES, MAX_REQUESTS_PER_HARNESS, agentReview, identityHome, pathFree, rateLimit, readApprovals, readIdentities, type AgentDeps } from './agents';
import { BrowserAgent } from './browser-agent';
import { BrowserLobby } from './browser/lobby';
import { browserHandler } from './browser/http';
import { client } from './browser/test-client';
import { processRuns } from './browser/fake-runner';
import type { HarnessScan, SessionListing } from './detectors/harnesses';
import { localControlToken, readLocalApi, startLocalApi } from './local-api';
import type { AgentServices } from './local-agents';
import { initPerson, joinRoom, personAgent, queueMessage, roomState } from './person';
import { testDirectory } from './test-directory';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch { /* Best effort. */ } });
// Nothing here may reach the real ~/.meshrooms: the registry, and with it the person and daemon folders, move to a
// folder of this file's own.
const sandboxKeys = ['MESHROOMS_AGENT_HOME', 'MESHROOMS_AGENT_REGISTRY', 'MESHROOMS_DAEMON_DIR', 'MESHROOMS_PERSON_HOME', 'MESHROOMS_LOCAL_PORT'] as const;
let sandbox: { dir: ReturnType<typeof testDirectory>; saved: (string | undefined)[] } | undefined;
beforeAll(() => {
  const dir = testDirectory('agents-home');
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
const until = async <T>(look: () => T | undefined | false | Promise<T | undefined | false>, ms = 20_000) => {
  for (const by = Date.now() + ms; Date.now() < by; await Bun.sleep(100)) { const seen = await look(); if (seen) return seen; }
  throw new Error('timed out');
};
const noRunner = async () => ({ outcome: 'test' });

/**
 * A person whose device the host admitted into a hosted room. The room's roster is written as its runner would (members.json),
 * so the person device signs commands without a runner.
 */
async function admittedPerson() {
  const dir = testDirectory('agents'); cleanups.push(dir.cleanup);
  const service = coordinator(), host = await client(service.lobby, Date.now, service.origin), roomId = crypto.randomUUID();
  await host.send('create', roomId, { title: 'Design review', name: 'Alex', label: 'Desktop' });
  const home = join(dir.path, 'person'), daemon = join(dir.path, 'daemon');
  await initPerson(home);
  await joinRoom({ url: `${service.origin}/r/${roomId}`, kind: 'person', name: 'Robin', label: 'Meshrooms app' }, noRunner, home);
  await host.send('decide', roomId, { requestId: (await host.status(roomId)).requests![0].id, admit: true });
  const person = personAgent(roomId, home), status = await person.command('status', { session: crypto.randomUUID() });
  writeFileSync(join(person.dir, 'members.json'), JSON.stringify({ memberId: status.memberId, ownerId: status.ownerId, title: status.title, members: status.members, devices: [] }));
  return { dir: dir.path, home, daemon, roomId, host, person, personMember: status.memberId as string, ...service };
}

/** The host admits the agents waiting (a guest's agent waits for the host: the room's own rule). */
async function admitAgents(room: Awaited<ReturnType<typeof admittedPerson>>) {
  for (const r of (await room.host.status(room.roomId)).requests!.filter(r => r.kind === 'agent' && r.state === 'pending'))
    await room.host.send('decide', room.roomId, { requestId: r.id, admit: true });
}
/** The agent's roster as its runner would write it, after the host admitted it. */
async function rosterOf(room: Awaited<ReturnType<typeof admittedPerson>>, id: string) {
  const agent = new BrowserAgent(identityHome(room.home, id), room.origin, room.roomId), status = await agent.command('status', { session: crypto.randomUUID() });
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: status.memberId, title: status.title, members: status.members, devices: [] }));
  await personRoster(room);
  return status.memberId as string;
}
/** The person device's roster as its runner would write it (who operates which agent). */
async function personRoster(room: Awaited<ReturnType<typeof admittedPerson>>) {
  const status = await room.person.command('status', { session: crypto.randomUUID() });
  writeFileSync(join(room.person.dir, 'members.json'), JSON.stringify({ memberId: status.memberId, ownerId: status.ownerId, title: status.title, members: status.members, devices: [] }));
}
/** Fake deps: connect redeems the link for real (so the room service makes the member), the rest is recorded. */
function fakeDeps() {
  const calls: { bind: { dir: string; values: Record<string, string> }[]; unbind: string[]; bootstrap: { harness: string; name: string; title: string | null; identityId: string }[]; connect: Record<string, unknown>[];
    stopRoom: string[]; preflight: string[] } = { bind: [], unbind: [], bootstrap: [], connect: [], stopRoom: [], preflight: [] };
  const deps: AgentDeps = {
    connect: async input => {
      calls.connect.push({ ...input, token: input.token ? 'given' : 'none' });
      const agent = new BrowserAgent(input.agentHome, input.origin, input.roomId);
      await agent.command('agent-redeem', { token: input.token, label: input.label });
      writeFileSync(join(agent.dir, 'room.json'), JSON.stringify({ origin: input.origin, roomId: input.roomId, link: 'x' }));
      const status = await agent.command('status', { session: crypto.randomUUID() });
      writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: status.memberId, title: status.title, members: status.members, devices: [] }));
      return { state: status.memberId ? 'connected' : 'waiting-for-host', bridge: { runner: 'daemon' } };
    },
    bind: async (agent, values) => { calls.bind.push({ dir: agent.dir, values }); return { pid: null }; },
    unbind: async agent => { calls.unbind.push(agent.dir); return { stopped: false, wakes: 'off' }; },
    bootstrap: async (_agent, input) => { calls.bootstrap.push(input); return 'b6d1b2a4-1f8e-4c56-9d6f-0d0f7c1b2e3a'; },
    sessionFolder: (harness, session) => harness === 'claude' && session === existingClaude ? join(sandbox!.dir.path, 'project') : undefined,
    checkCommand: command => { splitTemplate(command); },
    preflight: async origin => { calls.preflight.push(origin); },
    stopRoom: async agent => { calls.stopRoom.push(agent.dir); },
  };
  const scan: HarnessScan[] = [{ harness: 'claude', label: 'Claude Code', detected: true, version: '2.1.289', sessionsAvailable: true },
    { harness: 'exec', label: 'Custom command', detected: true, sessionsAvailable: false, reason: 'custom-command' }];
  const listing: SessionListing = { harness: 'claude', sessionsAvailable: true, truncated: false, sessions: [{ id: existingClaude, title: 'Synthetic title', folder: 'project', lastActiveAt: new Date(0).toISOString() }] };
  const services: AgentServices = { deps, scanner: { scan: async () => scan, sessions: async h => h === 'claude' ? listing : { harness: h, sessionsAvailable: false, sessions: [], truncated: false } } };
  return { deps, calls, services };
}
const existingClaude = '4b8f6c1e-2d3a-4e5f-8a9b-0c1d2e3f4a5b';

/** The local API on a loopback port, with fake agent deps; `page` is the Meshrooms page (its Origin and session token). */
async function served(room: Awaited<ReturnType<typeof admittedPerson>>, options: { approvals?: boolean } = {}) {
  const fake = fakeDeps();
  const api = startLocalApi({ dir: room.daemon, home: room.home, port: 0, log: () => {}, agents: fake.services, ...(options.approvals ? { approvals: true } : {}) });
  cleanups.push(() => api.stop());
  const base = `http://127.0.0.1:${api.port}`, control = { Authorization: `Bearer ${localControlToken(readLocalApi(room.daemon)!.secret)}` };
  const { ticket } = await (await fetch(`${base}/api/local/ticket`, { method: 'POST', headers: control })).json() as { ticket: string };
  const { token } = await (await fetch(`${base}/api/local/session`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) })).json() as { token: string };
  const call = async (as: 'page' | 'control', method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = as === 'page' ? { Authorization: `Bearer ${token}`, Origin: base } : { ...control };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  return { ...fake, api, base, call };
}

test('identities: made by the person at a terminal (never with a command), or asked for and approved in the app; kept private', async () => {
  const room = await admittedPerson();
  process.env.MESHROOMS_PERSON_HOME = room.home;
  const interactive = terminal.interactive;
  try {
    // No person at a terminal (an agent's shell, a harness, a pipe): create is refused, whatever it asks for.
    terminal.interactive = () => false;
    await expect(agentCli(['agent', 'create', '--name', 'Wren', '--harness', 'claude'])).rejects.toThrow('interactive terminal');
    terminal.interactive = () => true;
    // At the terminal: what the page can make, and no more. A custom command is never created without the app's approval.
    await expect(agentCli(['agent', 'create', '--name', 'Wren', '--harness', 'exec', '--command', 'my-agent {prompt_file}'])).rejects.toThrow('only you make one, in the Meshrooms app');
    await expect(agentCli(['agent', 'create', '--name', 'Wren', '--harness', 'claude', '--command', 'x {prompt_file}'])).rejects.toThrow('only you make one, in the Meshrooms app');
    await expect(agentCli(['agent', 'create', '--name', 'agents', '--harness', 'claude'])).rejects.toThrow('reserved');
    await expect(agentCli(['agent', 'create', '--name', 'Wren', '--harness', 'gpt'])).rejects.toThrow('harness');
    const made = await agentCli(['agent', 'create', '--name', 'Wren', '--harness', 'claude']) as Record<string, unknown>;
    expect(made).toMatchObject({ created: true, name: 'Wren', harness: 'claude', label: 'Claude Code', custom: false, model: null, rooms: [] });
    await expect(agentCli(['agent', 'create', '--name', 'wren', '--harness', 'codex'])).rejects.toThrow('already have an agent named');
    expect(await agentCli(['agent', 'create', '--name', 'Ash', '--harness', 'claude', '--model', 'sonnet'])).toMatchObject({ name: 'Ash', model: 'sonnet' });
    expect((await agentCli(['agent', 'list']) as { agents: unknown[] }).agents).toHaveLength(2);
    if (process.platform !== 'win32') expect(statSync(join(room.home, AGENTS_FILE)).mode & 0o077).toBe(0);
    // A tampered entry is left out, never guessed at: a command on a non-exec identity, say.
    const raw = JSON.parse(readFileSync(join(room.home, AGENTS_FILE), 'utf8'));
    writeFileSync(join(room.home, AGENTS_FILE), JSON.stringify([...raw, { ...raw[1], id: crypto.randomUUID(), name: 'Evil', command: 'calc {prompt_file}' }]));
    expect(readIdentities(room.home).map(i => i.name)).toEqual(['Wren', 'Ash']);

    // A request (anyone may file one, an agent included) does nothing until the app approves it; asking twice files one.
    terminal.interactive = () => false;
    // A request never chooses a custom command: no exec harness, no --command, whatever else it says.
    await expect(agentCli(['agent', 'request', '--name', 'Fern', '--harness', 'exec'])).rejects.toThrow('only you make one, in the Meshrooms app');
    await expect(agentCli(['agent', 'request', '--name', 'Fern', '--harness', 'exec', '--command', 'my-agent {prompt_file}'])).rejects.toThrow('only you make one, in the Meshrooms app');
    await expect(agentCli(['agent', 'request', '--name', 'Fern', '--harness', 'claude', '--command', 'x {prompt_file}'])).rejects.toThrow('only you make one, in the Meshrooms app');
    await expect(agentCli(['agent', 'request', '--name', 'Fe\u202ern', '--harness', 'claude'])).rejects.toThrow('plain text');
    await expect(agentCli(['agent', 'request', '--name', 'Ash', '--harness', 'claude'])).rejects.toThrow('already an agent named');
    const asked = await agentCli(['agent', 'request', '--name', 'Fern', '--harness', 'codex', '--model', 'gpt-5']) as { approvalId: string };
    expect(await agentCli(['agent', 'request', '--name', 'fern', '--harness', 'claude'])).toMatchObject({ approvalId: asked.approvalId });
    // A name, a harness and a model: that is all a request holds.
    expect(readApprovals(room.home)).toEqual([{ id: asked.approvalId, kind: 'identity', name: 'Fern', harness: 'codex', model: 'gpt-5', requestedAt: expect.any(Number), expiresAt: expect.any(Number) }]);
    expect(readIdentities(room.home).map(i => i.name)).toEqual(['Wren', 'Ash']);
    // A hand-edited request carrying anything more (a command, rooms, a folder, tools, a session) or a custom-command
    // harness, or shown text that isn't plain, is no request at all: the app can't be shown less than would be applied.
    const filed = JSON.parse(readFileSync(join(room.home, APPROVALS_FILE), 'utf8'));
    for (const extra of [{ command: 'calc {prompt_file}' }, { rooms: [crypto.randomUUID()] }, { cwd: '/' }, { allowTools: ['Bash'] }, { session: existingClaude }, { harness: 'exec' }, { name: 'F\u202eern' }]) {
      writeFileSync(join(room.home, APPROVALS_FILE), JSON.stringify([{ ...filed[0], ...extra }]));
      expect(readApprovals(room.home)).toEqual([]);
    }
    writeFileSync(join(room.home, APPROVALS_FILE), JSON.stringify(filed));
    expect(readApprovals(room.home)).toHaveLength(1);
    if (process.platform !== 'win32') expect(statSync(join(room.home, APPROVALS_FILE)).mode & 0o077).toBe(0);
    // Nothing on the command line approves: approve is the app's, refused without its proof (no running daemon here).
    await expect(agentCli(['agent', 'approve', '--id', asked.approvalId])).rejects.toThrow('Approve this in the Meshrooms app');
    await expect(agentCli(['agent', 'custom', '--name', 'Oak'])).rejects.toThrow('Approve this in the Meshrooms app');
  } finally { terminal.interactive = interactive; delete process.env.MESHROOMS_PERSON_HOME; }
}, 30_000);

test('the page creates an identity and puts it into a room: a member the person operates, made from a link the person device signed', async () => {
  const room = await admittedPerson(), api = await served(room);
  expect(await api.call('page', 'GET', '/api/local/harnesses')).toMatchObject({ status: 200, body: { harnesses: [expect.objectContaining({ harness: 'claude' }), expect.objectContaining({ harness: 'exec' })] } });
  expect((await api.call('page', 'GET', '/api/local/harnesses/claude/sessions')).body.sessions).toEqual([expect.objectContaining({ id: existingClaude, title: 'Synthetic title' })]);
  expect((await api.call('page', 'GET', '/api/local/harnesses/nope/sessions')).status).toBe(404);
  // No custom command from the page, ever.
  expect(await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'exec' })).toMatchObject({ status: 400 });
  expect(await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude', command: 'calc {prompt_file}' })).toMatchObject({ status: 400 });
  expect(await api.call('page', 'POST', '/api/local/agents', { name: '', harness: 'claude' })).toMatchObject({ status: 400 });
  const made = await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude', model: 'sonnet' });
  expect(made).toMatchObject({ status: 201, body: { agent: { name: 'Wren', harness: 'claude', label: 'Claude Code', model: 'sonnet', rooms: [] } } });
  const id = made.body.agent.id as string;

  expect(await api.call('page', 'POST', `/api/local/rooms/${crypto.randomUUID()}/agents`, { identity: id })).toMatchObject({ status: 404 });
  expect(await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: crypto.randomUUID() })).toMatchObject({ status: 404 });
  const put = await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  // A guest's agent waits for the host, as the room's rules say; the host admits it.
  expect(put).toMatchObject({ status: 201, body: { identityId: id, roomId: room.roomId, state: 'waiting' } });
  expect((await api.call('page', 'GET', '/api/local/agents')).body.agents[0].rooms).toEqual([expect.objectContaining({ roomId: room.roomId, memberId: null, state: 'waiting' })]);
  // Waiting for the host: no second link is made.
  expect(await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id })).toMatchObject({ status: 409, body: { error: expect.stringContaining('waiting for the host') } });
  expect(api.calls.connect).toHaveLength(1);
  await admitAgents(room);
  await rosterOf(room, id);
  expect(api.calls.connect).toEqual([expect.objectContaining({ agentHome: identityHome(room.home, id), roomId: room.roomId, harness: 'Claude Code', model: 'sonnet', label: 'Meshrooms app', token: 'given' })]);
  const member = (await room.host.status(room.roomId)).members!.find(m => m.name === 'Wren')!;
  expect(member).toMatchObject({ role: 'agent', operatorId: room.personMember });
  // In the room already: not added again.
  expect(await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id })).toMatchObject({ status: 409 });
  const listed = (await api.call('page', 'GET', '/api/local/agents')).body;
  expect(listed).toMatchObject({ approvalsWaiting: 0, agents: [{ id, name: 'Wren', rooms: [{ roomId: room.roomId, memberId: member.id, title: 'Design review', state: 'connected', binding: { wakes: 'unbound' } }] }] });
  expect(JSON.stringify(listed)).not.toContain(room.home);

  // The room's own rule: four agents per operator per room, as the room service says it.
  for (const name of ['Ash', 'Fern', 'Oak', 'Elm']) {
    const other = (await api.call('page', 'POST', '/api/local/agents', { name, harness: 'codex' })).body.agent.id;
    const answer = await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: other });
    if (name === 'Elm') expect(answer).toMatchObject({ status: 429, body: { error: expect.stringContaining('four agents') } });
    else expect(answer.status).toBe(201);
    await admitAgents(room);
  }
}, 60_000);

test('every agent route: the right credential, the person\'s own rooms (admitted), and only agents this person operates', async () => {
  const room = await admittedPerson(), api = await served(room, { approvals: true });
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  await admitAgents(room);
  const member = await rosterOf(room, id);
  // Another person's agent in the same room: the host's own.
  const { token } = await room.host.send('agent-invite', room.roomId, { name: 'Alexbot' }) as unknown as { token: string };
  const theirs = new BrowserAgent(join(room.dir, 'host-agent'), room.origin, room.roomId);
  await theirs.command('agent-redeem', { token, label: 'Elsewhere' });
  await personRoster(room);
  const alexbot = (await room.host.status(room.roomId)).members!.find(m => m.name === 'Alexbot')!;
  expect(alexbot.operatorId).not.toBe(room.personMember);
  // A room the person asked to join and still waits in, and one they are not in at all.
  const pending = crypto.randomUUID(), unknown = crypto.randomUUID();
  await room.host.send('create', pending, { title: 'Waiting room', name: 'Alex', label: 'Desktop' });
  await joinRoom({ url: `${room.origin}/r/${pending}`, kind: 'person', name: 'Robin', label: 'Meshrooms app' }, noRunner, room.home);

  const routes: [string, string, unknown?][] = [
    ['GET', '/api/local/harnesses'], ['GET', '/api/local/harnesses/claude/sessions'], ['GET', '/api/local/agents'], ['POST', '/api/local/agents', { name: 'Ash', harness: 'claude' }],
    ['POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id }], ['POST', `/api/local/rooms/${room.roomId}/agents/${member}/bind`, { session: 'new' }],
    ['POST', `/api/local/rooms/${room.roomId}/agents/${member}/unbind`], ['GET', '/api/local/approvals'], ['POST', '/api/local/app/agents', { name: 'Oak', harness: 'claude' }]];
  const control = { Authorization: `Bearer ${localControlToken(readLocalApi(room.daemon)!.secret)}` };
  for (const [method, path, body] of routes) {
    const init = (headers: Record<string, string>) => ({ method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    // No credential, a made-up one, and the control token from a browser: refused before anything is done.
    expect((await fetch(`${api.base}${path}`, init({ Origin: api.base }))).status).toBe(401);
    expect((await fetch(`${api.base}${path}`, init({ Origin: api.base, Authorization: `Bearer ${'x'.repeat(43)}` }))).status).toBe(401);
    expect((await fetch(`${api.base}${path}`, init({ ...control, Origin: api.base }))).status).toBe(403);
  }
  // The app-only routes never take the page's token.
  expect((await api.call('page', 'GET', '/api/local/approvals')).status).toBe(403);
  expect((await api.call('page', 'POST', '/api/local/app/agents', { name: 'Oak', harness: 'claude' })).status).toBe(403);
  expect(readIdentities(room.home).map(i => i.name)).toEqual(['Wren']);

  // Room-scoped: an unknown room, and one the person waits in.
  for (const roomId of [unknown, pending]) {
    const want = roomId === unknown ? 404 : 409;
    expect((await api.call('page', 'POST', `/api/local/rooms/${roomId}/agents`, { identity: id })).status).toBe(want);
    expect((await api.call('page', 'POST', `/api/local/rooms/${roomId}/agents/${id}/bind`, { session: 'new' })).status).toBe(want);
    expect((await api.call('page', 'POST', `/api/local/rooms/${roomId}/agents/${id}/unbind`)).status).toBe(want);
  }
  // Member-scoped: another person's agent is not this person's to bind, unbind or file a bind for.
  for (const action of ['bind', 'unbind'])
    expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${alexbot.id}/${action}`, action === 'bind' ? { session: 'new' } : undefined)).status).toBe(404);
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${alexbot.id}/bind`, { session: existingClaude })).status).toBe(404);
  // Nor when the identity's own folder is made to claim that member: the room's roster says who operates it.
  const folder = join(identityHome(room.home, id), 'browser-agents', room.roomId, 'members.json'), real = readFileSync(folder, 'utf8');
  writeFileSync(folder, JSON.stringify({ ...JSON.parse(real), memberId: alexbot.id }));
  for (const action of ['bind', 'unbind'])
    expect(await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${alexbot.id}/${action}`, action === 'bind' ? { session: 'new' } : undefined)).toMatchObject({ status: 403, body: { error: expect.stringContaining('not an agent you operate') } });
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${id}/bind`, { session: existingClaude })).status).toBe(403);
  writeFileSync(folder, real);
  // An identity id resolves only among the person's own: a made-up one, or another person's agent's id, is nothing.
  for (const other of [crypto.randomUUID(), alexbot.id])
    expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: other })).status).toBe(404);
  // The sessions listing takes a harness name from the fixed set only, never a path.
  for (const name of ['..%2F..%2Fetc', 'CLAUDE', 'claude%00', 'shell']) expect((await api.call('page', 'GET', `/api/local/harnesses/${name}/sessions`)).status).toBe(404);
  expect(api.calls.bind).toEqual([]);
  expect(api.calls.unbind).toEqual([]);
  expect(api.calls.bootstrap).toEqual([]);
}, 60_000);

test('binding: a new session is bound at once (logged), an existing one only filed for the app, and approvals are app-only', async () => {
  const room = await admittedPerson(), api = await served(room);
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  await admitAgents(room);
  const member = await rosterOf(room, id);
  expect((await api.call('page', 'GET', '/api/local/agents')).body.agents[0].rooms[0].memberId).toBe(member);
  const bind = (body: unknown, who: string = member) => api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${who}/bind`, body);

  // Another folder or command is the terminal's to choose.
  expect(await bind({ session: 'new', cwd: '/elsewhere' })).toMatchObject({ status: 400 });
  expect(await bind({ session: '../../x' })).toMatchObject({ status: 400 });
  expect(await bind({ session: 'new' }, crypto.randomUUID())).toMatchObject({ status: 404 });
  // No existing session rides in on a new one: a body is { session } and nothing else.
  for (const smuggled of [{ session: 'new', sessionId: existingClaude }, { session: 'new', resume: existingClaude }, { session: 'new', id: existingClaude }, { session: 'NEW' }, { session: ['new'] }])
    expect([400, 404]).toContain((await bind(smuggled)).status);
  // Nor through the terminal: bind and watch refuse an app identity's room folder, whatever session they name.
  process.env.MESHROOMS_PERSON_HOME = room.home; process.env.MESHROOMS_AGENT_HOME = identityHome(room.home, id);
  try {
    for (const verb of ['bind', 'watch'])
      await expect(agentCli([verb, '--room', room.roomId, '--harness', 'claude', '--session', existingClaude, '--cwd', sandbox!.dir.path])).rejects.toThrow('belongs to the Meshrooms app');
  } finally { delete process.env.MESHROOMS_PERSON_HOME; process.env.MESHROOMS_AGENT_HOME = join(sandbox!.dir.path, 'agents'); }
  expect(api.calls.bind).toEqual([]);
  // New: the session starts in the background, then the binding is made in the room's wake folder.
  const started = await bind({ session: 'new' });
  expect(started).toMatchObject({ status: 202, body: { identityId: id, kind: 'new', state: 'starting' } });
  await until(() => readIdentities(room.home)[0].bound?.[room.roomId]?.state === 'bound');
  expect(api.calls.bootstrap).toEqual([{ harness: 'claude', name: 'Wren', title: 'Design review', identityId: id }]);
  const roomDir = join(identityHome(room.home, id), 'browser-agents', room.roomId);
  expect(api.calls.bind).toEqual([{ dir: roomDir, values: { '--harness': 'claude', '--session': 'b6d1b2a4-1f8e-4c56-9d6f-0d0f7c1b2e3a', '--cwd': join(roomDir, 'wake') } }]);
  const log = readFileSync(join(room.home, 'agents.log'), 'utf8');
  expect(log).toContain('"event":"bind-new"');
  expect(log).not.toContain('Design review');

  // Existing: 403, filed once for the app, nothing bound.
  expect(await bind({ session: crypto.randomUUID() })).toMatchObject({ status: 404 });
  const asked = await bind({ session: existingClaude }), approvalId = asked.body.approvalId as string;
  expect(asked).toMatchObject({ status: 403, body: { approval: 'pending' } });
  expect(approvalId).toMatch(/^[a-f0-9-]{36}$/);
  expect((await bind({ session: existingClaude })).body.approvalId).toBe(approvalId);
  expect(api.calls.bind).toHaveLength(1);
  expect((await api.call('page', 'GET', '/api/local/agents')).body.approvalsWaiting).toBe(1);
  // With approvals off (this daemon), the approval routes don't exist, whoever asks.
  expect((await api.call('control', 'GET', '/api/local/approvals')).status).toBe(404);
  expect((await api.call('page', 'POST', `/api/local/approvals/${approvalId}/approve`)).status).toBe(404);

  // Unbind: wakes off, the agent stays.
  expect(await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/unbind`)).toMatchObject({ status: 200, body: { wakes: 'off' } });
  expect(api.calls.unbind).toEqual([roomDir]);
  expect(readIdentities(room.home)[0].bound).toEqual({});
}, 60_000);

test('approvals: only the control token (a local program, the app) lists, approves and rejects; never the page', async () => {
  const room = await admittedPerson(), api = await served(room, { approvals: true });
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  const asked = (await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${id}/bind`, { session: existingClaude })).body.approvalId as string;
  process.env.MESHROOMS_PERSON_HOME = room.home;
  const request = await agentCli(['agent', 'request', '--name', 'Fern', '--harness', 'codex']) as { approvalId: string };
  const elm = await agentCli(['agent', 'request', '--name', 'Elm', '--harness', 'claude']) as { approvalId: string };
  const ivy = await agentCli(['agent', 'request', '--name', 'Ivy', '--harness', 'hermes']) as { approvalId: string };
  delete process.env.MESHROOMS_PERSON_HOME;

  for (const [method, path] of [['GET', '/api/local/approvals'], ['POST', `/api/local/approvals/${asked}/approve`], ['POST', `/api/local/approvals/${asked}/reject`]] as const)
    expect(await api.call('page', method, path)).toMatchObject({ status: 403, body: { error: 'Approve this in the Meshrooms app.' } });
  // The daemon that serves them is still known as the daemon (person open, daemon stop) by its command line.
  expect(isDaemonCommand('/opt/bun/bun --no-env-file /srv/bin/meshrooms.js daemon run --approvals')).toBe(true);
  expect(isDaemonCommand('"C:\\bun\\bun.exe" --no-env-file "C:\\bin\\meshrooms.js" daemon run --approvals --bin-dir C:\\bin')).toBe(true);
  expect(isDaemonCommand('/opt/bun/bun /srv/bin/meshrooms.js daemon run --approve')).toBe(false);
  // A browser can't use the control token: any Origin or Sec-Fetch-Site and it is refused.
  const control = { Authorization: `Bearer ${localControlToken(readLocalApi(room.daemon)!.secret)}` };
  expect((await fetch(`${api.base}/api/local/approvals`, { headers: { ...control, Origin: api.base } })).status).toBe(403);
  expect((await fetch(`${api.base}/api/local/approvals`, { headers: { ...control, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(403);

  const listed = (await api.call('control', 'GET', '/api/local/approvals')).body.approvals as { id: string; digest: string }[];
  expect(listed).toEqual([
    expect.objectContaining({ id: asked, kind: 'bind-existing', identityId: id, roomId: room.roomId, harness: 'claude', session: existingClaude, title: 'Synthetic title', folder: 'project',
      cwd: join(sandbox!.dir.path, 'project'), identityName: 'Wren', identityModel: null, roomTitle: 'Design review' }),
    expect.objectContaining({ id: request.approvalId, kind: 'identity', name: 'Fern', harness: 'codex' }),
    expect.objectContaining({ id: elm.approvalId, kind: 'identity', name: 'Elm', harness: 'claude' }),
    expect.objectContaining({ id: ivy.approvalId, kind: 'identity', name: 'Ivy', harness: 'hermes' })]);
  // The view is every stored field, and only those, as plain text, with the digest of exactly that.
  expect(Object.keys(listed.find(a => a.id === elm.approvalId)!).sort()).toEqual(['digest', 'expiresAt', 'harness', 'id', 'kind', 'name', 'requestedAt']);
  // A bind-existing view also names its identity and room as they are now: labels for the ids its digest covers.
  expect(Object.keys(listed.find(a => a.id === asked)!).sort()).toEqual(['cwd', 'digest', 'expiresAt', 'folder', 'harness', 'id', 'identityId', 'identityModel', 'identityName', 'kind', 'requestedAt', 'roomId', 'roomTitle', 'session', 'title']);
  const digest = (approval: string) => listed.find(a => a.id === approval)!.digest;
  // Approving names what the app showed: without it, or after the request changed, nothing is approved.
  expect(await api.call('control', 'POST', `/api/local/approvals/${asked}/approve`, {})).toMatchObject({ status: 409 });
  const filed = JSON.parse(readFileSync(join(room.home, APPROVALS_FILE), 'utf8'));
  const other = 'c0ffee00-1111-4222-8333-444455556666';
  writeFileSync(join(room.home, APPROVALS_FILE), JSON.stringify(filed.map((a: { id: string }) => a.id === asked ? { ...a, session: other } : a)));
  expect(await api.call('control', 'POST', `/api/local/approvals/${asked}/approve`, { digest: digest(asked) })).toMatchObject({ status: 409, body: { error: expect.stringContaining('changed since it was shown') } });
  expect(api.calls.bind).toEqual([]);
  writeFileSync(join(room.home, APPROVALS_FILE), JSON.stringify(filed));
  // What the bind is shown with and applies besides the request (the identity's name and model, the room's title) is in
  // the digest too: the model the bind would run changed since it was shown, and nothing is bound.
  const identitiesFile = readFileSync(join(room.home, AGENTS_FILE), 'utf8');
  writeFileSync(join(room.home, AGENTS_FILE), JSON.stringify(JSON.parse(identitiesFile).map((i: { id: string }) => i.id === id ? { ...i, model: 'opus' } : i)));
  expect(await api.call('control', 'POST', `/api/local/approvals/${asked}/approve`, { digest: digest(asked) })).toMatchObject({ status: 409, body: { error: expect.stringContaining('changed since it was shown') } });
  expect(api.calls.bind).toEqual([]);
  const relisted = (await api.call('control', 'GET', '/api/local/approvals')).body.approvals as { id: string; digest: string; identityModel: string | null }[];
  expect(relisted.find(a => a.id === asked)).toMatchObject({ identityModel: 'opus' });
  expect(relisted.find(a => a.id === asked)!.digest).not.toBe(digest(asked));
  writeFileSync(join(room.home, AGENTS_FILE), identitiesFile);
  // Approved: the existing session is bound, in its own folder.
  expect(await api.call('control', 'POST', `/api/local/approvals/${asked}/approve`, { digest: digest(asked) })).toMatchObject({ status: 200, body: { approved: true, session: existingClaude } });
  expect(api.calls.bind.at(-1)!.values).toEqual({ '--harness': 'claude', '--session': existingClaude, '--cwd': join(sandbox!.dir.path, 'project') });
  expect(readIdentities(room.home)[0].bound?.[room.roomId]).toMatchObject({ kind: 'existing', state: 'bound', session: existingClaude });
  // Rejected: nothing made.
  expect(await api.call('control', 'POST', `/api/local/approvals/${request.approvalId}/reject`)).toMatchObject({ status: 200, body: { rejected: true } });
  expect(readIdentities(room.home).map(i => i.name)).toEqual(['Wren']);
  // A bind-existing request whose shown title isn't plain text is no request.
  const kept = readFileSync(join(room.home, APPROVALS_FILE), 'utf8');
  writeFileSync(join(room.home, APPROVALS_FILE), JSON.stringify(JSON.parse(kept).map((a: { kind: string }) => a.kind === 'bind-existing' ? { ...a, title: 'Synthetic\u202e title' } : a)));
  expect(readApprovals(room.home).some(a => a.kind === 'bind-existing')).toBe(false);
  writeFileSync(join(room.home, APPROVALS_FILE), kept);
  // Approving an identity makes the identity and nothing else: no room, no binding. It is spent once used.
  expect(await api.call('control', 'POST', `/api/local/approvals/${elm.approvalId}/approve`, { digest: digest(elm.approvalId) })).toMatchObject({ status: 200, body: { approved: true } });
  expect((await api.call('page', 'GET', '/api/local/agents')).body.agents.find((a: { name: string }) => a.name === 'Elm')).toMatchObject({ harness: 'claude', custom: false, rooms: [] });
  expect(readIdentities(room.home).find(i => i.name === 'Elm')).not.toHaveProperty('bound');
  expect((await api.call('control', 'POST', `/api/local/approvals/${elm.approvalId}/approve`, { digest: digest(elm.approvalId) })).status).toBe(404);
  // Only for a harness this machine has (this machine's scan has no Hermes): it stays waiting, nothing made.
  expect(await api.call('control', 'POST', `/api/local/approvals/${ivy.approvalId}/approve`, { digest: digest(ivy.approvalId) })).toMatchObject({ status: 409, body: { error: expect.stringContaining('not installed') } });
  expect(readIdentities(room.home).map(i => i.name)).not.toContain('Ivy');
  expect(await api.call('control', 'POST', `/api/local/approvals/${ivy.approvalId}/reject`)).toMatchObject({ status: 200 });
  expect((await api.call('control', 'GET', '/api/local/approvals')).body.approvals).toEqual([]);
  expect((await api.call('control', 'POST', `/api/local/approvals/${asked}/approve`, { digest: digest(asked) })).status).toBe(404);

  // A custom command comes only from the person in the app's window: the app-only route, never the page.
  const make = { name: 'Oak', harness: 'exec', command: 'my-agent --prompt-file {prompt_file}' };
  expect(await api.call('page', 'POST', '/api/local/app/agents', make)).toMatchObject({ status: 403 });
  expect(await api.call('control', 'POST', '/api/local/app/agents', { ...make, command: '"unclosed {prompt_file}' })).toMatchObject({ status: 400 });
  expect(await api.call('control', 'POST', '/api/local/app/agents', make)).toMatchObject({ status: 201, body: { agent: { name: 'Oak', harness: 'exec', custom: true, rooms: [] } } });
  expect(readIdentities(room.home).find(i => i.name === 'Oak')).toMatchObject({ command: 'my-agent --prompt-file {prompt_file}' });

  // Capped, and an expired one is gone.
  process.env.MESHROOMS_PERSON_HOME = room.home;
  try {
    // One source can't fill the queue: a few requests per harness kind wait at once.
    for (let i = 0; i < MAX_REQUESTS_PER_HARNESS; i++) await agentCli(['agent', 'request', '--name', `Agent ${i}`, '--harness', 'claude']);
    await expect(agentCli(['agent', 'request', '--name', 'One more', '--harness', 'claude'])).rejects.toThrow(`${MAX_REQUESTS_PER_HARNESS} requests for Claude Code agents are waiting`);
    expect(await agentCli(['agent', 'request', '--name', 'A codex one', '--harness', 'codex'])).toMatchObject({ requested: true });
    // And the queue as a whole is capped.
    const full = Array.from({ length: MAX_APPROVALS }, () => ({ id: crypto.randomUUID(), kind: 'bind-existing', identityId: id, roomId: room.roomId, harness: 'codex', session: crypto.randomUUID(),
      title: null, folder: null, cwd: null, requestedAt: Date.now(), expiresAt: Date.now() + 60_000 }));
    writeFileSync(join(room.home, APPROVALS_FILE), JSON.stringify(full));
    expect(readApprovals(room.home)).toHaveLength(MAX_APPROVALS);
    await expect(agentCli(['agent', 'request', '--name', 'Over', '--harness', 'hermes'])).rejects.toThrow('Too many approvals');
    const raw = JSON.parse(readFileSync(join(room.home, APPROVALS_FILE), 'utf8'));
    writeFileSync(join(room.home, APPROVALS_FILE), JSON.stringify(raw.map((a: { expiresAt: number }) => ({ ...a, expiresAt: Date.now() - 1 }))));
    expect(readApprovals(room.home)).toEqual([]);
  } finally { delete process.env.MESHROOMS_PERSON_HOME; }
}, 60_000);

test('an app identity is never bound from the command line: not through another person folder, a link, or without its marker at the default place', async () => {
  const room = await admittedPerson(), api = await served(room);
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  expect(existsSync(join(identityHome(room.home, id), IDENTITY_MARKER))).toBe(true);
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  const elsewhere = testDirectory('agents-elsewhere'); cleanups.push(elsewhere.cleanup);
  const link = join(elsewhere.path, 'innocent-looking');
  symlinkSync(identityHome(room.home, id), link, 'junction');
  const bind = ['bind', '--room', room.roomId, '--harness', 'claude', '--session', existingClaude, '--cwd', sandbox!.dir.path];
  for (const agentHome of [identityHome(room.home, id), link]) {
    // The person folder named somewhere else entirely: the marker in the folder still says whose it is.
    process.env.MESHROOMS_PERSON_HOME = join(elsewhere.path, 'person'); process.env.MESHROOMS_AGENT_HOME = agentHome;
    try {
      for (const verb of ['bind', 'watch']) await expect(agentCli([verb, ...bind.slice(1)])).rejects.toThrow('belongs to the Meshrooms app');
    } finally { delete process.env.MESHROOMS_PERSON_HOME; process.env.MESHROOMS_AGENT_HOME = join(sandbox!.dir.path, 'agents'); }
  }
  // A link one level down: an agent folder of its own whose browser-agents, or whose room folder, leads into the
  // identity's. The check reads where the room folder really is, and the room folder carries the marker too.
  const roomDir = join(identityHome(room.home, id), 'browser-agents', room.roomId);
  expect(existsSync(join(roomDir, IDENTITY_MARKER))).toBe(true);
  const viaAgents = join(elsewhere.path, 'via-agents'), viaRoom = join(elsewhere.path, 'via-room');
  mkdirSync(viaAgents); mkdirSync(join(viaRoom, 'browser-agents'), { recursive: true });
  symlinkSync(join(identityHome(room.home, id), 'browser-agents'), join(viaAgents, 'browser-agents'), 'junction');
  symlinkSync(roomDir, join(viaRoom, 'browser-agents', room.roomId), 'junction');
  for (const agentHome of [viaAgents, viaRoom]) {
    process.env.MESHROOMS_PERSON_HOME = join(elsewhere.path, 'person'); process.env.MESHROOMS_AGENT_HOME = agentHome;
    try {
      for (const verb of ['bind', 'watch']) await expect(agentCli([verb, ...bind.slice(1)])).rejects.toThrow('belongs to the Meshrooms app');
    } finally { delete process.env.MESHROOMS_PERSON_HOME; process.env.MESHROOMS_AGENT_HOME = join(sandbox!.dir.path, 'agents'); }
  }
  // Even with the agent folder's marker gone, the room folder's still says whose it is.
  rmSync(join(identityHome(room.home, id), IDENTITY_MARKER));
  process.env.MESHROOMS_PERSON_HOME = join(elsewhere.path, 'person'); process.env.MESHROOMS_AGENT_HOME = viaRoom;
  try { await expect(agentCli(bind)).rejects.toThrow('belongs to the Meshrooms app'); }
  finally { delete process.env.MESHROOMS_PERSON_HOME; process.env.MESHROOMS_AGENT_HOME = join(sandbox!.dir.path, 'agents'); }
  expect(readBinding(roomDir, room.daemon)).toBeUndefined();
  expect(existsSync(join(roomDir, 'watch.json'))).toBe(false);
  // Without a marker, a folder under the default person folder (whatever the environment says) is the app's too, by
  // its real path, through a link as well.
  const fakeHome = join(elsewhere.path, 'home'), under = join(fakeHome, '.meshrooms', 'person', 'agents', crypto.randomUUID());
  mkdirSync(under, { recursive: true });
  symlinkSync(under, join(elsewhere.path, 'to-under'), 'junction');
  process.env.MESHROOMS_PERSON_HOME = join(elsewhere.path, 'person');
  try {
    expect(appIdentityFolder(under, fakeHome)).toBe(true);
    expect(appIdentityFolder(join(elsewhere.path, 'to-under'), fakeHome)).toBe(true);
    expect(appIdentityFolder(join(sandbox!.dir.path, 'agents'), fakeHome)).toBe(false);
  } finally { delete process.env.MESHROOMS_PERSON_HOME; }
}, 60_000);

test('what reaches the page never names a local path; a failed binding keeps a reason code', async () => {
  expect(pathFree('could not read C:\\Users\\someone\\project\\x.ts, giving up')).toBe('could not read <path>, giving up');
  // A path with spaces is taken whole, up to a delimiter: none of it is left behind.
  expect(pathFree('could not read C:\\Users\\Jane Doe\\my project\\x.ts, giving up', [])).toBe('could not read <path>, giving up');
  expect(pathFree('--cwd "/home/jane doe/my work" holds it', [])).toBe('--cwd "<path>" holds it');
  expect(pathFree('no folder at /home/jane doe/my work. Try again', [])).toBe('no folder at <path>. Try again');
  expect(pathFree('see \\\\server\\share\\a dir, twice', [])).toBe('see <path>, twice');
  // Known roots first, however they are spelled, so text after them can't hide them.
  const root = process.platform === 'win32' ? 'C:\\Users\\Jane Doe' : '/home/Jane Doe';
  for (const text of [`${root}\\x y`, `${root.replace(/\\/g, '/')}/x y`, `"${root.replace(/\\/g, '\\\\')}\\\\x"`])
    expect(pathFree(`at ${text}: nope`, [root])).not.toMatch(/Jane|Doe/);
  expect(pathFree(`in ${homedir()} and ${tmpdir()}`)).toBe('in <path> and <path>');
  expect(pathFree('https://rooms.example/r/1 and 3/4 and a-b/c')).toBe('https://rooms.example/r/1 and 3/4 and a-b/c');
  const room = await admittedPerson(), api = await served(room);
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  await admitAgents(room);
  const member = await rosterOf(room, id);
  const secretPath = process.platform === 'win32' ? 'C:\\Users\\jane doe\\secret project' : '/home/jane doe/secret project';
  api.deps.bind = async () => { throw new Error(`--cwd ${secretPath} holds ${secretPath}/.ssh, which a wake would be able to read.`); };
  expect(await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/bind`, { session: 'new' })).toMatchObject({ status: 202 });
  const failed = await until(async () => { const r = (await api.call('page', 'GET', '/api/local/agents')).body.agents[0].rooms[0]; return r.binding.state === 'failed' && r; });
  expect(failed.binding).toMatchObject({ kind: 'new', state: 'failed', reason: 'bind-refused' });
  expect(JSON.stringify(failed)).not.toMatch(/jane doe|secret project|doe\\|doe\//);
  // Nor what is stored.
  expect(readFileSync(join(room.home, AGENTS_FILE), 'utf8')).not.toMatch(/jane doe|secret|doe\\|doe\//);
  api.deps.bootstrap = async () => { throw new Error(`no session in ${secretPath}`); };
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/bind`, { session: 'new' })).status).toBe(202);
  expect(await until(async () => { const b = (await api.call('page', 'GET', '/api/local/agents')).body.agents[0].rooms[0].binding; return b.reason === 'bootstrap-failed' && b; }))
    .toMatchObject({ state: 'failed', error: expect.stringContaining('<path>') });
  // An error answered at once (an exec bind, a connect refusal) is path-free too.
  api.deps.unbind = async () => { throw Object.assign(new Error(`cannot stop ${secretPath}`), { status: 409 }); };
  const answer = await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/unbind`);
  expect(answer.status).toBe(409);
  expect(answer.body.error).not.toMatch(/jane doe|secret/);
}, 60_000);

test('no link is made for a put that can\'t go through, a failed connect cools the room down, and new sessions are rate limited', async () => {
  const room = await admittedPerson(), api = await served(room);
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  // The bridge check fails five times: no link is minted (the room service caps unused links at four), then it goes through.
  api.deps.preflight = async () => { throw new Error('This room service needs a newer bridge.'); };
  for (let i = 0; i < 5; i++) expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id })).status).toBe(502);
  api.deps.preflight = async () => {};
  const connect = api.deps.connect;
  api.deps.connect = async () => { throw new Error('the room service gave an unexpected answer'); };
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id })).status).toBe(502);
  // That link may be left unused: the room cools down.
  expect(await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id })).toMatchObject({ status: 429, body: { error: expect.stringContaining('failed a moment ago') } });
  api.deps.connect = connect;
  const other = await admittedPerson(), otherApi = await served(other);
  const oid = (await otherApi.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  expect((await otherApi.call('page', 'POST', `/api/local/rooms/${other.roomId}/agents`, { identity: oid })).status).toBe(201);
  await admitAgents(other);
  const member = await rosterOf(other, oid);
  // New sessions: each is a model run, so a few per agent per window.
  for (let i = 0; i < BIND_NEW_LIMIT.count; i++) {
    expect((await otherApi.call('page', 'POST', `/api/local/rooms/${other.roomId}/agents/${member}/bind`, { session: 'new' })).status).toBe(202);
    await until(() => readIdentities(other.home)[0].bound?.[other.roomId]?.state === 'bound');
  }
  expect(await otherApi.call('page', 'POST', `/api/local/rooms/${other.roomId}/agents/${member}/bind`, { session: 'new' })).toMatchObject({ status: 429 });
  expect(otherApi.calls.bootstrap).toHaveLength(BIND_NEW_LIMIT.count);
  let now = 0;
  const limit = rateLimit({ count: 2, windowMs: 1_000 }, () => now);
  limit.take('a', 'x'); limit.take('a', 'x');
  expect(() => limit.take('a', 'x')).toThrow('Too many');
  limit.take('b', 'x');
  now = 1_001; limit.take('a', 'x');
}, 90_000);

test('an approved existing-session bind uses the folder the app showed, and only while the session still says so', async () => {
  const room = await admittedPerson(), api = await served(room, { approvals: true });
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  const asked = await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${id}/bind`, { session: existingClaude });
  expect(asked.status).toBe(403);
  expect(JSON.stringify(asked.body)).not.toContain(sandbox!.dir.path);
  const shown = (await api.call('control', 'GET', '/api/local/approvals')).body.approvals[0];
  expect(shown).toMatchObject({ kind: 'bind-existing', cwd: join(sandbox!.dir.path, 'project'), folder: 'project' });
  // The transcript now names another folder: refused, nothing bound.
  const folderOf = api.deps.sessionFolder;
  api.deps.sessionFolder = () => join(sandbox!.dir.path, 'elsewhere');
  expect(await api.call('control', 'POST', `/api/local/approvals/${shown.id}/approve`, { digest: shown.digest })).toMatchObject({ status: 409, body: { error: expect.stringContaining('changed since it was shown') } });
  expect(api.calls.bind).toEqual([]);
  api.deps.sessionFolder = folderOf;
  expect((await api.call('control', 'POST', `/api/local/approvals/${shown.id}/approve`, { digest: shown.digest })).status).toBe(200);
  expect(api.calls.bind.at(-1)!.values['--cwd']).toBe(join(sandbox!.dir.path, 'project'));
}, 60_000);

test('identities: models start with a letter or digit, at most 32 are kept, and one is deleted from the page only while it is in no room', async () => {
  const room = await admittedPerson(), api = await served(room, { approvals: true });
  for (const model of ['--dangerous', '-x', '.hidden', '/abs']) expect((await api.call('page', 'POST', '/api/local/agents', { name: 'M', harness: 'claude', model })).status).toBe(400);
  const ids: string[] = [];
  for (let i = 0; i < MAX_IDENTITIES; i++) ids.push((await api.call('page', 'POST', '/api/local/agents', { name: `Agent ${i}`, harness: 'codex' })).body.agent.id);
  expect(await api.call('page', 'POST', '/api/local/agents', { name: 'One more', harness: 'codex' })).toMatchObject({ status: 429 });
  // In no room: the page deletes it, folder and all.
  expect(existsSync(identityHome(room.home, ids[1]))).toBe(true);
  expect(await api.call('page', 'DELETE', `/api/local/agents/${ids[1]}`)).toMatchObject({ status: 200, body: { deleted: true, leftRooms: 0 } });
  expect(existsSync(identityHome(room.home, ids[1]))).toBe(false);
  expect(readIdentities(room.home)).toHaveLength(MAX_IDENTITIES - 1);
  // In a room: only the app deletes it, and takes it out of the room.
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: ids[0] });
  await admitAgents(room);
  await rosterOf(room, ids[0]);
  expect((await room.host.status(room.roomId)).members!.some(m => m.name === 'Agent 0')).toBe(true);
  expect(await api.call('page', 'DELETE', `/api/local/agents/${ids[0]}`)).toMatchObject({ status: 403, body: { error: expect.stringContaining('Delete it in the Meshrooms app') } });
  expect(await api.call('control', 'DELETE', `/api/local/agents/${ids[0]}`)).toMatchObject({ status: 200, body: { deleted: true, leftRooms: 1 } });
  expect((await room.host.status(room.roomId)).members!.some(m => m.name === 'Agent 0')).toBe(false);
  expect(api.calls.stopRoom).toEqual([join(identityHome(room.home, ids[0]), 'browser-agents', room.roomId)]);
  expect(existsSync(identityHome(room.home, ids[0]))).toBe(false);
  expect(readIdentities(room.home).map(i => i.id)).not.toContain(ids[0]);
  expect((await api.call('page', 'DELETE', `/api/local/agents/${crypto.randomUUID()}`)).status).toBe(404);
}, 90_000);

test('one change at a time per agent: delete waits out a new session\'s start, refuses while a runner may still run, and unlists only once the folder is gone', async () => {
  const room = await admittedPerson(), api = await served(room, { approvals: true });
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  await admitAgents(room);
  const member = await rosterOf(room, id);
  // A new session that takes its time: nothing else changes this agent meanwhile, delete included.
  let finish!: (id: string) => void;
  api.deps.bootstrap = () => new Promise(done => { finish = done; });
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/bind`, { session: 'new' })).status).toBe(202);
  expect(await api.call('control', 'DELETE', `/api/local/agents/${id}`)).toMatchObject({ status: 409, body: { error: expect.stringContaining('being changed already') } });
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/unbind`)).status).toBe(409);
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id })).status).toBe(409);
  expect(existsSync(identityHome(room.home, id))).toBe(true);
  // If it is deleted from outside meanwhile, the session that then starts is bound to nothing.
  const kept = readFileSync(join(room.home, AGENTS_FILE), 'utf8');
  writeFileSync(join(room.home, AGENTS_FILE), JSON.stringify(JSON.parse(kept).filter((i: { id: string }) => i.id !== id)));
  finish('b6d1b2a4-1f8e-4c56-9d6f-0d0f7c1b2e3a');
  await Bun.sleep(300);
  expect(api.calls.bind).toEqual([]);
  expect(existsSync(join(identityHome(room.home, id), 'browser-agents', room.roomId, 'watch.json'))).toBe(false);
  writeFileSync(join(room.home, AGENTS_FILE), kept);
  // A runner that may still run (busy, unverified, not stopped): nothing is deleted, nothing unlisted.
  for (const reason of ['busy', 'unverified', 'not-stopped']) {
    api.deps.stopRoom = async () => ({ stopped: false, reason });
    expect(await api.call('control', 'DELETE', `/api/local/agents/${id}`)).toMatchObject({ status: 409, body: { error: expect.stringContaining('nothing was deleted') } });
    expect(existsSync(identityHome(room.home, id))).toBe(true);
    expect(readIdentities(room.home).map(i => i.id)).toContain(id);
    expect((await room.host.status(room.roomId)).members!.some(m => m.name === 'Wren')).toBe(true);
  }
  api.deps.stopRoom = async () => ({ stopped: true });
  expect(await api.call('control', 'DELETE', `/api/local/agents/${id}`)).toMatchObject({ status: 200, body: { deleted: true } });
  expect(existsSync(identityHome(room.home, id))).toBe(false);
  expect(readIdentities(room.home)).toEqual([]);
}, 60_000);

test('before unpair deletes the person folder, its agent identities leave their rooms, stop, and leave the registry', async () => {
  const room = await admittedPerson(), api = await served(room);
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  await admitAgents(room);
  await rosterOf(room, id);
  recordAgentHome(identityHome(room.home, id));
  expect(knownAgentHomes()).toContain(identityHome(room.home, id));
  expect((await room.host.status(room.roomId)).members!.some(m => m.name === 'Wren')).toBe(true);
  // A new session starting for it (in the daemon, as agents.json says): unpair waits.
  const raw = readFileSync(join(room.home, AGENTS_FILE), 'utf8');
  writeFileSync(join(room.home, AGENTS_FILE), JSON.stringify(JSON.parse(raw).map((i: object) => ({ ...i, bound: { [room.roomId]: { kind: 'new', state: 'starting', at: Date.now() } } }))));
  expect(await releaseIdentities(room.home)).toEqual([{ roomId: room.roomId, title: null }]);
  expect((await room.host.status(room.roomId)).members!.some(m => m.name === 'Wren')).toBe(true);
  writeFileSync(join(room.home, AGENTS_FILE), raw);
  expect(await releaseIdentities(room.home)).toEqual([]);
  // Gone from the room (by its own key: its operator is still there), stopped, and no longer the daemon's to run.
  expect((await room.host.status(room.roomId)).members!.some(m => m.name === 'Wren')).toBe(false);
  expect(existsSync(join(identityHome(room.home, id), 'browser-agents', room.roomId, 'stopped.json'))).toBe(true);
  expect(knownAgentHomes()).not.toContain(identityHome(room.home, id));
}, 60_000);

test('a new session starts as a wake runs, without its resume: Claude Code, Codex and Hermes', () => {
  const roomId = crypto.randomUUID(), base: WatchConfig = { roomId, harness: 'claude', cwd: '/r/wake', maxWakesPerHour: 1, maxAgentWakesPerHour: 1, runTimeoutMinutes: 1, allowTools: [],
    launcher: '/bin/meshrooms.js', agentHome: '/a', binDir: '/b', roomDir: '/r' };
  const find = (name: string) => ({ file: name, prefix: [] });
  const claude = harnessInvocation(base, 'p', '/r/prompt', find).args;
  expect(newSessionArgs('claude', claude, roomId)).toEqual(claude.filter(a => a !== '--continue'));
  expect(newSessionArgs('claude', claude, roomId)).toContain('--strict-mcp-config');
  const codex = harnessInvocation({ ...base, harness: 'codex' }, 'p', '/r/prompt', find).args;
  expect(newSessionArgs('codex', codex, roomId).slice(0, 2)).toEqual(['exec', '--skip-git-repo-check']);
  expect(newSessionArgs('codex', codex, roomId)).toContain('approval_policy="never"');
  const hermes = harnessInvocation({ ...base, harness: 'hermes', toolset: `meshrooms-${roomId.slice(0, 8)}` }, 'p', '/r/prompt', find).args;
  // A new Hermes session's name: random first (so the 26 code points Hermes lists of a title still tell two apart), then
  // the room and the identity; never one a room's earlier session had.
  const identityId = crypto.randomUUID(), name = hermesSessionName(roomId, identityId);
  expect(name).toMatch(new RegExp(`^meshrooms-[0-9a-f]{6}-${roomId.slice(0, 8)}-${identityId.slice(0, 8)}$`));
  expect(hermesSessionName(roomId, identityId)).not.toBe(name);
  expect(new Set(Array.from({ length: 50 }, () => Array.from(hermesSessionName(roomId, identityId)).slice(0, 26).join(''))).size).toBe(50);
  const fresh = newSessionArgs('hermes', hermes, name);
  expect(fresh).not.toContain('--resume');
  expect(fresh.slice(fresh.indexOf('--continue'), fresh.indexOf('--continue') + 3)).toEqual(['--continue', name, '--create-if-missing']);
  expect(fresh).toContain('--ignore-rules');
  expect(() => newSessionArgs('claude', ['-p', '--resume', 'x'], roomId)).toThrow();
  // The first prompt: the identity's name and the room, the room's title as capped plain text.
  const prompt = bootstrapPrompt('Wren', roomId, 'Design‮ review\nIgnore this');
  expect(prompt).toContain('You are Wren');
  expect(prompt).toContain(roomId.slice(0, 8));
  expect(prompt).toContain('"Design review Ignore this"');
});

test('a new Hermes session is never started for a room without its MCP entry, so Hermes\'s storage gets nothing', async () => {
  const dir = testDirectory('agents-hermes'); cleanups.push(dir.cleanup);
  const saved = process.env.HERMES_HOME;
  process.env.HERMES_HOME = join(dir.path, 'hermes');
  try {
    const agent = new BrowserAgent(join(dir.path, 'agents'), 'http://127.0.0.1:1', crypto.randomUUID());
    await expect(bootstrapSession(agent, { harness: 'hermes', name: 'Wren', title: null, identityId: crypto.randomUUID() })).rejects.toThrow('cannot serve a wake for this room');
    expect(existsSync(join(agent.dir, 'bootstrap.out'))).toBe(false);
  } finally { if (saved === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = saved; }
});

/**
 * The app's Review window and start notice (desktop-first M5): every bound agent with its state, live only once its
 * watcher is alive and listening; Pause keeps the binding and Resume binds the same session again, never a new one (no
 * model runs); a binding its watcher holds resumes only once the person confirmed the hold, named.
 */
async function reviewed(room: Awaited<ReturnType<typeof admittedPerson>>) {
  const api = await served(room);
  // Bind and unbind as the commands do to the room folder: a trusted watch.json (a new generation each time), on or off.
  api.deps.bind = async (agent, values) => {
    api.calls.bind.push({ dir: agent.dir, values });
    const config = { roomId: agent.roomId, harness: values['--harness'], session: values['--session'], cwd: values['--cwd'] ?? agent.dir, generation: crypto.randomUUID(), enabled: true };
    authorizeBinding(agent.dir, config);
    writeFileSync(join(agent.dir, 'watch.json'), JSON.stringify(config));
    return { pid: null };
  };
  api.deps.unbind = async agent => { api.calls.unbind.push(agent.dir); disableBinding(agent.dir); return { stopped: true, wakes: 'off' }; };
  const review = async () => (await api.call('control', 'GET', '/api/local/app/review')).body as { summary: Record<string, number>; agents: Record<string, any>[] };
  return { ...api, review };
}
/** The watcher's state file as a watcher writes it: `extra` over a fresh proof of life. */
const watchState = (roomDir: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(roomDir, 'watch-state.json'), JSON.stringify({ wakes: [], noProgress: 0, startedAt: Date.now(), aliveAt: Date.now(), ...extra }));
const generationOf = (roomDir: string) => JSON.parse(readFileSync(join(roomDir, 'watch.json'), 'utf8')).generation as string;

test('review: bound agents are live only once their watcher listens; pause keeps the binding, resume binds the same session again; the app\'s only', async () => {
  const room = await admittedPerson(), api = await reviewed(room), { review } = api;
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  await admitAgents(room);
  const member = await rosterOf(room, id), roomDir = join(identityHome(room.home, id), 'browser-agents', room.roomId);
  // In the room, never bound: not listed (nothing listens there, by the person's choice).
  expect(await review()).toEqual({ summary: { live: 0, rooms: 0, starting: 0, waiting: 0, paused: 0, failed: 0 }, agents: [] });
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/bind`, { session: 'new' })).status).toBe(202);
  await until(() => readIdentities(room.home)[0].bound?.[room.roomId]?.state === 'bound');
  const firstBind = api.calls.bind[0].values;
  writeFileSync(join(roomDir, 'runner-alive.json'), JSON.stringify({ at: Date.now() }));
  // Bound, its runner up, but no watcher has proved it is alive: starting, never live, and the page says so too.
  expect((await review()).agents).toEqual([{ identityId: id, name: 'Wren', harness: 'claude', roomId: room.roomId, memberId: member, title: 'Design review', state: 'starting',
    reason: 'Its watcher is starting.', canPause: true, canResume: false }]);
  new BrowserAgent(identityHome(room.home, id), room.origin, room.roomId).saveListenCursor({ boardAfter: 0, decisionsAfter: 0 });
  expect((await review()).agents[0]).toMatchObject({ state: 'starting', reason: 'Its watcher is starting.' });
  expect((await api.call('page', 'GET', '/api/local/agents')).body.agents[0].rooms[0].binding).toMatchObject({ wakes: 'on', watcher: 'down', listening: false });
  // A watcher alive, but without its listen cursor yet: still starting.
  rmSync(join(roomDir, 'live', 'listen-cursor.json'));
  watchState(roomDir);
  expect((await review()).agents[0]).toMatchObject({ state: 'starting', reason: 'It is getting the room\'s history before it listens.' });
  // Alive and listening: live.
  new BrowserAgent(identityHome(room.home, id), room.origin, room.roomId).saveListenCursor({ boardAfter: 0, decisionsAfter: 0 });
  expect(await review()).toMatchObject({ summary: { live: 1, rooms: 1, failed: 0 }, agents: [{ state: 'live', canPause: true, canResume: false }] });
  expect((await api.call('page', 'GET', '/api/local/agents')).body.agents[0].rooms[0].binding).toMatchObject({ wakes: 'on', watcher: 'alive', listening: true });
  // A watcher whose proof of life is two heartbeats old is gone: not listening; past the grace, failed.
  watchState(roomDir, { startedAt: Date.now() - 120_000, aliveAt: Date.now() - 2 * WATCH_TIMING.heartbeatMs - 1_000 });
  expect((await api.call('page', 'GET', '/api/local/agents')).body.agents[0].rooms[0].binding).toMatchObject({ watcher: 'down', listening: false });
  expect(agentReview(room.home, Date.now(), Date.now() - 5 * 60_000).agents).toMatchObject([{ state: 'starting', reason: 'Its watcher is starting.' }]);
  const early = JSON.parse(readFileSync(join(room.home, AGENTS_FILE), 'utf8'));
  early[0].bound[room.roomId].at = Date.now() - 5 * 60_000;
  writeFileSync(join(room.home, AGENTS_FILE), JSON.stringify(early));
  expect(agentReview(room.home, Date.now(), Date.now() - 5 * 60_000).agents).toMatchObject([{ state: 'failed', reason: 'Its watcher is not running.' }]);
  watchState(roomDir);

  // Never the page's: it can't read the review, pause or resume.
  expect((await api.call('page', 'GET', '/api/local/app/review')).status).toBe(403);
  expect((await api.call('page', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/pause`)).status).toBe(403);
  expect((await api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${crypto.randomUUID()}/pause`)).status).toBe(404);

  // Pause: wakes off, the binding kept.
  expect(await api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/pause`)).toMatchObject({ status: 200, body: { wakes: 'paused' } });
  expect(api.calls.unbind).toEqual([roomDir]);
  expect(readIdentities(room.home)[0].bound?.[room.roomId]).toMatchObject({ kind: 'new', state: 'bound', session: 'b6d1b2a4-1f8e-4c56-9d6f-0d0f7c1b2e3a', paused: expect.any(Number) });
  expect(await review()).toMatchObject({ summary: { live: 0, paused: 1 }, agents: [{ state: 'paused', reason: 'Paused from the app.', canPause: false, canResume: true }] });
  // Resume: the same session bound again in the same folder; no new session (no model run).
  expect(await api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/resume`)).toMatchObject({ status: 200, body: { wakes: 'on' } });
  expect(api.calls.bind).toHaveLength(2);
  expect(api.calls.bind[1].values).toEqual(firstBind);
  expect(api.calls.bootstrap).toHaveLength(1);
  expect(readIdentities(room.home)[0].bound?.[room.roomId]?.paused).toBeUndefined();
  expect(await review()).toMatchObject({ summary: { live: 1 }, agents: [{ state: 'live' }] });

  // Its runner down: starting while the daemon has only just started, failed after; never left out.
  writeFileSync(join(roomDir, 'runner-alive.json'), JSON.stringify({ at: Date.now() - 60_000 }));
  expect(agentReview(room.home, Date.now(), Date.now() - 5_000).agents).toMatchObject([{ state: 'starting', reason: 'Its runner is starting.' }]);
  expect(agentReview(room.home, Date.now() + 5 * 60_000, Date.now() - 5 * 60_000)).toMatchObject({ summary: { live: 0, failed: 1 }, agents: [{ state: 'failed', reason: 'Its runner is not running.' }] });
  // A new session that failed stays listed as failed, with its reason; nothing to resume.
  const identities = JSON.parse(readFileSync(join(room.home, AGENTS_FILE), 'utf8'));
  identities[0].bound[room.roomId] = { kind: 'new', state: 'failed', reason: 'bootstrap-failed', error: 'claude exited with 1', at: Date.now() };
  writeFileSync(join(room.home, AGENTS_FILE), JSON.stringify(identities));
  expect(agentReview(room.home).agents).toMatchObject([{ state: 'failed', reason: 'claude exited with 1', canPause: false, canResume: false }]);
  expect((await api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/resume`)).status).toBe(409);
}, 60_000);

test('review: a breach pause or a halt is never paused over, and resumes only once the person confirmed it, named; then it is cleared', async () => {
  const room = await admittedPerson(), api = await reviewed(room), { review } = api;
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  await admitAgents(room);
  const member = await rosterOf(room, id), roomDir = join(identityHome(room.home, id), 'browser-agents', room.roomId);
  expect((await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/bind`, { session: 'new' })).status).toBe(202);
  await until(() => readIdentities(room.home)[0].bound?.[room.roomId]?.state === 'bound');
  writeFileSync(join(roomDir, 'runner-alive.json'), JSON.stringify({ at: Date.now() }));
  new BrowserAgent(identityHome(room.home, id), room.origin, room.roomId).saveListenCursor({ boardAfter: 0, decisionsAfter: 0 });
  const resume = (confirmHold?: number) => api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/resume`, confirmHold === undefined ? undefined : { confirmHold });
  const pause = () => api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/pause`);

  for (const [label, held] of [
    ['a hard pause', { paused: { reason: 'the wake reached outside the room', at: 1_700_000_000_001, hard: true } }],
    ['a halt on a run from before a restart', { halted: { reason: 'a run from before the restart (pid 4242) may still be going and can\'t be identified, so no wake is started beside it; check it, then bind again', at: 1_700_000_000_002, pid: 4242 } }],
  ] as const) {
    const at = (Object.values(held)[0] as { at: number }).at;
    // The watcher's state as it writes it: for the binding that runs now (its generation).
    const generation = generationOf(roomDir);
    watchState(roomDir, Object.fromEntries(Object.entries(held).map(([k, v]) => [k, { ...v, generation }])));
    const row = (await review()).agents[0];
    expect(row.hold).toMatchObject({ kind: 'paused' in held ? 'hard-pause' : 'halted', at });
    expect(row).toMatchObject({ canPause: false, canResume: true });
    if ('halted' in held) expect(row).toMatchObject({ state: 'failed', hold: { pid: 4242 }, reason: expect.stringContaining('It is checking process 4242.') });
    else expect(row).toMatchObject({ state: 'paused', reason: 'the wake reached outside the room' });
    // Pause would put "paused" over the reason: refused, and the hold kept in the record.
    expect(await pause()).toMatchObject({ status: 409, body: { code: 'hold' } });
    expect(readIdentities(room.home)[0].bound?.[room.roomId]?.held).toMatchObject({ at });
    // Resume without confirming, or confirming another hold: refused, naming the reason; nothing bound.
    const binds = api.calls.bind.length;
    expect(await resume()).toMatchObject({ status: 409, body: { code: 'hold', error: expect.stringMatching(/^Waking stopped because .+\. Resume anyway\?$/) } });
    expect(await resume(at - 1)).toMatchObject({ status: 409, body: { code: 'hold' } });
    expect(api.calls.bind).toHaveLength(binds);
    // Confirmed: bound again (a new generation), the hold cleared from the record and from the review.
    expect(await resume(at)).toMatchObject({ status: 200, body: { wakes: 'on' } });
    expect(api.calls.bind).toHaveLength(binds + 1);
    expect(generationOf(roomDir)).not.toBe(generation);
    expect(readIdentities(room.home)[0].bound?.[room.roomId]?.held).toBeUndefined();
    expect((await review()).agents[0]).toMatchObject({ state: 'live', canPause: true });
    expect((await review()).agents[0].hold).toBeUndefined();
    expect(label).toBeTruthy();
  }
}, 60_000);

test('review: resuming an approved existing session binds the folder that was approved, and refuses one its transcript moved', async () => {
  const room = await admittedPerson(), api = await reviewed(room);
  const id = (await api.call('page', 'POST', '/api/local/agents', { name: 'Wren', harness: 'claude' })).body.agent.id as string;
  await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents`, { identity: id });
  await admitAgents(room);
  const member = await rosterOf(room, id);
  // Approved as the app approves an existing session: the folder it shows goes into the record.
  const asked = await api.call('page', 'POST', `/api/local/rooms/${room.roomId}/agents/${member}/bind`, { session: existingClaude });
  const { decideApproval, approvalsView } = await import('./agents');
  const shown = approvalsView(room.home).find(a => a.id === asked.body.approvalId)!;
  await decideApproval(shown.id, true, api.deps, room.home, shown.digest);
  const approved = join(sandbox!.dir.path, 'project');
  expect(readIdentities(room.home)[0].bound?.[room.roomId]).toMatchObject({ kind: 'existing', session: existingClaude, cwd: approved });
  expect(api.calls.bind.at(-1)!.values).toMatchObject({ '--session': existingClaude, '--cwd': approved });
  expect((await api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/pause`)).status).toBe(200);
  expect((await api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/resume`)).status).toBe(200);
  expect(api.calls.bind.at(-1)!.values).toEqual({ '--harness': 'claude', '--session': existingClaude, '--cwd': approved });
  // The transcript now says another folder: not bound again there.
  expect((await api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/pause`)).status).toBe(200);
  const binds = api.calls.bind.length;
  api.deps.sessionFolder = () => join(sandbox!.dir.path, 'elsewhere');
  expect(await api.call('control', 'POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/resume`)).toMatchObject({ status: 409, body: { error: expect.stringContaining('folder changed') } });
  expect(api.calls.bind).toHaveLength(binds);
}, 60_000);

/**
 * The whole path, for real: the daemon (a real `daemon run`) serves the page, which puts an identity into the room
 * (its runner started by the daemon), binds it to a new exec session, and a mention wakes it once.
 */
test('the real daemon: an identity put into a room, its runner started, bound to a new exec session, woken once by a mention', async () => {
  const room = await admittedPerson(), registry = join(room.dir, 'agent-homes.json'), counter = join(room.dir, 'woke.txt'), fake = join(room.dir, 'fake-harness.js');
  await Bun.write(registry, '[]');
  const cli = join(import.meta.dir, 'agent-cli.ts');
  // A harness that does what a wake prompt asks: listen, reply to what addressed it, and count its runs.
  writeFileSync(fake, `const { appendFileSync } = require('node:fs'); const { execFileSync } = require('node:child_process');
appendFileSync(${JSON.stringify(counter)}, 'woke\\n');
const room = process.env.MESHROOMS_WAKE_ROOM, cli = ${JSON.stringify(cli)};
const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: process.env }));
const heard = run(['listen', '--room', room, '--wait-seconds', '2']);
for (const id of heard.addressed || []) run(['send', '--room', room, '--request-id', crypto.randomUUID(), '--reply-to', id, '--text', 'On it.']);
`);

  const env: Record<string, string | undefined> = { ...process.env, MESHROOMS_AGENT_REGISTRY: registry, MESHROOMS_AGENT_HOME: join(room.dir, 'agents'), MESHROOMS_LOCAL_PORT: '0' };
  for (const key of ['MESHROOMS_DAEMON_DIR', 'MESHROOMS_PERSON_HOME']) delete env[key];
  const daemon = spawn(process.execPath, [cli, 'daemon', 'run', '--approvals'], { env, stdio: 'ignore', detached: true, windowsHide: true });
  daemon.unref();
  let wren = { id: '' }, roomDir = '';
  const pidIn = (file: string) => { try { return Number(readFileSync(file, 'utf8')) || undefined; } catch { return undefined; } };
  cleanups.push(() => {
    try { process.kill(daemon.pid!, 'SIGKILL'); } catch { /* Gone. */ }
    for (const file of [join(room.person.dir, 'runner.pid'), join(roomDir, 'runner.pid'), join(roomDir, 'watch.pid')]) { const pid = pidIn(file); if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* Gone. */ } }
  });
  await until(() => runningDaemon(processRuns, room.daemon)?.pid === daemon.pid, 30_000);
  await until(() => roomState(room.person).state === 'joined', 60_000);
  const api = await until(() => readLocalApi(room.daemon), 30_000), base = `http://127.0.0.1:${api.port}`, control = { Authorization: `Bearer ${localControlToken(api.secret)}` };
  const { ticket } = await (await fetch(`${base}/api/local/ticket`, { method: 'POST', headers: control })).json() as { ticket: string };
  const { token } = await (await fetch(`${base}/api/local/session`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) })).json() as { token: string };
  const page = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };

  expect((await page('GET', '/api/local/harnesses')).body.harnesses).toContainEqual(expect.objectContaining({ harness: 'exec', detected: true }));
  // The person makes the custom-command agent in the app: the page can't, the app's credential can.
  const make = { name: 'Wren', harness: 'exec', command: `"${process.execPath}" "${fake}" {prompt_file}` };
  expect((await page('POST', '/api/local/app/agents', make)).status).toBe(403);
  const made = await (await fetch(`${base}/api/local/app/agents`, { method: 'POST', headers: { ...control, 'Content-Type': 'application/json' }, body: JSON.stringify(make) })).json() as { agent: { id: string } };
  wren = { id: made.agent.id };
  roomDir = join(identityHome(room.home, wren.id), 'browser-agents', room.roomId);
  expect(await page('POST', `/api/local/rooms/${room.roomId}/agents`, { identity: wren.id })).toMatchObject({ status: 201, body: { state: 'waiting', runner: 'daemon' } });
  await admitAgents(room);
  expect((await room.host.status(room.roomId)).members!.find(m => m.name === 'Wren')).toMatchObject({ role: 'agent', operatorId: room.personMember });
  // The daemon starts its runner, and supervises it.
  await until(() => { const pid = pidIn(join(roomDir, 'runner.pid')); return pid && processRuns(pid); }, 60_000);
  await until(() => runningDaemon(processRuns, room.daemon)?.rooms.find(r => r.roomId === room.roomId && r.home === identityHome(room.home, wren.id))?.runner.pid, 60_000);
  expect(JSON.parse(readFileSync(registry, 'utf8'))).toContain(identityHome(room.home, wren.id));
  const member = await until(async () => (await page('GET', '/api/local/agents')).body.agents[0].rooms[0]?.memberId as string | undefined, 30_000);

  // A new exec session: bound at once, the watcher started by the daemon.
  // Until the person device's roster lists the agent, a bind is answered 409 (try again), never 403.
  const bound = await until(async () => { const r = await page('POST', `/api/local/rooms/${room.roomId}/agents/${member}/bind`, { session: 'new' }); expect([200, 409]).toContain(r.status); return r.status === 200 && r; }, 30_000);
  expect(bound).toMatchObject({ status: 200, body: { kind: 'new', state: 'bound' } });
  expect(readBinding(roomDir, room.daemon)).toMatchObject({ enabled: true, harness: 'exec' });
  await until(() => { const pid = pidIn(join(roomDir, 'watch.pid')); return pid && processRuns(pid); }, 60_000);
  // The watcher starts from now once the agent is synced: its listen cursor says so.
  await until(() => existsSync(join(roomDir, 'live', 'listen-cursor.json')), 90_000);

  // The person mentions the agent: one wake, which reads and replies.
  const sent = await queueMessage(room.person, { text: '@Wren can you take a look?' });
  await until(() => existsSync(counter), 90_000);
  const reply = await until(() => new BrowserAgent(identityHome(room.home, wren.id), room.origin, room.roomId, { mkdir: false }).messages()
    .find(m => m.packet.body.replyTo === sent.messageId), 60_000);
  expect(reply.packet.body.text).toBe('On it.');
  await Bun.sleep(8_000);
  expect(readFileSync(counter, 'utf8')).toBe('woke\n');
  const listed = (await page('GET', '/api/local/agents')).body.agents[0].rooms[0];
  expect(listed).toMatchObject({ state: 'connected', runner: 'alive', binding: { wakes: 'on', kind: 'new', state: 'bound', listening: true } });

  // The app's start notice and Review (desktop-first M5): the fake exec agent is live, in one room.
  const app = async (method: string, path: string) => { const r = await fetch(`${base}${path}`, { method, headers: control }); return { status: r.status, body: await r.json() as any }; };
  expect((await app('GET', '/api/local/app/review')).body).toMatchObject({ summary: { live: 1, rooms: 1, failed: 0 }, agents: [{ name: 'Wren', state: 'live', memberId: member }] });
  // The agent's reply to the person's message reached the person device: one notification in the app's feed.
  const feed = await until(async () => { const r = await app('GET', '/api/local/notifications?after=' + encodeURIComponent(`${(await app('GET', '/api/local/notifications')).body.cursor.split('.')[0]}.0`));
    return r.body.notifications?.length ? r.body : undefined; }, 30_000);
  expect(feed.notifications).toEqual([expect.objectContaining({ title: 'Design review', body: 'Wren replied: On it.', target: { kind: 'room', roomId: room.roomId } })]);
  // Pause and Resume, for real: wakes off then on again with the same exec command, and no extra wake.
  expect(await app('POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/pause`)).toMatchObject({ status: 200, body: { wakes: 'paused' } });
  expect(readBinding(roomDir, room.daemon)).toMatchObject({ enabled: false });
  expect((await app('GET', '/api/local/app/review')).body).toMatchObject({ summary: { live: 0, paused: 1 }, agents: [{ state: 'paused', canResume: true }] });
  expect(await app('POST', `/api/local/app/rooms/${room.roomId}/agents/${member}/resume`)).toMatchObject({ status: 200, body: { wakes: 'on' } });
  expect(readBinding(roomDir, room.daemon)).toMatchObject({ enabled: true, harness: 'exec' });
  await until(async () => (await app('GET', '/api/local/app/review')).body.summary.live === 1, 60_000);
  expect(readFileSync(counter, 'utf8')).toBe('woke\n');

  // Unbind: wakes off, the agent stays in the room.
  expect(await page('POST', `/api/local/rooms/${room.roomId}/agents/${member}/unbind`)).toMatchObject({ status: 200, body: { wakes: 'off' } });
  expect((await page('GET', '/api/local/agents')).body.agents[0].rooms[0]).toMatchObject({ state: 'connected', binding: { wakes: 'off' } });
  // Approvals are on in this daemon, and still never the page's.
  expect((await page('GET', '/api/local/approvals')).status).toBe(403);
  expect((await fetch(`${base}/api/local/approvals`, { headers: control })).status).toBe(200);
}, 400_000);

test('approval answers for the app: a refusal by the daemon is a result the window can tell apart, anything else a failure', async () => {
  expect(await answered(Promise.resolve({ approved: true, identityId: 'x' }))).toEqual({ ok: true, approved: true, identityId: 'x' });
  const refusal = Object.assign(new Error('This request changed since it was shown, or the approval named no digest. Look at it again before approving.'), { status: 409 });
  expect(await answered(Promise.reject(refusal))).toEqual({ ok: false, status: 409, error: refusal.message });
  expect(await answered(Promise.reject(Object.assign(new Error('That approval is not waiting any more.'), { status: 404 })))).toMatchObject({ ok: false, status: 404 });
  // The daemon not reached at all is no answer: it fails as before.
  await expect(answered(Promise.reject(new Error('The Meshrooms daemon is not running.')))).rejects.toThrow('not running');
});

test('a custom command is shown before it is made as it will run: the command exactly, its program and each argument', () => {
  expect(customPreview({ name: ' Oak ', command: '"C:/Program Files/agent/run.exe" --prompt-file {prompt_file} --room {room}', model: 'sonnet' })).toEqual({
    name: 'Oak', command: '"C:/Program Files/agent/run.exe" --prompt-file {prompt_file} --room {room}', program: 'C:/Program Files/agent/run.exe',
    args: ['--prompt-file', '{prompt_file}', '--room', '{room}'], model: 'sonnet' });
  expect(customPreview({ name: 'Oak', command: "my-agent 'two words' {prompt_file}" })).toMatchObject({ program: 'my-agent', args: ['two words', '{prompt_file}'], model: null });
  for (const bad of [{ name: '', command: 'x {prompt_file}' }, { name: 'Oak', command: 'x' }, { name: 'Oak', command: '"unclosed {prompt_file}' }, { name: 'Oak', command: 'x {prompt_file}', model: '-x' }])
    expect(() => customPreview(bad)).toThrow();
});

test('names and working folders that hold a character rendering as nothing are refused, whatever its class', async () => {
  const { nameProblem } = await import('./agents');
  const blanks = ['͏', 'ᅟ', 'ᅠ', 'ㅤ', 'ﾠ', '឴', '឵', '⠀', '­', '​', '‮', '⁥', '️', '￰', '\u{1BCA0}', '\u{1D173}', '\u{E0080}'];
  const code = (blank: string) => `U+${blank.codePointAt(0)!.toString(16)}`;
  for (const blank of blanks) expect(nameProblem(`El${blank}m`), code(blank)).toBeDefined();
  expect(nameProblem('Elm')).toBeUndefined();
  expect(nameProblem('Élodie Жук')).toBeUndefined();
  // A bind request whose working folder holds one is no request at all.
  const dir = testDirectory('agents-blank-cwd'), now = Date.now();
  try {
    const entry = (cwd: string) => ({ id: 'c0ffee00-1111-4222-8333-444455556666', kind: 'bind-existing', identityId: 'c0ffee00-1111-4222-8333-444455556667',
      roomId: 'c0ffee00-1111-4222-8333-444455556668', harness: 'claude', session: 'c0ffee00-1111-4222-8333-444455556669', title: 'Review', folder: 'project', cwd,
      requestedAt: now, expiresAt: now + 60_000 });
    writeFileSync(join(dir.path, APPROVALS_FILE), JSON.stringify([entry('/srv/work/project')]));
    expect(readApprovals(dir.path)).toHaveLength(1);
    for (const blank of blanks) {
      writeFileSync(join(dir.path, APPROVALS_FILE), JSON.stringify([entry(`/srv/work/proj${blank}ect`)]));
      expect(readApprovals(dir.path), code(blank)).toHaveLength(0);
    }
  } finally { dir.cleanup(); }
});

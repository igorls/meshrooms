import { describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { LocalNode } from './node';
import { createHandler } from './http';
import { NodeAccess } from './access';
import { testStartupManager } from './startup';
import { tokenHash } from './model';
import { AGENT_CHAIN_LIMIT, AGENT_ROOM_LIMIT, CLAIM_TTL_MS, assignmentWakes, authorWakes, chainRoot, claimHolder, claimRefusal, evaluateWake, groupTasks, loopGuard, matchesTaskFilter, mayAgentSpeak, mentionSegments, mentionedIds, needsClaim, proseText, speakRefusal, wakes, type Claim, type Task } from '../src/collab';
import type { Message } from '../src/room';

const people = [
  { id: 'igor', name: 'Igor', role: 'human' as const },
  { id: 'codex', name: 'Codex', role: 'agent' as const },
  { id: 'codex-cli', name: 'Codex CLI', role: 'agent' as const },
  { id: 'grok', name: 'Grok', role: 'agent' as const },
];

test('mentions match roster names at word boundaries, prefer longer names, and expand @agents', () => {
  expect(mentionedIds('@codex can you check?', people)).toEqual(['codex']);
  expect(mentionedIds('Ask @Codex CLI, not the other one', people)).toEqual(['codex-cli']);
  expect(mentionedIds('@Codex and @Codex CLI', people)).toEqual(['codex', 'codex-cli']);
  expect(mentionedIds('mail igor@codex.dev or @Codexes', people)).toEqual([]);
  expect(mentionedIds('(@Grok) thoughts?', people)).toEqual(['grok']);
  expect(mentionedIds('@agents please review', people)).toEqual(['codex', 'codex-cli', 'grok']);
  // A participant named "agents" cannot capture @agents from every other agent.
  expect(mentionedIds('@agents please review', [...people, { id: 'imposter', name: 'Agents', role: 'human' as const }])).toEqual(['codex', 'codex-cli', 'grok']);
  expect(mentionSegments('Hi @Grok!', people)).toEqual([{ text: 'Hi ' }, { text: '@Grok', mention: true }, { text: '!' }]);
});

function message(id: string, authorId: string, text: string, extra: Partial<Message> = {}): Message {
  const author = people.find(p => p.id === authorId)!;
  return { id, authorId, author: author.name, role: author.role, text, time: new Date().toISOString(), mentions: mentionedIds(text, people), ...extra };
}

test('humans-first wakes an agent only when a person addresses it, and keeps observed messages as context', () => {
  const messages = [message('m1', 'igor', 'Morning, just people for now')];
  const room = { floor: 'humans-first' as const, participants: people, messages, tasks: [], boardRevision: 0 };
  expect(evaluateWake(room, 'codex', undefined, 0)).toMatchObject({ state: 'history', cursor: 'm1', addressed: [] });
  messages.push(message('m2', 'igor', 'Still chatting'), message('m3', 'grok', '@Codex I disagree'), message('m4', 'codex', 'My own note'));
  expect(evaluateWake(room, 'codex', 'm1', 0)).toMatchObject({ state: 'waiting', cursor: 'm1', addressed: [] });
  messages.push(message('m5', 'igor', '@Codex what do you think?'));
  const woken = evaluateWake(room, 'codex', 'm1', 0);
  expect(woken).toMatchObject({ state: 'addressed', cursor: 'm5', addressed: ['m5'] });
  expect(woken.messages.map(m => m.id)).toEqual(['m2', 'm3', 'm4', 'm5']);
  // Replying to an agent's message addresses it; @agents addresses every agent.
  messages.push(message('m6', 'igor', 'Good point', { replyTo: 'm4' }), message('m7', 'igor', '@agents stand by'));
  expect(evaluateWake(room, 'codex', 'm5', 0).addressed).toEqual(['m6', 'm7']);
  expect(evaluateWake(room, 'grok', 'm5', 0).addressed).toEqual(['m7']);
  expect(() => evaluateWake(room, 'codex', 'missing', 0)).toThrow('cursor');
});

test('open floor wakes on every human message but agents only on explicit address; assignments wake once', () => {
  const messages = [message('m1', 'igor', 'Hello'), message('m2', 'grok', 'Hi all'), message('m3', 'grok', '@Codex over to you')];
  const task = { id: randomUUID(), title: 'Review', notes: '', status: 'todo' as const, assigneeId: 'codex', assignedBy: 'igor', assignedRevision: 3,
    createdBy: 'igor', updatedBy: 'igor', updatedAt: new Date().toISOString(), revision: 1 };
  const open = { floor: 'open' as const, participants: people, messages, tasks: [task], boardRevision: 3 };
  expect(evaluateWake(open, 'codex', 'm1', 3).addressed).toEqual(['m3']);
  expect(evaluateWake({ ...open, floor: 'humans-first' }, 'codex', 'm1', 3).state).toBe('waiting');
  expect(evaluateWake({ ...open, messages: messages.slice(0, 1) }, 'codex', undefined, 3).addressed).toEqual(['m1']);
  const assigned = evaluateWake({ ...open, floor: 'humans-first' }, 'codex', 'm3', 2);
  expect(assigned).toMatchObject({ state: 'addressed', cursor: 'm3', boardCursor: 3 }); expect(assigned.tasks.map(t => t.id)).toEqual([task.id]);
  expect(evaluateWake({ ...open, floor: 'humans-first', tasks: [{ ...task, assignedBy: 'grok' }] }, 'codex', 'm3', 2).state).toBe('waiting');
  expect(evaluateWake({ ...open, tasks: [{ ...task, status: 'done' }] }, 'codex', 'm3', 2).state).toBe('waiting');
});

test('a mention wakes only the agents it names, on either floor; an open floor wakes every agent only for unaddressed messages', () => {
  const task = { id: randomUUID(), title: 'Review', notes: '', status: 'todo' as const, assigneeId: 'codex', assignedBy: 'igor', assignedRevision: 1,
    createdBy: 'igor', updatedBy: 'igor', updatedAt: new Date().toISOString(), revision: 1 };
  const messages = [
    message('m0', 'codex', 'Codex here'),
    message('other', 'igor', '@Grok did you get the report?'),
    message('me', 'igor', '@Codex all good on your side?'),
    message('all', 'igor', '@agents stand by'),
    message('none', 'igor', 'Lunch in five'),
    message('reply', 'igor', 'Thanks, and @Grok too', { replyTo: 'm0' }),
    message('human', 'igor', '@Igor note to self'),
  ];
  const woken = (floor: 'open' | 'humans-first', agent: string) => evaluateWake({ floor, participants: [...people], messages, tasks: [task], boardRevision: 1 }, agent, 'm0', 0);
  // Open floor: a mention of another agent (or only of a person) no longer wakes everyone; nothing named still does.
  expect(woken('open', 'codex').addressed).toEqual(['me', 'all', 'none', 'reply']);
  expect(woken('open', 'grok').addressed).toEqual(['other', 'all', 'none', 'reply']);
  expect(woken('open', 'codex-cli').addressed).toEqual(['all', 'none']);
  // Humans-first: only what addresses the agent, as before.
  expect(woken('humans-first', 'codex').addressed).toEqual(['me', 'all', 'reply']);
  expect(woken('humans-first', 'grok').addressed).toEqual(['other', 'all', 'reply']);
  expect(woken('humans-first', 'codex-cli').addressed).toEqual(['all']);
  // Assigned tasks still wake on both floors.
  for (const floor of ['open', 'humans-first'] as const) expect(woken(floor, 'codex').tasks.map(t => t.id)).toEqual([task.id]);
  // Speaking is unchanged: open floors let agents speak freely; humans-first only in reply to what woke them.
  const room = { floor: 'humans-first' as const, participants: people, messages, tasks: [] };
  expect(mayAgentSpeak(room, 'codex', 'other')).toBe(false);
  expect(mayAgentSpeak(room, 'codex', 'me')).toBe(true);
  expect(mayAgentSpeak({ ...room, floor: 'open' }, 'codex', 'other')).toBe(true);
});

test('a reply addresses the author of the message it replies to, and only a message with no mention and no reply wakes every agent', () => {
  // Two people and two agents; `me` is the agent listening.
  const roster = [
    { id: 'alex', name: 'Alex', role: 'human' as const }, { id: 'sam', name: 'Sam', role: 'human' as const },
    { id: 'me', name: 'Wren', role: 'agent' as const }, { id: 'other', name: 'Echo', role: 'agent' as const },
  ];
  const say = (id: string, authorId: string, text: string, replyTo?: string): Message => {
    const author = roster.find(p => p.id === authorId)!;
    return { id, authorId, author: author.name, role: author.role, text, time: new Date().toISOString(), mentions: mentionedIds(text, roster), ...(replyTo ? { replyTo } : {}) };
  };
  const messages = [
    say('from-other', 'other', 'Echo here, the build is green'), say('from-me', 'me', 'Wren here, reviewing now'), say('from-sam', 'sam', 'I will take the docs'),
    say('reply-other', 'alex', 'Thanks, ship it', 'from-other'),
    say('reply-me', 'alex', 'Good, go ahead', 'from-me'),
    say('reply-human', 'alex', 'Sounds good', 'from-sam'),
    say('reply-mention', 'alex', 'Thanks, and @Wren please double-check', 'from-other'),
    say('reply-gone', 'alex', 'Still true?', randomUUID()),
    say('mention-other', 'alex', '@Echo can you look?'),
    say('all', 'alex', '@agents stand by'),
    say('nobody', 'alex', 'Lunch in five'),
  ];
  const addressed = (floor: 'open' | 'humans-first', agent = 'me') =>
    evaluateWake({ floor, participants: roster, messages, tasks: [], boardRevision: 0 }, agent, 'from-sam', 0).addressed;
  // Open floor: a reply to another agent, to a person, or to a message no longer held is not a broadcast.
  expect(addressed('open')).toEqual(['reply-me', 'reply-mention', 'all', 'nobody']);
  expect(addressed('open', 'other')).toEqual(['reply-other', 'reply-mention', 'mention-other', 'all', 'nobody']);
  // Humans-first is unchanged: only what addresses the agent; a message naming nobody wakes nobody.
  expect(addressed('humans-first')).toEqual(['reply-me', 'reply-mention', 'all']);
  expect(addressed('humans-first', 'other')).toEqual(['reply-other', 'reply-mention', 'mention-other', 'all']);
  // An agent's reply or @mention wakes another agent on an open floor only: the humans-first guard comes before the
  // mention and reply checks, so two agents can't keep each other talking there.
  const agents = [...messages, say('agent-reply', 'other', 'Over to you', 'from-me'), say('agent-mention', 'other', '@Wren your turn'),
    say('agent-all', 'other', '@agents stand by')];
  const agentWake = (floor: 'open' | 'humans-first') => evaluateWake({ floor, participants: roster, messages: agents, tasks: [], boardRevision: 0 }, 'me', 'nobody', 0).addressed;
  expect(agentWake('open')).toEqual(['agent-reply', 'agent-mention', 'agent-all']);
  expect(agentWake('humans-first')).toEqual([]);
  // A third agent is never woken by a reply between two others.
  expect(evaluateWake({ floor: 'open', participants: [...roster, { id: 'third', name: 'Kite', role: 'agent' as const }], messages: agents, tasks: [], boardRevision: 0 }, 'third', 'nobody', 0).addressed)
    .not.toContain('agent-reply');
});

function memoryNode(records = new Map<string, string>()) {
  return { records, node: new LocalNode({ read: key => records.get(key) ?? null, write: (key, value) => { records.set(key, value); }, close() {} }) };
}
function agentRoom(node: LocalNode, agentName = 'Codex') {
  const secret = randomBytes(32).toString('base64url'), roomId = randomUUID();
  node.prepareRoom({ requestId: roomId, title: 'Floor', agentName, credentialHash: tokenHash(secret) });
  node.completeSetup({ requestId: randomUUID(), humanName: 'Igor', machineName: 'Test', startAtLogin: false, intentId: roomId });
  return { roomId, agent: node.authenticateAgent(secret)! };
}

test('the node enforces humans-first sends and lets the owner open the floor', () => {
  const { node } = memoryNode(); const { roomId, agent } = agentRoom(node);
  try {
    const send = (text: string, replyTo?: string, principal = agent) => node.send({ roomId, requestId: randomUUID(), text, replyTo }, principal);
    expect(node.snapshot().rooms[0].floor).toBe('humans-first');
    expect(() => send('Jumping in')).toThrow('humans-first');
    const chat = send('Just talking', undefined, node.owner);
    expect(() => send('Replying anyway', chat.messageId)).toThrow('humans-first');
    const ask = send('@Codex what do you think?', undefined, node.owner);
    expect(node.snapshot().rooms[0].messages.at(-1)?.mentions).toEqual([agent.participantId]);
    const answer = send('Here is my view', ask.messageId);
    send('And one more detail', ask.messageId);
    const followUp = send('Thanks, why?', answer.messageId, node.owner);
    send('Because…', followUp.messageId);
    expect(() => node.setFloor({ roomId, requestId: randomUUID(), floor: 'open' }, agent)).toThrow('human session');
    expect(() => node.setFloor({ roomId, requestId: randomUUID(), floor: 'loud' })).toThrow('humans-first or open');
    // The local node's interface can't show people-and-agents, so it doesn't take it.
    expect(() => node.setFloor({ roomId, requestId: randomUUID(), floor: 'people-and-agents' })).toThrow('humans-first or open');
    node.setFloor({ roomId, requestId: randomUUID(), floor: 'open' });
    expect(node.snapshot(agent).rooms[0].floor).toBe('open');
    send('Unprompted update');
  } finally { node.close(); }
});

test('task board commands are shared, idempotent, revision-checked, persisted, and let assigned agents speak', () => {
  const { node, records } = memoryNode(); const { roomId, agent } = agentRoom(node);
  const create = { roomId, requestId: randomUUID(), title: 'Write the release notes', assigneeId: agent.participantId };
  const created = node.createTask(create);
  expect(node.createTask(create)).toEqual(created);
  expect(() => node.createTask({ ...create, title: 'Different' })).toThrow('different content');
  expect(() => node.createTask({ roomId, requestId: randomUUID(), title: 'Nobody', assigneeId: randomUUID() })).toThrow('participant on this machine');
  const board = node.snapshot(agent).rooms[0];
  expect(board.boardRevision).toBe(1);
  expect(board.tasks).toMatchObject([{ id: created.taskId, status: 'todo', assigneeId: agent.participantId, assignedBy: node.owner.participantId, assignedRevision: 1 }]);
  // A person's assignment grants the agent the floor for progress reports.
  node.send({ roomId, requestId: randomUUID(), text: 'Starting on the notes' }, agent);
  const update = { roomId, requestId: randomUUID(), taskId: created.taskId, revision: 1, status: 'doing' };
  const moved = node.updateTask(update, agent); expect(moved).toEqual({ taskId: created.taskId, revision: 2 });
  expect(node.updateTask(update, agent)).toEqual(moved);
  expect(() => node.updateTask({ ...update, requestId: randomUUID() }, agent)).toThrow('changed since');
  expect(() => node.updateTask({ roomId, requestId: randomUUID(), taskId: created.taskId, revision: 2, status: 'blocked' })).toThrow('todo, doing, or done');
  node.updateTask({ roomId, requestId: randomUUID(), taskId: created.taskId, revision: 2, status: 'done', notes: 'Merged in #12' }, agent);
  expect(() => node.send({ roomId, requestId: randomUUID(), text: 'Anything else?' }, agent)).toThrow('humans-first');
  const second = node.createTask({ roomId, requestId: randomUUID(), title: 'Temporary' }, agent);
  node.removeTask({ roomId, requestId: randomUUID(), taskId: second.taskId, revision: 1 });
  node.close();
  const restored = memoryNode(records).node;
  try {
    const room = restored.snapshot().rooms[0];
    expect(room.boardRevision).toBe(5);
    expect(room.tasks).toMatchObject([{ id: created.taskId, status: 'done', notes: 'Merged in #12', revision: 3, updatedBy: agent.participantId }]);
  } finally { restored.close(); }
});

test('HTTP exposes floor and task commands for the owner session', async () => {
  const { node } = memoryNode(); const { roomId } = agentRoom(node);
  const token = 'test-control-token-32-bytes-minimum-length';
  const handle = createHandler({ node, origins: ['http://127.0.0.1:4318'], distDir: 'dist', dataDir: 'test-store', access: new NodeAccess(token, node),
    startup: testStartupManager(), runtime: { apiVersion: 2, instanceId: 'test-instance', pid: process.pid }, proof: () => 'test-proof' });
  const post = (path: string, body: unknown) => handle(new Request(`http://127.0.0.1:4318/api/node/${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  try {
    expect((await post('rooms/floor', { roomId, requestId: randomUUID(), floor: 'open' })).status).toBe(200);
    const created = await post('tasks', { roomId, requestId: randomUUID(), title: 'Board over HTTP' });
    expect(created.status).toBe(201); const { taskId, revision } = await created.json();
    expect((await post('tasks/update', { roomId, requestId: randomUUID(), taskId, revision, status: 'doing' })).status).toBe(200);
    expect((await post('tasks/remove', { roomId, requestId: randomUUID(), taskId, revision })).status).toBe(409);
    expect((await post('tasks/remove', { roomId, requestId: randomUUID(), taskId, revision: 2 })).status).toBe(200);
    expect(node.snapshot().rooms[0]).toMatchObject({ floor: 'open', tasks: [], boardRevision: 3 });
  } finally { node.close(); }
});

test('an operator-only agent wakes and may speak only for its operator', () => {
  const roster = [
    { id: 'igor', name: 'Igor', role: 'human' as const },
    { id: 'ana', name: 'Ana', role: 'human' as const },
    { id: 'codex', name: 'Codex', role: 'agent' as const, operatorId: 'igor', wake: 'operator' as const },
  ];
  const msg = (id: string, authorId: string, text: string): Message => {
    const author = roster.find(p => p.id === authorId)!;
    return { id, authorId, author: author.name, role: author.role, text, time: new Date().toISOString(), mentions: mentionedIds(text, roster) };
  };
  const messages = [msg('m1', 'ana', '@Codex please look'), msg('m2', 'igor', 'context only')];
  const task = { id: randomUUID(), title: 'Review', notes: '', status: 'todo' as const, assigneeId: 'codex', assignedBy: 'ana', assignedRevision: 1,
    createdBy: 'ana', updatedBy: 'ana', updatedAt: new Date().toISOString(), revision: 1 };
  const room = { floor: 'humans-first' as const, participants: roster, messages, tasks: [task], boardRevision: 1 };
  expect(evaluateWake(room, 'codex', 'm1', 0)).toMatchObject({ state: 'waiting' });
  expect(evaluateWake({ ...room, messages: [msg('m0', 'igor', 'start')] }, 'codex', 'm0', 0).tasks).toEqual([]);
  messages.push(msg('m3', 'igor', '@Codex go ahead'));
  expect(evaluateWake(room, 'codex', 'm2', 0)).toMatchObject({ state: 'addressed', addressed: ['m3'] });
  expect(evaluateWake({ ...room, floor: 'open' }, 'codex', 'm1', 0).addressed).toEqual(['m2', 'm3']);
  expect(evaluateWake({ ...room, tasks: [{ ...task, assignedBy: 'igor' }] }, 'codex', 'm3', 0).tasks).toHaveLength(1);
  // With the default policy, anyone's mention wakes it again.
  expect(evaluateWake({ ...room, participants: roster.map(p => p.id === 'codex' ? { ...p, wake: 'anyone' as const } : p) }, 'codex', undefined, 0).addressed).toEqual(['m1', 'm3']);
});

test('the node grants local agents an operator, carries it in descriptors, and lets only the operator change who can wake them', () => {
  const a = memoryNode().node, b = memoryNode().node;
  try {
    const { roomId, agent } = agentRoom(a, 'Codex');
    const roomB = agentRoom(b, 'Grok');
    const local = a.snapshot().rooms[0].participants;
    expect(local.find(p => p.role === 'agent')).toMatchObject({ operatorId: a.owner.participantId, machine: 'Test', wake: 'anyone' });
    expect(local.find(p => p.role === 'human')).toMatchObject({ machine: 'Test' });
    const descriptor = a.descriptor(roomId, 'a'.repeat(64));
    expect(descriptor.participants.find(p => p.role === 'agent')?.operatorId).toBe(a.owner.participantId);
    expect(descriptor.machine).toBe('Test');

    expect(() => a.setAgentWake({ roomId, requestId: randomUUID(), agentId: agent.participantId, wake: 'operator' }, agent)).toThrow('human session');
    expect(() => a.setAgentWake({ roomId, requestId: randomUUID(), agentId: a.owner.participantId, wake: 'operator' })).toThrow('agent on this machine');
    a.setAgentWake({ roomId, requestId: randomUUID(), agentId: agent.participantId, wake: 'operator' });
    expect(a.snapshot().rooms[0].participants.find(p => p.id === agent.participantId)?.wake).toBe('operator');

    // A paired node shows the remote agent's operator; an older grant can gain attribution later but never change it.
    b.createRoom({ title: 'Shared', requestId: roomId });
    const legacy = { ...descriptor, machine: undefined, participants: descriptor.participants.map(({ id, name, role }) => ({ id, name, role })) };
    b.pairRoom(legacy, 'b'.repeat(64));
    const shared = () => b.snapshot().rooms.find(r => r.id === roomId)!.participants;
    expect(shared().find(p => p.id === agent.participantId)?.operatorId).toBeUndefined();
    b.pairRoom(descriptor, 'b'.repeat(64));
    expect(shared().find(p => p.id === agent.participantId)).toMatchObject({ operatorId: a.owner.participantId, machine: 'Test', state: 'remote' });
    const other = descriptor.participants.find(p => p.role === 'human')!;
    expect(() => b.pairRoom({ ...descriptor, participants: descriptor.participants.map(p => p.role === 'agent' ? { ...p, operatorId: randomUUID() } : p) }, 'b'.repeat(64))).toThrow();
    expect(() => b.pairRoom({ ...descriptor, machine: 'Elsewhere' }, 'b'.repeat(64))).toThrow('different machine');
    // Copilot's review: the same people paired into another room keep their attribution and cannot change machine.
    const later = randomUUID(), third = randomUUID();
    b.createRoom({ title: 'Later', requestId: later }); b.createRoom({ title: 'Third', requestId: third });
    expect(() => b.pairRoom({ ...descriptor, roomId: third, machine: 'Elsewhere' }, 'b'.repeat(64))).toThrow('conflicts');
    b.pairRoom({ ...legacy, roomId: later }, 'b'.repeat(64));
    expect(b.snapshot().rooms.find(r => r.id === later)!.participants.find(p => p.id === agent.participantId)).toMatchObject({ operatorId: a.owner.participantId, machine: 'Test' });
    // A node that first met them without attribution gains it when they are paired into another room.
    const c = memoryNode().node;
    try {
      agentRoom(c, 'Gemini'); c.createRoom({ title: 'First', requestId: roomId }); c.createRoom({ title: 'Second', requestId: later });
      c.pairRoom(legacy, 'c'.repeat(64));
      c.pairRoom({ ...descriptor, roomId: later }, 'c'.repeat(64));
      expect(c.snapshot().rooms.find(r => r.id === roomId)!.participants.find(p => p.id === agent.participantId)).toMatchObject({ operatorId: a.owner.participantId, machine: 'Test' });
    } finally { c.close(); }
    expect(other.role).toBe('human');
    expect(roomB.roomId).not.toBe(roomId);
  } finally { a.close(); b.close(); }
});

test('an operator-only agent ignores a person from the paired machine but answers its own operator', () => {
  const a = memoryNode().node, b = memoryNode().node;
  try {
    const { roomId, agent } = agentRoom(a, 'Codex');
    b.completeSetup({ requestId: randomUUID(), humanName: 'Ana', machineName: 'Laptop', startAtLogin: false });
    b.createRoom({ title: 'Shared', requestId: roomId });
    a.pairRoom(b.descriptor(roomId, 'b'.repeat(64)), 'a'.repeat(64));
    b.pairRoom(a.descriptor(roomId, 'a'.repeat(64)), 'b'.repeat(64));
    a.setAgentWake({ roomId, requestId: randomUUID(), agentId: agent.participantId, wake: 'operator' });
    b.send({ roomId, requestId: randomUUID(), text: '@Codex can you check this?' });
    const fromAna = b.pendingDelivery()[0].messages[0];
    a.receivePeer(roomId, 'b'.repeat(64), fromAna);
    expect(a.snapshot().rooms[0].participants.find(p => p.name === 'Ana')).toMatchObject({ state: 'remote', machine: 'Laptop' });
    expect(() => a.send({ roomId, requestId: randomUUID(), text: 'On it', replyTo: fromAna.id }, agent)).toThrow('humans-first');
    const own = a.send({ roomId, requestId: randomUUID(), text: '@Codex please answer Ana' });
    a.send({ roomId, requestId: randomUUID(), text: 'Answering for Igor', replyTo: own.messageId }, agent);
    expect(() => a.setAgentWake({ roomId, requestId: randomUUID(), agentId: agent.participantId, wake: 'sometimes' })).toThrow('anyone or operator');
  } finally { a.close(); b.close(); }
});

test('an agent’s assignment wakes another agent only when the room allows agents to hand work to each other', () => {
  const roster = [
    { id: 'igor', name: 'Igor', role: 'human' as const },
    { id: 'opus', name: 'Opus', role: 'agent' as const },
    { id: 'wren', name: 'Wren', role: 'agent' as const },
  ];
  const task = { id: randomUUID(), title: 'Review', notes: '', status: 'todo' as const, assigneeId: 'wren', assignedBy: 'opus', assignedRevision: 1,
    createdBy: 'opus', updatedBy: 'opus', updatedAt: new Date().toISOString(), revision: 1 };
  const room = { floor: 'humans-first' as const, participants: roster, messages: [], tasks: [task], boardRevision: 1 };
  expect(evaluateWake(room, 'wren', undefined, 0).tasks).toEqual([]);
  expect(evaluateWake({ ...room, agentAssignmentsWake: true }, 'wren', undefined, 0).tasks).toHaveLength(1);
  // The assignee's own "only my operator" setting still applies.
  const guarded = { ...room, agentAssignmentsWake: true, participants: roster.map(p => p.id === 'wren' ? { ...p, operatorId: 'igor', wake: 'operator' as const } : p) };
  expect(evaluateWake(guarded, 'wren', undefined, 0).tasks).toEqual([]);
});

test("Copilot's review: an open floor does not let an operator-only agent speak for someone else", () => {
  const participants = [
    { id: 'igor', name: 'Igor', role: 'human' as const },
    { id: 'ana', name: 'Ana', role: 'human' as const },
    { id: 'codex', name: 'Codex', role: 'agent' as const, operatorId: 'igor', wake: 'operator' as const },
  ];
  const at = new Date().toISOString();
  const messages: Message[] = [
    { id: 'm1', authorId: 'ana', author: 'Ana', role: 'human', text: 'What do you think?', time: at },
    { id: 'm2', authorId: 'igor', author: 'Igor', role: 'human', text: 'Thoughts?', time: at },
  ];
  const room = { floor: 'open' as const, participants, messages, tasks: [] };
  expect(mayAgentSpeak(room, 'codex', 'm1')).toBe(false);
  expect(mayAgentSpeak(room, 'codex', undefined)).toBe(false);
  expect(mayAgentSpeak(room, 'codex', 'm2')).toBe(true);
  expect(mayAgentSpeak({ ...room, participants: participants.map(p => ({ ...p, wake: 'anyone' as const })) }, 'codex', 'm1')).toBe(true);
});

test('an operator-only agent follows the reply rule too: its operator replying to someone else is talking to them', () => {
  const participants = [
    { id: 'alex', name: 'Alex', role: 'human' as const }, { id: 'sam', name: 'Sam', role: 'human' as const },
    { id: 'wren', name: 'Wren', role: 'agent' as const, operatorId: 'alex', wake: 'operator' as const },
    { id: 'echo', name: 'Echo', role: 'agent' as const, operatorId: 'sam' },
  ];
  const at = new Date().toISOString();
  const say = (id: string, authorId: string, text: string, replyTo?: string): Message => {
    const author = participants.find(p => p.id === authorId)!;
    return { id, authorId, author: author.name, role: author.role, text, time: at, mentions: mentionedIds(text, participants), ...(replyTo ? { replyTo } : {}) };
  };
  const messages = [
    say('from-sam', 'sam', 'The draft is up'), say('from-echo', 'echo', 'Tests pass'), say('from-wren', 'wren', 'Reviewing'),
    say('to-sam', 'alex', 'Looks good', 'from-sam'), say('to-echo', 'alex', 'Thanks', 'from-echo'),
    say('to-wren', 'alex', 'Go ahead', 'from-wren'), say('to-sam-named', 'alex', 'Agreed, @Wren take a look', 'from-sam'),
    say('plain', 'alex', 'Anyone around?'), say('sam-plain', 'sam', 'Lunch?'),
  ];
  const room = { floor: 'open' as const, participants, messages, tasks: [], boardRevision: 0 };
  // Its operator's replies to another person or another agent are not for it; name it to bring it in.
  expect(evaluateWake(room, 'wren', 'from-wren', 0).addressed).toEqual(['to-wren', 'to-sam-named', 'plain']);
  expect(mayAgentSpeak(room, 'wren', 'to-sam')).toBe(false);
  expect(mayAgentSpeak(room, 'wren', 'to-sam-named')).toBe(true);
});

test("nobody on a local node may be named agents", () => {
  const { node } = memoryNode();
  try {
    expect(() => node.prepareRoom({ requestId: randomUUID(), title: 'Room', agentName: 'Agents', credentialHash: 'a'.repeat(64) })).toThrow('reserved');
    expect(() => node.validateSetup({ requestId: randomUUID(), humanName: ' agents ', machineName: 'Test', startAtLogin: false })).toThrow('reserved');
  } finally { node.close(); }
});

test('board filters and groups keep open work in board order and finished work newest first', () => {
  const task = (id: string, status: Task['status'], assigneeId?: string, minute = 0): Task => ({ id, title: id, notes: '', status, assigneeId, createdBy: 'igor', updatedBy: 'igor', updatedAt: new Date(Date.UTC(2026, 8, 25, 12, minute)).toISOString(), revision: 1 });
  const tasks = [task('a', 'todo', 'igor'), task('b', 'doing', 'codex'), task('c', 'todo'), task('d', 'done', 'codex', 1), task('e', 'done', undefined, 9), task('f', 'done', 'igor', 5)];
  expect(matchesTaskFilter(tasks[0], 'mine', 'igor')).toBe(true);
  expect(matchesTaskFilter(tasks[0], 'mine', undefined)).toBe(false);
  expect(matchesTaskFilter(tasks[2], 'mine', undefined)).toBe(false);
  expect(matchesTaskFilter(tasks[2], 'unassigned')).toBe(true);
  expect(matchesTaskFilter(tasks[1], 'member:codex')).toBe(true);
  expect(matchesTaskFilter(tasks[1], 'member:grok')).toBe(false);
  const ids = (groups: Record<string, Task[]>) => Object.fromEntries(Object.entries(groups).map(([status, list]) => [status, list.map(t => t.id)]));
  expect(ids(groupTasks(tasks))).toEqual({ todo: ['a', 'c'], doing: ['b'], done: ['e', 'f', 'd'] });
  expect(ids(groupTasks(tasks, 'mine', 'igor'))).toEqual({ todo: ['a'], doing: [], done: ['f'] });
  expect(ids(groupTasks(tasks, 'unassigned', 'igor'))).toEqual({ todo: ['c'], doing: [], done: ['e'] });
  expect(ids(groupTasks(tasks, 'member:codex', 'igor'))).toEqual({ todo: [], doing: ['b'], done: ['d'] });
  expect(tasks.map(t => t.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
});

test('mentions inside code are quoted, not addressed, and @agents can be left out', () => {
  expect(mentionedIds('run `notify @Codex` later', people)).toEqual([]);
  expect(mentionedIds('```\nlog: @Grok failed\n```\n@Codex look', people)).toEqual(['codex']);
  // An unclosed fence quotes everything after it.
  expect(mentionedIds('@Grok see\n```\n@Codex', people)).toEqual(['grok']);
  expect(mentionedIds('@agents and @Grok', people, { broadcast: false })).toEqual(['grok']);
  expect(mentionedIds('@agents', people, { broadcast: false })).toEqual([]);
});

test('code is masked the way the room renders it', () => {
  // Fences open only at the start of a line, with ``` or ~~~, and close with at least as many of the same character.
  expect(mentionedIds('see ``` @Codex', people)).toEqual(['codex']);
  expect(mentionedIds('~~~\n@Grok\n~~~\n@Codex', people)).toEqual(['codex']);
  expect(mentionedIds('````\n```\n@Grok\n````\n@Codex', people)).toEqual(['codex']);
  expect(mentionedIds('~~~\n@Grok\n```\n@Codex', people)).toEqual([]);
  expect(mentionedIds('   ```\n@Grok\n```', people)).toEqual([]);
  // Inline code is a run of backticks closed by a run of exactly as many.
  expect(mentionedIds('``a ` @Grok`` @Codex', people)).toEqual(['codex']);
  expect(mentionedIds('`` @Grok ` @Codex', people)).toEqual(['codex', 'grok']);
  expect(mentionedIds('it`s @Codex', people)).toEqual(['codex']);
  // It may wrap a line, but not cross a blank line.
  expect(mentionedIds('`one\n@Grok`', people)).toEqual([]);
  expect(mentionedIds('`one\n\n@Grok`', people)).toEqual(['grok']);
  // A stray backtick doesn't hide a mention the room shows as text: inline code ends where the renderer's block does.
  expect(mentionedIds('- don`t panic\n- @Grok run `make test`', people)).toEqual(['grok']);
  expect(mentionedIds('> it`s red\n@Grok please run `bun test`', people)).toEqual(['grok']);
  expect(mentionedIds('# Next `step\n@Grok take `lint`', people)).toEqual(['grok']);
  expect(mentionedIds('| `x | @Grok` |\n|---|---|', people)).toEqual(['grok']);
  expect(mentionedIds('`a\r\n\r\n@Grok`', people)).toEqual(['grok']);
  expect(mentionedIds('\\`@Grok`', people)).toEqual(['grok']);
  // Fences inside quotes and lists are code too.
  expect(mentionedIds('> ~~~\n> @Grok\n> ~~~', people)).toEqual([]);
  expect(mentionedIds('> ```\n> @Grok', people)).toEqual([]);
  expect(mentionedIds('- ~~~\n  @Grok\n  ~~~', people)).toEqual([]);
  // Code becomes a space, so the words on either side stay apart.
  expect(proseText('a `b` c')).toBe('a   c\n');
  // Emphasis and links keep their names apart from the word before them, as the raw text did.
  expect(mentionedIds('*hi*@Grok run `x`', people)).toEqual(['grok']);
  expect(mentionedIds('**done**@Grok `x`', people)).toEqual(['grok']);
  expect(mentionedIds('[docs](https://x.io)@Grok `x`', people)).toEqual(['grok']);
  expect(proseText('no code @Grok')).toBe('no code @Grok');
});

describe('people and agents', () => {
  const room = (messages: Message[], tasks: Task[] = []) => ({ floor: 'people-and-agents' as const, participants: people, messages, tasks });

  test('anyone’s @Name or reply wakes the agent it names; @agents from an agent and unaddressed messages wake nobody', () => {
    const msgs = [
      message('p1', 'igor', 'Morning all'),
      message('p2', 'igor', '@agents status?'),
      message('a1', 'grok', '@Codex can you take the tests?'),
      message('a2', 'grok', '@agents everyone look'),
      message('a3', 'grok', 'Thinking out loud'),
      message('a4', 'codex', 'On it', { replyTo: 'a1' }),
      message('a5', 'grok', '@Igor done'),
    ];
    const r = room(msgs);
    const woke = (id: string, agent: string) => wakes(r, msgs.find(m => m.id === id)!, agent);
    expect(woke('p1', 'codex')).toBe(false);
    expect(['codex', 'codex-cli', 'grok'].map(a => woke('p2', a))).toEqual([true, true, true]);
    expect(woke('a1', 'codex')).toBe(true);
    expect(woke('a1', 'codex-cli')).toBe(false);
    expect(['codex', 'codex-cli'].map(a => woke('a2', a))).toEqual([false, false]);
    expect(woke('a3', 'codex')).toBe(false);
    expect(woke('a4', 'grok')).toBe(true);
    expect(woke('a5', 'codex')).toBe(false);
  });

  test('an agent may start a message that names another member, but not with @agents alone', () => {
    const msgs = [message('p1', 'igor', 'Just chatting')];
    const r = room(msgs);
    expect(mayAgentSpeak(r, 'grok', undefined, '@Codex can you pair on this?')).toBe(true);
    expect(mayAgentSpeak(r, 'grok', undefined, '@agents anyone?')).toBe(false);
    expect(mayAgentSpeak(r, 'grok', undefined, 'Unprompted thought')).toBe(false);
    expect(mayAgentSpeak(r, 'grok', 'p1', 'Replying to people chatter')).toBe(false);
    expect(mayAgentSpeak(r, 'grok', undefined, 'see `@Codex` in the log')).toBe(false);
    // Humans-first is unchanged: naming an agent doesn't let an agent speak.
    expect(mayAgentSpeak({ ...r, floor: 'humans-first' }, 'grok', undefined, '@Codex can you pair on this?')).toBe(false);
    expect(speakRefusal('people-and-agents')).toContain('@Name');
    expect(speakRefusal('humans-first')).toContain('humans-first');
  });

  test('a reply chain pauses after the chain limit of agent-to-agent wakes, and a person in the chain lets it continue', () => {
    const msgs = [message('root', 'igor', '@Grok and @Codex, settle the API between you')];
    let previous = 'root';
    for (let i = 0; i < AGENT_CHAIN_LIMIT + 2; i++) {
      const [from, to] = i % 2 ? ['codex', 'Grok'] : ['grok', 'Codex'];
      msgs.push(message(`h${i}`, from, `@${to} point ${i}`, { replyTo: previous }));
      previous = `h${i}`;
    }
    const r = room(msgs);
    const target = (i: number) => (i % 2 ? 'grok' : 'codex');
    const wokeAt = (i: number) => wakes(r, msgs.find(m => m.id === `h${i}`)!, target(i));
    expect(Array.from({ length: AGENT_CHAIN_LIMIT }, (_, i) => wokeAt(i)).every(Boolean)).toBe(true);
    expect(wokeAt(AGENT_CHAIN_LIMIT)).toBe(false);
    expect(chainRoot(r, `h${AGENT_CHAIN_LIMIT}`)).toBe('root');
    expect(loopGuard(r).chains.get('root')).toMatchObject({ paused: true });
    // The paused agent can't reply into the chain either: nothing there woke it.
    expect(mayAgentSpeak(r, target(AGENT_CHAIN_LIMIT), `h${AGENT_CHAIN_LIMIT}`)).toBe(false);
    // A person speaking in the chain lets the agents continue.
    const resumed = [...msgs, message('p', 'igor', 'Keep going', { replyTo: previous }), message('n', 'grok', '@Codex next', { replyTo: 'p' })];
    expect(wakes(room(resumed), resumed.at(-1)!, 'codex')).toBe(true);
    expect(loopGuard(room(resumed)).chains.get('root')).toMatchObject({ hops: 1, paused: false });
  });

  test('a paused chain leaves other chains alone, and the room pauses at the room limit until a person addresses an agent', () => {
    const msgs: Message[] = [];
    let hops = 0, chain = 0;
    while (hops < AGENT_ROOM_LIMIT) {
      msgs.push(message(`r${chain}`, 'grok', '@Codex new topic'));
      hops++;
      let previous = `r${chain}`;
      for (let i = 0; i < 2 && hops < AGENT_ROOM_LIMIT; i++, hops++) {
        msgs.push(message(`r${chain}-${i}`, i % 2 ? 'grok' : 'codex', i % 2 ? '@Codex' : '@Grok', { replyTo: previous }));
        previous = `r${chain}-${i}`;
      }
      chain++;
    }
    const r = room(msgs);
    expect(loopGuard(r)).toMatchObject({ roomHops: AGENT_ROOM_LIMIT, roomPaused: true });
    expect([...loopGuard(r).chains.values()].every(c => !c.paused)).toBe(true);
    // A message this device doesn't hold yet is judged as if appended.
    const fresh = message('late', 'grok', '@Codex one more topic');
    expect(wakes(r, fresh, 'codex')).toBe(false);
    // People talking among themselves don't release the room.
    const chatter = room([...msgs, message('p0', 'igor', 'lunch?'), fresh]);
    expect(wakes(chatter, fresh, 'codex')).toBe(false);
    // A person addressing an agent anywhere in the room releases it.
    const released = room([...msgs, message('p', 'igor', '@agents ok, carry on'), fresh]);
    expect(loopGuard(released).roomPaused).toBe(false);
    expect(wakes(released, fresh, 'codex')).toBe(true);
    // So does a person's reply to an agent's message, which addresses that agent.
    const replied = room([...msgs, message('p', 'igor', 'thanks', { replyTo: 'r0' }), fresh]);
    expect(wakes(replied, fresh, 'codex')).toBe(true);
  });

  test('assignments wake across agents only with the hand-off setting and while the room is not paused; agent decisions never do', () => {
    const task: Task = { id: 't', title: 'x', notes: '', status: 'todo', assigneeId: 'codex', assignedBy: 'grok', assignedRevision: 1, createdBy: 'grok', updatedBy: 'grok', updatedAt: '', revision: 1 };
    const quiet = room([message('p', 'igor', '@agents hi')]);
    expect(assignmentWakes(quiet, task, 'codex')).toBe(false);
    expect(assignmentWakes({ ...quiet, agentAssignmentsWake: true }, task, 'codex')).toBe(true);
    const busy = room(Array.from({ length: AGENT_ROOM_LIMIT }, (_, i) => message(`a${i}`, i % 2 ? 'grok' : 'codex', 'progress')));
    expect(loopGuard(busy).roomPaused).toBe(true);
    expect(assignmentWakes({ ...busy, agentAssignmentsWake: true }, task, 'codex')).toBe(false);
    // Humans-first keeps the setting as it was: the guard is only for people-and-agents.
    expect(assignmentWakes({ ...busy, floor: 'humans-first', agentAssignmentsWake: true }, task, 'codex')).toBe(true);
    // A decision an agent opens would ask every agent at once: it wakes none here, and still wakes them in an open room.
    expect(authorWakes(quiet, 'codex', 'grok')).toBe(false);
    expect(authorWakes({ ...quiet, floor: 'open' }, 'codex', 'grok')).toBe(true);
    // A person's assignment and decision wake whatever the guard says.
    expect(assignmentWakes(busy, { ...task, assignedBy: 'igor' }, 'codex')).toBe(true);
    expect(authorWakes(busy, 'codex', 'igor')).toBe(true);
  });

  test('every agent message counts, deleted or from a member who left, and a deleted person message resets nothing', () => {
    const chainOf = (n: number, extra: (i: number) => Partial<Message> = () => ({})) => {
      const msgs = [message('root', 'igor', '@Grok @Codex go')];
      for (let i = 0; i < n; i++) msgs.push(message(`h${i}`, i % 2 ? 'codex' : 'grok', i % 2 ? '@Grok' : '@Codex', { replyTo: i ? `h${i - 1}` : 'root', ...extra(i) }));
      return msgs;
    };
    // Deleting the exchange doesn't make room for more of it.
    const deleted = chainOf(AGENT_CHAIN_LIMIT, i => (i < 4 ? { deleted: true } : {}));
    const next = message('n', 'grok', '@Codex again', { replyTo: `h${AGENT_CHAIN_LIMIT - 1}` });
    expect(wakes(room([...deleted, next]), next, 'codex')).toBe(false);
    // Nor does an agent leaving the room: its messages still count, though the view now calls their author a person.
    const left = chainOf(AGENT_CHAIN_LIMIT).map(m => (m.authorId === 'codex' ? { ...m, authorId: 'gone', author: 'Gone', role: 'human' as const } : m));
    const after = message('n', 'grok', '@Codex again', { replyTo: `h${AGENT_CHAIN_LIMIT - 1}` });
    expect(loopGuard(room([...left, after])).chains.get('root')?.hops).toBe(AGENT_CHAIN_LIMIT + 1);
    expect(wakes(room([...left, after]), after, 'codex')).toBe(false);
    // A person's message that was deleted doesn't reset the chain.
    const undone = [...chainOf(AGENT_CHAIN_LIMIT), message('p', 'igor', 'go on', { replyTo: `h${AGENT_CHAIN_LIMIT - 1}`, deleted: true })];
    const more = message('m', 'grok', '@Codex go on', { replyTo: 'p' });
    expect(wakes(room([...undone, more]), more, 'codex')).toBe(false);
    // A person's message in the chain resets it even when it addresses nobody; the room count stays.
    const reset = room([...chainOf(AGENT_CHAIN_LIMIT), message('p', 'igor', 'hmm', { replyTo: 'root' })]);
    expect(loopGuard(reset).chains.get('root')?.hops).toBe(0);
    expect(loopGuard(reset).roomHops).toBe(AGENT_CHAIN_LIMIT);
  });

  test('an agent reply to a message this device does not hold wakes nobody', () => {
    // A device that received only the last two replies of a chain already at the limit: without the rest it can't know.
    const tail = [
      message(`h${AGENT_CHAIN_LIMIT}`, 'grok', '@Codex next', { replyTo: `h${AGENT_CHAIN_LIMIT - 1}` }),
      message(`h${AGENT_CHAIN_LIMIT + 1}`, 'codex', '@Grok next', { replyTo: `h${AGENT_CHAIN_LIMIT}` }),
    ];
    const r = room(tail);
    expect(wakes(r, tail[0], 'codex')).toBe(false);
    // The second reply's target is here, but its chain still starts at a message the device doesn't hold, so it can't be
    // counted and wakes nobody either.
    expect(chainRoot(r, tail[1].id)).toBe(tail[0].id);
    expect(wakes(r, tail[1], 'grok')).toBe(false);
    // Nor does a new reply into that chain.
    expect(wakes(r, message('n', 'grok', '@Codex more', { replyTo: tail[1].id }), 'codex')).toBe(false);
    // Once the history arrives, the chain is counted from its start.
    const full = [message('root', 'igor', '@Grok @Codex go'), message('h0', 'grok', '@Codex', { replyTo: 'root' })];
    expect(wakes(room(full), full[1], 'codex')).toBe(true);
    // A person's reply to a missing message still wakes the agent it names, as on every floor.
    const person = message('p', 'igor', '@Codex see above', { replyTo: 'missing' });
    expect(wakes(room([person]), person, 'codex')).toBe(true);
  });

  test('a member who left takes the agent path, and without names only replies address agents', () => {
    const msgs = Array.from({ length: AGENT_ROOM_LIMIT }, (_, i) => message(`a${i}`, 'grok', 'progress'));
    const gone: Message = { id: 'g', authorId: 'gone', author: 'Gone', role: 'human', text: '@Codex @agents', time: '', mentions: ['codex', 'codex-cli', 'grok'] };
    const paused = room([...msgs, gone]);
    expect(loopGuard(paused).roomPaused).toBe(true);
    expect(wakes(paused, gone, 'codex')).toBe(false);
    // Unpaused, it wakes only whom it names one by one, as an agent's message would.
    const quiet = room([message('p', 'igor', '@agents hi'), gone]);
    expect(['codex', 'codex-cli'].map(a => wakes(quiet, gone, a))).toEqual([true, false]);
    // A view without names can't tell @Name from @agents: an agent's mentions count for nothing, its reply still does.
    const nameless = people.map(({ id, role }) => ({ id, role }));
    const ping = message('x', 'grok', '@agents look'), answer = message('y', 'grok', 'see', { replyTo: 'c1' });
    const r = { floor: 'people-and-agents' as const, participants: nameless, messages: [message('c1', 'codex', 'q'), ping, answer] };
    expect(wakes(r, ping, 'codex')).toBe(false);
    expect(wakes(r, answer, 'codex')).toBe(true);
  });

  test('a reply stored before the message it answers still counts in its chain', () => {
    // Messages are stored as they arrive: a2 came before a1, which it answers.
    const msgs = [message('p', 'igor', '@Grok @Codex go'), message('a2', 'codex', '@Grok b', { replyTo: 'a1' }), message('a1', 'grok', '@Codex a', { replyTo: 'p' }), message('a3', 'grok', '@Codex c', { replyTo: 'a2' })];
    const r = room(msgs);
    expect(chainRoot(r, 'a3')).toBe('p');
    expect(loopGuard(r).chains.get('p')?.hops).toBe(3);
    expect(wakes(r, msgs[3], 'codex')).toBe(true);
    expect(wakes(r, message('a4', 'codex', '@Grok d', { replyTo: 'a3' }), 'grok')).toBe(true);
    // A loop of replies has no beginning: it wakes nobody.
    const loop = [message('x', 'grok', '@Codex x', { replyTo: 'y' }), message('y', 'codex', '@Grok y', { replyTo: 'x' })];
    expect(wakes(room(loop), loop[1], 'grok')).toBe(false);
  });

  test('a second message under a reused id wakes no agent', () => {
    const msgs = [message('p', 'igor', '@Grok @Codex go'), message('p', 'grok', '@Codex sneaking in', { collidingCopy: true })];
    expect(wakes(room(msgs), msgs[1], 'codex')).toBe(false);
    // The first, canonical message keeps its own effect.
    expect(wakes(room(msgs), msgs[0], 'codex')).toBe(true);
  });

  test('the guard is recomputed when the same message array grows', () => {
    const msgs = Array.from({ length: AGENT_ROOM_LIMIT - 1 }, (_, i) => message(`a${i}`, 'grok', 'progress'));
    const r = room(msgs);
    expect(loopGuard(r).roomPaused).toBe(false);
    msgs.push(message('last', 'codex', 'progress'));
    expect(loopGuard(r).roomPaused).toBe(true);
  });

  test('refusals name the floor', () => {
    expect(speakRefusal('people-and-agents')).toContain('@Name');
    expect(speakRefusal('humans-first')).toContain('humans-first');
    expect(speakRefusal('open')).toContain('operator');
  });
});

test('open floor: a person’s message that names nobody goes to every agent until one claims it, and then only that one answers', () => {
  const now = Date.now();
  const ask = message('ask', 'igor', 'Who has the latest logo?');
  const all = message('all', 'igor', '@agents introduce yourselves');
  const named = message('named', 'igor', '@Grok the logo please');
  const reply = message('reply', 'igor', 'thanks', { replyTo: 'ask' });
  const claims: Claim[] = [];
  const start = message('start', 'igor', '@Grok morning');
  const room = { floor: 'open' as const, participants: people, messages: [ask, all, named, reply], tasks: [], boardRevision: 0, claims };
  // Only the broadcast needs a claim: @agents asks every agent, a name or a reply already says whom it is for.
  expect([ask, all, named, reply].map(m => needsClaim(room, m))).toEqual([true, false, false, false]);
  expect(needsClaim({ floor: 'people-and-agents' }, ask)).toBe(false);
  expect(needsClaim(room, message('agent-ask', 'grok', 'anyone?'))).toBe(false);
  // Unclaimed, it wakes every agent, and any of them may answer.
  expect(['codex', 'codex-cli', 'grok'].map(id => wakes(room, ask, id))).toEqual([true, true, true]);
  expect(mayAgentSpeak(room, 'codex', 'ask', 'I have it')).toBe(true);
  // Claimed by Grok: it stays Grok's; the others neither wake for it nor may reply to it.
  claims.push({ messageId: 'ask', memberId: 'grok', at: now, until: now + CLAIM_TTL_MS });
  expect(claimHolder(room, 'ask', now)).toBe('grok');
  expect(['codex', 'codex-cli', 'grok'].map(id => wakes(room, ask, id))).toEqual([false, false, true]);
  expect(mayAgentSpeak(room, 'codex', 'ask', 'I have it')).toBe(false);
  expect(mayAgentSpeak(room, 'grok', 'ask', 'Here it is')).toBe(true);
  // Codex may still speak elsewhere on an open floor, and @agents still wakes everyone.
  expect(mayAgentSpeak(room, 'codex', undefined, 'Something else')).toBe(true);
  expect(wakes(room, all, 'codex')).toBe(true);
  expect(evaluateWake(room, 'codex', undefined, 0).addressed).toEqual(['all']);
  expect(evaluateWake(room, 'grok', undefined, 0).addressed).toEqual(['ask', 'all', 'named']);
  // Not for Codex while Grok holds it, but still context: the cursor stays, so a claim that lapses wakes Codex again.
  expect(evaluateWake({ ...room, messages: [start, ask] }, 'codex', 'start', 0)).toMatchObject({ state: 'waiting', cursor: 'start', messages: [ask] });
  // A claim that lapsed without an answer frees the message again.
  claims[0] = { ...claims[0], until: now - 1 };
  expect(claimHolder(room, 'ask')).toBeUndefined();
  expect(wakes(room, ask, 'codex')).toBe(true);
  // Marked answered, it holds for good, but only once this device holds Grok's answer: its word alone isn't enough.
  claims[0] = { ...claims[0], answered: true };
  expect(claimHolder(room, 'ask')).toBeUndefined();
  room.messages.push(message('answer', 'grok', 'Here it is', { replyTo: 'ask' }));
  expect(claimHolder(room, 'ask')).toBe('grok');
  expect(mayAgentSpeak(room, 'codex', 'ask', 'Late answer')).toBe(false);
  expect(claimRefusal('Grok')).toContain('Grok is answering this message');
  // Once this device holds another agent's answer, the message is handled even after the room service forgot the claim.
  claims.length = 0;
  expect(wakes(room, ask, 'codex')).toBe(false);
  expect(wakes(room, ask, 'grok')).toBe(true);
  // A person's reply, or the agent's own, doesn't count as another agent's answer.
  const asked = message('asked', 'igor', 'Anyone?'), own = message('own', 'codex', 'me', { replyTo: 'asked' }), person = message('person', 'igor', 'hm', { replyTo: 'asked' });
  expect(wakes({ ...room, messages: [asked, own, person] }, asked, 'codex')).toBe(true);
  // On the other floors a claim of a message that isn't a broadcast changes nothing.
  const quiet = { ...room, floor: 'humans-first' as const, claims: [{ messageId: 'named', memberId: 'codex', at: now, until: now + CLAIM_TTL_MS }] };
  expect(wakes(quiet, named, 'grok')).toBe(true);
  expect(mayAgentSpeak(quiet, 'grok', 'named', 'On it')).toBe(true);
});

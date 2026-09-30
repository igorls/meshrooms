import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { LocalNode } from './node';
import { createHandler } from './http';
import { NodeAccess } from './access';
import { testStartupManager } from './startup';
import { tokenHash } from './model';
import { evaluateWake, groupTasks, matchesTaskFilter, mayAgentSpeak, mentionSegments, mentionedIds, type Task } from '../src/collab';
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

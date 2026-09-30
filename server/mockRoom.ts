import type { Plugin, ViteDevServer, PreviewServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Message, Participant, NodeSnapshot, RoomInfo, RoomSnapshot } from '../src/room.ts';
import { randomUUID } from 'node:crypto';

const nodeId = randomUUID();
const localParticipant: Participant = { id: 'local-person', name: 'You', role: 'human', state: 'local', detail: 'Local node · room member' };
const example = (id: string, name: string, role: 'human' | 'agent', offline = false): Participant => ({
  id, name, role, state: offline ? 'example-offline' : 'example-idle', detail: offline ? 'Example · not connected' : 'Example · room member',
});
const codex = example('codex', 'Codex', 'agent');
const grok = example('grok', 'Grok', 'agent', true);
const mira = example('mira', 'Mira', 'human');
const theo = example('theo', 'Theo', 'human');
const ada = example('ada', 'Ada', 'human');
const sampleMessage = (id: string, author: Participant, text: string, extra: Partial<Message> = {}): Message => ({
  id, authorId: author.id, author: author.name, role: author.role, text, time: '2026-09-20T17:06:00Z', sample: true, ...extra,
});
type Room = RoomSnapshot & { joined: boolean };
const rooms = new Map<string, Room>([
  ['connection-lab', {
    id: 'connection-lab', title: 'Connection lab', project: 'MeshGuard', sample: true, joined: true,
    participants: [localParticipant, codex, grok, mira],
    messages: [
      sampleMessage('s1', mira, 'Let’s use this room to work through the connection issue. Share the evidence that helps; keep the rest of your workspace local.'),
      sampleMessage('s2', codex, 'I’ve pulled out the relevant connection notes. The next useful check is whether both peers discover each other through the seed.', { time: '2026-09-20T17:07:00Z', share: { title: 'connection-notes.md', text: 'Peer discovery is still under investigation.\nA successful local send does not establish remote receipt.\nNext: compare peer liveness on both nodes.' } }),
      sampleMessage('s3', mira, 'Good starting point. When Grok joins, we can compare its view of the same exchange.', { time: '2026-09-20T17:08:00Z', replyTo: 's2' }),
    ],
  }],
  ['6c2bcf7a-0aad-4a2b-82c1-0f375df1bdd2', {
    id: '6c2bcf7a-0aad-4a2b-82c1-0f375df1bdd2', title: 'Release notes', project: 'MeshGuard', sample: true, joined: true,
    participants: [localParticipant, codex, theo],
    messages: [sampleMessage('release-1', theo, 'Keep release wording here, separate from the connection investigation.'), sampleMessage('release-2', codex, 'I can review the change summaries you choose to share. This room has its own history and participants.')],
  }],
  ['b617b466-82d5-40aa-9bcf-2f60fe191245', {
    id: 'b617b466-82d5-40aa-9bcf-2f60fe191245', title: 'History & recovery', project: 'WormDB', sample: true, joined: true,
    participants: [localParticipant, grok, ada],
    messages: [sampleMessage('history-1', ada, 'Let’s keep the recovery discussion in this room. The project label is just a way to organize the list.'), sampleMessage('history-2', grok, 'Example note: durable history needs a separate acceptance check. This demo currently keeps messages in memory only.')],
  }],
  ['751fe925-8af9-45f3-a741-9697a0d1b874', {
    id: '751fe925-8af9-45f3-a741-9697a0d1b874', title: 'Protocol review', project: 'MeshGuard', sample: true, joined: false,
    participants: [codex, ada],
    messages: [sampleMessage('protocol-1', ada, 'This example room is ready to join. Joining adds the local participant; opening or closing a browser does not change its membership.')],
  }],
]);
const views = new Map<string, ServerResponse>();
const info = ({ id, title, project, sample }: RoomInfo): RoomInfo => ({ id, title, project, sample });
function snapshot(): NodeSnapshot {
  return {
    backend: 'demo', storage: 'memory', nodeId, localParticipantId: localParticipant.id,
    rooms: Array.from(rooms.values()).filter(room => room.joined).map(room => ({ ...info(room), messages: room.messages, participants: room.participants })),
    availableRooms: Array.from(rooms.values()).filter(room => !room.joined).map(info),
  };
}
function broadcast() {
  const event = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const view of views.values()) view.write(event);
}
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); }
function setup(server: ViteDevServer | PreviewServer) {
  server.middlewares.use('/api/demo', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/events' && req.method === 'GET') {
      const viewId = url.searchParams.get('view') || '';
      if (!/^[\w-]{1,64}$/.test(viewId)) { json(res, 400, { message: 'A valid browser view ID is required.' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      views.get(viewId)?.end();
      views.set(viewId, res);
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      const heartbeat = setInterval(() => res.write(': local demo node heartbeat\n\n'), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        if (views.get(viewId) === res) views.delete(viewId);
        // Views are disposable. Rooms, membership and messages stay on this node.
      });
      return;
    }
    if (req.method !== 'POST' || !['/messages', '/rooms', '/rooms/join'].includes(url.pathname)) { next(); return; }
    // Loopback demo only. These fixed APIs provide no filesystem or tool execution.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { message: 'Use this local demo from its own browser address.' }); return; }
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 20000) { json(res, 413, { message: 'This demo accepts smaller message payloads.' }); return; } }
      const data = JSON.parse(raw);
      if (url.pathname === '/rooms') {
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        const project = typeof data.project === 'string' ? data.project.trim() : '';
        if (!title || title.length > 64 || project.length > 48) { json(res, 400, { message: 'Enter a room name up to 64 characters and a project label up to 48 characters.' }); return; }
        const roomId = randomUUID();
        rooms.set(roomId, { id: roomId, title, project, sample: false, joined: true, messages: [], participants: [localParticipant] });
        broadcast(); json(res, 201, { roomId }); return;
      }
      const room = typeof data.roomId === 'string' ? rooms.get(data.roomId) : undefined;
      if (!room) { json(res, 404, { message: 'That room is not on this demo node. Choose an available room or create one.' }); return; }
      if (url.pathname === '/rooms/join') {
        if (!room.joined) { room.joined = true; room.participants.unshift(localParticipant); broadcast(); }
        json(res, 200, { roomId: room.id }); return;
      }
      if (!room.joined || !room.participants.some(p => p.id === localParticipant.id)) { json(res, 409, { message: 'Join this room before sending a message.' }); return; }
      const text = typeof data.text === 'string' ? data.text.trim().slice(0, 4000) : '';
      const share = data.share && typeof data.share.title === 'string' && typeof data.share.text === 'string'
        ? { title: data.share.title.trim().slice(0, 100), text: data.share.text.slice(0, 8000) } : undefined;
      if ((!text && !share) || (data.share && (!share?.title || !share.text.trim()))) { json(res, 400, { message: 'Enter a message or a labeled excerpt.' }); return; }
      if (data.replyTo !== undefined && !room.messages.some(m => m.id === data.replyTo)) { json(res, 400, { message: 'The reply target is not in this room. Choose a message from this room.' }); return; }
      room.messages.push({ id: randomUUID(), authorId: localParticipant.id, author: localParticipant.name, role: 'human', text, time: new Date().toISOString(), share, replyTo: data.replyTo });
      broadcast(); json(res, 201, { status: 'in-local-memory' });
    } catch { json(res, 400, { message: 'The local demo could not read this request. Try again.' }); }
  });
}

export function mockRoomPlugin(): Plugin { return { name: 'meshrooms-local-demo', configureServer: setup, configurePreviewServer: setup }; }

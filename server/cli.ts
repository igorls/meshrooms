import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, cleanName } from './attachments';
import { defaultOptions } from './daemon';
import { controlCommand } from './meshguard';
import { fingerprint, isHash, isUuid, tokenHash } from './model';
import { ensureRunning, probeRuntime, type RuntimeRecord } from './runtime';
import type { NodeSnapshot } from '../src/room';
import { evaluateWake, type WakeResult } from '../src/collab';
import {
  appendOwnedAllow,
  assertNoConflictingShare,
  createShareRecord,
  defaultMeshguardConfigDir,
  findBroaderAllows,
  markSharePendingDisable,
  meshguardSocketPath,
  peerPolicyStem,
  readShareRecord,
  removeOwnedRules,
  validatePort,
  writeShareRecord,
} from './share';

type ClientCredential = { version: 1; nodeId: string; dataDir: string; intentId: string; token: string; title: string; project: string; agentName: string };
function parse(args: string[]) {
  const command = args[0] || 'help'; const values: Record<string, string> = {}; const attach: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const key = args[i]; const value = args[++i];
    if (key === '--attach' && value !== undefined) { attach.push(value); continue; }
    if (!key.startsWith('--') || value === undefined || Object.hasOwn(values, key)) throw new Error(`Use one value for ${key}.`);
    values[key] = value;
  }
  const allowed = ['--data-dir', '--library', '--port', '--dev-origin', '--title', '--project', '--agent', '--request-id', '--credential', '--text', '--after', '--wait-seconds', '--room', '--descriptor',
    '--reply-to', '--board-after', '--task', '--revision', '--status', '--notes', '--assignee', '--id', '--out', '--url', '--name',
    '--minutes', '--meshguard-config', '--peer-alias', '--peer-key', '--mesh-ip'];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`Unknown option ${key}.`);
  return { command, values, attach };
}

async function resolvePairedPeerKey(dataDir: string, roomId: string, explicit?: string): Promise<string> {
  if (explicit) {
    if (!isHash(explicit)) throw new Error('Use --peer-key with the paired peer\'s 64-hex MeshGuard public key.');
    return explicit;
  }
  const runtime = await probeRuntime(dataDir);
  if (!runtime) throw new Error('Start the local node, or pass --peer-key for the paired MeshGuard peer.');
  const token = await ownerToken(dataDir, runtime);
  const transport = await api(runtime, token, 'transport') as { enabled?: boolean; rooms?: { roomId: string; peerKey: string }[] };
  const room = transport.rooms?.find(entry => entry.roomId === roomId);
  if (!room || !isHash(room.peerKey)) {
    throw new Error(`Room ${roomId} is not paired on this node. Pair it first, or pass --peer-key explicitly.`);
  }
  return room.peerKey;
}

async function resolveMeshAttachment(explicitMeshIp?: string): Promise<{ socket: string; meshIp: string }> {
  const socket = meshguardSocketPath();
  const status = await controlCommand(socket, 'STATUS');
  if (status?.running !== true || typeof status.mesh_ip !== 'string') {
    throw new Error('MeshGuard STATUS did not report a running daemon with mesh_ip. Is meshguard up and MESHROOMS_MESHGUARD_SOCKET correct?');
  }
  const meshIp = explicitMeshIp || status.mesh_ip;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(meshIp)) throw new Error('Mesh IP must be an IPv4 address from MeshGuard STATUS.');
  return { socket, meshIp };
}
function requireText(value: string | undefined, name: string, max: number) {
  if (!value?.trim() || value.length > max) throw new Error(`${name} must contain 1–${max} characters.`); return value.trim();
}
function readCredential(file: string): ClientCredential {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.version !== 1 || !isUuid(value.nodeId) || !isUuid(value.intentId) || typeof value.dataDir !== 'string'
    || typeof value.token !== 'string' || !/^[\w-]{43}$/.test(value.token)
    || !['title', 'project', 'agentName'].every(key => typeof value[key] === 'string')) throw new Error('Invalid agent credential file. Do not replace it; recover the original file.');
  return value;
}
function createCredential(file: string, value: ClientCredential): ClientCredential {
  if (existsSync(file)) return readCredential(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try { linkSync(temporary, file); }
  catch (error) { if (!existsSync(file)) throw error; }
  finally { unlinkSync(temporary); }
  return readCredential(file);
}
async function api(record: RuntimeRecord, token: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/node/${path}`, record.url), { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || `Local request failed (${response.status}).`);
  return result;
}
/** A stable per-file request ID, so retrying the same send re-uses the same uploads. */
function derivedRequestId(requestId: string, index: number) {
  const hex = createHash('sha256').update(`${requestId}:attachment:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function upload(record: RuntimeRecord, credential: ClientCredential, file: string, requestId: string) {
  const path = resolve(file); const info = statSync(path);
  if (!info.isFile()) throw new Error(`${file} is not a file.`);
  if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file} exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB attachment limit.`);
  const query = new URLSearchParams({ roomId: credential.intentId, requestId, name: basename(path) });
  const response = await fetch(new URL(`/api/node/attachments?${query}`, record.url), { method: 'POST', body: readFileSync(path),
    headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(60000) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || `Upload failed (${response.status}).`);
  return result as { id: string };
}
async function download(record: RuntimeRecord, credential: ClientCredential, id: string, out: string | undefined) {
  const response = await fetch(new URL(`/api/node/attachments/${credential.intentId}/${id}`, record.url), {
    headers: { Authorization: `Bearer ${credential.token}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || `Download failed (${response.status}).`);
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  const name = cleanName(encoded ? decodeURIComponent(encoded) : '', 'attachment.bin');
  // Downloads default to a private folder under the node data directory, not the working tree.
  const directory = resolve(out || join(credential.dataDir, 'downloads', credential.intentId)); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id.slice(0, 8)}-${name}`); const data = new Uint8Array(await response.arrayBuffer());
  writeFileSync(path, data, { mode: 0o600 });
  return { state: 'downloaded', id, path, name, type: response.headers.get('content-type'), size: data.byteLength };
}
async function ownerToken(dataDir: string, runtime: RuntimeRecord): Promise<string> {
  const confirmed = await probeRuntime(dataDir);
  if (!confirmed || confirmed.instanceId !== runtime.instanceId) throw new Error('The daemon changed during setup. Retry the same command.');
  return readFileSync(join(dataDir, 'control.key'), 'utf8').trim();
}
function boardCursor(value: string | undefined) {
  if (value === undefined) return undefined;
  const cursor = Number(value); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Use --board-after with the boardCursor from a previous listen.');
  return cursor;
}
/**
 * Wait until this agent is addressed. Messages nobody addressed to the agent do not end the wait and do not
 * advance the cursor; they are returned as context with the next addressed batch.
 */
async function listen(record: RuntimeRecord, credential: ClientCredential, after: string | undefined, boardAfter: number | undefined, seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Use --wait-seconds between 1 and 60.');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), seconds * 1000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let last: (WakeResult & { floor?: string; participantId: string }) | undefined;
  try {
    const response = await fetch(new URL(`/api/node/events?view=agent-${randomUUID()}`, record.url), {
      headers: { Authorization: `Bearer ${credential.token}` }, signal: abort.signal, redirect: 'error' });
    if (!response.ok) throw new Error((await response.json()).message || 'Agent connection was rejected.');
    reader = response.body!.getReader(); let buffered = ''; const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read(); if (done) throw new Error('The daemon closed the agent connection.');
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (!event.startsWith('data: ')) continue;
        const snapshot = JSON.parse(event.slice(6)) as NodeSnapshot;
        const room = snapshot.rooms.find(r => r.id === credential.intentId); if (!room) throw new Error('The agent is no longer admitted to this room.');
        last = { ...evaluateWake(room, snapshot.localParticipantId, after, boardAfter), floor: room.floor, participantId: snapshot.localParticipantId };
        if (last.state !== 'waiting') return { roomId: room.id, ...last };
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
    // Observed messages stay after the unchanged cursor, so the next addressed batch still includes them.
    return { state: 'timeout', roomId: credential.intentId, floor: last?.floor, participantId: last?.participantId, messages: [],
      observed: last?.messages.filter(m => m.authorId !== last!.participantId).length ?? 0, cursor: after, boardCursor: last?.boardCursor ?? boardAfter };
  }
  finally { clearTimeout(timer); abort.abort(); if (reader) await reader.cancel().catch(() => {}); }
}

export async function runCli(args: string[]): Promise<unknown> {
  const { command, values, attach } = parse(args);
  if (command === 'help') return { commands: ['status', 'ensure', 'open', 'start --title NAME --agent NAME [--project LABEL]',
    'read --credential PATH', 'send --credential PATH --request-id UUID [--text TEXT] [--reply-to MESSAGE_ID] [--attach FILE]...',
    'attachment --credential PATH --id ATTACHMENT_ID [--out DIRECTORY]',
    'listen --credential PATH [--after MESSAGE_ID] [--board-after BOARD_CURSOR] [--wait-seconds 30]',
    'tasks --credential PATH', 'task-add --credential PATH --request-id UUID --title TEXT [--notes TEXT] [--assignee me|PARTICIPANT_ID]',
    'task-update --credential PATH --request-id UUID --task TASK_ID --revision N [--status todo|doing|done] [--title TEXT] [--notes TEXT] [--assignee me|none|PARTICIPANT_ID]',
    'browser-join --link AGENT_LINK', 'browser-run --url ROOM_LINK', 'browser-listen --url ROOM_LINK [--after MESSAGE_ID] [--wait-seconds 30]',
    'browser-send --url ROOM_LINK --request-id UUID --text TEXT [--reply-to MESSAGE_ID]',
    'transport', 'descriptor --room UUID', 'pair --descriptor PATH (operator-approved two-node development pairing)',
    'share --room UUID --port N [--minutes 30] [--meshguard-config DIR] [--peer-alias ALIAS] [--peer-key HEX] [--mesh-ip IP]',
    'share-stop --room UUID [--meshguard-config DIR]', 'share-status --room UUID'],
    options: ['--data-dir PATH', '--library PATH', '--port NUMBER', '--dev-origin URL'],
    note: 'Browser links expire after two minutes. Agent credential files stay private on this machine. Share commands are operator-only and require MeshGuard.' };
  // The browser bridge (and its WebRTC dependency) loads only for browser-* commands, so the packaged local runtime,
  // which does not ship it, starts without it.
  const bridge = () => import('./browser-agent').catch(() => {
    throw new Error('Browser room commands are not part of this runtime. Connect agents with meshrooms-agent.js from the /agent page of the room.');
  });
  if (command === 'browser-join') {
    const { BrowserAgent, parseConnectLink } = await bridge();
    // Agents join only through an agent link a person in the room made, so the room shows who operates them.
    const { origin, roomId, token } = parseConnectLink(requireText(values['--link'], '--link', 400));
    const agent = new BrowserAgent(resolve(values['--data-dir'] || defaultOptions().dataDir), origin, roomId);
    const identity = await agent.ensureIdentity();
    let status = await agent.command('status', { session: randomUUID() }).catch(() => ({} as any));
    if (!status.memberId) {
      await agent.command('agent-redeem', { token, label: 'Meshrooms agent bridge' });
      status = await agent.command('status', { session: randomUUID() }).catch(() => ({} as any));
    }
    return { state: status.memberId ? 'admitted' : 'waiting-for-host', deviceId: identity.id, roomId, title: status.title,
      next: `Keep browser-run --url ${origin}/r/${roomId} running.` };
  }
  if (command.startsWith('browser-')) {
    // A local agent's own device in a hosted browser room; its key stays in the node data directory.
    const { BrowserAgent, listenBrowser, parseRoomUrl, runBridge, sendBrowser } = await bridge();
    const { origin, roomId } = parseRoomUrl(requireText(values['--url'], '--url', 300));
    const agent = new BrowserAgent(resolve(values['--data-dir'] || defaultOptions().dataDir), origin, roomId);
    if (command === 'browser-run') { await runBridge(agent); return; }
    if (command === 'browser-listen') {
      const seconds = Number(values['--wait-seconds'] || 30);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Use --wait-seconds between 1 and 60.');
      return listenBrowser(agent, values['--after'], seconds);
    }
    if (command === 'browser-send') {
      if (!isUuid(values['--request-id'])) throw new Error('Use --request-id with a UUID and retain it for uncertain retries.');
      return sendBrowser(agent, requireText(values['--text'], '--text', 4000), values['--reply-to'], values['--request-id']);
    }
    throw new Error(`Unknown command ${command}. Run help.`);
  }
  const agentCommands = ['read', 'send', 'listen', 'tasks', 'task-add', 'task-update', 'attachment'];
  const shareCommands = ['share', 'share-stop', 'share-status'];
  if (attach.length && command !== 'send') throw new Error('Use --attach only with send.');
  if (!['status', 'ensure', 'open', 'start', 'transport', 'descriptor', 'pair', ...shareCommands, ...agentCommands].includes(command)) throw new Error(`Unknown command ${command}. Run help.`);
  if (shareCommands.includes(command)) {
    const options = defaultOptions();
    if (values['--data-dir']) options.dataDir = resolve(values['--data-dir']);
    if (!isUuid(values['--room'])) throw new Error('Use --room with the paired room UUID.');
    const roomId = values['--room'];
    const configDir = resolve(values['--meshguard-config'] || defaultMeshguardConfigDir());
    if (command === 'share-status') {
      const record = readShareRecord(options.dataDir, roomId);
      if (!record) return { state: 'missing', roomId, message: 'No local share record for this room.' };
      return { state: 'share-status', share: record,
        note: record.status === 'pending-enable' ? 'Rule written; restart MeshGuard before treating the URL as reachable.'
          : record.status === 'pending-disable' ? 'Owned rules removed; port may still work until MeshGuard reloads.'
            : undefined };
    }
    if (command === 'share-stop') {
      const record = readShareRecord(options.dataDir, roomId);
      if (!record) throw new Error(`No local share record for room ${roomId}.`);
      if (record.status === 'stopped') return { state: 'share-stopped', share: record, note: 'Share already stopped.' };
      if (record.ownedRules.length) removeOwnedRules(record.ownedRules);
      const stopped = markSharePendingDisable(record);
      writeShareRecord(options.dataDir, stopped);
      return { state: 'share-pending-disable', share: stopped, meshguardConfig: configDir,
        note: 'Owned MeshGuard rules removed. Restart MeshGuard before treating the port as closed.' };
    }
    const port = validatePort(values['--port']);
    assertNoConflictingShare(options.dataDir, roomId);
    const { meshIp } = await resolveMeshAttachment(values['--mesh-ip']);
    const peerKey = await resolvePairedPeerKey(options.dataDir, roomId, values['--peer-key']);
    const peerStem = peerPolicyStem(peerKey, values['--peer-alias']);
    const broader = findBroaderAllows(configDir, port, peerStem);
    if (broader.length) {
      throw new Error(`Refusing to share: broader MeshGuard allows would admit unpaired peers to TCP ${port}. ${broader.map(item => item.detail).join(' ')}`);
    }
    const owned = appendOwnedAllow(configDir, peerStem, port);
    const share = createShareRecord({
      roomId, port, peerKey, meshIp, minutes: values['--minutes'] === undefined ? undefined : Number(values['--minutes']),
      ownedRules: [owned],
    });
    writeShareRecord(options.dataDir, share);
    return {
      state: 'share-pending-enable', share, meshguardConfig: configDir, peerPolicy: owned.path,
      note: 'Peer allow written with an ownership marker. Restart MeshGuard to load the policy before the mesh URL is reachable. Prefer vite preview / a static build bound to the mesh IP only.',
    };
  }
  if (agentCommands.includes(command)) {
    const credential = readCredential(resolve(requireText(values['--credential'], '--credential', 4096)));
    const runtime = await probeRuntime(credential.dataDir);
    if (!runtime || runtime.nodeId !== credential.nodeId) throw new Error('This agent credential has no matching running node. Ask the Meshrooms skill to reopen the existing node.');
    if (command === 'listen') return listen(runtime, credential, values['--after'], boardCursor(values['--board-after']), Number(values['--wait-seconds'] || 30));
    if (command === 'read') return api(runtime, credential.token, 'snapshot');
    if (command === 'attachment') {
      if (!isUuid(values['--id'])) throw new Error('Use --id with an attachment ID from a message.');
      return download(runtime, credential, values['--id'], values['--out']);
    }
    if (command === 'tasks') {
      const snapshot = await api(runtime, credential.token, 'snapshot') as NodeSnapshot; const room = snapshot.rooms.find(r => r.id === credential.intentId);
      if (!room) throw new Error('The agent is no longer admitted to this room.');
      return { roomId: room.id, participantId: snapshot.localParticipantId, floor: room.floor, boardCursor: room.boardRevision, tasks: room.tasks,
        participants: room.participants.map(({ id, name, role, state, operatorId, machine, wake }) => ({ id, name, role, state, operatorId, machine, wake })) };
    }
    const id = values['--request-id']; if (!isUuid(id)) throw new Error('Use --request-id with a UUID and retain it for uncertain retries.');
    if (command === 'send') {
      if (attach.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`Attach up to ${MAX_MESSAGE_ATTACHMENTS} files per message.`);
      const text = attach.length && values['--text'] === undefined ? '' : requireText(values['--text'], '--text', 4000);
      if (values['--reply-to'] !== undefined && !isUuid(values['--reply-to'])) throw new Error('Use --reply-to with a message ID from this room.');
      const attachments: string[] = [];
      for (const [index, file] of attach.entries()) attachments.push((await upload(runtime, credential, file, derivedRequestId(id, index))).id);
      return api(runtime, credential.token, 'messages', { roomId: credential.intentId, requestId: id, text, replyTo: values['--reply-to'],
        ...(attachments.length ? { attachments } : {}) });
    }
    const assignee = async () => {
      const value = values['--assignee']; if (value === undefined) return undefined; if (value === 'none') return null;
      if (value === 'me') return (await api(runtime, credential.token, 'snapshot') as NodeSnapshot).localParticipantId;
      if (!isUuid(value)) throw new Error('Use --assignee me, none, or a participant ID from the tasks command.'); return value;
    };
    const notes = values['--notes'] === undefined ? undefined : values['--notes'].trim();
    if (command === 'task-add') return api(runtime, credential.token, 'tasks', { roomId: credential.intentId, requestId: id,
      title: requireText(values['--title'], '--title', 120), notes, assigneeId: await assignee() });
    if (!isUuid(values['--task'])) throw new Error('Use --task with a task ID from the tasks command.');
    const revision = Number(values['--revision']); if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Use --revision with the task revision you last read.');
    return api(runtime, credential.token, 'tasks/update', { roomId: credential.intentId, requestId: id, taskId: values['--task'], revision,
      title: values['--title'] === undefined ? undefined : requireText(values['--title'], '--title', 120), notes, status: values['--status'], assigneeId: await assignee() });
  }
  const options = defaultOptions();
  if (values['--data-dir']) options.dataDir = resolve(values['--data-dir']);
  if (values['--library']) options.libraryPath = resolve(values['--library']);
  if (values['--port'] !== undefined) options.port = Number(values['--port']);
  if (values['--dev-origin']) options.devOrigin = values['--dev-origin'];
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Use a valid port.');
  if (command === 'status') return { state: 'status', runtime: await probeRuntime(options.dataDir) };
  if (['transport', 'descriptor', 'pair'].includes(command)) {
    const runtime = await probeRuntime(options.dataDir);
    if (!runtime) throw new Error('Start the intended local node before inspecting or pairing it.');
    const token = await ownerToken(options.dataDir, runtime);
    if (command === 'transport') return api(runtime, token, 'transport');
    if (command === 'descriptor') {
      if (!isUuid(values['--room'])) throw new Error('Use --room with the accepted room UUID.');
      return api(runtime, token, `rooms/descriptor?roomId=${values['--room']}`);
    }
    const file = resolve(requireText(values['--descriptor'], '--descriptor', 4096));
    const descriptor = JSON.parse(readFileSync(file, 'utf8'));
    return api(runtime, token, 'rooms/pair', descriptor);
  }
  // Validate intent fields before starting a process or preparing private files.
  const title = command === 'start' ? requireText(values['--title'], '--title', 64) : '';
  const agentName = command === 'start' ? requireText(values['--agent'], '--agent', 64) : '';
  const project = values['--project']?.trim() || ''; if (project.length > 48) throw new Error('--project must be at most 48 characters.');
  if (values['--request-id'] !== undefined && !isUuid(values['--request-id'])) throw new Error('--request-id must be a UUID.');
  const runtime = await ensureRunning(options);
  if (command === 'ensure') return runtime;
  const token = await ownerToken(options.dataDir, runtime);
  let intentId: string | undefined; let credentialFile: string | undefined; let state = 'ready';
  if (command === 'start') {
    const directory = join(options.dataDir, 'clients'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = values['--request-id']?.toLowerCase() || fingerprint({ title, project, agentName, workspace: realpathSync(process.cwd()) });
    credentialFile = join(directory, `${key}.json`);
    const credential = createCredential(credentialFile, { version: 1, nodeId: runtime.nodeId, dataDir: realpathSync(options.dataDir),
      intentId: values['--request-id']?.toLowerCase() || randomUUID(), token: randomBytes(32).toString('base64url'), title, project, agentName });
    if (credential.nodeId !== runtime.nodeId || credential.title !== title || credential.project !== project || credential.agentName !== agentName) throw new Error('This request ID already describes different room details. Reuse its original details or choose a new request ID.');
    const pending = await api(runtime, token, 'control/prepare', { requestId: credential.intentId, title, project, agentName, credentialHash: tokenHash(credential.token) });
    intentId = pending.id;
    const setup = await api(runtime, token, `setup?intent=${intentId}`);
    state = !setup.completed ? 'needs-onboarding' : pending.status === 'pending' ? 'needs-room-review' : 'ready';
  }
  const { ticket } = await api(runtime, token, 'control/browser', {});
  const url = new URL(runtime.url); if (intentId) url.searchParams.set('setup', intentId); url.hash = `access=${ticket}`;
  return { state, url: url.href, nodeId: runtime.nodeId, intentId, credentialFile };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runCli(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Connection, Message, NodeSnapshot, Participant } from '../room';
import { createRoomTransport } from '../transport';
import type { Floor, Task } from '../collab';
import type { AgentWake, TaskDraft } from '../room';
import { FloorControl, MAX_MESSAGE_FILES, MAX_UPLOAD_BYTES, MentionText, MessageAttachments, PendingFiles, TaskBoard, floorNote, formatBytes, uploadName, useAutoGrow, useMentions, useStickToBottom, type PendingFile } from './Collaboration';

type IconName = 'arrow' | 'plus' | 'close' | 'file' | 'reply' | 'link' | 'room' | 'check' | 'chevron' | 'settings' | 'tasks' | 'at' | 'clip';
const paths: Record<IconName, ReactNode> = {
  arrow: <path d="M4 12h15M13 5l7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  file: <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6" />,
  reply: <path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7" />,
  link: <path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0M14 9l2-2a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-5 0" />,
  room: <path d="M4 5h16v12H9l-5 4zM8 9h8M8 13h5" />,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  settings: <><path d="M4 7h5m4 0h7M4 17h9m4 0h3" /><circle cx="11" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
  tasks: <path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h6" />,
  clip: <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14.5 7" />,
  at: <><circle cx="12" cy="12" r="3.5" /><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7" /></>,
};
function Icon({ name }: { name: IconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Wordmark({ demo }: { demo: boolean }) {
  return <div className="wordmark"><svg viewBox="0 0 28 28" width="28" height="28" fill="none" aria-hidden="true"><path d="M5 8h8v8H5zM15 12h8v8h-8zM9 4h10v8M9 16v8h10v-4" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>meshrooms<span className="proto-label">{demo ? 'demo' : 'local'}</span></div>;
}
function Avatar({ name, agent = false }: { name: string; agent?: boolean }) {
  return <span className={`avatar ${agent ? 'agent' : ''}`} aria-hidden="true">{agent ? <svg width="19" height="19" viewBox="0 0 20 20" fill="none"><path d="M6 4 2 10l4 6m8-12 4 6-4 6M11 3 9 17" stroke="currentColor" strokeWidth="1.7" /></svg> : name.slice(0, 1)}</span>;
}
/** "Igor (Mac)" style label so people with the same name on different machines stay distinguishable. */
function operatorLabel(participants: Participant[], operatorId: string | undefined, viewerId?: string) {
  const operator = participants.find(p => p.id === operatorId);
  if (!operator) return undefined;
  return operator.id === viewerId ? 'you' : `${operator.name}${operator.machine ? ` (${operator.machine})` : ''}`;
}
function Participants({ participants, connection, demo, floor, viewerId, onWake }: { participants: Participant[]; connection: Connection; demo: boolean; floor?: Floor; viewerId?: string; onWake?: (agentId: string, wake: AgentWake) => void }) {
  return <section className="participants" aria-labelledby="participants-title"><div className="section-label"><h2 id="participants-title">In this room</h2><span>{participants.length}</span></div><ul>{participants.map(p => {
    const stale = p.state === 'local' && connection !== 'local';
    const absentAgent = p.role === 'agent' && p.state === 'local' && p.connected !== true;
    const presenceLabel = p.state === 'local' ? stale ? 'Local node state unknown' : p.role === 'agent' ? p.connected ? 'Agent connected' : p.detail : 'Local node room member' : p.state === 'remote' ? 'Remote member; presence not tracked' : p.state === 'example-offline' ? 'Example: offline' : 'Example: idle';
    return <li key={p.id}><Avatar name={p.name} agent={p.role === 'agent'} /><div className="participant-copy"><div className="participant-name">{p.name}<span className="role-label">{p.role}</span></div><span className="participant-detail">{stale ? 'Last seen · node offline' : p.detail}{p.machine ? ` · ${p.machine}` : ''}</span>{p.role === 'agent' && <span className="participant-detail operator-detail">{operatorLabel(participants, p.operatorId, viewerId) ? `Operated by ${operatorLabel(participants, p.operatorId, viewerId)}` : 'Operator not shared by its machine'}</span>}{p.role === 'agent' && floor && <span className="participant-detail floor-detail">{p.wake === 'operator' ? `Wakes only for ${operatorLabel(participants, p.operatorId, viewerId) ?? 'its operator'}` : floor === 'open' ? 'Open floor · may reply to any message' : p.connected ? 'Listening · replies when addressed' : 'Replies only when addressed'}</span>}{p.role === 'agent' && onWake && p.operatorId === viewerId && p.wake && <span className="wake-control" role="group" aria-label={`Who can wake ${p.name}`}><span>Wakes for</span><button aria-pressed={p.wake === 'anyone'} onClick={() => p.wake !== 'anyone' && onWake(p.id, 'anyone')}>Anyone</button><button aria-pressed={p.wake === 'operator'} onClick={() => p.wake !== 'operator' && onWake(p.id, 'operator')}>Only me</button></span>}</div><span className={`presence ${stale || absentAgent ? 'example-offline' : p.state}`} aria-label={presenceLabel} /></li>;
  })}</ul><p className="roster-note">{demo && <>Example members are labeled.<br /></>}Browser tabs are views of this node.</p></section>;
}

type RoomView = {
  draft: string; replyId?: string; sharing: boolean; shareTitle: string; shareText: string;
  preview: boolean; sending: boolean; error: string; notice: string; files: PendingFile[];
};
const emptyView = (): RoomView => ({ draft: '', sharing: false, shareTitle: '', shareText: '', preview: false, sending: false, error: '', notice: '', files: [] });
const initialRoom = () => new URLSearchParams(location.search).get('room') || '';

export function RoomPrototype({ onSettings, selectedRoomId, connectionRevision = 0 }: { onSettings?: () => void; selectedRoomId?: string; connectionRevision?: number }) {
  const [roomId, setRoomId] = useState(initialRoom);
  const [node, setNode] = useState<NodeSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [views, setViews] = useState<Record<string, RoomView>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [mobileRoomsOpen, setMobileRoomsOpen] = useState(false);
  const [roomForm, setRoomForm] = useState<'create' | 'join' | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newProject, setNewProject] = useState('');
  const [joinValue, setJoinValue] = useState('');
  const [formError, setFormError] = useState('');
  const [roomActionPending, setRoomActionPending] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const demoRequested = useRef(new URLSearchParams(location.search).get('demo') === '1');
  const explicitRoomRequested = useRef(new URLSearchParams(location.search).has('room'));
  const [transport] = useState(() => createRoomTransport(demoRequested.current));
  const activeId = useRef(roomId);
  const counts = useRef<Record<string, number>>({});
  const knownNodeId = useRef('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const shareInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const roomNameInput = useRef<HTMLInputElement>(null);
  const stick = useStickToBottom();
  const previousVisible = useRef({ roomId, count: 0 });
  const activeRoom = node?.rooms.find(room => room.id === roomId);
  const availableRoom = node?.availableRooms.find(room => room.id === roomId);
  const demo = node ? node.backend === 'demo' : demoRequested.current;
  const durable = node?.storage === 'wormdb';
  const localService = demo ? 'Local demo node' : 'Local daemon';
  const memoryLabel = durable ? 'Saved locally' : node || demo ? 'Local memory' : 'Local storage';
  const storageNote = !node && !demo ? 'Connecting to local storage.' : durable ? activeRoom?.paired ? 'New messages and their attachments are queued for this room’s paired machine. Saved locally is not a remote receipt.' : 'Rooms and messages persist in WormDB. This room is local to this machine.' : 'Memory only; resets on restart. MeshGuard and WormDB are not connected.';
  const roomTitle = activeRoom?.title || availableRoom?.title || (node ? roomId ? 'Room unavailable' : 'Your rooms' : 'Opening rooms…');
  const state = views[roomId] || emptyView();
  const messages = activeRoom?.messages || [];
  const reply = messages.find(message => message.id === state.replyId);
  const groups = [...new Set(node?.rooms.map(room => room.project) || [])];
  const participants = activeRoom?.participants || [];
  const hasAgents = participants.some(p => p.role === 'agent');
  const boardAvailable = !!activeRoom?.tasks;
  const showBoard = boardOpen && boardAvailable;
  const openTasks = activeRoom?.tasks?.filter(t => t.status !== 'done').length || 0;
  const canAttach = !demo && !!activeRoom;
  const uploading = state.files.some(f => f.status === 'uploading');
  const readyFiles = state.files.filter(f => f.status === 'ready');
  const mentions = useMentions(participants, node?.localParticipantId, composer, text => updateView(roomId, { draft: text }));
  useAutoGrow(composer, state.draft);

  function updateView(id: string, update: Partial<RoomView> | ((current: RoomView) => RoomView)) {
    setViews(all => {
      const current = all[id] || emptyView();
      return { ...all, [id]: typeof update === 'function' ? update(current) : { ...current, ...update } };
    });
  }
  function selectRoom(id: string) {
    activeId.current = id; setRoomId(id); setUnread(current => ({ ...current, [id]: 0 }));
    setMobileRoomsOpen(false); setRoomForm(null); setFormError('');
    const url = new URL(location.href); url.searchParams.set('room', id); url.searchParams.delete('variant'); history.replaceState(null, '', url);
    if (matchMedia('(max-width: 760px)').matches) requestAnimationFrame(() => heading.current?.focus());
  }
  useEffect(() => { if (selectedRoomId && selectedRoomId !== activeId.current) selectRoom(selectedRoomId); }, [selectedRoomId]);
  useEffect(() => {
    const url = new URL(location.href); url.searchParams.delete('variant'); history.replaceState(null, '', url);
    return transport.connect(next => {
      if (!activeId.current && !explicitRoomRequested.current && next.rooms.length) selectRoom(next.rooms[0].id);
      const changedNode = knownNodeId.current !== next.nodeId;
      const increments: Record<string, number> = {};
      for (const room of next.rooms) {
        const previous = counts.current[room.id];
        if (!changedNode && previous !== undefined && room.id !== activeId.current && room.messages.length > previous) increments[room.id] = room.messages.length - previous;
      }
      counts.current = Object.fromEntries(next.rooms.map(room => [room.id, room.messages.length]));
      knownNodeId.current = next.nodeId;
      setUnread(current => changedNode ? {} : Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(increments)])].map(id => [id, id === activeId.current ? 0 : (current[id] || 0) + (increments[id] || 0)])));
      setNode(next);
    }, setConnection);
  }, [connectionRevision]);
  useEffect(() => {
    if (previousVisible.current.roomId !== roomId) stick.toBottom();
    else if (messages.length > previousVisible.current.count) stick.arrived(messages.at(-1)?.authorId === node?.localParticipantId);
    previousVisible.current = { roomId, count: messages.length };
  }, [roomId, messages.length]);
  useEffect(() => { if (state.sharing && !state.preview) shareInput.current?.focus({ preventScroll: true }); }, [roomId, state.sharing]);
  useEffect(() => { if (roomForm) roomNameInput.current?.focus(); }, [roomForm]);
  useEffect(() => {
    if (!state.notice) return;
    const id = roomId; const timer = setTimeout(() => updateView(id, { notice: '' }), 4500);
    return () => clearTimeout(timer);
  }, [roomId, state.notice]);

  /** Uploads start as soon as a file is added, so sending only references stored attachments. */
  function upload(origin: string, item: PendingFile) {
    const patch = (change: Partial<PendingFile>) => updateView(origin, current => ({ ...current, files: current.files.map(f => f.key === item.key ? { ...f, ...change } : f) }));
    patch({ status: 'uploading', error: undefined });
    transport.upload(origin, item.file, item.name, item.key)
      .then(attachment => patch({ status: 'ready', attachment }))
      .catch(error => patch({ status: 'failed', error: (error as Error).message }));
  }
  function addFiles(list: FileList | File[] | null | undefined) {
    const files = [...(list || [])]; if (!files.length || !activeRoom) return;
    const origin = roomId;
    if (!canAttach) { updateView(origin, { error: 'The demo node does not store attachments.' }); return; }
    const room = views[origin] || emptyView(); const space = MAX_MESSAGE_FILES - room.files.length;
    const accepted = files.filter(f => f.size > 0 && f.size <= MAX_UPLOAD_BYTES).slice(0, Math.max(0, space));
    const rejected = files.length - accepted.length;
    const items: PendingFile[] = accepted.map(file => ({ key: crypto.randomUUID(), file, name: uploadName(file), status: 'uploading',
      preview: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined }));
    updateView(origin, current => ({ ...current, files: [...current.files, ...items],
      error: rejected ? `Attach up to ${MAX_MESSAGE_FILES} files of ${formatBytes(MAX_UPLOAD_BYTES)} or less per message.` : current.error }));
    items.forEach(item => upload(origin, item));
  }
  function removeFile(key: string) {
    updateView(roomId, current => {
      const item = current.files.find(f => f.key === key); if (item?.preview) URL.revokeObjectURL(item.preview);
      return { ...current, files: current.files.filter(f => f.key !== key) };
    });
  }
  function retryFile(key: string) { const item = state.files.find(f => f.key === key); if (item) upload(roomId, item); }

  async function send(isShare = false) {
    if (!activeRoom || state.sending || connection !== 'local' || (!isShare && (uploading || state.files.some(f => f.status === 'failed') || (!state.draft.trim() && !readyFiles.length)))) return;
    const origin = roomId;
    const submitted = { ...state };
    const attachments = isShare ? [] : readyFiles.map(f => f.attachment!.id);
    updateView(origin, { sending: true, error: '', notice: '' });
    try {
      await transport.send(origin, { text: isShare ? '' : submitted.draft.trim(), replyTo: submitted.replyId, share: isShare ? { title: submitted.shareTitle.trim(), text: submitted.shareText } : undefined, attachments });
      const sentKeys = new Set(isShare ? [] : readyFiles.map(f => f.key));
      submitted.files.filter(f => sentKeys.has(f.key) && f.preview).forEach(f => URL.revokeObjectURL(f.preview!));
      // The response belongs to its originating room, even after a view switch.
      updateView(origin, current => ({
        ...current, sending: false, notice: durable ? 'Saved locally in this room.' : 'Added to this room’s local memory.',
        draft: !isShare && current.draft === submitted.draft ? '' : current.draft,
        files: current.files.filter(f => !sentKeys.has(f.key)),
        replyId: current.replyId === submitted.replyId ? undefined : current.replyId,
        ...(isShare && current.shareTitle === submitted.shareTitle && current.shareText === submitted.shareText ? { sharing: false, preview: false, shareTitle: '', shareText: '' } : {}),
      }));
      if (activeId.current === origin) composer.current?.focus({ preventScroll: true });
    } catch (error) { updateView(origin, { sending: false, error: (error as Error).message }); }
  }
  async function copyInvite() {
    const origin = roomId;
    const url = new URL('/prototype/room', location.origin); url.searchParams.set('room', origin);
    if (demoRequested.current) url.searchParams.set('demo', '1');
    try { await navigator.clipboard.writeText(url.href); updateView(origin, { notice: 'Same-machine room link copied. It opens this node on this computer.' }); }
    catch { setJoinValue(url.href); setRoomForm('join'); setFormError('Select and copy this local link.'); }
  }
  /** Room-scoped commands report errors in their originating room, even after a view switch. */
  async function roomCommand(origin: string, action: () => Promise<void>, notice: string) {
    try { await action(); updateView(origin, { error: '', notice }); }
    catch (error) { updateView(origin, { error: (error as Error).message }); throw error; }
  }
  const boardActions = {
    create: (task: TaskDraft & { title: string }) => { const origin = roomId; return roomCommand(origin, () => transport.createTask(origin, task), 'Task added to this room’s board.'); },
    update: (task: Task, changes: TaskDraft) => { const origin = roomId; return roomCommand(origin, () => transport.updateTask(origin, task.id, task.revision, changes), 'Task updated.'); },
    remove: (task: Task) => { const origin = roomId; return roomCommand(origin, () => transport.removeTask(origin, task.id, task.revision), 'Task removed.'); },
  };
  function changeWake(agentId: string, wake: AgentWake) {
    const origin = roomId; const agent = participants.find(p => p.id === agentId)?.name || 'This agent';
    void roomCommand(origin, () => transport.setAgentWake(origin, agentId, wake), wake === 'operator' ? `${agent} now wakes only for you.` : `${agent} can be woken by anyone.`).catch(() => {});
  }
  function changeFloor(floor: Floor) {
    const origin = roomId;
    void roomCommand(origin, () => transport.setFloor(origin, floor), floor === 'humans-first' ? 'Agents now reply only when addressed.' : 'Agents may now reply to every message.').catch(() => {});
  }
  function openRoomForm(mode: 'create' | 'join') { setRoomForm(mode); setFormError(''); setMobileRoomsOpen(false); }
  async function joinKnown(id: string) {
    setRoomActionPending(true); setFormError('');
    try {
      if (!demo && node?.rooms.some(room => room.id === id)) selectRoom(id);
      else if (!demo) setFormError('This room is not on this local daemon. Remote invitations are not connected.');
      else selectRoom(await transport.joinRoom(id));
    }
    catch (error) { setFormError((error as Error).message); }
    finally { setRoomActionPending(false); }
  }
  async function submitRoom(event: React.FormEvent) {
    event.preventDefault();
    if (roomForm === 'join') {
      let id = joinValue.trim();
      if (id.startsWith('http')) {
        try { const invite = new URL(id); if (invite.origin !== location.origin || (invite.searchParams.get('demo') === '1') !== demoRequested.current) throw new Error(); id = invite.searchParams.get('room') || ''; }
        catch { setFormError('Use a room ID or a link from this same local node.'); return; }
      }
      await joinKnown(id); return;
    }
    setRoomActionPending(true); setFormError('');
    try { selectRoom(await transport.createRoom({ title: newTitle, project: newProject })); setNewTitle(''); setNewProject(''); }
    catch (error) { setFormError((error as Error).message); }
    finally { setRoomActionPending(false); }
  }

  return <>
    <a className="skip-link" href="#message">Skip to message composer</a>
    <div className={`room-layout ${showBoard ? 'with-board' : ''}`}>
      <aside className="room-rail">
        <div className="rail-heading"><Wordmark demo={demo} /><button className="mobile-rooms-button" aria-expanded={mobileRoomsOpen} aria-controls="room-navigation" onClick={() => setMobileRoomsOpen(!mobileRoomsOpen)}>Rooms<Icon name="chevron" /></button></div>
        <div className="rail-scroll">
          <nav id="room-navigation" className={`room-nav ${mobileRoomsOpen ? 'is-open' : ''}`} aria-label="Rooms">
            <div className="nav-heading"><h2>Your rooms</h2><button className="icon-button" aria-label="Add a room" onClick={() => openRoomForm('create')}><Icon name="plus" /></button></div>
            {groups.map(project => <section className="project-group" key={project}><h3>{project || 'Other rooms'}</h3>{node?.rooms.filter(room => room.project === project).map(room => {
              const draft = views[room.id]; const hasDraft = !!(draft?.draft || draft?.shareText || draft?.replyId || draft?.files.length);
              return <button key={room.id} className={`room-link ${room.id === roomId ? 'active' : ''}`} aria-current={room.id === roomId ? 'page' : undefined} onClick={() => selectRoom(room.id)}><Icon name="room" /><span className="room-link-copy"><span>{room.title}</span><small>{hasDraft ? 'Draft saved in this view' : room.sample ? 'Example room' : 'Joined on this node'}</small></span>{(unread[room.id] || 0) > 0 && <span className="unread" aria-label={`${unread[room.id]} unread messages`}>{unread[room.id]}</span>}</button>;
            })}</section>)}
            {!node && <p className="nav-loading">Connecting to local rooms…</p>}
            {node && !node.rooms.length && <p className="nav-loading">No rooms yet.</p>}
            <button className="join-room-link" onClick={() => openRoomForm('join')}><Icon name="link" />{demo ? 'Join a room' : 'Open room link'}</button>
            {!demo && onSettings && <button className="join-room-link settings-link" onClick={onSettings}><Icon name="settings" />Settings</button>}
          </nav>
          {activeRoom && <Participants participants={activeRoom.participants} connection={connection} demo={demo} floor={hasAgents ? activeRoom.floor : undefined} viewerId={node?.localParticipantId} onWake={connection === 'local' ? changeWake : undefined} />}
        </div>
        <div className="rail-bottom"><strong>{demo ? 'One local demo node' : 'One local daemon'}</strong><span>Rooms stay joined while you switch views.</span></div>
      </aside>
      <main className="main-room">
        <header className="room-header"><div className="room-heading"><span className="room-symbol"><Icon name="room" /></span><div><h1 ref={heading} tabIndex={-1}>{roomTitle}</h1><div className="room-subtitle">{activeRoom || availableRoom ? `${(activeRoom || availableRoom)?.project || 'Other rooms'} · ${activeRoom?.sample || availableRoom?.sample ? 'Example room' : 'Joined on this node'}` : 'Rooms on your local node'}</div></div></div><div className="room-actions"><span className={`connection-label ${connection}`}><span className={`presence ${connection === 'local' ? 'local' : 'example-offline'}`} />{connection === 'local' ? localService : connection === 'connecting' ? 'Connecting locally' : `${localService} offline`}</span>{boardAvailable && <button className="secondary tasks-button" aria-expanded={showBoard} aria-controls="task-board" onClick={() => setBoardOpen(!boardOpen)}><Icon name="tasks" />Tasks{openTasks > 0 && <span className="task-count" aria-label={`${openTasks} open`}>{openTasks}</span>}</button>}<button className="secondary invite-button" onClick={copyInvite} disabled={!activeRoom}><Icon name="link" />{demo ? 'Invite' : 'Copy room link'}</button></div></header>
        <div className="demo-strip"><div className="demo-state-row"><span>{demo ? 'Demo' : activeRoom?.paired ? 'Paired room' : 'Local only'}</span><span className={`connection-inline ${connection}`} role="status"><span className={`presence ${connection === 'local' ? 'local' : 'example-offline'}`} />{connection === 'local' ? `${localService} connected` : connection === 'connecting' ? 'Connecting locally' : `${localService} offline · retrying`}</span></div><p>{storageNote}</p>{activeRoom?.floor && hasAgents && <FloorControl floor={activeRoom.floor} disabled={connection !== 'local'} onChange={changeFloor} />}</div>

        {roomForm && <section className="room-form" aria-labelledby="room-form-title"><div className="form-heading"><div><h2 id="room-form-title">{roomForm === 'create' ? 'Create a room' : demo ? 'Join a local room' : 'Open a local room'}</h2><p>{roomForm === 'create' ? `A separate conversation, registered on this ${demo ? 'demo node' : 'local daemon'}.` : demo ? 'Join an available example, or paste a link from this node.' : 'Open a room already registered on this daemon.'}</p></div><button className="icon-button" aria-label="Close room form" onClick={() => setRoomForm(null)}><Icon name="close" /></button></div><div className="form-tabs"><button aria-pressed={roomForm === 'create'} onClick={() => openRoomForm('create')}>Create room</button><button aria-pressed={roomForm === 'join'} onClick={() => openRoomForm('join')}>{demo ? 'Join room' : 'Open room'}</button></div>
          <form onSubmit={submitRoom}>{roomForm === 'create' ? <div className="create-fields"><label>Room name<input ref={roomNameInput} value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="e.g. API review" maxLength={64} required /></label><label>Project label <span>(optional)</span><input value={newProject} onChange={e => setNewProject(e.target.value)} placeholder="e.g. MeshGuard" maxLength={48} list="project-labels" /><datalist id="project-labels">{groups.filter(Boolean).map(project => <option key={project} value={project} />)}</datalist></label></div> : <label>Room ID or local link<input ref={roomNameInput} value={joinValue} onChange={e => setJoinValue(e.target.value)} placeholder="Paste a local room link…" maxLength={300} required /></label>}<div className="form-submit"><p>{roomForm === 'create' ? 'Project labels organize rooms; they do not grant membership.' : 'Local links open this same node. Remote invitations are not connected.'}</p><button className="primary" type="submit" disabled={connection !== 'local' || roomActionPending}>{roomActionPending ? 'Working…' : roomForm === 'create' ? 'Create and open' : demo ? 'Join and open' : 'Open room'}<Icon name="arrow" /></button></div></form>
          {demo && roomForm === 'join' && !!node?.availableRooms.length && <div className="available-rooms"><h3>Available example rooms</h3>{node.availableRooms.map(room => <button key={room.id} onClick={() => joinKnown(room.id)} disabled={roomActionPending || connection !== 'local'}><span>{room.title}<small>{room.project}</small></span><span>Join<Icon name="arrow" /></span></button>)}</div>}
          {formError && <p className="form-error" role="alert">{formError}</p>}
        </section>}

        {activeRoom && state.sharing && !roomForm && <section className="share-panel" aria-labelledby="share-heading"><div className="share-heading"><div><h2 id="share-heading">{state.preview ? 'Ready to share?' : 'Share an excerpt'}</h2><p>{state.preview ? `This excerpt will be shared with ${roomTitle}.` : 'Paste only the part you want this room to see.'}</p></div><button className="icon-button" aria-label="Cancel sharing" onClick={() => updateView(roomId, { sharing: false, preview: false })}><Icon name="close" /></button></div>{!state.preview ? <><label htmlFor="share-title">Source label</label><input ref={shareInput} id="share-title" value={state.shareTitle} onChange={e => updateView(roomId, { shareTitle: e.target.value })} placeholder="e.g. connection-notes.md" maxLength={100} /><label htmlFor="share-text">Selected excerpt</label><textarea id="share-text" value={state.shareText} onChange={e => updateView(roomId, { shareText: e.target.value })} placeholder="Paste the text to share…" maxLength={8000} rows={3} /><div className="share-controls"><span>No files or private context are read.</span><button className="primary" disabled={!state.shareTitle.trim() || !state.shareText.trim()} onClick={() => updateView(roomId, { preview: true })}>Preview share<Icon name="arrow" /></button></div></> : <><div className="share-preview"><div><Icon name="file" /><strong>{state.shareTitle.trim()}</strong><span>Excerpt</span></div><pre>{state.shareText}</pre></div><div className="share-controls"><button className="text-button" onClick={() => updateView(roomId, { preview: false })}>Edit excerpt</button><button className="primary" onClick={() => send(true)} disabled={state.sending || connection !== 'local'}>{state.sending ? 'Sharing…' : 'Share to room'}<Icon name="arrow" /></button></div></>}</section>}

        <section className={`conversation ${dragging ? 'dragging' : ''}`} aria-label="Room conversation"
          onDragEnter={e => { if (canAttach && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
          onDragOver={e => { if (canAttach && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
          {dragging && <div className="drop-overlay" aria-hidden="true"><Icon name="clip" /><strong>Drop to attach</strong><span>Screenshots and files up to {formatBytes(MAX_UPLOAD_BYTES)}</span></div>}<div className="conversation-toolbar"><span>Conversation</span><span className="memory-note">{memoryLabel}</span></div><div ref={stick.ref} onScroll={stick.onScroll} className="message-scroll" role="log" aria-label="Messages" aria-live="polite">
          {messages.length > 0 && <div className="date-rule"><span>Room history · {durable ? 'saved locally' : 'memory only'}</span></div>}
          {!node && <div className="empty-state"><h2>{connection === 'disconnected' ? `${localService} unavailable` : 'Opening the local node…'}</h2><p>{connection === 'disconnected' ? 'This view will reconnect when the local node returns.' : 'Loading the rooms registered on this node.'}</p></div>}
          {node && !activeRoom && <div className="empty-state"><Icon name="room" /><h2>{demo && availableRoom ? 'This room is ready to join' : !roomId && !node.rooms.length ? 'Create your first room' : 'This room is not on the local node'}</h2><p>{demo && availableRoom ? 'Join it once on the node, then return whenever you need it.' : !roomId && !node.rooms.length ? 'Give the conversation a name. You can organize rooms with project labels.' : 'Choose a room from the list or create a new one. Remote invitations are not connected.'}</p><button className="primary" onClick={() => demo && availableRoom ? joinKnown(availableRoom.id) : openRoomForm('create')} disabled={connection !== 'local' || roomActionPending}>{demo && availableRoom ? 'Join this room' : 'Create a room'}</button>{formError && <p className="form-error" role="alert">{formError}</p>}</div>}
          {activeRoom && messages.length === 0 && <div className="empty-state"><Icon name="room" /><h2>Start the conversation</h2><p>This room has its own history and membership. Send a message or share a selected excerpt.</p></div>}
          {messages.map(message => {
            const target = messages.find(m => m.id === message.replyTo); const own = message.authorId === node?.localParticipantId;
            const mentionsYou = !own && (!!node && message.mentions?.includes(node.localParticipantId) || target?.authorId === node?.localParticipantId && message.role === 'agent');
            return <article className={`message ${mentionsYou ? 'mentions-you' : ''}`} key={message.id}><Avatar name={own ? 'You' : message.author} agent={message.role === 'agent'} /><div className="message-main"><div className="message-meta"><strong>{own ? 'You' : message.author}</strong><span className="role-label">{message.role}</span>{message.role === 'agent' && (() => { const author = participants.find(p => p.id === message.authorId); const label = operatorLabel(participants, author?.operatorId, node?.localParticipantId); return label ? <span className="operator-label">for {label}</span> : null; })()}<time dateTime={message.time}>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span className="message-state">{message.sample ? 'Example' : durable ? 'Saved locally' : 'In local memory'}</span><button className="reply-button" aria-label={`Reply to ${own ? 'your' : message.author + '’s'} message`} title="Reply" onClick={() => { updateView(roomId, { replyId: message.id }); composer.current?.focus(); }}><Icon name="reply" /></button></div>{target && <div className="reply-reference"><Icon name="reply" /><span>{target.author}: {target.text || target.share?.title || target.attachments?.map(a => a.name).join(', ')}</span></div>}{message.text && <div className="message-text"><MentionText text={message.text} participants={participants} viewerId={node?.localParticipantId} /></div>}{message.attachments?.length ? <MessageAttachments roomId={activeRoom!.id} attachments={message.attachments} author={own ? 'You' : message.author} /> : null}{message.share && <div className="shared-excerpt"><div className="excerpt-title"><Icon name="file" /><strong>{message.share.title}</strong><span>Shared excerpt</span></div><pre>{message.share.text}</pre></div>}</div></article>;
          })}
        </div>
        {activeRoom && <div className="composer-area">{stick.unread > 0 && <button className="secondary jump-latest" onClick={stick.toBottom}>{stick.unread === 1 ? 'New message' : `${stick.unread} new messages`} <span aria-hidden="true">↓</span></button>}{reply && <div className="reply-draft"><Icon name="reply" /><span>Replying to <strong>{reply.authorId === node?.localParticipantId ? 'your message' : reply.author}</strong></span><button className="icon-button" aria-label="Cancel reply" onClick={() => updateView(roomId, { replyId: undefined })}><Icon name="close" /></button></div>}{mentions.list}<form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><label className="sr-only" htmlFor="message">Message {roomTitle}</label><textarea ref={composer} id="message" value={state.draft} {...mentions.inputProps} onChange={e => { updateView(roomId, { draft: e.target.value }); mentions.track(e.target.value, e.target.selectionStart); }} onSelect={e => mentions.track(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={mentions.close} onPaste={e => { const pasted = [...e.clipboardData.files]; if (pasted.length) { e.preventDefault(); addFiles(pasted); } }} placeholder={hasAgents && activeRoom?.floor === 'humans-first' ? `Message ${roomTitle}… type @ to ask an agent` : `Message ${roomTitle}…`} maxLength={4000} rows={2} onKeyDown={e => { if (mentions.onKeyDown(e)) return; if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} /><PendingFiles files={state.files} onRemove={removeFile} onRetry={retryFile} /><div className="composer-tools"><div className="composer-left">{canAttach && <><input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} /><button type="button" className="share-button" aria-label="Attach screenshots or files" title="Attach screenshots or files (you can also paste or drop them)" onClick={() => fileInput.current?.click()}><Icon name="clip" /><span className="tool-label">Attach</span></button></>}{participants.length > 1 && <button type="button" className="share-button" aria-label="Mention someone" title="Mention someone" onClick={mentions.start}><Icon name="at" /><span className="tool-label">Mention</span></button>}<button type="button" className="share-button" aria-label="Share excerpt" title="Share excerpt" onClick={() => updateView(roomId, { sharing: true, error: '' })}><Icon name="plus" /><span className="tool-label">Share excerpt</span></button></div><div><span className="keyboard-hint">Ctrl + Enter</span><button className="primary send-button" type="submit" disabled={(!state.draft.trim() && !readyFiles.length) || uploading || state.files.some(f => f.status === 'failed') || state.sending || connection !== 'local'}>{state.sending ? 'Sending…' : uploading ? 'Uploading…' : 'Send'}<Icon name="arrow" /></button></div></div></form><p className="composer-note">{floorNote(activeRoom.floor, hasAgents)}</p></div>}
        </section>
      </main>
      {showBoard && activeRoom && <TaskBoard room={activeRoom} viewerId={node?.localParticipantId} disabled={connection !== 'local'} onClose={() => setBoardOpen(false)} actions={boardActions} />}
    </div>
    <div className="feedback" aria-live="polite">{state.notice && <p><Icon name="check" />{state.notice}</p>}{state.error && <p className="error" role="alert">{state.error}<button aria-label="Dismiss error" onClick={() => updateView(roomId, { error: '' })}><Icon name="close" /></button></p>}</div>
  </>;
}

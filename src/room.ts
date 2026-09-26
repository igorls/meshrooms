import type { Floor, Task } from './collab';

export type Role = 'human' | 'agent';
export type Share = { title: string; text: string };
/** Uploaded file metadata. `type` is sniffed from the bytes; only `image` kinds render inline. */
export type Attachment = { id: string; name: string; type: string; kind: 'image' | 'file'; size: number; width?: number; height?: number };
export type Participant = {
  id: string;
  name: string;
  role: Role;
  state: 'local' | 'remote' | 'example-idle' | 'example-offline';
  peerKey?: string;
  detail: string;
  connected?: boolean;
  /** For agents: the human who admitted this agent and answers for it. Granted by its node, never set by the agent. */
  operatorId?: string;
  /** The machine (node) this participant runs on, as named by its owner. */
  machine?: string;
  /** For agents: who can wake it. `operator` means only its operator's messages and assignments. */
  wake?: AgentWake;
};
export type AgentWake = 'anyone' | 'operator';
export type Message = {
  id: string;
  authorId: string;
  author: string;
  role: Role;
  text: string;
  time: string;
  sample?: boolean;
  replyTo?: string;
  share?: Share;
  attachments?: Attachment[];
  /** Participant IDs addressed with @Name, derived from the text by the node. */
  mentions?: string[];
};
export type RoomInfo = { id: string; title: string; project: string; sample: boolean };
export type RoomSnapshot = RoomInfo & {
  messages: Message[]; participants: Participant[]; paired?: boolean;
  /** Absent on backends without agent floor control or a task board (the demo node). */
  floor?: Floor; tasks?: Task[]; boardRevision?: number;
};
export type TaskDraft = { title?: string; notes?: string; status?: Task['status']; assigneeId?: string | null; issue?: string | null };
export type NodeSnapshot = {
  backend: 'demo' | 'local';
  storage: 'memory' | 'wormdb';
  nodeId: string;
  localParticipantId: string;
  rooms: RoomSnapshot[];
  availableRooms: RoomInfo[];
};
export type Draft = { text: string; replyTo?: string; share?: Share; attachments?: string[] };
export type Connection = 'connecting' | 'local' | 'disconnected';

/** One browser view subscribes to the node; selecting a room changes no membership. */
export interface RoomTransport {
  connect(onSnapshot: (state: NodeSnapshot) => void, onConnection: (state: Connection) => void): () => void;
  send(roomId: string, draft: Draft): Promise<void>;
  createRoom(input: { title: string; project: string }): Promise<string>;
  joinRoom(roomId: string): Promise<string>;
  setFloor(roomId: string, floor: Floor): Promise<void>;
  setAgentWake(roomId: string, agentId: string, wake: AgentWake): Promise<void>;
  /** Upload before sending; retry with the same requestId after an uncertain result. */
  upload(roomId: string, file: Blob, name: string, requestId: string): Promise<Attachment>;
  createTask(roomId: string, task: TaskDraft & { title: string }): Promise<void>;
  updateTask(roomId: string, taskId: string, revision: number, changes: TaskDraft): Promise<void>;
  removeTask(roomId: string, taskId: string, revision: number): Promise<void>;
}

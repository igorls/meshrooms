import { isHash, isUuid } from './model';
import type { Role } from '../src/room';

export type DescriptorParticipant = { id: string; name: string; role: Role; operatorId?: string };
/** `machine` and agent `operatorId` are optional so descriptors from older nodes still pair. */
export type RoomDescriptor = { version: 1; roomId: string; peerKey: string; machine?: string; participants: DescriptorParticipant[] };

/** A locally approved, fixed two-node grant. This is not an invitation token. */
export function parseDescriptor(value: any): RoomDescriptor {
  if (!value || value.version !== 1 || !isUuid(value.roomId) || !isHash(value.peerKey)
    || !Array.isArray(value.participants) || value.participants.length < 1 || value.participants.length > 16
    || new Set(value.participants.map((p: any) => p?.id)).size !== value.participants.length
    || value.participants.some((p: any) => !p || !isUuid(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 64 || !['human', 'agent'].includes(p.role))) {
    throw new Error('Invalid room pairing descriptor.');
  }
  const humans = new Set(value.participants.filter((p: any) => p.role === 'human').map((p: any) => p.id));
  // An operator must be a human granted by the same descriptor; humans have no operator.
  if (value.participants.some((p: any) => p.operatorId !== undefined && (p.role !== 'agent' || !humans.has(p.operatorId)))
    || (value.machine !== undefined && (typeof value.machine !== 'string' || !value.machine.trim() || value.machine.length > 64))) {
    throw new Error('Invalid room pairing descriptor.');
  }
  return { version: 1, roomId: value.roomId, peerKey: value.peerKey, ...(value.machine ? { machine: value.machine } : {}),
    participants: value.participants.map(({ id, name, role, operatorId }: any) => ({ id, name, role, ...(operatorId ? { operatorId } : {}) })) };
}

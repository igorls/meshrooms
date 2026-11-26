import { cleanDisplayName, foldDisplayName, type BrowserMember, type RenameNotice } from './protocol';

/** The longest agent name; the same limit as when an agent joins. */
export const MAX_AGENT_NAME = 64;

/**
 * Whether this person may rename this agent: the host may rename any agent, and a person the agent they operate. People
 * can't be renamed, and an agent can't rename itself. The room service decides again; this only decides what to offer.
 */
export function canRenameAgent(member: BrowserMember, self: BrowserMember | undefined, ownerId: string | undefined): boolean {
  if (!self || member.role !== 'agent' || (self.role ?? 'human') !== 'human') return false;
  return self.id === ownerId || member.operatorId === self.id;
}

/**
 * What is wrong with this name for this agent, in words for the person, or undefined when it is fine. These are the
 * room service's rules (cleaned like a joining name, at most 64 characters, unique by case- and width-folded name, and
 * `agents` reserved because @agents addresses every agent), so the person hears it before asking. A new name that only
 * changes case or spacing of its own is fine. `reserved` lists names the room holds for others, such as unused agent links.
 */
export function renameProblem(raw: string, member: BrowserMember, members: BrowserMember[], reserved: string[] = []): string | undefined {
  const name = cleanDisplayName(raw);
  if (!name) return 'Enter a name.';
  if (name.length > MAX_AGENT_NAME) return `Use ${MAX_AGENT_NAME} characters or fewer.`;
  if (foldDisplayName(name) === 'agents') return '“agents” is reserved: @agents addresses every agent. Choose another name.';
  if (name === member.name) return 'That is already its name.';
  const folded = foldDisplayName(name);
  if (members.some(m => m.id !== member.id && foldDisplayName(m.name) === folded) || reserved.some(r => foldDisplayName(r) === folded)) return 'Someone in this room already uses that name. Choose a different name.';
  return undefined;
}

/** The timeline line: “You renamed agent “Codex” to “Scout”.” `nameOf` gives a member's current name, or nothing once they left. */
export function renameLine(notice: RenameNotice, selfId: string | undefined, nameOf: (id: string) => string | undefined): string {
  const by = notice.by === selfId ? 'You' : nameOf(notice.by) ?? 'A former member';
  return `${by} renamed agent “${notice.from}” to “${notice.to}”`;
}

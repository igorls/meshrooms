/** How long an agent connect link lives (the room service's INVITE_TTL). */
export const AGENT_LINK_TTL = 15 * 60_000;

/**
 * Where an agent link stands, from what the room status says about it:
 * - `open`: not used yet (or the service hasn't listed it yet; status may lag the link by a poll).
 * - `used`: the room status stopped listing it as unused, but the agent isn't a member yet (a guest's agent waits for the host).
 * - `joined`: the person's agent of that name is in the room.
 * - `expired`: its time ran out unused.
 * `wasUsed` latches `used`: a used link that waits for the host longer than its lifetime is not an expired one.
 */
export type AgentLinkState = 'open' | 'used' | 'joined' | 'expired';
export function agentLinkState(input: { createdAt: number; expiresAt?: number; listed: boolean; joined: boolean; wasUsed?: boolean; now: number }): AgentLinkState {
  if (input.joined) return 'joined';
  const deadline = input.expiresAt ?? input.createdAt + AGENT_LINK_TTL;
  if (input.expiresAt === undefined && !input.listed) return input.now >= deadline ? 'expired' : 'open';
  if (input.listed) return input.now >= deadline ? 'expired' : 'open';
  return input.wasUsed || input.now < deadline ? 'used' : 'expired';
}

export type StepStatus = 'done' | 'now' | 'todo' | 'bad';
/** The three steps the dialog shows: copied, the agent opens the link, the agent joins. */
export function inviteSteps(state: AgentLinkState, copied: boolean): [StepStatus, StepStatus, StepStatus] {
  switch (state) {
    case 'open': return copied ? ['done', 'now', 'todo'] : ['now', 'todo', 'todo'];
    case 'used': return ['done', 'done', 'now'];
    case 'joined': return ['done', 'done', 'done'];
    case 'expired': return [copied ? 'done' : 'todo', 'bad', 'todo'];
  }
}

/** "14:32": the time left, never negative. */
export function formatCountdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000)), minutes = Math.floor(total / 60), seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

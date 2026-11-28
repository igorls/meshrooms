/**
 * The room as a mesh: its people as anchors and each agent beside the person who operates it. A fixed layout from the
 * roster alone (no physics), so the same room always draws the same way and nothing moves while people read it.
 */
export const MESH_WIDTH = 720;
export const MESH_HEIGHT = 440;
const MARGIN_X = 56, MARGIN_TOP = 40, MARGIN_BOTTOM = 56;
/** The least distance between two members' centres, in view-box units: an agent's face and name, or a person's. */
export const MESH_GAP_AGENTS = 62, MESH_GAP_PERSON = 80;

export type MeshMember = { id: string; role: 'human' | 'agent'; operatorId?: string };
export type MeshPoint = { x: number; y: number };
export type MeshLayout = {
  points: Map<string, MeshPoint>;
  /** Person to agent, for each agent whose operator is in the room. */
  operates: { from: string; to: string }[];
  /** Between people: the room they share. */
  shares: { from: string; to: string }[];
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const toward = (from: MeshPoint, angle: number, radius: number): MeshPoint =>
  ({ x: from.x + Math.cos(angle) * radius, y: from.y + Math.sin(angle) * radius });
/** How far from a point a member can go in this direction and stay inside the margins. */
function room(from: MeshPoint, angle: number) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let reach = Infinity;
  if (dx > 1e-9) reach = Math.min(reach, (MESH_WIDTH - MARGIN_X - from.x) / dx);
  if (dx < -1e-9) reach = Math.min(reach, (MARGIN_X - from.x) / dx);
  if (dy > 1e-9) reach = Math.min(reach, (MESH_HEIGHT - MARGIN_BOTTOM - from.y) / dy);
  if (dy < -1e-9) reach = Math.min(reach, (MARGIN_TOP - from.y) / dy);
  return Math.max(0, reach);
}
const inside = (point: MeshPoint): MeshPoint =>
  ({ x: clamp(point.x, MARGIN_X, MESH_WIDTH - MARGIN_X), y: clamp(point.y, MARGIN_TOP, MESH_HEIGHT - MARGIN_BOTTOM) });

/**
 * Moves agents apart until no two members sit closer than their gap. People stay where they are. A fixed number of
 * passes in a fixed order, so the same roster still lands in the same places; it runs once per roster, not over time.
 * An agent pushed into an edge slides along it, away from the middle, instead of sticking.
 */
function separate(points: Map<string, MeshPoint>, members: MeshMember[]) {
  const center = { x: MESH_WIDTH / 2, y: MESH_HEIGHT / 2 };
  const nudge = (id: string, dx: number, dy: number) => {
    const from = points.get(id)!, to = inside({ x: from.x + dx, y: from.y + dy });
    const blockedX = Math.abs(from.x + dx - to.x), blockedY = Math.abs(from.y + dy - to.y);
    if (blockedY > 0.5 && Math.abs(to.x - from.x) < blockedY / 2) to.x = clamp(to.x + (to.x >= center.x ? 1 : -1) * blockedY, MARGIN_X, MESH_WIDTH - MARGIN_X);
    if (blockedX > 0.5 && Math.abs(to.y - from.y) < blockedX / 2) to.y = clamp(to.y + (to.y >= center.y ? 1 : -1) * blockedX, MARGIN_TOP, MESH_HEIGHT - MARGIN_BOTTOM);
    points.set(id, to);
  };
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      if (a.role === 'human' && b.role === 'human') continue;
      const gap = a.role === 'human' || b.role === 'human' ? MESH_GAP_PERSON : MESH_GAP_AGENTS;
      const pa = points.get(a.id)!, pb = points.get(b.id)!;
      let dx = pb.x - pa.x, dy = pb.y - pa.y, distance = Math.hypot(dx, dy);
      if (distance >= gap - 0.5) continue;
      // Two in the very same spot part along a direction fixed by their order.
      if (distance < 0.01) { const angle = i * 2.4 + j; dx = Math.cos(angle); dy = Math.sin(angle); distance = 1; }
      const push = gap - Math.hypot(pb.x - pa.x, pb.y - pa.y), ux = dx / distance, uy = dy / distance;
      const share = a.role === 'agent' && b.role === 'agent' ? push / 2 : push;
      if (a.role === 'agent') nudge(a.id, -ux * share, -uy * share);
      if (b.role === 'agent') nudge(b.id, ux * share, uy * share);
      moved = true;
    }
    if (!moved) break;
  }
}

/** Where each person sits: alone in the middle, two side by side, more around a circle starting at the top. */
function anchors(count: number): MeshPoint[] {
  const center = { x: MESH_WIDTH / 2, y: MESH_HEIGHT / 2 };
  if (count === 1) return [center];
  if (count === 2) return [{ x: MESH_WIDTH * 0.32, y: center.y }, { x: MESH_WIDTH * 0.68, y: center.y }];
  const radius = Math.min(MESH_WIDTH, MESH_HEIGHT) * 0.26;
  return Array.from({ length: count }, (_, i) => toward(center, -Math.PI / 2 + (i * 2 * Math.PI) / count, radius));
}

/**
 * Each person's agents fan out away from the middle; a person alone has theirs all around. Agents whose operator
 * isn't in the room (a former member) fan out below the middle with no line to anyone.
 */
export function meshLayout(members: MeshMember[]): MeshLayout {
  const people = members.filter(m => m.role === 'human');
  const agents = members.filter(m => m.role === 'agent');
  const center = { x: MESH_WIDTH / 2, y: MESH_HEIGHT / 2 };
  const points = new Map<string, MeshPoint>();
  anchors(people.length).forEach((point, i) => points.set(people[i].id, point));

  const groups = new Map<string | undefined, MeshMember[]>();
  for (const agent of agents) {
    const owner = agent.operatorId && points.has(agent.operatorId) ? agent.operatorId : undefined;
    groups.set(owner, [...(groups.get(owner) ?? []), agent]);
  }
  for (const [owner, group] of groups) {
    const anchor = owner ? points.get(owner)! : people.length ? { x: center.x, y: center.y + 30 } : center;
    const k = group.length;
    const ring = 112 + Math.max(0, k - 5) * 8;
    // Each agent goes as far out as the view allows in its direction, so an edge never folds it back onto its person.
    const place = (agent: MeshMember, angle: number) => points.set(agent.id, toward(anchor, angle, Math.min(ring, room(anchor, angle))));
    if (owner && people.length === 1 || !people.length) {
      // All the way around, starting at the top.
      group.forEach((agent, j) => place(agent, -Math.PI / 2 + (j * 2 * Math.PI) / k));
      continue;
    }
    const out = owner ? Math.atan2(anchor.y - center.y, anchor.x - center.x) : Math.PI / 2;
    const span = Math.min((200 * Math.PI) / 180, (k - 1) * ((46 * Math.PI) / 180));
    group.forEach((agent, j) => place(agent, out + (k > 1 ? -span / 2 + (j * span) / (k - 1) : 0)));
  }
  for (const [id, point] of points) points.set(id, inside(point));
  separate(points, [...people, ...agents]);
  for (const [id, point] of points) points.set(id, { x: Math.round(point.x), y: Math.round(point.y) });

  const operates = agents.filter(a => a.operatorId && points.has(a.operatorId) && people.some(p => p.id === a.operatorId))
    .map(a => ({ from: a.operatorId!, to: a.id }));
  const shares = people.flatMap((p, i) => people.slice(i + 1).map(q => ({ from: p.id, to: q.id })));
  return { points, operates, shares };
}

/** A gentle curve between two points, bowing away from the middle so lines through it stay apart. */
export function meshCurve(a: MeshPoint, b: MeshPoint, bend = 0.12) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
  const side = (mx - MESH_WIDTH / 2) * -dy + (my - MESH_HEIGHT / 2) * dx >= 0 ? 1 : -1;
  const cx = mx - dy * bend * side, cy = my + dx * bend * side;
  return `M${a.x} ${a.y} Q${Math.round(cx)} ${Math.round(cy)} ${b.x} ${b.y}`;
}

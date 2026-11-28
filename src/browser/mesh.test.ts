import { describe, expect, test } from 'bun:test';
import { MESH_GAP_AGENTS, MESH_GAP_PERSON, MESH_HEIGHT, MESH_WIDTH, meshCurve, meshLayout, type MeshMember } from './mesh';

const person = (id: string): MeshMember => ({ id, role: 'human' });
const agent = (id: string, operatorId?: string): MeshMember => ({ id, role: 'agent', ...(operatorId ? { operatorId } : {}) });
const inside = (p: { x: number; y: number }) => p.x >= 0 && p.x <= MESH_WIDTH && p.y >= 0 && p.y <= MESH_HEIGHT;

describe('the mesh layout', () => {
  test('a person alone sits in the middle with their agents around them', () => {
    const { points, operates, shares } = meshLayout([person('igor'), agent('a', 'igor'), agent('b', 'igor'), agent('c', 'igor')]);
    expect(points.get('igor')).toEqual({ x: MESH_WIDTH / 2, y: MESH_HEIGHT / 2 });
    expect(operates).toEqual([{ from: 'igor', to: 'a' }, { from: 'igor', to: 'b' }, { from: 'igor', to: 'c' }]);
    expect(shares).toEqual([]);
    // The first agent at the top, the others around.
    expect(points.get('a')!.y).toBeLessThan(points.get('igor')!.y);
  });

  test('two people side by side, each with their agents on their own side', () => {
    const { points, shares } = meshLayout([person('igor'), person('dom'), agent('a', 'igor'), agent('b', 'dom'), agent('c', 'dom')]);
    expect(points.get('igor')!.x).toBeLessThan(points.get('dom')!.x);
    expect(points.get('a')!.x).toBeLessThan(points.get('igor')!.x);
    expect(points.get('b')!.x).toBeGreaterThan(points.get('dom')!.x);
    expect(points.get('c')!.x).toBeGreaterThan(points.get('dom')!.x);
    expect(shares).toEqual([{ from: 'igor', to: 'dom' }]);
  });

  test('a busy room: everyone placed inside, no two in the same spot, every pair of people linked', () => {
    const members = [person('p1'), person('p2'), person('p3'),
      ...['a', 'b', 'c', 'd'].map(id => agent(id, 'p1')), agent('e', 'p2'), agent('f', 'p2'), agent('g', 'p3'), agent('former', 'gone')];
    const { points, operates, shares } = meshLayout(members);
    expect(points.size).toBe(members.length);
    expect([...points.values()].every(inside)).toBe(true);
    expect(new Set([...points.values()].map(p => `${p.x},${p.y}`)).size).toBe(members.length);
    expect(shares).toHaveLength(3);
    // An agent whose operator left is drawn, but with no line to anyone.
    expect(operates.some(o => o.to === 'former')).toBe(false);
    expect(operates).toHaveLength(7);
  });

  test('nobody covers anybody: agents keep their gap from each other and from people, at the edges too', () => {
    const many = (count: number, operatorId: string, prefix = operatorId) => Array.from({ length: count }, (_, j) => agent(`${prefix}-${j}`, operatorId));
    const people = (count: number) => Array.from({ length: count }, (_, i) => person(`p${i}`));
    const rooms = {
      // A former member's agent below a person alone with an even number of agents.
      "one person, two agents, a former member's": [person('p0'), ...many(2, 'p0'), agent('former', 'gone')],
      // The bottom person of four or six, whose agents the bottom edge used to fold back onto them.
      'four people, one agent each': [...people(4), ...[0, 1, 2, 3].map(i => agent(`a${i}`, `p${i}`))],
      'six people, two agents each': [...people(6), ...Array.from({ length: 12 }, (_, j) => agent(`a${j}`, `p${j % 6}`))],
      "four people and a former member's agent": [...people(4), agent('former', 'gone')],
      // Eight agents fanned up from the top person of three.
      'three people, eight on the top one': [...people(3), ...many(8, 'p0')],
      'two people, eight agents each': [...people(2), ...many(8, 'p0'), ...many(8, 'p1')],
      'one person, eight agents, three former': [person('p0'), ...many(8, 'p0'), ...many(3, 'gone', 'former')],
    };
    for (const [room, members] of Object.entries(rooms)) {
      const { points } = meshLayout(members);
      const role = new Map(members.map(m => [m.id, m.role]));
      const ids = [...points.keys()];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]];
        if (role.get(a) === 'human' && role.get(b) === 'human') continue;
        const gap = role.get(a) === 'human' || role.get(b) === 'human' ? MESH_GAP_PERSON : MESH_GAP_AGENTS;
        const distance = Math.hypot(points.get(a)!.x - points.get(b)!.x, points.get(a)!.y - points.get(b)!.y);
        // Positions are rounded to whole units.
        if (distance < gap - 2) throw new Error(`${room}: ${a} and ${b} are ${distance.toFixed(1)} apart, under ${gap}`);
      }
    }
  });

  test('the same room draws the same way', () => {
    const members = [person('p1'), person('p2'), agent('a', 'p1'), agent('b', 'p2')];
    expect([...meshLayout(members).points]).toEqual([...meshLayout(members).points]);
  });

  test('curves are SVG quadratic paths between the two points', () => {
    expect(meshCurve({ x: 10, y: 20 }, { x: 110, y: 20 })).toMatch(/^M10 20 Q\d+ -?\d+ 110 20$/);
  });
});

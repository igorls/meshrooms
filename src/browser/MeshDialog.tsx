import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MESH_HEIGHT, MESH_WIDTH, meshCurve, meshLayout } from './mesh';

/** One member as the mesh draws it. */
export type MeshNode = {
  id: string; name: string; role: 'human' | 'agent'; operatorId?: string;
  /** The dot's colour: what the strip shows for an agent; people have none. */
  state?: 'working' | 'idle' | 'online' | 'offline';
  /** Idle but not listening, or busy with no check-in: the strip's faded dot, and no breathing. */
  quiet?: boolean;
  /** "Agent · Claude Code · claude-opus-5-5 · operated by Igor", "Person · host". */
  kind: string;
  /** "Replying to you · 1 min", "Idle · 3 h", "You". */
  doing: string;
  /** People this agent is answering right now: a live line to each. */
  answering: string[];
  you?: boolean;
  /** How your device reaches theirs right now (undefined for you). */
  path?: MeshPath;
};
export type MeshPath = 'direct' | 'turn' | 'relay' | 'none';
const PATH_TEXT: Record<MeshPath, string> = {
  direct: 'Connected to you directly, device to device',
  turn: 'Connected to you through a TURN relay',
  relay: 'Reached through the room service’s relay',
  none: 'Not connected to you right now',
};
const PATH_LEGEND: Record<MeshPath, string> = { direct: 'direct', turn: 'through TURN', relay: 'through the relay', none: 'not connected' };

/**
 * "Mesh": who is in the room and who runs which agent, as a picture. People anchor it; each agent hangs off the person
 * who operates it, and an agent at work draws a live line to the people it is answering. Picking a member says what
 * it is doing, with a way to mention it.
 */
export function MeshDialog({ open, nodes, connections, summary, avatar, onMention, onDetails, onClose }: {
  open: boolean; nodes: MeshNode[]; summary: string; avatar: (id: string) => ReactNode;
  /** Whether this page knows its connections (not on the local page, which reaches the room through the app). */
  connections: boolean;
  onMention: (name: string) => void; onDetails: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string>();
  const [hover, setHover] = useState<string>();
  /** "Who runs what" (operators and live work) or "Connections" (how your device reaches each member). */
  const [view, setView] = useState<'agents' | 'links'>('agents');
  /** What a screen reader hears on a pick, fixed then, so the minute-by-minute "doing" doesn't announce itself again. */
  const [announce, setAnnounce] = useState('');
  const layout = useMemo(() => meshLayout(nodes), [nodes.map(n => `${n.id}:${n.role}:${n.operatorId ?? ''}`).join('|')]);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const chosen = selected ? byId.get(selected) : undefined;
  // A member who left (no mouseleave fires for them) doesn't keep the picture lit.
  const lit = hover && byId.has(hover) ? hover : selected;

  useEffect(() => {
    const element = dialog.current; if (!element) return;
    if (open && !element.open) { element.showModal(); setSelected(undefined); setHover(undefined); setAnnounce(''); requestAnimationFrame(() => element.querySelector<HTMLElement>('.mesh-node')?.focus()); }
    else if (!open && element.open) element.close();
  }, [open]);
  // Someone who left takes the selection with them.
  useEffect(() => { if (selected && !byId.has(selected)) setSelected(undefined); }, [nodes]);

  const line = (from: string, to: string) => {
    const a = layout.points.get(from), b = layout.points.get(to);
    return a && b ? meshCurve(a, b) : undefined;
  };
  const touches = (from: string, to: string) => !!lit && (from === lit || to === lit);
  const live = nodes.flatMap(n => n.answering.filter(p => layout.points.has(p)).map(p => ({ from: n.id, to: p })));
  const people = nodes.filter(n => n.role === 'human');
  const you = nodes.find(n => n.you);
  const reach = nodes.filter(n => !n.you && n.path);
  /** A page that can't read its connections (the local page) only has the first view. */
  const mode = connections ? view : 'agents';
  const counts = (['direct', 'turn', 'relay', 'none'] as const).map(path => [path, reach.filter(n => n.path === path).length] as const).filter(([, n]) => n > 0);

  return <dialog ref={dialog} className="mesh-dialog" aria-labelledby="mesh-title" aria-describedby="mesh-summary" onClose={onClose}
    onClick={event => {
      // The backdrop only: the dialog's own surface around the stage is the dialog too.
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    <header className="mesh-head">
      <div><h2 id="mesh-title">Mesh</h2><p id="mesh-summary">{summary}</p></div>
      {connections && <div className="mesh-view" role="group" aria-label="Show" data-view={mode}>
        <span className="mesh-view-glider" aria-hidden="true" />
        <button type="button" aria-pressed={view === 'agents'} onClick={() => setView('agents')}>Who runs what</button>
        <button type="button" aria-pressed={view === 'links'} onClick={() => setView('links')}>Connections</button>
      </div>}
      <button type="button" className="browser-close" aria-label="Close mesh" onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </header>
    <div className={`mesh-stage is-${mode}${lit ? ' has-lit' : ''}`} role="group" aria-label={mode === 'agents' ? 'People and the agents they run' : 'How your device reaches each member'}>
      <svg className="mesh-lines" viewBox={`0 0 ${MESH_WIDTH} ${MESH_HEIGHT}`} aria-hidden="true">
        {mode === 'links' ? you && reach.map(n => { const d = n.path !== 'none' && line(you.id, n.id); return d && <path key={`p-${n.id}`} d={d} pathLength={1} className={`mesh-path is-${n.path}${touches(you.id, n.id) ? ' is-lit' : ''}`} />; }) : <>
        {layout.shares.map(({ from, to }) => { const d = line(from, to); return d && <path key={`s-${from}-${to}`} d={d} pathLength={1} className={`mesh-share${touches(from, to) ? ' is-lit' : ''}`} />; })}
        {layout.operates.filter(({ from, to }) => !live.some(l => l.from === to && l.to === from)).map(({ from, to }) => { const d = line(from, to); return d && <path key={`o-${to}`} d={d} pathLength={1} className={`mesh-operates${touches(from, to) ? ' is-lit' : ''}`} />; })}
        {live.map(({ from, to }) => { const d = line(from, to); return d && <path key={`l-${from}-${to}`} d={d} className={`mesh-live${touches(from, to) ? ' is-lit' : ''}`} />; })}
        </>}
      </svg>
      {nodes.map((node, i) => {
        const point = layout.points.get(node.id); if (!point) return null;
        const style = { left: `${(point.x / MESH_WIDTH) * 100}%`, top: `${(point.y / MESH_HEIGHT) * 100}%`, '--i': i } as CSSProperties;
        // On Connections, someone with no path stays dimmed unless they're the one picked or hovered.
        const related = mode === 'links' ? lit === node.id || node.path !== 'none' && (!lit || !!node.you || lit === you?.id) : !lit || lit === node.id || layout.operates.some(o => touches(o.from, o.to) && (o.from === node.id || o.to === node.id))
          || live.some(l => touches(l.from, l.to) && (l.from === node.id || l.to === node.id)) || (node.role === 'human' && byId.get(lit)?.role === 'human');
        return <button key={node.id} type="button" style={style} aria-pressed={selected === node.id}
          className={`mesh-node is-${node.role === 'human' ? 'person' : 'agent'}${node.state ? ` is-${node.state}` : ''}${node.quiet ? ' is-quiet' : ''}${related ? '' : ' is-dim'}${node.you ? ' is-you' : ''}`}
          aria-label={`${node.name}${node.you ? ' (you)' : ''}. ${node.kind}. ${node.doing}${node.path ? `. ${PATH_TEXT[node.path]}` : ''}`}
          onClick={() => { const next = selected === node.id ? undefined : node.id; setSelected(next); setAnnounce(next ? `${node.name}${node.you ? ' (you)' : ''}. ${node.kind}. ${node.doing}${node.path ? `. ${PATH_TEXT[node.path]}` : ''}` : ''); }}
          onMouseEnter={() => setHover(node.id)} onMouseLeave={() => setHover(undefined)} onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setHover(node.id); }} onBlur={() => setHover(undefined)}>
          <span className="mesh-face">{avatar(node.id)}{node.state && <span className={`agent-dot is-${node.state}${node.quiet ? ' is-quiet' : ''}`} />}</span>
          <span className="mesh-name">{node.you ? 'You' : node.name}</span>
          {mode === 'links' && node.path && node.path !== 'none' && <span className={`mesh-path-tag is-${node.path}`} aria-hidden="true">{node.path === 'direct' ? 'P2P' : node.path === 'turn' ? 'TURN' : 'Relay'}</span>}
        </button>;
      })}
      {people.length === 0 && <p className="mesh-empty">Nobody here yet.</p>}
    </div>
    {mode === 'links' && <ul className="mesh-legend" aria-label="Your connections">
      {counts.length ? counts.map(([path, n]) => <li key={path} className={`is-${path}`}><span className="mesh-swatch" aria-hidden="true" />{n} {PATH_LEGEND[path]}</li>)
        : <li>{nodes.some(n => !n.you) ? 'Checking your connections…' : 'Nobody else is here yet.'}</li>}
    </ul>}
    <p className="sr-only" aria-live="polite">{announce}</p>
    <div className="mesh-detail">
      {chosen ? <>
        <div className="mesh-detail-who">
          <span className="mesh-detail-face">{avatar(chosen.id)}</span>
          <div><strong>{chosen.name}{chosen.you ? ' (you)' : ''}</strong><span>{chosen.kind}</span></div>
        </div>
        <p className={`mesh-detail-doing${chosen.state ? ` is-${chosen.state}` : ''}${chosen.quiet ? ' is-quiet' : ''}`}>{chosen.doing}</p>
        {chosen.path && <p className={`mesh-detail-path is-${chosen.path}`}><span className="mesh-swatch" aria-hidden="true" />{PATH_TEXT[chosen.path]}</p>}
        <div className="mesh-detail-actions">
          {!chosen.you && <button type="button" className="primary" onClick={() => { dialog.current?.close(); onMention(chosen.name); }}>Mention</button>}
          <button type="button" className="secondary" onClick={() => { dialog.current?.close(); onDetails(); }}>Room details</button>
        </div>
      </> : <p className="mesh-hint">{mode === 'agents'
        ? 'Lines join each agent to the person who runs it. An amber line moves from an agent to whoever it is answering. Pick anyone to see what they’re doing.'
        : 'Lines run from you to each member: green when your devices talk directly, blue through a TURN relay, grey through the room service’s relay. Direct links carry files with no server in between.'}</p>}
    </div>
  </dialog>;
}

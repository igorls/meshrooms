import { useId, useRef, useState, type FormEvent } from 'react';
import type { BrowserMember } from './protocol';
import { MAX_AGENT_NAME, renameProblem } from './rename-state';

/**
 * "Rename" on an agent's row in Room details: a link that opens one field in the row, so the name changes where it is
 * shown. The name is checked here as the room service will check it (rename-state.ts), and what the service refuses
 * anyway (someone took the name a moment ago) is shown under the field, not in the room's banner.
 */
export function AgentRename({ member, members, reserved, disabled, onRename }: {
  member: BrowserMember; members: BrowserMember[]; reserved: string[]; disabled: boolean;
  onRename(name: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false), [value, setValue] = useState(''), [problem, setProblem] = useState(''), [saving, setSaving] = useState(false);
  const opener = useRef<HTMLButtonElement>(null), field = useRef<HTMLInputElement>(null), error = useId();
  const open = () => { setValue(member.name); setProblem(''); setEditing(true); requestAnimationFrame(() => field.current?.select()); };
  const close = () => { setEditing(false); setProblem(''); requestAnimationFrame(() => opener.current?.focus()); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const found = renameProblem(value, member, members, reserved);
    if (found) { setProblem(found); field.current?.focus(); return; }
    setSaving(true); setProblem('');
    try { await onRename(value); setEditing(false); }
    catch (e) { setProblem((e as Error).message || 'Could not rename the agent.'); field.current?.focus(); }
    finally { setSaving(false); }
  }
  if (!editing) return <button ref={opener} type="button" className="browser-text-link browser-picture-link" disabled={disabled} aria-label={`Rename ${member.name}`} onClick={open}>Rename</button>;
  return <form className="browser-rename" onSubmit={e => void submit(e)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }} noValidate>
    <label>New name for agent “{member.name}”
      <input ref={field} value={value} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={problem ? true : undefined} aria-describedby={problem ? error : undefined}
        onChange={e => { setValue(e.target.value); setProblem(''); }} disabled={saving} />
    </label>
    <p className="browser-rename-hint">People will @mention it by the new name; the old one stops matching. At most {MAX_AGENT_NAME} characters.</p>
    {problem && <p id={error} className="browser-rename-error" role="alert">{problem}</p>}
    <div className="browser-rename-actions">
      <button type="submit" className="primary" disabled={saving || !value.trim()} aria-busy={saving}>{saving ? 'Renaming…' : 'Rename'}</button>
      <button type="button" className="secondary" disabled={saving} onClick={close}>Cancel</button>
    </div>
  </form>;
}

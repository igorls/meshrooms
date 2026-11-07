import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MessageNotificationLevel, RoomNotifications } from './source';

export function RoomNotificationControls({ api, roomId }: { api: RoomNotifications; roomId: string }) {
  const choiceId = useId();
  const [level, setLevel] = useState<MessageNotificationLevel>();
  const [pending, setPending] = useState<MessageNotificationLevel>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true); setError(''); setSaved(false);
    try {
      const answer = await api.read(roomId);
      if (id === request.current) setLevel(answer);
    } catch (problem) {
      if (id === request.current) setError(problem instanceof Error ? problem.message : 'Could not read your notification setting.');
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [api, roomId]);
  useEffect(() => {
    void load();
    return () => { ++request.current; };
  }, [load]);

  async function save(next: MessageNotificationLevel) {
    const id = ++request.current;
    setPending(next); setError(''); setSaved(false);
    try {
      const answer = await api.save(roomId, next);
      if (id === request.current) { setLevel(answer); setSaved(true); }
    } catch (problem) {
      if (id === request.current) setError(problem instanceof Error ? problem.message : 'Could not save your notification setting.');
    } finally {
      if (id === request.current) setPending(undefined);
    }
  }

  return <section className="browser-notifications" aria-label="Desktop notifications" aria-busy={loading || !!pending}>
    <h3>Desktop notifications</h3>
    <p>For this room, on this computer.</p>
    <label htmlFor={choiceId}>Message notifications</label>
      <select id={choiceId} value={pending ?? level ?? ''} disabled={loading || !!pending || !level} onChange={event => void save(event.target.value as MessageNotificationLevel)}>
        {!level && <option value="">{loading ? 'Loading…' : 'Unavailable'}</option>}
        <option value="mentions">Mentions and replies</option>
        <option value="all">All messages</option>
        <option value="off">Off</option>
      </select>
    <p>Join requests, agent issues, and approvals still notify you.</p>
    <p role="status">{loading ? 'Reading your setting…' : pending ? 'Saving…' : saved ? 'Saved.' : ''}</p>
    {error && <div className="browser-notifications-error" role="alert"><p>{error}</p>
      {!level && <button className="browser-text-link" onClick={() => void load()}>Try again</button>}
    </div>}
  </section>;
}

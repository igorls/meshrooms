import { describe, expect, test } from 'bun:test';
import { RoomDrafts } from './drafts';

describe('unpublished room drafts', () => {
  const store = () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    return { values, storage, drafts: new RoomDrafts(() => storage) };
  };
  test('text and reply survive navigation independently for each device and room', () => {
    const { drafts, storage } = store();
    drafts.save('me', 'first', { text: 'Unsent café 🧪\nSecond line', replyId: 'message' });
    drafts.save('me', 'second', { text: 'A separate draft' });
    const reloaded = new RoomDrafts(() => storage);
    expect(reloaded.read('me', 'first')).toEqual({ text: 'Unsent café 🧪\nSecond line', replyId: 'message' });
    expect(reloaded.read('me', 'second').text).toBe('A separate draft');
    expect(reloaded.read('another-person', 'first').text).toBe('');
    expect(reloaded.has('another-person', 'first')).toBe(false);
    expect(reloaded.has('me', 'first')).toBe(true);
    drafts.save('me', 'first', { text: '' });
    expect(reloaded.read('me', 'first')).toEqual({ text: '' });
    expect(reloaded.has('me', 'first')).toBe(false);
    expect(reloaded.read('me', 'second').text).toBe('A separate draft');
  });
  test('a reply with no text is retained, and unavailable storage reports a failed save', () => {
    const { drafts } = store();
    drafts.save('me', 'room', { text: '', replyId: 'message' });
    expect(drafts.read('me', 'room').replyId).toBe('message');
    expect(drafts.has('me', 'room')).toBe(true);
    const unavailable = new RoomDrafts(() => { throw new Error('Storage disabled'); });
    expect(unavailable.read('me', 'room')).toEqual({ text: '' });
    expect(unavailable.save('me', 'room', { text: 'Keep me' })).toBe(false);
  });
  test('malformed saved data does not become draft text', () => {
    const { values, drafts } = store();
    values.set('meshrooms:draft:me:room', '{bad JSON');
    expect(drafts.read('me', 'room').text).toBe('');
    values.set('meshrooms:draft:me:room', '{"text":23,"replyId":false}');
    expect(drafts.read('me', 'room')).toEqual({ text: '' });
  });
});

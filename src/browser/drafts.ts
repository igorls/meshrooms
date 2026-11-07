/** Unpublished text stays in this browser tab. Room and device keys keep drafts separate when navigating. */
export type RoomDraft = { text: string; replyId?: string };
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class RoomDrafts {
  constructor(private storage: () => DraftStorage = () => sessionStorage) {}
  private key(device: string, room: string) { return `meshrooms:draft:${device}:${room}`; }

  read(device: string, room: string): RoomDraft {
    try {
      const value = JSON.parse(this.storage().getItem(this.key(device, room)) || 'null');
      if (value && typeof value.text === 'string') return { text: value.text, ...(typeof value.replyId === 'string' ? { replyId: value.replyId } : {}) };
    } catch { /* A missing or damaged draft never prevents entering a room. */ }
    return { text: '' };
  }

  has(device: string, room: string): boolean {
    const draft = this.read(device, room);
    return !!(draft.text || draft.replyId);
  }

  /** Synchronous, so a room link or reload immediately after typing cannot overtake the save. */
  save(device: string, room: string, draft: RoomDraft): boolean {
    try {
      const storage = this.storage(), key = this.key(device, room);
      if (!draft.text && !draft.replyId) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(draft));
      return true;
    } catch { return false; }
  }
}

export const roomDrafts = new RoomDrafts();

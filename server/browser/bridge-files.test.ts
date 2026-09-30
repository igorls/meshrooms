import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentRef, attachmentText, type AttachmentRef } from '../../src/browser/files';
import { BrowserAgent, attachmentBrowser } from '../browser-agent';

const roomId = crypto.randomUUID(), memberId = crypto.randomUUID();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const png = () => { const b = new Uint8Array(40_000); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8]); return b; };
/** Messages written as if `run` had stored them, bypassing arrival checks to exercise the later defenses. */
function stored(agent: BrowserAgent, refs: AttachmentRef[]) {
  const body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'a'.repeat(64), memberId, text: attachmentText(refs), at: Date.now(), attachments: refs };
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify([{ packet: { body, signature: '' }, targets: [], receipts: [] }]));
}
function room(refs: AttachmentRef[]) {
  const home = mkdtempSync(join(tmpdir(), 'mr-bridge-files-')); dirs.push(home);
  const agent = new BrowserAgent(home, 'http://127.0.0.1:1', roomId);
  stored(agent, refs);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: crypto.randomUUID(), members: [{ id: memberId, name: 'Alex' }], devices: [] }));
  return { home, agent };
}

test('a peer-supplied name cannot leave the output directory or replace a file there', async () => {
  const bytes = png(); const ref = { ...await attachmentRef(bytes, 'shot.png'), name: '../../.zshrc' };
  const { home, agent } = room([ref]);
  agent.files.add(bytes);
  const out = join(home, 'out'); mkdirSync(out);
  const first = await attachmentBrowser(agent, ref.id, out, 1);
  expect(first.path).toBe(join(out, 'zshrc'));
  writeFileSync(join(out, 'kept.png'), 'mine');
  stored(agent, [{ ...ref, name: 'kept.png' }]);
  const second = await attachmentBrowser(agent, ref.id, out, 1);
  expect(second.path).toBe(join(out, 'kept-2.png'));
  expect(readFileSync(join(out, 'kept.png'), 'utf8')).toBe('mine');
  expect(new Uint8Array(readFileSync(second.path))).toEqual(bytes);
  expect(readdirSync(home).sort()).toEqual(['browser-agents', 'out']);
  expect(existsSync(join(home, '..', '.zshrc'))).toBe(false);
});

test('a damaged local copy is never returned, and listen shows files instead of the fallback text', async () => {
  const bytes = png(); const ref = await attachmentRef(bytes, 'shot.png');
  const { home, agent } = room([ref]);
  const sha = agent.files.add(bytes);
  const view = agent.view().messages[0];
  expect(view.text).toBe('');
  expect(view.attachments).toEqual([{ ...ref, kind: 'image' }]);
  const tampered = bytes.slice(); tampered[100] ^= 1; writeFileSync(agent.files.path(sha), tampered);
  expect(await agent.files.get(sha)).toBeUndefined();
  expect(agent.files.has(sha)).toBe(false);
  await expect(attachmentBrowser(agent, ref.id, home, 1)).rejects.toThrow('No connected device');
  await expect(attachmentBrowser(agent, crypto.randomUUID(), home, 1)).rejects.toThrow('No message');
});

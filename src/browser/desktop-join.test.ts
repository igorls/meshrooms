import { expect, test } from 'bun:test';
import { PAIRED_FLAG, joinLink, pairedHere } from './desktop-join';

const ROOM = '0d8f6a52-1b7e-4c3a-9e2f-5a6b7c8d9e0f';

test('the join link names this site and the room, encoded as the app parses it', () => {
  // The same spelling desktop/src-tauri/src/links.rs tests (a_join_link_as_the_hosted_page_builds_it).
  expect(joinLink('https://meshrooms.wormdb.dev', ROOM)).toBe(`meshrooms://join?origin=https%3A%2F%2Fmeshrooms.wormdb.dev&room=${ROOM}`);
  expect(joinLink('http://127.0.0.1:4317', ROOM)).toBe(`meshrooms://join?origin=http%3A%2F%2F127.0.0.1%3A4317&room=${ROOM}`);
  const parsed = new URL(joinLink('https://rooms.example:8443', ROOM));
  expect([parsed.protocol, parsed.host, [...parsed.searchParams]]).toEqual(['meshrooms:', 'join', [['origin', 'https://rooms.example:8443'], ['room', ROOM]]]);
});

test('only a browser that paired is offered the app; storage that fails means not paired', () => {
  const storage = (value: string | null) => ({ getItem: (key: string) => key === PAIRED_FLAG ? value : null });
  expect(PAIRED_FLAG).toBe('meshrooms:paired');
  expect(pairedHere(storage('1'))).toBe(true);
  for (const value of [null, '', '0', 'true']) expect(pairedHere(storage(value))).toBe(false);
  expect(pairedHere({ getItem: () => { throw new Error('blocked'); } })).toBe(false);
});

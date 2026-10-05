/** SYNTHETIC SANITIZED FIXTURES, not captured sessions. Fixed-width layout observed
 * with Hermes 0.21.5+6489.gf4d3e62. Every title/workspace/ID below is invented.
 * Last Active is a display label, not an epoch. IDs retain the observed 8_6_6 shape.
 */
export const versionFixture = 'Hermes Agent v0.21.5+6489.gf4d3e62 (2026.9.24) · upstream f4d3e626\nInstall directory: HERMES_INSTALL_PLACEHOLDER\n';
export const headerFixture = 'Title                        Workspace          Last Active   ID\n' + '─'.repeat(110) + '\n';
const pad = (text: string, width: number) => text + ' '.repeat(width - Array.from(text).length);
export function rowFixture(title = 'Synthetic fixture title', workspace = 'fixture-project', active = 'just now', id = '20000101_000000_aabbcc') {
  return `${pad(title, 28)} ${pad(workspace, 18)} ${pad(active, 13)} ${id}\n`;
}
export const listingFixture = headerFixture + rowFixture() + rowFixture('—', '—', '?', '20000101_000001_aabbcc');
export const cappedFixture = headerFixture + Array.from({ length: 20 }, (_, i) => rowFixture('Fixture row', 'fixture-project', '4d ago', `20000101_000000_${i.toString(16).padStart(6, '0')}`)).join('') + '  … more not shown (use --limit 40 to see more)\n';

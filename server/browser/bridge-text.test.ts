import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTextOptions } from '../agent-cli';
import { testDirectory } from '../test-directory';

// Production: an apostrophe in `--text '...'` ended the argument, and bash ran the rest of the message.
const risky = "It's done: `rm -rf` wasn't needed; see \"notes\" & $HOME\nSecond line | with a pipe";

test('long text comes from a file or stdin, exactly, instead of a quoted shell argument', async () => {
  const dir = testDirectory('bridge-text');
  try {
    const file = join(dir.path, 'message.md');
    writeFileSync(file, `${risky}\n`);
    const fromFile: Record<string, string> = { '--text-file': file };
    await readTextOptions(fromFile, async () => { throw new Error('stdin not read'); });
    expect(fromFile['--text']).toBe(risky);

    const fromStdin: Record<string, string> = { '--text': '-', '--notes-file': file };
    await readTextOptions(fromStdin, async () => `${risky}\r\n`);
    expect(fromStdin['--text']).toBe(risky);
    expect(fromStdin['--notes']).toBe(risky);

    // PowerShell 5 writes files with a byte order mark; only one trailing newline is dropped.
    writeFileSync(file, `﻿${risky}\n\n`);
    const bom: Record<string, string> = { '--comment-file': file };
    await readTextOptions(bom);
    expect(bom['--comment']).toBe(`${risky}\n`);

    // Plain arguments are left alone.
    const plain: Record<string, string> = { '--text': 'short', '--notes': '' };
    await readTextOptions(plain, async () => { throw new Error('stdin not read'); });
    expect(plain).toEqual({ '--text': 'short', '--notes': '' });

    await expect(readTextOptions({ '--text': 'a', '--text-file': file })).rejects.toThrow('Use --text or --text-file, not both.');
    await expect(readTextOptions({ '--text': '-', '--comment': '-' }, async () => 'x')).rejects.toThrow('Only one option can read from stdin');
    await expect(readTextOptions({ '--text-file': join(dir.path, 'missing.md') })).rejects.toThrow();

    // Windows PowerShell 5's `>` writes UTF-16LE with a byte order mark; UTF-16BE is read too.
    const utf16 = (bytes: Buffer) => { writeFileSync(file, bytes); const v: Record<string, string> = { '--text-file': file }; return readTextOptions(v).then(() => v['--text']); };
    expect(await utf16(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${risky} ✓\r\n`, 'utf16le')]))).toBe(`${risky} ✓`);
    expect(await utf16(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${risky} ✓\n`, 'utf16le').swap16()]))).toBe(`${risky} ✓`);
    // Anything else that isn't UTF-8 (a legacy code page) is refused rather than posted garbled.
    await expect(utf16(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))).rejects.toThrow('Save it as UTF-8');
  } finally { dir.cleanup(); }
});

test('--text - reads the real stdin of the bridge process, as a heredoc or a pipe gives it', async () => {
  const cli = join(import.meta.dir, '..', 'agent-cli.ts').replaceAll('\\', '/');
  const child = Bun.spawn([process.execPath, '-e', `import { readTextOptions } from '${cli}'; const v = { '--text': '-' }; await readTextOptions(v); console.log(JSON.stringify(v));`],
    { stdin: new Blob([`${risky}\n`]), stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(err).toBe('');
  expect(JSON.parse(out)).toEqual({ '--text': risky });
});

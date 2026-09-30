import { expect, test } from 'bun:test';
import { acquireInstance } from './instance';
import { testDirectory } from './test-directory';

test('an OS owner excludes a second process and releases ownership after forced exit', async () => {
  const directory = testDirectory('owner'); const dir = directory.path;
  const modulePath = new URL('./instance.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '-e', `import {acquireInstance} from ${JSON.stringify(modulePath)}; acquireInstance(${JSON.stringify(dir)}); console.log('owned'); setInterval(()=>{},1000);`], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Owner did not start')), 5000))]);
    expect(new TextDecoder().decode(first.value)).toContain('owned'); reader.releaseLock();
    expect(() => acquireInstance(dir)).toThrow('already owns');
    if (process.platform === 'win32') {
      const extended = dir.startsWith('\\\\?\\') ? dir : `\\\\?\\${dir}`;
      expect(() => acquireInstance(extended)).toThrow('already owns');
    }
    child.kill('SIGKILL'); await child.exited;
    const release = acquireInstance(dir);
    expect(() => acquireInstance(dir)).toThrow('already owns');
    release(); release();
    acquireInstance(dir)();
  } finally { child.kill(); await child.exited; directory.cleanup(); }
}, 10000);

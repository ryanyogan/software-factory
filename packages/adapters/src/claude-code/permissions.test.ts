import { describe, expect, it } from 'vite-plus/test';
import { createPathGuard } from './permissions';

const opts = { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' };

describe('createPathGuard', () => {
  const guard = createPathGuard(['/w/task', '/extra']);

  it('allows tools without paths and paths inside the roots', async () => {
    expect(await guard('Bash', { command: 'pnpm test' }, opts)).toMatchObject({
      behavior: 'allow',
    });
    expect(await guard('Write', { file_path: '/w/task/a.ts' }, opts)).toMatchObject({
      behavior: 'allow',
    });
    expect(await guard('Edit', { file_path: 'src/b.ts' }, opts)).toMatchObject({
      behavior: 'allow',
    });
    expect(await guard('Write', { file_path: '/extra/x' }, opts)).toMatchObject({
      behavior: 'allow',
    });
  });

  it('denies paths outside the roots, including traversal and blockedPath', async () => {
    expect(await guard('Write', { file_path: '/w/task-other/a' }, opts)).toMatchObject({
      behavior: 'deny',
    });
    expect(await guard('Edit', { file_path: '../../etc/passwd' }, opts)).toMatchObject({
      behavior: 'deny',
    });
    expect(
      await guard('Bash', { command: 'rm x' }, { ...opts, blockedPath: '/home/u/.ssh' }),
    ).toMatchObject({
      behavior: 'deny',
    });
  });
});

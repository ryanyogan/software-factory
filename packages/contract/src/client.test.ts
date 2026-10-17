import { describe, expect, it } from 'vite-plus/test';
import { CommandError, commandNames, commands, createClient } from './index';

const task = {
  id: 't_1',
  projectId: 'p_1',
  title: 'Hello',
  branch: 'hello',
  status: 'open',
  createdAt: '2026-10-17T00:00:00.000Z',
};

describe('commands registry', () => {
  it('keys match command names', () => {
    for (const name of commandNames) expect(commands[name].name).toBe(name);
  });
});

describe('createClient', () => {
  it('POSTs to /v1/commands/<name> with bearer token and parses output', async () => {
    let seen: Request | undefined;
    const client = createClient({
      baseUrl: 'http://x/',
      token: 'tok',
      fetch: async (url, init) => {
        seen = new Request(url, init);
        return Response.json(task);
      },
    });
    const out = await client.call('task.create', { projectId: 'p_1', title: 'Hello' });
    expect(out).toEqual(task);
    expect(seen?.url).toBe('http://x/v1/commands/task.create');
    expect(seen?.headers.get('authorization')).toBe('Bearer tok');
  });

  it('throws CommandError from error body', async () => {
    const client = createClient({
      baseUrl: 'http://x',
      fetch: async () =>
        Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 }),
    });
    await expect(client.call('run.get', { id: 'r' })).rejects.toBeInstanceOf(CommandError);
  });
});

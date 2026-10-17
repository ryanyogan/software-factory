import { CommandError } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import { unwrap } from './result';

const project = {
  id: 'prj_1',
  name: 'Demo',
  repoUrl: 'https://github.com/acme/demo',
  createdAt: '2026-10-17T00:00:00.000Z',
};

describe('unwrap', () => {
  it('returns contract-validated output', () => {
    expect(unwrap('project.create', { ok: true, data: project })).toEqual(project);
  });

  it('rebuilds CommandError from the RPC error union', () => {
    const fn = () =>
      unwrap('run.get', { ok: false, status: 404, error: { code: 'not_found', message: 'nope' } });
    expect(fn).toThrow(CommandError);
    expect(fn).toThrow(expect.objectContaining({ code: 'not_found', status: 404 }));
  });

  it('rejects output that breaks the contract', () => {
    expect(() => unwrap('project.create', { ok: true, data: { id: 'x' } })).toThrow(
      /expected string/i,
    );
  });
});

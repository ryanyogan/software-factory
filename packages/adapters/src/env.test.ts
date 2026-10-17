import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { findOnPath, resolveBinary } from './binaries';
import { buildAgentEnv } from './env';

describe('buildAgentEnv', () => {
  const base = {
    PATH: '/bin',
    HOME: '/h',
    ANTHROPIC_API_KEY: 'sk-a',
    OPENAI_API_KEY: 'sk-o',
    CODEX_API_KEY: 'c',
    EMPTY: undefined,
  };

  it('starts from the full base env and strips provider API keys', () => {
    expect(buildAgentEnv({ base })).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('keeps keys when opted in, merges extras last, strips extra names', () => {
    const env = buildAgentEnv({
      base,
      allowApiKeys: true,
      extra: { HOME: '/x', SF: '1' },
      strip: ['PATH'],
    });
    expect(env).toEqual({
      HOME: '/x',
      ANTHROPIC_API_KEY: 'sk-a',
      OPENAI_API_KEY: 'sk-o',
      CODEX_API_KEY: 'c',
      SF: '1',
    });
  });

  it('defaults to process.env', () => {
    process.env.SF_ENV_TEST = 'yes';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const env = buildAgentEnv();
      expect(env.SF_ENV_TEST).toBe('yes');
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    } finally {
      delete process.env.SF_ENV_TEST;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('binaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-bin-'));
  const exe = join(dir, 'claude');
  writeFileSync(exe, '#!/bin/sh\n');
  chmodSync(exe, 0o755);
  writeFileSync(join(dir, 'codex'), 'not executable');

  it('finds executables on PATH only', () => {
    expect(findOnPath('claude', `/nonexistent:${dir}`)).toBe(exe);
    expect(findOnPath('codex', dir)).toBeNull();
  });

  it('resolves auto / bundled / absolute', () => {
    expect(resolveBinary('auto', 'claude', dir)).toBe(exe);
    expect(resolveBinary(undefined, 'nope', dir)).toBeUndefined();
    expect(resolveBinary('bundled', 'claude', dir)).toBeUndefined();
    expect(resolveBinary('/opt/claude', 'claude', dir)).toBe('/opt/claude');
    expect(() => resolveBinary('rel/claude', 'claude', dir)).toThrow(/absolute/);
  });
});

import { describe, expect, it } from 'vite-plus/test';
import { cli, shellQuote } from './cli';

describe('shellQuote', () => {
  it('leaves safe tokens bare and single-quotes the rest', () => {
    expect(shellQuote('prj_1')).toBe('prj_1');
    expect(shellQuote('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(shellQuote('Fix login')).toBe(`'Fix login'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe(`''`);
  });
});

describe('cli', () => {
  it('matches the stage-5 sf syntax', () => {
    expect(cli.projectCreate('Demo', 'https://x.dev/r')).toBe(
      'sf project create --name Demo --repo https://x.dev/r',
    );
    expect(cli.projectCreate('Demo')).toBe('sf project create --name Demo');
    expect(cli.taskCreate('prj_1', 'Add login')).toBe(
      `sf task create --project prj_1 --title 'Add login'`,
    );
    expect(cli.runStart('tsk_1', 'claude-code', 'local', `Add a 'login' page`)).toBe(
      `sf run start --task tsk_1 --agent claude-code --location local --prompt 'Add a '\\''login'\\'' page'`,
    );
    expect(cli.runList()).toBe('sf run list');
    expect(cli.runGet('run_1')).toBe('sf run get run_1');
  });
});

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

describe('cli (stage 11 run actions)', () => {
  it('matches the sf run/watch/daemon flags in apps/cli', () => {
    expect(cli.runStart('tsk_1', 'fake', 'local', 'go', false)).toBe(
      'sf run start --task tsk_1 --agent fake --location local --prompt go --no-pr',
    );
    expect(cli.runStart('tsk_1', 'fake', 'local', 'go', true)).toBe(
      'sf run start --task tsk_1 --agent fake --location local --prompt go',
    );
    expect(cli.runMessage('run_1', `also add a "README" & it's done`)).toBe(
      `sf run message run_1 'also add a "README" & it'\\''s done'`,
    );
    expect(cli.runCancel('run_1')).toBe('sf run cancel run_1');
    expect(cli.watch('run_1')).toBe('sf watch run_1');
    expect(cli.open('run_1')).toBe('sf open run_1');
    expect(cli.open()).toBe('sf open');
    expect(cli.daemon()).toBe('sf daemon');
    expect(cli.link()).toBe('sf link');
    expect(cli.link('prj_1')).toBe('sf link --project prj_1');
  });
});

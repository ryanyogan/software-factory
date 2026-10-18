import type { Run } from '@sf/contract';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';
import { buildTranscript, type RawRunEvent } from '@/lib/transcript';
import { ExternalLink } from './external-link';

const html = (href: string, text?: string) =>
  renderToStaticMarkup(createElement(ExternalLink, { href, 'data-testid': 'run-pr' }, text));

describe('ExternalLink (PR / repo urls from data)', () => {
  it('links http(s) urls in a new tab', () => {
    expect(html('https://github.com/acme/web/pull/1', 'PR')).toBe(
      '<a data-testid="run-pr" href="https://github.com/acme/web/pull/1" target="_blank" rel="noreferrer noopener">PR</a>',
    );
  });

  it('renders any other scheme as plain text, never as an href', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', '//x']) {
      const out = html(bad, 'PR');
      expect(out).not.toContain('<a');
      expect(out).not.toContain('href');
      expect(out).toContain('data-unsafe-url');
    }
  });
});

describe('transcript PR marker', () => {
  const run: Run = {
    id: 'run_1',
    taskId: 'tsk_1',
    agent: 'fake',
    location: 'local',
    state: 'review',
    prompt: 'p',
    openPr: true,
    createdAt: '2026-10-17T10:00:00.000Z',
    startedBy: 'dev',
    claimedBy: 'mch_a',
    claimedAt: '2026-10-17T10:00:01.000Z',
    sessionId: null,
    prUrl: null,
    costUsd: null,
    endedAt: null,
  };
  const prEvent = (url: string): RawRunEvent => ({
    seq: 1,
    type: 'pr.opened',
    payload: { url, run },
    at: 1,
  });

  it('shows a pr.opened event with an https url', () => {
    const t = buildTranscript([prEvent('https://github.com/acme/web/pull/1')], 'review');
    expect(JSON.stringify(t.blocks)).toContain('"kind":"pr"');
  });

  it('drops a pr.opened event whose url is not http(s) (contract rejects it → raw text)', () => {
    const t = buildTranscript([prEvent('javascript:alert(1)')], 'review');
    const items = JSON.stringify(t.blocks);
    expect(items).not.toContain('"kind":"pr"');
  });
});

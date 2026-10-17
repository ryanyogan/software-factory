import { describe, expect, it } from 'vite-plus/test';
import { parseInline, parseMarkdown, safeHref } from './markdown';

describe('markdown', () => {
  it('parses blocks', () => {
    const md =
      '# Title\n\nSome **bold** text\nsecond line\n\n- a\n- b\n\n1. one\n2. two\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\n---';
    expect(parseMarkdown(md).map((b) => b.t)).toEqual([
      'h',
      'p',
      'ul',
      'ol',
      'code',
      'quote',
      'hr',
    ]);
    const code = parseMarkdown('```ts\n<b>x</b>\n```')[0];
    expect(code).toEqual({ t: 'code', lang: 'ts', v: '<b>x</b>' });
  });

  it('parses inline code, emphasis and links', () => {
    expect(parseInline('use `a*b` and **strong** or *em*')).toEqual([
      { t: 'text', v: 'use ' },
      { t: 'code', v: 'a*b' },
      { t: 'text', v: ' and ' },
      { t: 'strong', c: [{ t: 'text', v: 'strong' }] },
      { t: 'text', v: ' or ' },
      { t: 'em', c: [{ t: 'text', v: 'em' }] },
    ]);
    expect(parseInline('snake_case_name stays')).toEqual([
      { t: 'text', v: 'snake_case_name stays' },
    ]);
    expect(parseInline('[docs](https://x.dev/a)')).toEqual([
      { t: 'link', href: 'https://x.dev/a', c: [{ t: 'text', v: 'docs' }] },
    ]);
  });

  it('never produces markup or unsafe links', () => {
    // Raw HTML stays text (React escapes it on render).
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { t: 'text', v: '<img src=x onerror=alert(1)>' },
    ]);
    // javascript: links degrade to their label.
    expect(parseInline('[click](javascript:alert(1))')).toEqual([
      { t: 'text', v: 'click' },
      { t: 'text', v: ')' },
    ]);
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

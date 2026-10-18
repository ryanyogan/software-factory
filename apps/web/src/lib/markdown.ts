/**
 * Tiny markdown subset → AST, rendered as React elements by `components/markdown.tsx`.
 * Raw HTML is never interpreted (it stays literal text), and links are limited to http(s)/mailto,
 * so agent output cannot inject markup or `javascript:` URLs.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' };

/** http(s) only — for URLs that come from data (PR, repo), not from markdown. */
export function webHref(href: string): string | null {
  const h = href.trim();
  return /^https?:\/\//i.test(h) ? h : null;
}

export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const UL = /^\s{0,3}[-*+]\s+(.*)$/;
const OL = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) =>
    FENCE.test(l) || HEADING.test(l) || UL.test(l) || OL.test(l) || HR.test(l) || QUOTE.test(l);

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) body.push(lines[i++]!);
      i++; // closing fence (or EOF)
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ t: 'h', level: h[1]!.length, c: parseInline(h[2]!) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({ t: 'quote', c: parseMarkdown(body.join('\n')) });
      continue;
    }
    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (ul || ol) {
      const re = ul ? UL : OL;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = re.exec(l);
        if (m) items.push(m[ul ? 1 : 2]!);
        else if (l.trim() !== '' && /^\s+/.test(l) && items.length)
          items[items.length - 1] += ' ' + l.trim();
        else break;
        i++;
      }
      const parsed = items.map(parseInline);
      blocks.push(
        ul ? { t: 'ul', items: parsed } : { t: 'ol', start: Number(ol![1]), items: parsed },
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !(para.length && startsBlock(lines[i]!)))
      para.push(lines[i++]!.trim());
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#+\-.!>]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] !== ' ' && src[i + 1] !== undefined) {
      // `_` only opens at a word boundary (snake_case stays literal).
      const prev = src[i - 1];
      if (ch === '*' || prev === undefined || /\W/.test(prev)) {
        const end = src.indexOf(ch, i + 1);
        if (end > i + 1 && src[end - 1] !== ' ' && (ch === '*' || !/\w/.test(src[end + 1] ?? ''))) {
          flush();
          out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        const href = safeHref(m[2]!);
        flush();
        if (href) out.push({ t: 'link', href, c: parseInline(m[1]!) });
        else out.push({ t: 'text', v: m[1]! });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

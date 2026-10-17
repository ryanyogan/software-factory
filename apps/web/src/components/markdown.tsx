import { Separator } from '@sf/ui/components/separator';
import { type ReactNode, useMemo } from 'react';
import { type Block, type Inline, parseMarkdown } from '@/lib/markdown';

/** Renders agent markdown as React elements only (no HTML injection; see lib/markdown.ts). */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="flex min-w-0 flex-col gap-2 leading-relaxed">{blocks.map(block)}</div>;
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'p':
      return (
        <p key={i} className="whitespace-pre-wrap">
          {inlines(b.c)}
        </p>
      );
    case 'h':
      return (
        <p key={i} className="font-semibold" role="heading" aria-level={b.level}>
          {inlines(b.c)}
        </p>
      );
    case 'code':
      return (
        <pre
          key={i}
          className="max-h-96 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs"
          data-lang={b.lang || undefined}
        >
          <code>{b.v}</code>
        </pre>
      );
    case 'ul':
      return (
        <ul key={i} className="ml-5 list-disc">
          {b.items.map((it, j) => (
            <li key={j}>{inlines(it)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={i} start={b.start} className="ml-5 list-decimal">
          {b.items.map((it, j) => (
            <li key={j}>{inlines(it)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote key={i} className="border-l-2 pl-3 text-muted-foreground">
          {b.c.map(block)}
        </blockquote>
      );
    case 'hr':
      return <Separator key={i} />;
  }
}

function inlines(list: Inline[]): ReactNode[] {
  return list.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            {n.v}
          </code>
        );
      case 'strong':
        return <strong key={i}>{inlines(n.c)}</strong>;
      case 'em':
        return <em key={i}>{inlines(n.c)}</em>;
      case 'link':
        return (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-3"
          >
            {inlines(n.c)}
          </a>
        );
    }
  });
}

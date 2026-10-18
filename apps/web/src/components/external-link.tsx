import type { ComponentProps, ReactNode } from 'react';
import { webHref } from '@/lib/markdown';

type Props = Omit<ComponentProps<'a'>, 'href' | 'children' | 'target' | 'rel'> & {
  href: string;
  children?: ReactNode;
  'data-testid'?: string;
};

/**
 * A link to a URL that came from data (PR urls, repo urls). Only http(s) becomes an `<a>`: any
 * other scheme (`javascript:`, `data:`, …) renders as plain text, so a bad value can't run script.
 */
export function ExternalLink({ href, children, className, 'data-testid': testId, ...rest }: Props) {
  const safe = webHref(href);
  if (!safe) {
    return (
      <span className={className} data-testid={testId} data-unsafe-url="">
        {href}
      </span>
    );
  }
  return (
    <a
      {...rest}
      className={className}
      data-testid={testId}
      href={safe}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children ?? href}
    </a>
  );
}

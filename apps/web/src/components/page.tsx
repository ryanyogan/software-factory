import { Skeleton } from '@sf/ui/components/skeleton';
import { useHydrated } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        {description && <div className="text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  );
}

/**
 * Local-time display. SSR has no viewer timezone, so the server (and first client render) print
 * UTC and the client switches to local time after hydration — no hydration mismatch.
 */
export function Time({ value, timeOnly }: { value: string | number; timeOnly?: boolean }) {
  const hydrated = useHydrated();
  const d = new Date(value);
  const opts: Intl.DateTimeFormatOptions = timeOnly
    ? { timeStyle: 'medium' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  const text = hydrated
    ? d.toLocaleString(undefined, opts)
    : d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' }) + ' UTC';
  return <time dateTime={d.toISOString()}>{text}</time>;
}

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@sf/ui/components/empty';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { InboxIcon } from 'lucide-react';
import { CopyCli } from '@/components/copy-cli';
import { PageHeader, TableSkeleton } from '@/components/page';
import { RunsTable } from '@/components/runs-table';
import { cli } from '@/lib/cli';
import { NEEDS_YOU, runsQuery } from '@/lib/queries';

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(runsQuery()),
  pendingComponent: TableSkeleton,
  component: Home,
});

function Home() {
  const { data } = useSuspenseQuery(runsQuery());
  const runs = data.runs.filter((r) => NEEDS_YOU.has(r.state));
  return (
    <>
      <PageHeader
        title="Needs you"
        description="Runs that are queued, blocked, or waiting for review."
        actions={<CopyCli command={cli.runList()} />}
      />
      {runs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing needs you</EmptyTitle>
            <EmptyDescription>Queued, blocked and review runs show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <RunsTable runs={runs} />
      )}
    </>
  );
}

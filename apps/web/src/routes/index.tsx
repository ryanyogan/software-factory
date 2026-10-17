import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@sf/ui/components/empty';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { InboxIcon } from 'lucide-react';
import { CopyCli } from '@/components/copy-cli';
import { PageHeader, TableSkeleton } from '@/components/page';
import { RunsTable } from '@/components/runs-table';
import { cli } from '@/lib/cli';
import { useProjectRooms } from '@/lib/project-room';
import { NEEDS_YOU, projectsQuery, runsQuery } from '@/lib/queries';

/** Review first, then failed, blocked, queued; newest first within a state. */
const ORDER = ['review', 'failed', 'blocked', 'queued'];

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(runsQuery()),
  pendingComponent: TableSkeleton,
  component: Home,
});

function Home() {
  const { data } = useSuspenseQuery(runsQuery());
  const runs = data.runs
    .filter((r) => NEEDS_YOU.has(r.state))
    .sort(
      (a, b) =>
        ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.createdAt.localeCompare(a.createdAt),
    );
  // Live: every project room's notices patch runs and refresh this list.
  const projectIds = useQuery(projectsQuery()).data?.projects.map((p) => p.id) ?? [];
  useProjectRooms(projectIds);
  return (
    <>
      <PageHeader
        title="Needs you"
        description="Runs waiting for review, failed, blocked, or not picked up yet."
        actions={<CopyCli command={cli.runList()} />}
      />
      {runs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing needs you</EmptyTitle>
            <EmptyDescription>
              Review, failed, blocked and queued runs show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <RunsTable runs={runs} reason task />
      )}
    </>
  );
}

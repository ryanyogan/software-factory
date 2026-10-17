import { Button } from '@sf/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@sf/ui/components/empty';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { CopyCli } from '@/components/copy-cli';
import { StartRunDialog } from '@/components/dialogs';
import { PageHeader, TableSkeleton } from '@/components/page';
import { RunsTable } from '@/components/runs-table';
import { cli } from '@/lib/cli';
import { runsQuery, tasksQuery } from '@/lib/queries';

export const Route = createFileRoute('/tasks/$taskId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(runsQuery(params.taskId)),
  pendingComponent: TableSkeleton,
  component: TaskPage,
});

function TaskPage() {
  const { taskId } = Route.useParams();
  const { data } = useSuspenseQuery(runsQuery(taskId));
  // No task.get command yet: find the task in the (cached) full task list.
  const task = useQuery(tasksQuery()).data?.tasks.find((t) => t.id === taskId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title={task?.title ?? taskId}
        description={task && <span className="font-mono text-xs">{task.branch}</span>}
        actions={
          <>
            <CopyCli command={cli.runList(taskId)} />
            <Button size="sm" onClick={() => setOpen(true)}>
              <PlayIcon data-icon="inline-start" />
              Start run
            </Button>
          </>
        }
      />
      {data.runs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No runs</EmptyTitle>
            <EmptyDescription>Start a run to put an agent on this task.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <RunsTable runs={data.runs} />
      )}
      <StartRunDialog open={open} onOpenChange={setOpen} taskId={taskId} />
    </>
  );
}

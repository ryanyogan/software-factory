import { Badge } from '@sf/ui/components/badge';
import { Button } from '@sf/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@sf/ui/components/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sf/ui/components/table';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { CopyCli } from '@/components/copy-cli';
import { CreateTaskDialog } from '@/components/dialogs';
import { PageHeader, TableSkeleton, Time } from '@/components/page';
import { cli } from '@/lib/cli';
import { projectsQuery, tasksQuery } from '@/lib/queries';

export const Route = createFileRoute('/projects/$projectId')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(tasksQuery(params.projectId)),
  pendingComponent: TableSkeleton,
  component: ProjectPage,
});

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { data } = useSuspenseQuery(tasksQuery(projectId));
  const project = useQuery(projectsQuery()).data?.projects.find((p) => p.id === projectId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title={project?.name ?? projectId}
        description={project?.repoUrl}
        actions={
          <>
            <CopyCli command={cli.taskList(projectId)} />
            <Button size="sm" onClick={() => setOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              New task
            </Button>
          </>
        }
      />
      {data.tasks.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No tasks</EmptyTitle>
            <EmptyDescription>Create a task, then start an agent run on it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.tasks.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">
                  <Link to="/tasks/$taskId" params={{ taskId: t.id }} className="hover:underline">
                    {t.title}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{t.branch}</TableCell>
                <TableCell>
                  <Badge variant="outline">{t.status}</Badge>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  <Time value={t.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CreateTaskDialog open={open} onOpenChange={setOpen} projectId={projectId} />
    </>
  );
}

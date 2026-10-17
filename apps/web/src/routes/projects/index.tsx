import { Button } from '@sf/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@sf/ui/components/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sf/ui/components/table';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useShell } from '@/components/app-shell';
import { CopyCli } from '@/components/copy-cli';
import { PageHeader, TableSkeleton, Time } from '@/components/page';
import { cli } from '@/lib/cli';
import { projectsQuery } from '@/lib/queries';

export const Route = createFileRoute('/projects/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQuery()),
  pendingComponent: TableSkeleton,
  component: Projects,
});

function Projects() {
  const { data } = useSuspenseQuery(projectsQuery());
  const { openCreateProject } = useShell();
  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          <>
            <CopyCli command={cli.projectList()} />
            <Button size="sm" onClick={openCreateProject}>
              <PlusIcon data-icon="inline-start" />
              New project
            </Button>
          </>
        }
      />
      {data.projects.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>Create one to start adding tasks.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={openCreateProject}>
              New project
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Id</TableHead>
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: p.id }}
                    className="hover:underline"
                  >
                    {p.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{p.repoUrl}</TableCell>
                <TableCell className="font-mono text-xs">{p.id}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  <Time value={p.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

import { Badge } from '@sf/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@sf/ui/components/card';
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
import { CopyCli } from '@/components/copy-cli';
import { PageHeader, TableSkeleton, Time } from '@/components/page';
import { StateBadge } from '@/components/state-badge';
import { cli } from '@/lib/cli';
import { runQuery } from '@/lib/queries';
import { runEventsQuery, useRunEvents } from '@/lib/run-events';

export const Route = createFileRoute('/runs/$runId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(runQuery(params.runId)),
  pendingComponent: TableSkeleton,
  component: RunPage,
});

function RunPage() {
  const { runId } = Route.useParams();
  const { data: run } = useSuspenseQuery(runQuery(runId));
  const events = useQuery(runEventsQuery(runId)).data ?? [];
  const status = useRunEvents(runId);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{run.id}</span>
            <StateBadge state={run.state} />
          </span>
        }
        description={
          <span>
            {run.agent} · {run.location} · task{' '}
            <Link
              to="/tasks/$taskId"
              params={{ taskId: run.taskId }}
              className="font-mono underline"
            >
              {run.taskId}
            </Link>{' '}
            · <Time value={run.createdAt} />
          </span>
        }
        actions={<CopyCli command={cli.runGet(run.id)} />}
      />
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Events
            <Badge variant={status === 'live' ? 'secondary' : 'outline'} data-testid="ws-status">
              {status}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-muted-foreground">Waiting for events…</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Payload</TableHead>
                  <TableHead className="text-right">At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => (
                  <TableRow key={e.seq} data-event={e.type}>
                    <TableCell className="text-muted-foreground">{e.seq}</TableCell>
                    <TableCell className="font-mono text-xs">{e.type}</TableCell>
                    <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground">
                      {JSON.stringify(e.payload)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      <Time value={e.at} timeOnly />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

import type { Run } from '@sf/contract';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sf/ui/components/table';
import { Link } from '@tanstack/react-router';
import { GitPullRequestIcon } from 'lucide-react';
import { formatCost, needsYouReason } from '@/lib/transcript';
import { Time } from './page';
import { StateBadge } from './state-badge';

/** Runs list. `reason` adds the Needs-you reason + PR link; `task` adds the task column. */
export function RunsTable({
  runs,
  reason = false,
  task = false,
}: {
  runs: Run[];
  reason?: boolean;
  task?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Prompt</TableHead>
          <TableHead>State</TableHead>
          {reason && <TableHead>Why</TableHead>}
          <TableHead>Agent</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          {task && <TableHead>Task</TableHead>}
          <TableHead className="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id} data-run={r.id} data-state={r.state}>
            <TableCell className="font-mono text-xs">
              <Link to="/runs/$runId" params={{ runId: r.id }} className="hover:underline">
                {r.id}
              </Link>
            </TableCell>
            <TableCell className="max-w-64 truncate" title={r.prompt}>
              {r.prompt || <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell>
              <StateBadge state={r.state} />
            </TableCell>
            {reason && (
              <TableCell className="text-muted-foreground">
                <span className="flex items-center gap-2">
                  {needsYouReason(r)}
                  {r.prUrl && (
                    <a
                      href={r.prUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-center gap-1 text-foreground hover:underline"
                      data-testid="pr-link"
                    >
                      <GitPullRequestIcon className="size-3.5" />
                      PR
                    </a>
                  )}
                </span>
              </TableCell>
            )}
            <TableCell>{r.agent}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCost(r.costUsd)}</TableCell>
            {task && (
              <TableCell className="font-mono text-xs">
                <Link to="/tasks/$taskId" params={{ taskId: r.taskId }} className="hover:underline">
                  {r.taskId}
                </Link>
              </TableCell>
            )}
            <TableCell className="text-right text-muted-foreground">
              <Time value={r.createdAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

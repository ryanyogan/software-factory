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
import { Time } from './page';
import { StateBadge } from './state-badge';

export function RunsTable({ runs }: { runs: Run[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Task</TableHead>
          <TableHead className="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-mono text-xs">
              <Link to="/runs/$runId" params={{ runId: r.id }} className="hover:underline">
                {r.id}
              </Link>
            </TableCell>
            <TableCell>
              <StateBadge state={r.state} />
            </TableCell>
            <TableCell>{r.agent}</TableCell>
            <TableCell>{r.location}</TableCell>
            <TableCell className="font-mono text-xs">
              <Link to="/tasks/$taskId" params={{ taskId: r.taskId }} className="hover:underline">
                {r.taskId}
              </Link>
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              <Time value={r.createdAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

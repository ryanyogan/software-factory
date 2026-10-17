import type { RunState } from '@sf/contract';
import { Badge } from '@sf/ui/components/badge';

const variant: Record<RunState, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  queued: 'secondary',
  running: 'default',
  blocked: 'destructive',
  checks: 'secondary',
  review: 'default',
  final_review: 'default',
  merged: 'outline',
  abandoned: 'outline',
};

export function StateBadge({ state }: { state: RunState }) {
  return (
    <Badge variant={variant[state]} data-state={state}>
      {state.replace('_', ' ')}
    </Badge>
  );
}

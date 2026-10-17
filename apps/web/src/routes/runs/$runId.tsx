import type { Run } from '@sf/contract';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@sf/ui/components/alert-dialog';
import { Badge } from '@sf/ui/components/badge';
import { Button } from '@sf/ui/components/button';
import { Field, FieldDescription, FieldError } from '@sf/ui/components/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@sf/ui/components/input-group';
import { Kbd } from '@sf/ui/components/kbd';
import { Spinner } from '@sf/ui/components/spinner';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, createFileRoute, useHydrated } from '@tanstack/react-router';
import { GitPullRequestIcon, SendIcon, SquareIcon } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { CopyCli } from '@/components/copy-cli';
import { PageHeader, TableSkeleton, Time } from '@/components/page';
import { StateBadge } from '@/components/state-badge';
import { TranscriptView } from '@/components/transcript';
import { cli } from '@/lib/cli';
import { runQuery, tasksQuery, useCancelRun, useSendMessage } from '@/lib/queries';
import { type RunEvent, applyRunEvent, runEventsQuery, useRunEvents } from '@/lib/run-events';
import {
  buildTranscript,
  canCancel,
  formatCost,
  formatElapsed,
  messageBlockedReason,
} from '@/lib/transcript';

export const Route = createFileRoute('/runs/$runId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(runQuery(params.runId)),
  pendingComponent: TableSkeleton,
  component: RunPage,
});

const NO_EVENTS: RunEvent[] = [];

function RunPage() {
  const { runId } = Route.useParams();
  const { data: run } = useSuspenseQuery(runQuery(runId));
  const events = useQuery(runEventsQuery(runId)).data ?? NO_EVENTS;
  const status = useRunEvents(runId);
  const transcript = useMemo(() => buildTranscript(events, run.state), [events, run.state]);
  // No task.get yet: the branch comes from the (cached) task list.
  const task = useQuery(tasksQuery()).data?.tasks.find((t) => t.id === run.taskId);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const followUp = useRef<HTMLTextAreaElement>(null);
  const cancellable = canCancel(run);

  // `c` cancel (confirmed: cancelling can't be undone), `/` focus the follow-up box.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        t?.closest('input,textarea,select,[contenteditable]')
      )
        return;
      if (e.key === 'c' && cancellable) {
        e.preventDefault();
        setConfirmCancel(true);
      } else if (e.key === '/') {
        e.preventDefault();
        followUp.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancellable]);

  const cost = Math.max(run.costUsd ?? 0, transcript.costUsd ?? 0);
  const hasCost = run.costUsd !== null || transcript.costUsd !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{run.id}</span>
            <StateBadge state={run.state} />
            <Badge variant={status === 'live' ? 'secondary' : 'outline'} data-testid="ws-status">
              {status}
            </Badge>
          </span>
        }
        description={
          <span>
            task{' '}
            <Link
              to="/tasks/$taskId"
              params={{ taskId: run.taskId }}
              className="font-mono underline"
            >
              {task?.title ?? run.taskId}
            </Link>{' '}
            · <Time value={run.createdAt} />
          </span>
        }
        actions={
          <>
            <CopyCli command={cli.watch(run.id)} />
            {cancellable && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmCancel(true)}
                data-testid="cancel-run"
              >
                <SquareIcon data-icon="inline-start" />
                Cancel
                <Kbd>c</Kbd>
              </Button>
            )}
          </>
        }
      />
      <RunFacts
        run={run}
        branch={task?.branch}
        cost={hasCost ? formatCost(cost) : '—'}
        model={transcript.model}
      />
      <div className="flex h-[60svh] min-h-80 flex-col">
        <TranscriptView
          transcript={transcript}
          prompt={run.prompt}
          empty={<p className="text-muted-foreground">{emptyText(run, status)}</p>}
        />
      </div>
      <FollowUp run={run} inputRef={followUp} />
      <CancelDialog run={run} open={confirmCancel} onOpenChange={setConfirmCancel} />
    </div>
  );
}

function emptyText(run: Run, status: string): string {
  if (status === 'connecting') return 'Connecting…';
  if (run.state === 'queued')
    return run.location === 'local'
      ? 'Queued. Waiting for a daemon (sf daemon) on a machine where this repo is linked.'
      : 'Queued.';
  return 'No events yet.';
}

function RunFacts({
  run,
  branch,
  cost,
  model,
}: {
  run: Run;
  branch?: string;
  cost: string;
  model: string | null;
}) {
  return (
    <dl
      className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl px-3 py-2 ring-1 ring-foreground/10 sm:grid-cols-4 lg:grid-cols-7"
      data-testid="run-facts"
    >
      <Fact label="Agent">
        {model && model !== run.agent ? `${run.agent} (${model})` : run.agent}
      </Fact>
      <Fact label="Location">{run.location}</Fact>
      <Fact label="Machine">{run.claimedBy ?? '—'}</Fact>
      <Fact label="Cost">{cost}</Fact>
      <Fact label="Elapsed">
        <Elapsed run={run} />
      </Fact>
      <Fact label="Branch">{branch ? <span className="font-mono">{branch}</span> : '—'}</Fact>
      <Fact label="PR">
        {run.prUrl ? (
          <a
            href={run.prUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1 underline underline-offset-3"
            data-testid="run-pr"
          >
            <GitPullRequestIcon className="size-3.5" />
            {run.prUrl.replace(/^https?:\/\/(www\.)?/, '')}
          </a>
        ) : run.openPr ? (
          'when the run ends'
        ) : (
          'off'
        )}
      </Fact>
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

/** Ticks every second while the run is live. SSR / first render prints nothing time-dependent. */
function Elapsed({ run }: { run: Run }) {
  const hydrated = useHydrated();
  const [now, setNow] = useState(() => Date.now());
  const live = run.endedAt === null && run.state !== 'queued';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!hydrated || run.state === 'queued') return <span>—</span>;
  const start = Date.parse(run.claimedAt ?? run.createdAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  return <span className="tabular-nums">{formatElapsed(end - start)}</span>;
}

function FollowUp({
  run,
  inputRef,
}: {
  run: Run;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const send = useSendMessage();
  const blocked = messageBlockedReason(run);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || blocked || send.isPending) return;
    send.mutate(
      { id: run.id, text: body },
      {
        onSuccess: ({ event }) => {
          applyRunEvent(qc, run.id, event);
          setText('');
        },
      },
    );
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') inputRef.current?.blur();
  };

  const hint =
    blocked ??
    (run.state === 'running'
      ? 'Sent to the running agent.'
      : run.state === 'queued'
        ? 'Delivered when a daemon picks the run up.'
        : 'The daemon resumes the agent session with this message.');

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="follow-up">
      <Field data-invalid={send.isError || undefined} data-disabled={blocked ? true : undefined}>
        <InputGroup>
          <InputGroupTextarea
            ref={inputRef}
            aria-label="Follow-up message"
            placeholder={blocked ? '' : 'Steer the agent… (/ to focus)'}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={!!blocked}
            aria-invalid={send.isError || undefined}
          />
          <InputGroupAddon align="block-end">
            <span className="text-xs text-muted-foreground">
              <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd>
            </span>
            <InputGroupButton
              type="submit"
              variant="default"
              size="sm"
              className="ml-auto"
              disabled={!!blocked || !text.trim() || send.isPending}
            >
              {send.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SendIcon data-icon="inline-start" />
              )}
              Send
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {send.error ? (
          <FieldError>{send.error.message}</FieldError>
        ) : (
          <FieldDescription data-testid="follow-up-hint">{hint}</FieldDescription>
        )}
      </Field>
      <CopyCli command={cli.runMessage(run.id, text.trim() || '<message>')} />
    </form>
  );
}

function CancelDialog({
  run,
  open,
  onOpenChange,
}: {
  run: Run;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cancel = useCancelRun();
  const confirm = () =>
    cancel.mutate(run.id, {
      onSuccess: (r) => {
        toast.success(r.state === 'running' ? 'Cancel requested' : 'Run cancelled', {
          description: r.id,
        });
        onOpenChange(false);
      },
      onError: (e) => toast.error('Cancel failed', { description: e.message }),
    });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
          <AlertDialogDescription>
            {run.state === 'running'
              ? 'The daemon stops the agent and the run becomes abandoned. Uncommitted changes stay in the task worktree.'
              : 'The run becomes abandoned before an agent works on it.'}{' '}
            This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <CopyCli command={cli.runCancel(run.id)} />
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            disabled={cancel.isPending}
            data-testid="confirm-cancel"
          >
            Cancel run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

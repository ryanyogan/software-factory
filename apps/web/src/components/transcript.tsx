import { Bubble, BubbleContent } from '@sf/ui/components/bubble';
import { Marker, MarkerContent, MarkerIcon } from '@sf/ui/components/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from '@sf/ui/components/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@sf/ui/components/message-scroller';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@sf/ui/components/trace';
import {
  BrainIcon,
  CircleAlertIcon,
  FilePenIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  type LucideIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  type ActivityItem,
  type Block,
  type Transcript,
  formatCost,
  formatTokens,
  stateNote,
} from '@/lib/transcript';
import { DiffSnapshotView } from './diff-view';
import { Markdown } from './markdown';
import { Time } from './page';
import { ExternalLink } from './external-link';

/**
 * The run transcript. `MessageScroller` follows new rows (autoScroll) and stops following as soon as
 * the reader scrolls up; the jump-to-latest button brings it back.
 */
export function TranscriptView({
  transcript,
  prompt,
  empty,
}: {
  transcript: Transcript;
  prompt: string;
  empty?: ReactNode;
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="rounded-xl ring-1 ring-foreground/10">
        <MessageScrollerViewport aria-label="Run transcript" data-testid="transcript">
          <MessageScrollerContent className="gap-3 p-3">
            {prompt && (
              <MessageScrollerItem messageId="prompt">
                <UserTurn text={prompt} header="Prompt" />
              </MessageScrollerItem>
            )}
            {transcript.blocks.map((b) => (
              <MessageScrollerItem key={b.key} messageId={b.key}>
                <BlockView block={b} />
              </MessageScrollerItem>
            ))}
            {transcript.blocks.length === 0 && empty && (
              <MessageScrollerItem messageId="empty">{empty}</MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function UserTurn({ text, header, footer }: { text: string; header: string; footer?: ReactNode }) {
  return (
    <Message align="end">
      <MessageContent>
        <MessageHeader>{header}</MessageHeader>
        <Bubble variant="secondary" align="end">
          <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
        </Bubble>
        {footer && <MessageFooter>{footer}</MessageFooter>}
      </MessageContent>
    </Message>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'activity':
      return (
        <Trace data-testid="activity">
          {block.items.map((i) => (
            <ActivityRow key={i.key} item={i} />
          ))}
        </Trace>
      );
    case 'assistant':
      return (
        <Message data-testid="assistant">
          <MessageContent>
            <Markdown text={block.text} />
          </MessageContent>
        </Message>
      );
    case 'user':
      return (
        <div data-testid="user-message" data-pending={block.pending || undefined}>
          <UserTurn
            text={block.text}
            header={`Follow-up from ${block.authorId}`}
            footer={
              <span>
                <Time value={block.at} timeOnly />
                {block.pending && ' · waiting for the agent'}
              </span>
            }
          />
        </div>
      );
    case 'error':
      return (
        <Marker data-testid="agent-error" className="text-destructive">
          <MarkerIcon>
            <CircleAlertIcon />
          </MarkerIcon>
          <MarkerContent>
            {block.fatal ? 'Fatal error: ' : 'Error: '}
            {block.message}
          </MarkerContent>
        </Marker>
      );
    case 'turn': {
      const u = block.usage;
      const parts = [`Turn ${block.turn}${block.isError ? ' failed' : ''}`];
      if (u) parts.push(`${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out`);
      if (u?.costUsd !== undefined) parts.push(formatCost(u.costUsd));
      return (
        <Marker variant="separator" data-testid="turn" data-turn={block.turn}>
          <MarkerContent>{parts.join(' · ')}</MarkerContent>
        </Marker>
      );
    }
    case 'diff':
      return <DiffSnapshotView diff={block} />;
    case 'state':
      return (
        <Marker variant="separator" data-testid="state" data-to={block.to}>
          <MarkerContent>{block.to === 'running' ? 'Resumed' : stateNote(block.to)}</MarkerContent>
        </Marker>
      );
    case 'note':
      return (
        <Marker>
          <MarkerContent>{block.text}</MarkerContent>
        </Marker>
      );
    case 'pr':
      return (
        <Marker data-testid="pr">
          <MarkerIcon>
            <GitPullRequestIcon />
          </MarkerIcon>
          <MarkerContent>
            Opened <ExternalLink href={block.url} />
          </MarkerContent>
        </Marker>
      );
    case 'raw':
      return (
        <Marker>
          <MarkerContent className="font-mono text-xs">
            {block.type} {JSON.stringify(block.payload)}
          </MarkerContent>
        </Marker>
      );
  }
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  Bash: TerminalIcon,
  shell: TerminalIcon,
  command: TerminalIcon,
};

function ActivityRow({ item }: { item: ActivityItem }) {
  switch (item.kind) {
    case 'reasoning':
      return (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <BrainIcon />
              </TraceIcon>
              <TraceTitle>Thought</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="whitespace-pre-wrap">
            {item.text}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      );
    case 'files':
      return (
        <TraceLine>
          <TraceIcon>
            <FilePenIcon />
          </TraceIcon>
          <TraceTitle>
            Changed {item.changes.map((c) => c.path.split('/').at(-1)).join(', ')}
          </TraceTitle>
          <TraceDescription>{item.changes.length}</TraceDescription>
        </TraceLine>
      );
    case 'todo': {
      const done = item.items.filter((t) => t.done).length;
      return (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <ListTodoIcon />
              </TraceIcon>
              <TraceTitle>Updated todos</TraceTitle>
              <TraceDescription>
                {done}/{item.items.length}
              </TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <ul>
              {item.items.map((t, i) => (
                <li key={i} className={t.done ? 'line-through' : undefined}>
                  {t.text}
                </li>
              ))}
            </ul>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      );
    }
    case 'tool': {
      const Icon = TOOL_ICONS[item.name] ?? WrenchIcon;
      const status =
        item.status === 'running' ? 'running' : item.status === 'error' ? 'error' : undefined;
      const verb =
        item.status === 'running' ? 'Running' : item.status === 'error' ? 'Failed' : 'Ran';
      const line = (
        <TraceLine status={status} data-testid="tool" data-tool={item.name}>
          <TraceIcon>
            <Icon />
          </TraceIcon>
          <TraceTitle>
            {verb} {item.name}
            {item.summary && <span className="font-mono text-xs"> {item.summary}</span>}
          </TraceTitle>
        </TraceLine>
      );
      if (item.output === undefined && item.input === undefined) return line;
      return (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="flex flex-col gap-2">
            {item.input !== undefined && <Pre label="Input" text={stringify(item.input)} />}
            {item.output !== undefined && (
              <Pre
                label={item.truncated ? 'Output (truncated)' : 'Output'}
                text={item.output || '(no output)'}
              />
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      );
    }
  }
}

function Pre({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs">{label}</span>
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap text-foreground">
        {text}
      </pre>
    </div>
  );
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
}

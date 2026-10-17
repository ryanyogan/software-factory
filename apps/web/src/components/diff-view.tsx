import { Badge } from '@sf/ui/components/badge';
import { Button } from '@sf/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@sf/ui/components/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@sf/ui/components/collapsible';
import { cn } from '@sf/ui/lib/utils';
import { ChevronRightIcon, FileDiffIcon } from 'lucide-react';
import { useState } from 'react';
import type { DiffFile, DiffLine } from '@/lib/diff';
import type { Item } from '@/lib/transcript';

type DiffItem = Extract<Item, { kind: 'diff' }>;

/** Per-turn `diff.snapshot`: cumulative unified diff vs the task's base, file list with +/- stats. */
export function DiffSnapshotView({ diff }: { diff: DiffItem }) {
  const [open, setOpen] = useState(diff.latest);
  const { stats } = diff;
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card size="sm" data-testid="diff-snapshot" data-turn={diff.turn}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileDiffIcon />
            Changes after turn {diff.turn}
          </CardTitle>
          <CardDescription>
            {stats.files} file{stats.files === 1 ? '' : 's'}{' '}
            <Stat add={stats.additions} del={stats.deletions} /> vs{' '}
            <span className="font-mono">{diff.base.slice(0, 7)}</span>
          </CardDescription>
          <CardAction>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={open ? 'Hide diff' : 'Show diff'}>
                {open ? 'Hide' : 'Show'}
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent asChild>
          <CardContent className="flex flex-col gap-2">
            {diff.truncated ? (
              <p className="text-muted-foreground">
                The diff is too large to show here; open the task worktree to review it.
              </p>
            ) : diff.files.length === 0 ? (
              <p className="text-muted-foreground">No changes against the base.</p>
            ) : (
              diff.files.map((f) => <FileDiff key={f.path} file={f} />)
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function Stat({ add, del }: { add: number; del: number }) {
  return (
    <span className="font-mono tabular-nums">
      <span className="text-diff-add">+{add}</span> <span className="text-diff-del">-{del}</span>
    </span>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border"
      data-file={file.path}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start rounded-b-none font-mono text-xs"
          aria-expanded={open}
        >
          <ChevronRightIcon
            data-icon="inline-start"
            className={cn('transition-transform', open && 'rotate-90')}
          />
          <span className="truncate">
            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
          {file.status !== 'modified' && <Badge variant="outline">{file.status}</Badge>}
          <span className="ml-auto">
            <Stat add={file.additions} del={file.deletions} />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {file.binary ? (
          <p className="border-t p-2 text-muted-foreground">Binary file</p>
        ) : (
          <div className="overflow-x-auto border-t">
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <tbody>
                {file.hunks.map((h, i) => (
                  <HunkRows key={i} header={h.header} lines={h.lines} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function HunkRows({ header, lines }: { header: string; lines: DiffLine[] }) {
  return (
    <>
      <tr className="bg-muted/50 text-muted-foreground">
        <td colSpan={3} className="px-2">
          {header}
        </td>
      </tr>
      {lines.map((l, i) => (
        <tr
          key={i}
          data-kind={l.kind}
          className={cn(
            l.kind === 'add' && 'bg-diff-add/10',
            l.kind === 'del' && 'bg-diff-del/10',
            l.kind === 'meta' && 'text-muted-foreground',
          )}
        >
          <td className="w-10 px-1 text-right text-muted-foreground select-none">{l.oldNo}</td>
          <td className="w-10 px-1 text-right text-muted-foreground select-none">{l.newNo}</td>
          <td className="px-2 whitespace-pre">
            <span className="select-none text-muted-foreground">
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
            </span>
            {l.text}
          </td>
        </tr>
      ))}
    </>
  );
}

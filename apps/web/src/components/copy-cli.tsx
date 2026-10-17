import { Button } from '@sf/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@sf/ui/components/tooltip';
import { cn } from '@sf/ui/lib/utils';
import { CheckIcon, TerminalIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/** "Copy as CLI": every GUI action shows the equivalent `sf` command. */
export function CopyCli({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success('Copied CLI command', { description: command });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Clipboard unavailable', { description: command });
    }
  };
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2',
        className,
      )}
      data-testid="copy-cli"
    >
      <code className="truncate font-mono text-xs text-muted-foreground">{command}</code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" onClick={copy} aria-label="Copy as CLI">
            {copied ? <CheckIcon /> : <TerminalIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy as CLI</TooltipContent>
      </Tooltip>
    </div>
  );
}

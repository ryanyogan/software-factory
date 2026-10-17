import type { Agent, RunLocation } from '@sf/contract';
import { Alert, AlertDescription } from '@sf/ui/components/alert';
import { Button } from '@sf/ui/components/button';
import { Checkbox } from '@sf/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@sf/ui/components/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@sf/ui/components/field';
import { Input } from '@sf/ui/components/input';
import { Textarea } from '@sf/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@sf/ui/components/select';
import { useNavigate } from '@tanstack/react-router';
import { InfoIcon } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useState } from 'react';
import { toast } from 'sonner';
import { agentsFor } from '@/lib/agents';
import { cli } from '@/lib/cli';
import { useCreateProject, useCreateTask, useStartRun } from '@/lib/queries';
import { CopyCli } from './copy-cli';

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

export function CreateProjectDialog({ open, onOpenChange }: DialogProps) {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const create = useCreateProject();
  const navigate = useNavigate();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name, repoUrl: repoUrl.trim() || undefined },
      {
        onSuccess: (p) => {
          toast.success(`Project ${p.name} created`);
          onOpenChange(false);
          setName('');
          setRepoUrl('');
          void navigate({ to: '/projects/$projectId', params: { projectId: p.id } });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>A project can link to one git repository.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">Name</FieldLabel>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field data-invalid={create.isError || undefined}>
              <FieldLabel htmlFor="project-repo">Repository URL (optional)</FieldLabel>
              <Input
                id="project-repo"
                type="url"
                placeholder="https://github.com/org/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                aria-invalid={create.isError || undefined}
              />
              {create.error && <FieldError>{create.error.message}</FieldError>}
            </Field>
          </FieldGroup>
          <CopyCli command={cli.projectCreate(name || '<name>', repoUrl || undefined)} />
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  projectId,
}: DialogProps & { projectId: string }) {
  const [title, setTitle] = useState('');
  const create = useCreateTask();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { projectId, title },
      {
        onSuccess: (t) => {
          toast.success('Task created', { description: t.title });
          onOpenChange(false);
          setTitle('');
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>The branch defaults to a slug of the title.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={create.isError || undefined}>
              <FieldLabel htmlFor="task-title">Title</FieldLabel>
              <Input
                id="task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                autoFocus
                aria-invalid={create.isError || undefined}
              />
              {create.error && <FieldError>{create.error.message}</FieldError>}
            </Field>
          </FieldGroup>
          <CopyCli command={cli.taskCreate(projectId, title || '<title>')} />
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const LOCATIONS: RunLocation[] = ['local', 'cloud'];

export function StartRunDialog({ open, onOpenChange, taskId }: DialogProps & { taskId: string }) {
  const [agent, setAgent] = useState<Agent>('claude-code');
  const [location, setLocation] = useState<RunLocation>('local');
  const [prompt, setPrompt] = useState('');
  const [openPr, setOpenPr] = useState(true);
  const start = useStartRun();
  const navigate = useNavigate();

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || start.isPending) return;
    start.mutate(
      { taskId, agent, location, prompt, openPr },
      {
        onSuccess: (run) => {
          toast.success('Run queued', { description: run.id });
          onOpenChange(false);
          setPrompt('');
          void navigate({ to: '/runs/$runId', params: { runId: run.id } });
        },
      },
    );
  };
  const onPromptKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Start run</DialogTitle>
            <DialogDescription>Queue an agent run for this task.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="run-prompt">Prompt</FieldLabel>
              <Textarea
                id="run-prompt"
                required
                autoFocus
                rows={6}
                placeholder="What should the agent do?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onPromptKey}
              />
              <FieldDescription>Ctrl/⌘ + Enter to start.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="run-agent">Agent</FieldLabel>
              <Select value={agent} onValueChange={(v) => setAgent(v as Agent)}>
                <SelectTrigger id="run-agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {agentsFor(
                      typeof window === 'undefined' ? undefined : window.location.hostname,
                    ).map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="run-location">Location</FieldLabel>
              <Select value={location} onValueChange={(v) => setLocation(v as RunLocation)}>
                <SelectTrigger id="run-location">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {LOCATIONS.map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="run-open-pr"
                checked={openPr}
                onCheckedChange={(v) => setOpenPr(v === true)}
              />
              <FieldContent>
                <FieldLabel htmlFor="run-open-pr">Open a draft PR when the run ends</FieldLabel>
                <FieldDescription>
                  Needs a GitHub remote and the gh CLI on the daemon.
                </FieldDescription>
              </FieldContent>
            </Field>
            {start.error && <FieldError>{start.error.message}</FieldError>}
          </FieldGroup>
          {location === 'local' && (
            <Alert>
              <InfoIcon />
              <AlertDescription>
                <span>
                  Local runs are picked up by <code className="font-mono">sf daemon</code> running
                  on a machine where this project&apos;s repo is linked (
                  <code className="font-mono">sf link</code>).
                </span>
              </AlertDescription>
            </Alert>
          )}
          <CopyCli command={cli.runStart(taskId, agent, location, prompt || '<prompt>', openPr)} />
          <DialogFooter>
            <Button type="submit" disabled={start.isPending || !prompt.trim()}>
              Start run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

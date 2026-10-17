/** Builds the exact `sf ...` invocation for an action so every GUI action is reproducible in a shell. */

const SAFE = /^[\w@%+=:,./-]+$/;

/** POSIX-shell quote: bare when safe, otherwise single quotes with embedded `'` escaped. */
export function shellQuote(value: string): string {
  if (value !== '' && SAFE.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type Flags = Record<string, string | undefined>;

export function sf(command: string, flags: Flags = {}, args: string[] = []): string {
  const parts = ['sf', command, ...args.map(shellQuote)];
  for (const [k, v] of Object.entries(flags))
    if (v !== undefined && v !== '') parts.push(`--${k}`, shellQuote(v));
  return parts.join(' ');
}

export const cli = {
  projectCreate: (name: string, repoUrl?: string) => sf('project create', { name, repo: repoUrl }),
  projectList: () => sf('project list'),
  taskCreate: (projectId: string, title: string) =>
    sf('task create', { project: projectId, title }),
  taskList: (projectId: string) => sf('task list', { project: projectId }),
  runStart: (taskId: string, agent: string, location: string, prompt: string, openPr = true) =>
    sf('run start', { task: taskId, agent, location, prompt }) + (openPr ? '' : ' --no-pr'),
  runList: (taskId?: string) => sf('run list', { task: taskId }),
  runGet: (id: string) => sf('run get', {}, [id]),
  runMessage: (id: string, text: string) => sf('run message', {}, [id, text]),
  runCancel: (id: string) => sf('run cancel', {}, [id]),
  /** Follow a run's events in the terminal. */
  watch: (id: string) => sf('watch', {}, [id]),
  /** Open a run in the browser from a shell. */
  open: (id?: string) => sf('open', {}, id ? [id] : []),
  daemon: () => sf('daemon'),
  link: (projectId?: string) => sf('link', { project: projectId }),
};

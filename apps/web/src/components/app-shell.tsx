import { Button } from '@sf/ui/components/button';
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@sf/ui/components/command';
import { Kbd } from '@sf/ui/components/kbd';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@sf/ui/components/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@sf/ui/components/sidebar';
import { Skeleton } from '@sf/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  FactoryIcon,
  FolderIcon,
  LogInIcon,
  InboxIcon,
  LayoutListIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
} from 'lucide-react';
import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '@/lib/auth-client';
import { projectsQuery, viewerQuery } from '@/lib/queries';
import { CreateProjectDialog } from './dialogs';
import { ThemeToggle, useTheme } from './theme';

type Shell = { openPalette: () => void; openCreateProject: () => void };
const ShellContext = createContext<Shell>({ openPalette: () => {}, openCreateProject: () => {} });
export const useShell = () => useContext(ShellContext);

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const theme = useTheme();

  const navigate = useNavigate();
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        t?.closest('input,textarea,select,[contenteditable]')
      )
        return;
      // Two-key "g h" / "g p" navigation.
      if (e.key === 'g') gAt = Date.now();
      else if (Date.now() - gAt < 1000) {
        if (e.key === 'h') void navigate({ to: '/' });
        if (e.key === 'p') void navigate({ to: '/projects' });
        gAt = 0;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);

  const shell: Shell = {
    openPalette: () => setPaletteOpen(true),
    openCreateProject: () => setCreateProjectOpen(true),
  };

  return (
    <ShellContext.Provider value={shell}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
            <SidebarTrigger />
            <Button
              variant="outline"
              size="sm"
              className="w-56 justify-start text-muted-foreground"
              onClick={shell.openPalette}
            >
              <SearchIcon data-icon="inline-start" />
              Search or run…
              <Kbd className="ml-auto">⌘K</Kbd>
            </Button>
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle theme={theme} />
              <ViewerMenu />
            </div>
          </header>
          <main className="flex flex-1 flex-col gap-4 p-4">{children}</main>
        </SidebarInset>
      </SidebarProvider>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onCreateProject={() => setCreateProjectOpen(true)}
        onCycleTheme={theme.cycle}
      />
      <CreateProjectDialog open={createProjectOpen} onOpenChange={setCreateProjectOpen} />
    </ShellContext.Provider>
  );
}

function AppSidebar() {
  const projects = useQuery(projectsQuery());
  const { openCreateProject } = useShell();
  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link to="/">
                <FactoryIcon />
                <span className="font-semibold">Software Factory</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link
                    to="/"
                    activeOptions={{ exact: true }}
                    activeProps={{ 'data-active': true }}
                  >
                    <InboxIcon />
                    <span>Needs you</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link
                    to="/projects"
                    activeOptions={{ exact: true }}
                    activeProps={{ 'data-active': true }}
                  >
                    <LayoutListIcon />
                    <span>Projects</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupAction title="New project" onClick={openCreateProject}>
            <PlusIcon />
            <span className="sr-only">New project</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.isPending &&
                [0, 1].map((i) => (
                  <SidebarMenuItem key={i}>
                    <Skeleton className="h-7" />
                  </SidebarMenuItem>
                ))}
              {projects.data?.projects.map((p) => (
                <SidebarMenuItem key={p.id}>
                  <SidebarMenuButton asChild>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: p.id }}
                      activeProps={{ 'data-active': true }}
                    >
                      <FolderIcon />
                      <span>{p.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function ViewerMenu() {
  const viewer = useQuery(viewerQuery());
  const signIn = async () => {
    const res = await authClient.signIn.social({ provider: 'github', callbackURL: '/' });
    if (res.error) toast.error('GitHub sign-in unavailable', { description: res.error.message });
  };
  if (viewer.isPending) return <Skeleton className="h-7 w-24" />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="viewer">
          <UserIcon data-icon="inline-start" />
          {viewer.data ? viewer.data.name : 'Signed out'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {viewer.data
              ? `${viewer.data.email}${viewer.data.kind === 'dev' ? ' (dev bypass)' : ''}`
              : 'Not signed in'}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => void signIn()}>
            <LogInIcon />
            Sign in with GitHub
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CommandPalette({
  open,
  onOpenChange,
  onCreateProject,
  onCycleTheme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateProject: () => void;
  onCycleTheme: () => void;
}) {
  const navigate = useNavigate();
  const projects = useQuery({ ...projectsQuery(), enabled: open });
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Create">
            <CommandItem onSelect={run(onCreateProject)}>
              <PlusIcon />
              New project
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Go to">
            <CommandItem onSelect={run(() => void navigate({ to: '/' }))}>
              <InboxIcon />
              Needs you
              <CommandShortcut>g h</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => void navigate({ to: '/projects' }))}>
              <LayoutListIcon />
              Projects
              <CommandShortcut>g p</CommandShortcut>
            </CommandItem>
            {projects.data?.projects.map((p) => (
              <CommandItem
                key={p.id}
                value={`project ${p.name} ${p.id}`}
                onSelect={run(
                  () => void navigate({ to: '/projects/$projectId', params: { projectId: p.id } }),
                )}
              >
                <FolderIcon />
                {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Preferences">
            <CommandItem onSelect={run(onCycleTheme)}>Toggle theme</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

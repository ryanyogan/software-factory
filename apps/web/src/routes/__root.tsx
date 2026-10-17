import { TooltipProvider } from '@sf/ui/components/tooltip';
import { Toaster } from '@sf/ui/components/sonner';
import appCss from '@sf/ui/globals.css?url';
import type { QueryClient } from '@tanstack/react-query';
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { THEME_INIT_SCRIPT } from '@/components/theme';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Software Factory' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: 'data:,' },
    ],
  }),
  shellComponent: RootDocument,
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: () => <p className="text-muted-foreground">Not found.</p>,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="bg-background text-sm text-foreground antialiased">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}

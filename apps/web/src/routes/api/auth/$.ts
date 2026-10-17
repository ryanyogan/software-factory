import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

/** Better Auth lives in sf-api; proxy it so session cookies are set on the web origin. */
const proxy = ({ request }: { request: Request }) => env.API.fetch(request);

export const Route = createFileRoute('/api/auth/$')({
  server: { handlers: { GET: proxy, POST: proxy } },
});

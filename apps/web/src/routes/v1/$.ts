import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

/**
 * `/v1/*` → sf-api over the service binding (streamed, incl. WebSocket upgrades), so the browser
 * (run events) and the CLI can both use the web origin in dev: `SF_API_URL=http://localhost:5173`.
 */
const proxy = ({ request }: { request: Request }) => env.API.fetch(request);

export const Route = createFileRoute('/v1/$')({
  server: { handlers: { ANY: proxy } },
});

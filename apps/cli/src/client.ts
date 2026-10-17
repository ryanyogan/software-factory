import { type Client, createClient } from '@sf/contract';
import type { GlobalArgs } from './args';
import { readConfig, resolveApiUrl } from './config';

/** The ONE API: every data command goes through `createClient` from @sf/contract. */
export function apiClient(args: GlobalArgs): Client {
  return createClient({
    baseUrl: resolveApiUrl(args.api),
    token: async () => process.env.SF_TOKEN || (await readConfig()).token,
  });
}

import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { clearConfig, configPath, readConfig, resolveApiUrl, writeConfig } from '../config';
import { deviceLogin, fetchSessionUser } from '../login';
import { action, io, record } from '../output';

export const login = defineCommand({
  meta: { name: 'login', description: 'Sign in via the browser (device code)' },
  args: { ...globalArgs },
  run: ({ args }) => {
    const apiUrl = resolveApiUrl(args.api);
    return action(
      args,
      async () => {
        const token = await deviceLogin({
          apiUrl,
          onCode: (c) => {
            // Always stderr, so `--json` stdout stays a single JSON document.
            io.err(`Open ${c.verification_uri_complete ?? c.verification_uri}`);
            io.err(`and confirm the code: ${c.user_code}`);
            io.err('Waiting for approval…');
          },
        });
        const user = await fetchSessionUser(apiUrl, token);
        if (!user) throw new Error('login succeeded but the session could not be read');
        await writeConfig({ ...(await readConfig()), token, apiUrl, user });
        return { user, apiUrl, config: configPath() };
      },
      (d) => `Logged in as ${d.user.email ?? d.user.id} (${d.apiUrl})`,
    );
  },
});

export const logout = defineCommand({
  meta: { name: 'logout', description: 'Forget the stored session' },
  args: { ...globalArgs },
  run: ({ args }) =>
    action(
      args,
      async () => {
        const config = await readConfig();
        if (config.token) {
          // Best effort server-side revoke; the local token is removed regardless.
          await fetch(
            `${resolveApiUrl(args.api || process.env.SF_API_URL || config.apiUrl)}/api/auth/sign-out`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${config.token}`,
                'content-type': 'application/json',
              },
              body: '{}',
            },
          ).catch(() => undefined);
        }
        await clearConfig();
        return { loggedOut: Boolean(config.token) };
      },
      (d) => (d.loggedOut ? 'Logged out.' : 'Not logged in.'),
    ),
});

export const whoami = defineCommand({
  meta: { name: 'whoami', description: 'Show the signed-in user (verifies the stored token)' },
  args: { ...globalArgs },
  run: ({ args }) =>
    action(
      args,
      async () => {
        const config = await readConfig();
        const token = process.env.SF_TOKEN || config.token;
        const apiUrl = resolveApiUrl(args.api || process.env.SF_API_URL || config.apiUrl);
        if (!token) throw new Error('not logged in (run `sf login`)');
        const user = await fetchSessionUser(apiUrl, token);
        if (!user) throw new Error('session expired or revoked (run `sf login`)');
        return { user, apiUrl };
      },
      (d) =>
        record([
          ['user', d.user.email ?? d.user.id],
          ['id', d.user.id],
          ['api', d.apiUrl],
        ]),
    ),
});

import { Button } from '@sf/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@sf/ui/components/card';
import { Field, FieldDescription, FieldLabel } from '@sf/ui/components/field';
import { Input } from '@sf/ui/components/input';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { authClient, devSignIn } from '@/lib/auth-client';

/** `sf login` sends the user here (Better Auth device flow verification_uri). */
export const Route = createFileRoute('/device')({
  validateSearch: (search: Record<string, unknown>): { user_code?: string } =>
    typeof search.user_code === 'string' ? { user_code: search.user_code } : {},
  component: DevicePage,
});

type Phase =
  | { kind: 'enter' }
  | { kind: 'review'; code: string; clientId?: string }
  | { kind: 'done'; approved: boolean };

/** User codes are shown as ABCD-EFGH; Better Auth stores them without the dash. */
function normalizeUserCode(code: string): string {
  return code.trim().replaceAll('-', '').replaceAll(' ', '').toUpperCase();
}

function isLoopbackHost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

function DevicePage() {
  const search = Route.useSearch();
  const session = authClient.useSession();
  const [code, setCode] = useState(search.user_code ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'enter' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signedIn = Boolean(session.data?.user);

  async function verify() {
    setError(null);
    setBusy(true);
    const userCode = normalizeUserCode(code);
    const res = await authClient.device({ query: { user_code: userCode } });
    setBusy(false);
    if (res.error || !res.data) return setError('Invalid or expired code');
    if (res.data.status !== 'pending') return setError(`This code is already ${res.data.status}.`);
    setPhase({ kind: 'review', code: userCode, clientId: res.data.client_id });
  }

  async function decide(approve: boolean, userCode: string) {
    setError(null);
    setBusy(true);
    const res = approve
      ? await authClient.device.approve({ userCode })
      : await authClient.device.deny({ userCode });
    setBusy(false);
    if (res.error) return setError(res.error.error_description || 'Request failed');
    setPhase({ kind: 'done', approved: approve });
  }

  async function signInDev() {
    setError(null);
    if (await devSignIn()) await session.refetch();
    else setError('Dev sign-in is not available');
  }

  return (
    <div className="mx-auto w-full max-w-md py-10">
      <Card>
        <CardHeader>
          <CardTitle>Connect a device</CardTitle>
          <CardDescription>
            Authorize the <code>sf</code> CLI to act as you.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {session.isPending ? (
            <p className="text-sm text-muted-foreground">Checking session…</p>
          ) : !signedIn ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">Sign in to approve this device.</p>
              <Button
                variant="outline"
                onClick={() =>
                  void authClient.signIn.social({
                    provider: 'github',
                    callbackURL: `/device?user_code=${encodeURIComponent(code)}`,
                  })
                }
              >
                Sign in with GitHub
              </Button>
              {isLoopbackHost() && (
                <Button variant="secondary" onClick={() => void signInDev()}>
                  Continue as dev user
                </Button>
              )}
            </div>
          ) : phase.kind === 'enter' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <Field>
                <FieldLabel htmlFor="user-code">Code</FieldLabel>
                <Input
                  id="user-code"
                  name="user_code"
                  autoFocus
                  autoComplete="off"
                  placeholder="ABCD-EFGH"
                  className="font-mono uppercase"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <FieldDescription>
                  Signed in as {session.data?.user.email}. Enter the code shown by{' '}
                  <code>sf login</code>.
                </FieldDescription>
              </Field>
              <Button type="submit" disabled={busy || !code.trim()}>
                Continue
              </Button>
            </form>
          ) : phase.kind === 'review' ? (
            <p className="text-sm">
              <span className="font-mono">{phase.clientId ?? 'A device'}</span> wants to access your
              account with code <span className="font-mono">{phase.code}</span>.
            </p>
          ) : (
            <p className="text-sm" role="status">
              {phase.approved
                ? 'Device approved. You can return to your terminal.'
                : 'Device denied.'}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
        {phase.kind === 'review' && (
          <CardFooter className="justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void decide(false, phase.code)}
            >
              Deny
            </Button>
            <Button disabled={busy} onClick={() => void decide(true, phase.code)}>
              Approve
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}

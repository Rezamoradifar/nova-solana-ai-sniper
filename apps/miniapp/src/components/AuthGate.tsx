import type { ReactNode } from 'react';
import { useAuth } from '../lib/AuthContext.js';
import { Button, Card, Skeleton } from './ui/index.js';

/**
 * Gates all real screens behind a fully resolved auth state — nothing
 * downstream of this component ever renders with a null/loading user. Three
 * non-authenticated states are handled distinctly because they mean
 * different things to a real user: still checking (loading), not opened
 * inside Telegram at all (unauthenticated + outsideTelegram, not retryable
 * the same way), and a genuine sign-in failure (error, retryable).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, errorMessage, outsideTelegram, retry } = useAuth();

  if (status === 'loading') {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6">
        <Skeleton className="h-8 w-40" />
        <Card className="flex flex-col gap-3 p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-32" />
        </Card>
        <Skeleton count={3} className="h-16 w-full" />
      </div>
    );
  }

  if (status === 'unauthenticated' && outsideTelegram) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-lg font-semibold text-text-primary">Open in Telegram</p>
          <p className="text-sm text-text-secondary">
            GSP Bank Sniper is a Telegram Mini App — open it from the bot to sign in.
          </p>
        </Card>
      </div>
    );
  }

  if (status === 'error' || status === 'unauthenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-lg font-semibold text-text-primary">Couldn't sign you in</p>
          <p className="text-sm text-text-secondary">
            {errorMessage ?? 'Something went wrong while signing in.'}
          </p>
          <Button variant="primary" onClick={retry}>
            Try again
          </Button>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}

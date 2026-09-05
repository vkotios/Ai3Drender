import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { SignInForm } from '@/components/SignInForm';
import { Panel } from '@/components/ui';
import { hasSupabase } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  // Nothing to sign into when running on the local disk store.
  if (!hasSupabase) redirect('/');

  const { next, error } = await searchParams;
  // Only accept same-origin paths, so `next` cannot be used to bounce someone
  // to another site after a successful sign-in.
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">ai3drender</h1>
        <p className="mt-1 text-sm text-shell-400">
          Sign in to your exhibition projects.
        </p>
      </header>

      {error && (
        <p className="mb-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <Panel>
        <Suspense fallback={<p className="text-sm text-shell-400">Loading…</p>}>
          <SignInForm next={target} />
        </Suspense>
      </Panel>
    </main>
  );
}

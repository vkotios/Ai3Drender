import { hasSupabase } from '@/lib/env';

/**
 * Who you are signed in as, and the way out.
 *
 * Local-disk mode has no accounts, so it says so rather than showing a
 * sign-out control that would do nothing.
 */
export function AuthStatus({ email }: { email: string }) {
  if (!hasSupabase) {
    return (
      <span className="text-[11px] text-shell-400">
        Local mode — no sign-in required
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2.5">
      <span className="truncate text-[11px] text-shell-400" title={email}>
        {email}
      </span>
      <form action="/auth/sign-out" method="post">
        <button
          type="submit"
          className="rounded-md border border-shell-700 px-2 py-1 text-[11px] text-shell-300 transition hover:border-shell-600 hover:text-shell-100"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

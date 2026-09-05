import { redirect } from 'next/navigation';

import { getSession, type Session } from '@/lib/db';

/**
 * The session, or a redirect to sign-in.
 *
 * Middleware already gates these routes, so reaching the redirect here means
 * the session lapsed between the two. Pages call this rather than handling a
 * null session themselves.
 */
export async function requireSession(returnTo?: string): Promise<Session> {
  const session = await getSession();
  if (session) return session;
  redirect(returnTo ? `/sign-in?next=${encodeURIComponent(returnTo)}` : '/sign-in');
}

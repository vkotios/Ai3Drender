import { LOCAL_USER_EMAIL, LOCAL_USER_ID, hasSupabase } from '@/lib/env';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

/**
 * Resolve a project owner's email from their id.
 *
 * Local mode has exactly one user - the fixed `LOCAL_USER_ID` - and its email
 * is a constant. Supabase mode has no `email` column of its own to query
 * (RLS-visible tables only ever carry `owner_id`, an auth.users foreign key),
 * so this goes through the admin API instead, the same service-role client
 * the background worker uses.
 *
 * Never throws: an owner email this can't resolve just means the Slack post
 * (if configured) still goes out and the email one is skipped, not that the
 * client's note or verdict fails to save.
 */
export async function resolveOwnerEmail(ownerId: string): Promise<string | null> {
  if (!hasSupabase) return ownerId === LOCAL_USER_ID ? LOCAL_USER_EMAIL : null;
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.auth.admin.getUserById(ownerId);
    if (error || !data.user) return null;
    return data.user.email ?? null;
  } catch (cause) {
    console.error('[notify] resolveOwnerEmail failed', cause);
    return null;
  }
}

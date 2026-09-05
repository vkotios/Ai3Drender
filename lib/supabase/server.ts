import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';

/**
 * Request-scoped client that carries the caller's session, so RLS applies.
 * Only call this from a Server Component, Route Handler or Server Action.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    throw new Error('Supabase is not configured');
  }
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies; middleware refreshes instead.
        }
      },
    },
  });
}

/**
 * Service-role client. Bypasses RLS, so it is only for the background worker,
 * which has already resolved ownership itself.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  if (!env.supabaseUrl || !env.supabaseServiceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for background work');
  }
  return createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

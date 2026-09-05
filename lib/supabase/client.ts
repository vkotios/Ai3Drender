'use client';

import { createBrowserClient } from '@supabase/ssr';

import { env } from '@/lib/env';

export function createSupabaseBrowserClient() {
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    throw new Error('Supabase is not configured');
  }
  return createBrowserClient(env.supabaseUrl, env.supabaseAnonKey);
}

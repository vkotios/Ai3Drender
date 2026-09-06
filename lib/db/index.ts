import { LOCAL_USER_EMAIL, LOCAL_USER_ID, hasSupabase } from '@/lib/env';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';

import { LocalStore } from './local';
import { SupabaseStore } from './supabase';
import { SIGNED_URL_TTL_SECONDS, type Store } from './store';

export type { Store } from './store';

export interface Viewer {
  id: string;
  email: string;
}

export interface Session {
  store: Store;
  viewer: Viewer;
}

// One LocalStore per process: it owns an in-process write queue, so sharing the
// instance is what makes that queue an effective lock.
let localStore: LocalStore | null = null;

function getLocalStore(): LocalStore {
  localStore ??= new LocalStore();
  return localStore;
}

/**
 * Resolve the store and the authenticated user for the current request.
 * Returns null when Supabase is configured but nobody is signed in.
 */
export async function getSession(): Promise<Session | null> {
  if (!hasSupabase) {
    return { store: getLocalStore(), viewer: { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL } };
  }
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return {
    store: new SupabaseStore(client),
    viewer: { id: data.user.id, email: data.user.email ?? '' },
  };
}

/**
 * Store for background work. Uses the service role in Supabase mode because the
 * worker runs without a user session; ownership is checked before enqueueing.
 */
export function getWorkerStore(): Store {
  if (!hasSupabase) return getLocalStore();
  return new SupabaseStore(createSupabaseAdminClient());
}

/**
 * Load a project the viewer is allowed to see. In Supabase mode RLS already
 * filters this, but the explicit owner check keeps the worker path honest too.
 */
export async function requireProject(session: Session, projectId: string) {
  const project = await session.store.getProject(projectId);
  if (!project || project.ownerId !== session.viewer.id) return null;
  return project;
}

/**
 * Resolve a blob's URL alongside when it goes stale, so a caller can tell the
 * browser when to ask for a new one instead of trusting this one forever.
 *
 * `null` in local mode: `LocalStore.blobUrl` returns a stable `/api/blob/...`
 * path that never expires, so there is nothing to schedule a refresh around.
 */
export async function blobUrlWithExpiry(
  store: Store,
  key: string,
): Promise<{ url: string; expiresAt: string | null }> {
  const url = await store.blobUrl(key);
  const expiresAt =
    store.kind === 'supabase'
      ? new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString()
      : null;
  return { url, expiresAt };
}

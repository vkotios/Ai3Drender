import { hasSupabase } from '@/lib/env';
import type { Store } from '@/lib/db';

/**
 * A URL the share view's browser can fetch a mesh from.
 *
 * In Supabase mode `store.blobUrl` already hands back a short-lived signed
 * Storage URL scoped by `renders_shared_read` - usable directly, no token
 * needed in the URL itself. In local mode the ordinary `/api/blob` route
 * requires a session (see app/api/blob/[...key]/route.ts), which an
 * unauthenticated recipient never has, so the share-scoped route needs the
 * token folded into the path instead.
 */
export async function shareBlobUrl(store: Store, token: string, key: string): Promise<string> {
  if (hasSupabase) return store.blobUrl(key);
  const encodedKey = key
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `/api/share/${encodeURIComponent(token)}/blob/${encodedKey}`;
}

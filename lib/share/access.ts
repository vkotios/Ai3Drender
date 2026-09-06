import { getLocalStoreForShareAccess } from '@/lib/db';
import type { Store } from '@/lib/db';
import { hasSupabase } from '@/lib/env';
import { createSupabaseShareClient } from '@/lib/supabase/server';
import type { Scene } from '@/lib/types';

import { SupabaseStore } from '@/lib/db/supabase';

/**
 * Resolving a share token to the one scene it grants.
 *
 * Local mode has no RLS at all, so this module IS the authorization check:
 * it looks the token up, and rejects it if revoked or expired, before handing
 * back a store scoped to nothing in particular (LocalStore has no per-request
 * scoping - every route built on this module is responsible for only ever
 * touching the resolved scene and what it references).
 *
 * Supabase mode instead defers to `active_share_scene_id()` (see
 * supabase/migrations/0004_client_review_links.sql): the anon+header client
 * this hands back is genuinely restricted by RLS to the shared scene and the
 * asset versions/annotations/mesh files it references, so a bug in a route
 * built on this module fails closed rather than open.
 */

export interface ShareContext {
  store: Store;
  scene: Scene;
}

export type ShareResolution =
  | { ok: true; context: ShareContext }
  | { ok: false; status: 404 | 410; message: string };

async function resolveLocal(token: string): Promise<ShareResolution> {
  const store = getLocalStoreForShareAccess();
  const link = await store.getShareLinkByToken(token);
  if (!link) return { ok: false, status: 404, message: 'This share link does not exist' };
  if (link.revokedAt) {
    return { ok: false, status: 410, message: 'This share link has been revoked' };
  }
  if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) {
    return { ok: false, status: 410, message: 'This share link has expired' };
  }
  const scene = await store.getScene(link.sceneId);
  if (!scene) return { ok: false, status: 404, message: 'The shared scene no longer exists' };
  await store.touchShareLink(link.id);
  return { ok: true, context: { store, scene } };
}

async function resolveSupabase(token: string): Promise<ShareResolution> {
  const client = createSupabaseShareClient(token);
  const { data: sceneId, error } = await client.rpc('active_share_scene_id');
  if (error) throw new Error(`share token check failed: ${error.message}`);
  if (!sceneId) {
    return { ok: false, status: 404, message: 'This share link is invalid, revoked or expired' };
  }
  const store = new SupabaseStore(client);
  const scene = await store.getScene(sceneId as string);
  if (!scene) {
    return { ok: false, status: 404, message: 'This share link is invalid, revoked or expired' };
  }
  // Best-effort; a failure here should never block the view itself.
  void client.rpc('touch_active_share_link').then(({ error: touchError }) => {
    if (touchError) console.error('[share] touch_active_share_link failed', touchError.message);
  });
  return { ok: true, context: { store, scene } };
}

/** Validate a raw bearer token and resolve the scene it grants read access to. */
export async function resolveShareToken(token: string): Promise<ShareResolution> {
  if (!token || token.length > 512) {
    return { ok: false, status: 404, message: 'This share link does not exist' };
  }
  return hasSupabase ? resolveSupabase(token) : resolveLocal(token);
}

/** The set of asset version ids a scene's staged nodes reference. */
export function referencedAssetVersionIds(scene: Scene): Set<string> {
  return new Set(
    scene.doc.nodes.map((n) => n.assetVersionId).filter((id): id is string => Boolean(id)),
  );
}

/**
 * Find storage blobs with no owning row: `npx tsx scripts/reconcile-storage.ts`.
 *
 * Deletes go through the row first and the storage cleanup that follows is
 * best-effort (lib/db/local.ts, lib/db/supabase.ts), so a failed cleanup - or
 * data written before that cleanup existed - can leave files with nothing in
 * the database pointing at them. This walks every blob key in storage and
 * every key any row actually references, and reports the difference.
 *
 * Read-only by default. Pass --delete to actually remove the orphans found.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getWorkerStore } from '@/lib/db';
import { hasSupabase } from '@/lib/env';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

const DELETE = process.argv.includes('--delete');

interface ViewLike {
  path: string;
}

/** Every path a local-mode row can carry, read straight off the JSON store. */
async function livePathsLocal(): Promise<Set<string>> {
  const dbFile = path.join(process.cwd(), 'storage-local', 'db.json');
  const raw = await readFile(dbFile, 'utf8').catch(() => '{}');
  const db = JSON.parse(raw) as {
    sourceImages?: { path: string }[];
    assetVersions?: { views?: ViewLike[]; meshPath?: string | null }[];
    sceneRenders?: { path: string }[];
  };

  const paths = new Set<string>();
  for (const image of db.sourceImages ?? []) paths.add(image.path);
  for (const version of db.assetVersions ?? []) {
    for (const view of version.views ?? []) paths.add(view.path);
    if (version.meshPath) paths.add(version.meshPath);
  }
  for (const render of db.sceneRenders ?? []) paths.add(render.path);
  return paths;
}

/**
 * Same, queried across every project via the service-role client - the
 * `Store` port only exposes owner-scoped reads, and reconciliation needs to
 * see everything at once.
 */
async function livePathsSupabase(): Promise<Set<string>> {
  const admin = createSupabaseAdminClient();
  const [images, versions, renders] = await Promise.all([
    admin.from('source_images').select('path'),
    admin.from('asset_versions').select('views, mesh_path'),
    admin.from('scene_renders').select('path'),
  ]);
  for (const [what, res] of [
    ['source_images', images],
    ['asset_versions', versions],
    ['scene_renders', renders],
  ] as const) {
    if (res.error) throw new Error(`reconcile: reading ${what}: ${res.error.message}`);
  }

  const paths = new Set<string>();
  for (const row of images.data ?? []) paths.add(row.path as string);
  for (const row of versions.data ?? []) {
    for (const view of (row.views ?? []) as ViewLike[]) paths.add(view.path);
    if (row.mesh_path) paths.add(row.mesh_path as string);
  }
  for (const row of renders.data ?? []) paths.add(row.path as string);
  return paths;
}

async function main() {
  const store = getWorkerStore();
  const live = hasSupabase ? await livePathsSupabase() : await livePathsLocal();
  const stored = await store.listBlobKeys();
  const orphans = stored.filter((key) => !live.has(key));

  console.log(`[reconcile] ${store.kind} store: ${stored.length} blob(s) in storage`);
  if (orphans.length === 0) {
    console.log('[reconcile] none orphaned');
    return;
  }

  console.log(`[reconcile] ${orphans.length} orphaned (no owning row):`);
  for (const key of orphans) console.log(`  ${key}`);

  if (!DELETE) {
    console.log('\nRe-run with --delete to remove them.');
    return;
  }

  let removed = 0;
  for (const key of orphans) {
    try {
      await store.deleteBlob(key);
      removed += 1;
    } catch (cause) {
      console.error(`[reconcile] failed to delete ${key}:`, cause);
    }
  }
  console.log(`[reconcile] removed ${removed}/${orphans.length} orphaned blob(s)`);
}

void main();

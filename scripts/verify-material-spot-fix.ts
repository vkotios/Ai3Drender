/**
 * End-to-end proof that the material spot-fix path (issue #48) works, using
 * only the offline pipeline (no GEMINI_API_KEY, no Supabase) - the exact path
 * CI runs with an empty .env. Run with `npx tsx scripts/verify-material-spot-fix.ts`.
 *
 * This calls the real Next.js route handlers directly (not a re-implementation
 * of their logic), against the on-disk LocalStore, so it exercises the actual
 * code that ships:
 *
 *   1. Upload a photo whose filename says "chair" and run it through the real
 *      analyze -> synthesize_views -> reconstruct pipeline via the offline
 *      analyzer, exactly like scripts/verify-material-library.ts.
 *   2. Send a free-text correction ("make this darker walnut") to the "frame"
 *      material via PATCH .../materials/[materialId], the same route the
 *      library rebind uses - just with `instruction` instead of `libraryEntryId`.
 *   3. Confirm via a SEPARATE GET /api/assets/:id (not just the write's own
 *      response) that only the "frame" material's PBR values changed - the
 *      other material, every component, the dimensions and the mesh are
 *      untouched - and that it came back unbound + flagged invented, since it
 *      no longer matches any library entry's canonical values.
 *
 * Cleans up the storage-local/ directory it writes to (gitignored, but this
 * leaves no state behind either way) regardless of outcome.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { POST as createProjectRoute } from '@/app/api/projects/route';
import { POST as uploadImagesRoute } from '@/app/api/projects/[projectId]/images/route';
import { POST as createAssetRoute } from '@/app/api/projects/[projectId]/assets/route';
import { GET as getAssetRoute } from '@/app/api/assets/[assetId]/route';
import { PATCH as materialRoute } from '@/app/api/assets/[assetId]/versions/[versionId]/materials/[materialId]/route';
import { POST as acceptVersionRoute } from '@/app/api/assets/[assetId]/versions/[versionId]/accept/route';
import { POST as tickJobsRoute } from '@/app/api/jobs/tick/route';
import type { AssetVersion, FurnitureAsset } from '@/lib/types';

const STORAGE_ROOT = path.join(process.cwd(), 'storage-local');

async function asJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body as T;
}

const jsonRequest = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function main() {
  const steps: string[] = [];
  const step = (name: string) => {
    steps.push(name);
    console.log(`\n[verify] ${name}`);
  };

  step('Create a project (owned by the local dev user, same as every other route)');
  const project = await asJson<{ id: string }>(
    await createProjectRoute(
      jsonRequest('http://local/api/projects', 'POST', { name: 'Spot-fix verification project' }),
    ),
  );

  step('Upload a photo named so the offline analyzer picks the "lounge chair" profile');
  const form = new FormData();
  form.append(
    'files',
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'oslo-lounge-chair.jpg', { type: 'image/jpeg' }),
  );
  form.append('role', 'primary');
  const images = await asJson<{ id: string }[]>(
    await uploadImagesRoute(
      new Request(`http://local/api/projects/${project.id}/images`, { method: 'POST', body: form }),
      { params: Promise.resolve({ projectId: project.id }) },
    ),
  );
  assert.equal(images.length, 1);

  step('Create the asset - queues the analyze job, exactly like the studio does');
  const created = await asJson<{ asset: FurnitureAsset }>(
    await createAssetRoute(
      jsonRequest(`http://local/api/projects/${project.id}/assets`, 'POST', {
        name: '',
        sourceImageIds: [images[0].id],
      }),
      { params: Promise.resolve({ projectId: project.id }) },
    ),
  );
  const assetId = created.asset.id;

  step('Drain the queue: analyze -> synthesize_views -> reconstruct, all offline/stub');
  for (let i = 0; i < 5; i += 1) {
    const { processed } = await asJson<{ processed: number }>(
      await tickJobsRoute(new Request('http://local/api/jobs/tick', { method: 'POST' })),
    );
    if (processed === 0) break;
  }

  step('Read the asset back and inspect the spec the offline analyzer produced');
  const before = await asJson<{ asset: FurnitureAsset; versions: { version: AssetVersion }[] }>(
    await getAssetRoute(new Request(`http://local/api/assets/${assetId}`), {
      params: Promise.resolve({ assetId }),
    }),
  );
  assert.equal(before.asset.status, 'ready', `asset should be ready, got ${before.asset.status}`);
  const versionId = before.asset.currentVersionId!;
  assert.ok(versionId, 'asset should have a current version');
  const beforeVersion = before.versions.find((v) => v.version.id === versionId)!.version;

  const beforeFrame = beforeVersion.spec.materials.find((m) => m.id === 'frame');
  assert.ok(beforeFrame, 'expected a "frame" material from the lounge-chair offline profile');
  const beforeAccent = beforeVersion.spec.materials.find((m) => m.id === 'accent');
  assert.ok(beforeAccent, 'expected an "accent" material from the lounge-chair offline profile');
  console.log(`  frame before: ${beforeFrame!.baseColorHex}, roughness ${beforeFrame!.roughness}`);

  step('Spot-fix the "frame" material with a free-text instruction (no libraryEntryId)');
  const instruction = 'make this darker walnut';
  const written = await asJson<AssetVersion>(
    await materialRoute(
      jsonRequest(
        `http://local/api/assets/${assetId}/versions/${versionId}/materials/frame`,
        'PATCH',
        { instruction },
      ),
      { params: Promise.resolve({ assetId, versionId, materialId: 'frame' }) },
    ),
  );
  const writtenFrame = written.spec.materials.find((m) => m.id === 'frame')!;
  console.log(`  frame after: ${writtenFrame.baseColorHex}, roughness ${writtenFrame.roughness}`);
  assert.notEqual(writtenFrame.baseColorHex, beforeFrame!.baseColorHex, 'the colour must actually change');
  assert.equal(writtenFrame.libraryEntryId, null, 'a spot-fixed material no longer matches any library entry');
  assert.equal(writtenFrame.invented, true, 'a spot-fixed material is flagged invented, for review');
  assert.match(writtenFrame.notes, /darker walnut/i);

  step('Confirm via a SEPARATE GET (not the write response) that ONLY "frame" changed');
  const after = await asJson<{ asset: FurnitureAsset; versions: { version: AssetVersion }[] }>(
    await getAssetRoute(new Request(`http://local/api/assets/${assetId}`), {
      params: Promise.resolve({ assetId }),
    }),
  );
  const afterVersion = after.versions.find((v) => v.version.id === versionId)!.version;
  const afterFrame = afterVersion.spec.materials.find((m) => m.id === 'frame')!;
  const afterAccent = afterVersion.spec.materials.find((m) => m.id === 'accent')!;

  assert.equal(afterFrame.baseColorHex, writtenFrame.baseColorHex, 'the correction must persist, not just echo');
  assert.deepEqual(afterAccent, beforeAccent, 'the untouched "accent" material must be byte-for-byte unchanged');
  assert.deepEqual(afterVersion.spec.components, beforeVersion.spec.components, 'components must be unchanged');
  assert.deepEqual(afterVersion.spec.dimensions, beforeVersion.spec.dimensions, 'dimensions must be unchanged');
  assert.equal(afterVersion.spec.displayName, beforeVersion.spec.displayName, 'displayName must be unchanged');
  assert.equal(afterVersion.meshPath, beforeVersion.meshPath, 'the mesh must be untouched by a spot-fix');
  assert.equal(afterVersion.meshExtentMm, beforeVersion.meshExtentMm, 'the mesh extent must be untouched');
  console.log('  confirmed: only the "frame" material changed; accent/components/dimensions/mesh untouched');

  step('Confirm the accepted-version-immutability guard still applies to the spot-fix path');
  await asJson(
    await acceptVersionRoute(
      new Request(`http://local/api/assets/${assetId}/versions/${versionId}/accept`, { method: 'POST' }),
      { params: Promise.resolve({ assetId, versionId }) },
    ),
  );
  const blocked = await materialRoute(
    jsonRequest(
      `http://local/api/assets/${assetId}/versions/${versionId}/materials/frame`,
      'PATCH',
      { instruction: 'make it lighter' },
    ),
    { params: Promise.resolve({ assetId, versionId, materialId: 'frame' }) },
  );
  assert.equal(blocked.status, 409, 'a spot-fix on an accepted version must be rejected, same as a rebind');
  console.log('  confirmed: PATCH on an accepted version is rejected with 409');

  console.log(`\n[verify] All ${steps.length} steps passed.`);
}

main()
  .then(async () => {
    await rm(STORAGE_ROOT, { recursive: true, force: true });
    process.exit(0);
  })
  .catch(async (cause) => {
    console.error('\n[verify] FAILED:', cause instanceof Error ? cause.stack ?? cause.message : cause);
    await rm(STORAGE_ROOT, { recursive: true, force: true });
    process.exit(1);
  });

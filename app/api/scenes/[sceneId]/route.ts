import { apiError, json, withScene } from '@/lib/api';
import { blobUrlWithExpiry } from '@/lib/db';
import { migrateSceneOnLoad } from '@/lib/scene/materialOverrides';
import type { MaterialSpec, SceneDoc, Uuid } from '@/lib/types';

type Params = { params: Promise<{ sceneId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    // Resolve every asset version the scene references, plus a mesh URL, so
    // the studio can render in one round trip.
    const versionIds = [
      ...new Set(scene.doc.nodes.map((n) => n.assetVersionId).filter((id): id is string => !!id)),
    ];
    const versions = [];
    for (const id of versionIds) {
      const version = await store.getAssetVersion(id);
      if (!version) continue;
      const resolved = version.meshPath
        ? await blobUrlWithExpiry(store, version.meshPath)
        : { url: null, expiresAt: null };
      versions.push({ version, meshUrl: resolved.url, meshUrlExpiresAt: resolved.expiresAt });
    }

    // Rekey any material overrides still written under the pre-fix "material
    // name" scheme (issue #7) before handing the doc back.
    const specMaterialsByVersionId = new Map<Uuid, readonly MaterialSpec[]>(
      versions.map((v) => [v.version.id, v.version.spec.materials]),
    );
    const migrated = await migrateSceneOnLoad(store, scene, specMaterialsByVersionId);

    // The studio needs every note on every staged piece, plus any renders
    // already produced for this stand.
    const assetIds = [...new Set(versions.map((v) => v.version.assetId))];
    return json({
      scene: migrated,
      versions,
      annotations: await store.listAnnotations(assetIds),
      renders: await store.listSceneRenders(scene.id),
    });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    const body = (await request.json()) as {
      name?: string;
      doc?: SceneDoc;
      note?: string;
      acceptedAt?: string | null;
    };
    if (body.doc && body.doc.schemaVersion !== 1) {
      return apiError(`Unsupported scene schema version ${body.doc.schemaVersion}`);
    }
    return json(
      await store.updateScene(
        scene.id,
        { name: body.name, doc: body.doc, acceptedAt: body.acceptedAt },
        body.note ?? 'edited in studio',
      ),
    );
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    await store.deleteScene(scene.id);
    return json({ deleted: true });
  });
}

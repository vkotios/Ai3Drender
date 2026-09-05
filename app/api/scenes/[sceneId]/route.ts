import { apiError, json, withScene } from '@/lib/api';
import type { SceneDoc } from '@/lib/types';

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
      versions.push({
        version,
        meshUrl: version.meshPath ? await store.blobUrl(version.meshPath) : null,
      });
    }
    return json({ scene, versions });
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

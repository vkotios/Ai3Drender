import { notFound } from 'next/navigation';

import { StudioShell } from '@/components/studio/StudioShell';
import { requireProject } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { hasGemini } from '@/lib/env';
import { migrateSceneOnLoad } from '@/lib/scene/materialOverrides';
import type { LoadedVersion } from '@/lib/studio/store';
import type { MaterialSpec, Uuid } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function StudioPage({
  params,
}: {
  params: Promise<{ projectId: string; sceneId: string }>;
}) {
  const { projectId, sceneId } = await params;
  const session = await requireSession();

  const project = await requireProject(session, projectId);
  if (!project) notFound();

  const { store } = session;
  let scene = await store.getScene(sceneId);
  if (!scene || scene.projectId !== project.id) notFound();

  // Every finished piece in the project can be staged, so resolve them all
  // up front along with signed mesh URLs.
  const assets = await store.listAssets(project.id);
  const available: LoadedVersion[] = [];
  for (const asset of assets) {
    if (!asset.currentVersionId) continue;
    const version = await store.getAssetVersion(asset.currentVersionId);
    if (!version?.meshPath) continue;
    available.push({ version, meshUrl: await store.blobUrl(version.meshPath) });
  }

  // Versions the scene already references may be older than the current one.
  const referenced = [
    ...new Set(scene.doc.nodes.map((n) => n.assetVersionId).filter((id): id is string => !!id)),
  ];
  const versions: LoadedVersion[] = [];
  for (const id of referenced) {
    const existing = available.find((v) => v.version.id === id);
    if (existing) {
      versions.push(existing);
      continue;
    }
    const version = await store.getAssetVersion(id);
    if (!version?.meshPath) continue;
    versions.push({ version, meshUrl: await store.blobUrl(version.meshPath) });
  }

  // Rekey any material overrides still written under the pre-fix "material
  // name" scheme (issue #7) before handing the doc to the client.
  const specMaterialsByVersionId = new Map<Uuid, readonly MaterialSpec[]>(
    versions.map((v) => [v.version.id, v.version.spec.materials]),
  );
  scene = await migrateSceneOnLoad(store, scene, specMaterialsByVersionId);

  const annotations = await store.listAnnotations([
    ...new Set([...available, ...versions].map((v) => v.version.assetId)),
  ]);

  const renders = await Promise.all(
    (await store.listSceneRenders(scene.id)).map(async (render) => ({
      ...render,
      url: await store.blobUrl(render.path),
    })),
  );

  return (
    <StudioShell
      project={project}
      scene={scene}
      versions={versions}
      available={available}
      annotations={annotations}
      initialRenders={renders}
      conceptAvailable={hasGemini}
    />
  );
}

import { notFound } from 'next/navigation';

import { StudioShell } from '@/components/studio/StudioShell';
import { blobUrlWithExpiry, requireProject } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { hasGemini } from '@/lib/env';
import type { LoadedVersion } from '@/lib/studio/store';

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
  const scene = await store.getScene(sceneId);
  if (!scene || scene.projectId !== project.id) notFound();

  // Every finished piece in the project can be staged, so resolve them all
  // up front along with signed mesh URLs.
  const assets = await store.listAssets(project.id);
  const available: LoadedVersion[] = [];
  for (const asset of assets) {
    if (!asset.currentVersionId) continue;
    const version = await store.getAssetVersion(asset.currentVersionId);
    if (!version?.meshPath) continue;
    const { url, expiresAt } = await blobUrlWithExpiry(store, version.meshPath);
    available.push({ version, meshUrl: url, meshUrlExpiresAt: expiresAt });
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
    const { url, expiresAt } = await blobUrlWithExpiry(store, version.meshPath);
    versions.push({ version, meshUrl: url, meshUrlExpiresAt: expiresAt });
  }

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

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ProjectWorkbench } from '@/components/ProjectWorkbench';
import { getSession, requireProject } from '@/lib/db';
import type { AssetVersion } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await getSession();
  if (!session) notFound();

  const project = await requireProject(session, projectId);
  if (!project) notFound();

  const { store } = session;
  const [images, assets, scenes] = await Promise.all([
    store.listSourceImages(project.id),
    store.listAssets(project.id),
    store.listScenes(project.id),
  ]);

  // Resolve thumbnails and current versions server-side so the workbench
  // renders complete on first paint.
  const imageUrls = Object.fromEntries(
    await Promise.all(images.map(async (image) => [image.id, await store.blobUrl(image.path)])),
  ) as Record<string, string>;

  const rows = await Promise.all(
    assets.map(async (asset) => ({
      asset,
      currentVersion: asset.currentVersionId
        ? ((await store.getAssetVersion(asset.currentVersionId)) as AssetVersion | null)
        : null,
    })),
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <Link href="/" className="text-xs text-shell-400 transition hover:text-shell-100">
          ← All projects
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{project.name}</h1>
        {project.client && <p className="text-sm text-shell-400">{project.client}</p>}
        {project.brief && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-shell-300">{project.brief}</p>
        )}
      </header>

      <ProjectWorkbench
        project={project}
        initialImages={images}
        initialAssets={rows}
        initialScenes={scenes}
        imageUrls={imageUrls}
      />
    </main>
  );
}

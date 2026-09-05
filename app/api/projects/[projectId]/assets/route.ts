import { apiError, json, withProject } from '@/lib/api';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) => {
    const assets = await store.listAssets(project.id);
    // The studio needs the current version inline to render anything.
    const versions = await Promise.all(
      assets.map((a) => (a.currentVersionId ? store.getAssetVersion(a.currentVersionId) : null)),
    );
    return json(assets.map((asset, i) => ({ asset, currentVersion: versions[i] })));
  });
}

/**
 * Create an asset from selected photographs and kick off the pipeline.
 * Returns immediately with the queued job; the client polls /jobs.
 */
export async function POST(request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) => {
    const body = (await request.json()) as { name?: string; sourceImageIds?: string[] };
    const sourceImageIds = body.sourceImageIds ?? [];
    if (sourceImageIds.length === 0) return apiError('Select at least one photograph');

    // Reject ids that are not actually this project's images.
    const owned = new Set((await store.listSourceImages(project.id)).map((i) => i.id));
    const unknown = sourceImageIds.filter((id) => !owned.has(id));
    if (unknown.length > 0) return apiError('One or more images do not belong to this project');

    const asset = await store.createAsset({
      projectId: project.id,
      // Left blank on purpose when the user gives no name: the analysis
      // stage fills it in from the piece it identifies.
      name: body.name?.trim() ?? '',
      status: 'draft',
      currentVersionId: null,
      sourceImageIds,
    });
    const job = await store.createJob({ projectId: project.id, assetId: asset.id, kind: 'analyze' });

    return json({ asset, job }, 201);
  });
}

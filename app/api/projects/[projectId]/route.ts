import { json, withProject } from '@/lib/api';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) =>
    json({
      project,
      images: await store.listSourceImages(project.id),
      assets: await store.listAssets(project.id),
      scenes: await store.listScenes(project.id),
    }),
  );
}

export async function PATCH(request: Request, { params }: Params) {
  const { projectId } = await params;
  const body = (await request.json()) as { name?: string; client?: string; brief?: string };
  return withProject(projectId, async ({ store }, project) =>
    json(await store.updateProject(project.id, body)),
  );
}

export async function DELETE(_request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) => {
    await store.deleteProject(project.id);
    return json({ deleted: true });
  });
}

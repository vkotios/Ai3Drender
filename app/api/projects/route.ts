import { apiError, json, withSession } from '@/lib/api';

export async function GET() {
  return withSession(async ({ store, viewer }) => json(await store.listProjects(viewer.id)));
}

export async function POST(request: Request) {
  return withSession(async ({ store, viewer }) => {
    const body = (await request.json()) as { name?: string; client?: string; brief?: string };
    if (!body.name?.trim()) return apiError('A project name is required');
    const project = await store.createProject({
      ownerId: viewer.id,
      name: body.name.trim(),
      client: body.client?.trim() || null,
      brief: body.brief?.trim() || null,
    });
    return json(project, 201);
  });
}

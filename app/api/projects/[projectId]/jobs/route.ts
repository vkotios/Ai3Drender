import { json, withProject } from '@/lib/api';
import type { JobStatus } from '@/lib/types';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { projectId } = await params;
  const statuses = new URL(request.url).searchParams.get('status');
  return withProject(projectId, async ({ store }, project) =>
    json(
      await store.listJobs(
        project.id,
        statuses ? (statuses.split(',') as JobStatus[]) : undefined,
      ),
    ),
  );
}

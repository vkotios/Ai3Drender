import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import type { Job, Project } from '@/lib/types';

/**
 * `POST /api/projects/:projectId/scenes/from-floor-plan` (issue #58): queues
 * a `floorplan_scene` job from an uploaded floor-plan image. Exercises the
 * real route handler against a real on-disk LocalStore - the job itself is
 * covered end-to-end by tests/pipeline/floorplan-scene.test.ts.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { POST: postFromFloorPlan } = await import(
  '@/app/api/projects/[projectId]/scenes/from-floor-plan/route'
);

let dir: string;
let store: LocalStore;
let project: Project;

const OWNER = 'floorplan-upload-owner';

function pngFile(name = 'plan.png') {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
}

function requestFor(projectId: string, form: FormData) {
  return postFromFloorPlan(new Request('http://local/api/projects/x/scenes/from-floor-plan', {
    method: 'POST',
    body: form,
  }), { params: Promise.resolve({ projectId }) });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-floorplan-upload-'));
  store = new LocalStore(dir);
  vi.mocked(getSession).mockResolvedValue({ store, viewer: { id: OWNER, email: `${OWNER}@test` } });
  project = await store.createProject({ ownerId: OWNER, name: 'Upload project' });
});

afterEach(async () => {
  vi.mocked(getSession).mockReset();
  await rm(dir, { recursive: true, force: true });
});

describe('POST /api/projects/[projectId]/scenes/from-floor-plan', () => {
  it('stores the image and queues a floorplan_scene job', async () => {
    const form = new FormData();
    form.append('file', pngFile());
    form.append('imageWidthPx', '1600');
    form.append('imageHeightPx', '1200');
    form.append('sceneName', 'My auto stand');

    const response = await requestFor(project.id, form);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { job: Job };

    expect(body.job.kind).toBe('floorplan_scene');
    expect(body.job.status).toBe('queued');
    expect(body.job.projectId).toBe(project.id);
    expect(body.job.input).toMatchObject({ imageWidthPx: 1600, imageHeightPx: 1200, sceneName: 'My auto stand' });
    expect(typeof body.job.input.floorPlanPath).toBe('string');

    // The blob really landed in storage under this project.
    const blob = await store.getBlob(body.job.input.floorPlanPath as string);
    expect(blob).not.toBeNull();
  });

  it('omits sceneName from the job input when none was given', async () => {
    const form = new FormData();
    form.append('file', pngFile());
    form.append('imageWidthPx', '1000');
    form.append('imageHeightPx', '1000');

    const response = await requestFor(project.id, form);
    const body = (await response.json()) as { job: Job };
    expect(body.job.input.sceneName).toBeUndefined();
  });

  it('400s with no file', async () => {
    const form = new FormData();
    form.append('imageWidthPx', '1000');
    form.append('imageHeightPx', '1000');
    const response = await requestFor(project.id, form);
    expect(response.status).toBe(400);
  });

  it('400s for an unsupported file type', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1])], 'plan.pdf', { type: 'application/pdf' }));
    form.append('imageWidthPx', '1000');
    form.append('imageHeightPx', '1000');
    const response = await requestFor(project.id, form);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/unsupported/i);
  });

  it('400s when the image dimensions are missing or not positive', async () => {
    const form = new FormData();
    form.append('file', pngFile());
    const response = await requestFor(project.id, form);
    expect(response.status).toBe(400);

    const negative = new FormData();
    negative.append('file', pngFile());
    negative.append('imageWidthPx', '-5');
    negative.append('imageHeightPx', '1000');
    const response2 = await requestFor(project.id, negative);
    expect(response2.status).toBe(400);
  });

  it('404s for a project belonging to a different owner', async () => {
    vi.mocked(getSession).mockResolvedValue({ store, viewer: { id: 'someone-else', email: 'x@test' } });
    const form = new FormData();
    form.append('file', pngFile());
    form.append('imageWidthPx', '1000');
    form.append('imageHeightPx', '1000');
    const response = await requestFor(project.id, form);
    expect(response.status).toBe(404);
  });
});

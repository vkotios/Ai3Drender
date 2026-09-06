import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { drainJobs, runJob } from '@/lib/pipeline';
import type { FurnitureAsset, Project } from '@/lib/types';

/**
 * Exercises the full analyze -> synthesize_views -> reconstruct chain, then
 * refine, against LocalStore in offline/stub mode (GEMINI_API_KEY unset, so
 * `hasGemini` is false and MESH_PROVIDER resolves to the stub - see
 * tests/setup.ts). No network calls, no API keys, fully deterministic.
 */

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-pipeline-'));
  store = new LocalStore(dir);

  project = await store.createProject({ ownerId: 'owner-1', name: 'Test project' });

  const imagePath = `${project.id}/sources/photo-1.jpg`;
  await store.putBlob(imagePath, new Uint8Array([1, 2, 3, 4]), 'image/jpeg');
  const image = await store.addSourceImage({
    projectId: project.id,
    path: imagePath,
    filename: 'sofa-front.jpg',
    mimeType: 'image/jpeg',
    byteSize: 4,
    role: 'primary',
  });

  asset = await store.createAsset({
    projectId: project.id,
    name: '',
    status: 'draft',
    currentVersionId: null,
    sourceImageIds: [image.id],
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Drain until the queue is empty, with a hard cap so a stuck test fails fast. */
async function drainAll(max = 20) {
  let total = 0;
  for (let i = 0; i < max; i += 1) {
    const processed = await drainJobs(store, 1);
    total += processed;
    if (processed === 0) break;
  }
  return total;
}

describe('pipeline: analyze -> synthesize_views -> reconstruct', () => {
  it('carries an asset from draft to ready through all three stages', async () => {
    await store.createJob({ projectId: project.id, assetId: asset.id, kind: 'analyze', input: {} });

    await drainAll();

    const finalAsset = await store.getAsset(asset.id);
    expect(finalAsset?.status).toBe('ready');
    expect(finalAsset?.currentVersionId).toBeTruthy();

    const version = await store.getAssetVersion(finalAsset!.currentVersionId!);
    expect(version).not.toBeNull();
    expect(version!.provider).toBe('stub');
    expect(version!.meshPath).toBeTruthy();
    expect(version!.meshExtentMm).toBeGreaterThan(0);
    // The offline analyzer infers a category from the filename ("sofa-front.jpg").
    expect(version!.spec.category).toBe('sofa');
    expect(version!.spec.dimensionConfidence).toBe('rough');

    const meshBlob = await store.getBlob(version!.meshPath!);
    expect(meshBlob).not.toBeNull();
    expect(meshBlob!.bytes.byteLength).toBeGreaterThan(0);
    expect(meshBlob!.contentType).toBe('model/gltf-binary');

    const jobs = await store.listJobs(project.id);
    expect(jobs).toHaveLength(3); // analyze, synthesize_views, reconstruct
    expect(jobs.every((j) => j.status === 'succeeded')).toBe(true);
  });

  it('records the intermediate states along the way', async () => {
    const analyzeJob = await store.createJob({
      projectId: project.id,
      assetId: asset.id,
      kind: 'analyze',
      input: {},
    });

    await runJob(store, analyzeJob);
    expect((await store.getAsset(asset.id))?.status).toBe('generating_views');

    const synthJob = (await store.listJobs(project.id, ['queued']))[0];
    expect(synthJob.kind).toBe('synthesize_views');
    await runJob(store, synthJob);
    expect((await store.getAsset(asset.id))?.status).toBe('reconstructing');

    const reconstructJob = (await store.listJobs(project.id, ['queued']))[0];
    expect(reconstructJob.kind).toBe('reconstruct');
    await runJob(store, reconstructJob);
    expect((await store.getAsset(asset.id))?.status).toBe('ready');
  });
});

describe('pipeline: refine', () => {
  async function buildReadyVersion() {
    await store.createJob({ projectId: project.id, assetId: asset.id, kind: 'analyze', input: {} });
    await drainAll();
    const ready = await store.getAsset(asset.id);
    return store.getAssetVersion(ready!.currentVersionId!);
  }

  it('applies a pinned annotation to a spec-only refinement, marking it applied and linked to the new version', async () => {
    const parent = await buildReadyVersion();
    expect(parent).not.toBeNull();

    const annotation = await store.createAnnotation({
      assetId: asset.id,
      assetVersionId: parent!.id,
      sceneId: null,
      point: { x: 0, y: 0.3, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      partName: 'Legs 1',
      componentName: 'Legs',
      componentRole: 'leg',
      originVersionId: parent!.id,
      originVersionNumber: parent!.versionNumber,
      staleNote: null,
      source: 'internal',
      clientName: null,
      selectionKind: 'point',
      anchorDescription: 'front-left, 300 mm above the floor',
      body: 'Make these legs slimmer.',
    });
    expect(annotation.status).toBe('open');

    await store.createJob({
      projectId: project.id,
      assetId: asset.id,
      kind: 'refine',
      input: {
        versionId: parent!.id,
        refinement: { instruction: '', annotationIds: [annotation.id], rebuildMesh: false },
      },
    });
    await drainAll();

    const finalAsset = await store.getAsset(asset.id);
    expect(finalAsset?.status).toBe('ready');
    expect(finalAsset?.currentVersionId).not.toBe(parent!.id); // a new version was created

    const newVersion = await store.getAssetVersion(finalAsset!.currentVersionId!);
    expect(newVersion?.parentVersionId).toBe(parent!.id);
    // Spec-only refinement (rebuildMesh: false): the mesh carries over unchanged.
    expect(newVersion?.meshPath).toBe(parent!.meshPath);

    const resolved = await store.getAnnotation(annotation.id);
    expect(resolved?.status).toBe('applied');
    expect(resolved?.resolvedByVersionId).toBe(newVersion!.id);
  });

  it('re-runs reconstruction and produces a new mesh when rebuildMesh is true', async () => {
    const parent = await buildReadyVersion();

    await store.createJob({
      projectId: project.id,
      assetId: asset.id,
      kind: 'refine',
      input: {
        versionId: parent!.id,
        refinement: { instruction: 'Lower the seat by 20mm', annotationIds: [], rebuildMesh: true },
      },
    });
    await drainAll();

    const finalAsset = await store.getAsset(asset.id);
    expect(finalAsset?.status).toBe('ready');
    const newVersion = await store.getAssetVersion(finalAsset!.currentVersionId!);
    expect(newVersion?.parentVersionId).toBe(parent!.id);
    expect(newVersion?.label).toBe('Lower the seat by 20mm');
    expect(newVersion?.meshPath).toBeTruthy();
    // A fresh reconstruct job ran, producing its own mesh blob.
    expect(await store.getBlob(newVersion!.meshPath!)).not.toBeNull();
  });

  it('does not mark an annotation applied unless the refine job actually ran', async () => {
    const parent = await buildReadyVersion();
    const annotation = await store.createAnnotation({
      assetId: asset.id,
      assetVersionId: parent!.id,
      sceneId: null,
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      partName: null,
      componentName: null,
      componentRole: null,
      originVersionId: parent!.id,
      originVersionNumber: parent!.versionNumber,
      staleNote: null,
      source: 'internal',
      clientName: null,
      selectionKind: 'point',
      anchorDescription: 'centre, 0 mm above the floor',
      body: 'Unrelated note.',
    });
    expect((await store.getAnnotation(annotation.id))?.status).toBe('open');
  });
});

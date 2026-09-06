import { Document, NodeIO } from '@gltf-transform/core';
import { getSceneVertexCount, VertexCountMethod } from '@gltf-transform/functions';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import type { FurnitureAsset, Project } from '@/lib/types';

/**
 * The stub provider's own massing meshes have nothing left for the
 * simplifier to give up (see tests/ai/mesh/simplify.test.ts and the
 * assertion in tests/pipeline/pipeline.test.ts) - real vendor scans are
 * where the win in issue #47 actually shows up. This drives the *real*
 * `reconstruct` stage end to end (queue -> runJob -> store), with the mesh
 * provider swapped for a fake that returns a dense synthetic mesh, so the
 * full previewMeshPath plumbing is exercised the way it would be against a
 * real vendor rather than only unit-testing `createPreviewMesh` in
 * isolation.
 */

async function makeSphereGlb(segments: number): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  document.getRoot().setDefaultScene(scene);
  const material = document.createMaterial('Sphere material');

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const rings = segments;
  const sectors = segments * 2;

  for (let r = 0; r <= rings; r += 1) {
    const theta = (Math.PI * r) / rings;
    for (let s = 0; s <= sectors; s += 1) {
      const phi = (2 * Math.PI * s) / sectors;
      const x = Math.sin(theta) * Math.cos(phi);
      const y = Math.cos(theta);
      const z = Math.sin(theta) * Math.sin(phi);
      positions.push(x, y, z);
      normals.push(x, y, z);
    }
  }

  const vertsPerRow = sectors + 1;
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < sectors; s += 1) {
      const a = r * vertsPerRow + s;
      const b = a + vertsPerRow;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const position = document.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
  const normal = document.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer);
  const index = document.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer);

  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setIndices(index)
    .setMaterial(material);
  const mesh = document.createMesh().addPrimitive(primitive);
  scene.addChild(document.createNode().setMesh(mesh));

  return new NodeIO().writeBinary(document);
}

vi.mock('@/lib/ai/mesh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/mesh')>();
  return {
    ...actual,
    getMeshProvider: () => ({
      name: 'fake-dense-vendor',
      configured: true,
      async reconstruct() {
        return { glb: await makeSphereGlb(64), providerJobId: 'fake-job', extentMm: 1200 };
      },
    }),
  };
});

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-preview-mesh-'));
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

async function drainAll(max = 20) {
  const { drainJobs } = await import('@/lib/pipeline');
  let total = 0;
  for (let i = 0; i < max; i += 1) {
    const processed = await drainJobs(store, 1);
    total += processed;
    if (processed === 0) break;
  }
  return total;
}

async function renderVertexCount(glb: Uint8Array): Promise<number> {
  const document = await new NodeIO().readBinary(glb);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!;
  return getSceneVertexCount(scene, VertexCountMethod.RENDER);
}

describe('reconstruct: preview mesh generation against a dense vendor mesh', () => {
  it('stores a distinct, lighter, structurally valid previewMeshPath alongside the full-detail meshPath', async () => {
    await store.createJob({ projectId: project.id, assetId: asset.id, kind: 'analyze', input: {} });
    await drainAll();

    const finalAsset = await store.getAsset(asset.id);
    expect(finalAsset?.status).toBe('ready');
    const version = await store.getAssetVersion(finalAsset!.currentVersionId!);
    expect(version?.provider).toBe('fake-dense-vendor');

    // Same shape a GET /api/assets/:id response carries on this version.
    expect(version!.meshPath).toBeTruthy();
    expect(version!.previewMeshPath).toBeTruthy();
    expect(version!.previewMeshPath).not.toBe(version!.meshPath);

    const fullBlob = await store.getBlob(version!.meshPath!);
    const previewBlob = await store.getBlob(version!.previewMeshPath!);
    expect(fullBlob).not.toBeNull();
    expect(previewBlob).not.toBeNull();

    // Both are independently valid glTF (NodeIO.readBinary throws on anything
    // structurally invalid), and the preview is genuinely lighter.
    const fullVertexCount = await renderVertexCount(fullBlob!.bytes);
    const previewVertexCount = await renderVertexCount(previewBlob!.bytes);
    expect(previewVertexCount).toBeLessThan(fullVertexCount);
    expect(previewBlob!.bytes.byteLength).toBeLessThan(fullBlob!.bytes.byteLength);
  });
});

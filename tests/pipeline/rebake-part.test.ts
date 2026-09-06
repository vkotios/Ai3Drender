import { NodeIO } from '@gltf-transform/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { drainJobs } from '@/lib/pipeline';
import type { AssetVersion, FurnitureAsset, Project } from '@/lib/types';

/**
 * Issue #57: `rebake_part` re-bakes one named part's material directly into
 * a new asset version's mesh, permanently - unlike the material spot-fix
 * (issue #48, `tests/api/material-spot-fix.test.ts`), which only patches the
 * spec and never touches the mesh. Drives the real job through `drainJobs`
 * against a real on-disk `LocalStore`, entirely offline (no GEMINI_API_KEY),
 * against the stub provider's own massing mesh - see
 * tests/pipeline/pipeline.test.ts for the same pattern.
 */

const io = new NodeIO();

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-rebake-'));
  store = new LocalStore(dir);

  project = await store.createProject({ ownerId: 'rebake-owner', name: 'Rebake project' });

  const imagePath = `${project.id}/sources/photo-1.jpg`;
  await store.putBlob(imagePath, new Uint8Array([1, 2, 3, 4]), 'image/jpeg');
  const image = await store.addSourceImage({
    projectId: project.id,
    path: imagePath,
    filename: 'sofa-front.jpg', // offline analyzer infers "sofa": Legs (frame) + three upholstered parts.
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
  let total = 0;
  for (let i = 0; i < max; i += 1) {
    const processed = await drainJobs(store, 1);
    total += processed;
    if (processed === 0) break;
  }
  return total;
}

async function buildReadyVersion(): Promise<AssetVersion> {
  await store.createJob({ projectId: project.id, assetId: asset.id, kind: 'analyze', input: {} });
  await drainAll();
  const ready = await store.getAsset(asset.id);
  return (await store.getAssetVersion(ready!.currentVersionId!))!;
}

describe('pipeline: rebake_part', () => {
  it('rebakes only the targeted part, forking a new version and a new mesh', async () => {
    const parent = await buildReadyVersion();
    const legs = parent.spec.components.find((c) => c.role === 'leg')!;
    const seat = parent.spec.components.find((c) => c.role === 'seat')!;
    expect(legs.materialId).not.toBe(seat.materialId);
    const parentLegMaterialId = legs.materialId;
    const parentSeatMaterial = parent.spec.materials.find((m) => m.id === seat.materialId)!;

    await store.createJob({
      projectId: project.id,
      assetId: asset.id,
      kind: 'rebake_part',
      input: {
        versionId: parent.id,
        target: legs.name, // exact name match, no model call needed
        materialChange: { instruction: 'darker, matte' },
      },
    });
    await drainAll();

    const finalAsset = await store.getAsset(asset.id);
    expect(finalAsset?.status).toBe('ready');
    expect(finalAsset?.currentVersionId).not.toBe(parent.id);

    const version = await store.getAssetVersion(finalAsset!.currentVersionId!);
    expect(version).not.toBeNull();
    expect(version!.parentVersionId).toBe(parent.id);
    expect(version!.meshPath).toBeTruthy();
    expect(version!.meshPath).not.toBe(parent.meshPath);
    // Nothing about the photographed views or real-world scale changed.
    expect(version!.views).toEqual(parent.views);
    expect(version!.meshExtentMm).toBe(parent.meshExtentMm);
    // A fresh thumbnail is needed since a part's appearance changed.
    expect(version!.previewPath).toBeNull();

    // The rebaked component now points at a brand-new material entry...
    const newLegs = version!.spec.components.find((c) => c.name === legs.name)!;
    expect(newLegs.materialId).not.toBe(parentLegMaterialId);
    const newLegMaterial = version!.spec.materials.find((m) => m.id === newLegs.materialId)!;
    expect(newLegMaterial.invented).toBe(true);
    expect(newLegMaterial.libraryEntryId).toBeNull();
    expect(newLegMaterial.notes).toMatch(/spot-fixed offline/i);

    // ...while every other component's material binding is completely untouched.
    const newSeat = version!.spec.components.find((c) => c.name === seat.name)!;
    expect(newSeat.materialId).toBe(seat.materialId);
    expect(version!.spec.materials.find((m) => m.id === newSeat.materialId)).toEqual(parentSeatMaterial);

    // Traceability: the version records what this rebake actually did.
    expect(version!.rebakedPart).toMatchObject({
      target: legs.name,
      componentNames: [legs.name],
      materialSource: 'instruction',
      libraryEntryId: null,
      materialId: newLegs.materialId,
    });
    expect(version!.rebakedPart!.meshPartNames.length).toBeGreaterThan(0);

    // And the mesh itself changed: the leg material's baked colour differs,
    // while the untouched seat's does not.
    const parentGlb = (await store.getBlob(parent.meshPath!))!.bytes;
    const parentDoc = await io.readBinary(parentGlb);
    const parentLegColor = parentDoc
      .getRoot()
      .listMeshes()
      .find((m) => m.getName().startsWith(legs.name))!
      .listPrimitives()[0]
      .getMaterial()!
      .getBaseColorFactor();

    const rebakedGlb = (await store.getBlob(version!.meshPath!))!.bytes;
    const rebakedDoc = await io.readBinary(rebakedGlb);
    const rebakedLegColor = rebakedDoc
      .getRoot()
      .listMeshes()
      .find((m) => m.getName().startsWith(legs.name))!
      .listPrimitives()[0]
      .getMaterial()!
      .getBaseColorFactor();
    expect(rebakedLegColor).not.toEqual(parentLegColor);

    const seatMeshName = version!.spec.components.find((c) => c.name === seat.name)!.name;
    const parentSeatColor = parentDoc
      .getRoot()
      .listMeshes()
      .find((m) => m.getName().startsWith(seatMeshName))!
      .listPrimitives()[0]
      .getMaterial()!
      .getBaseColorFactor();
    const rebakedSeatColor = rebakedDoc
      .getRoot()
      .listMeshes()
      .find((m) => m.getName().startsWith(seatMeshName))!
      .listPrimitives()[0]
      .getMaterial()!
      .getBaseColorFactor();
    expect(rebakedSeatColor).toEqual(parentSeatColor);
  });

  it('resolves a free-text target offline via word-overlap against the component list', async () => {
    const parent = await buildReadyVersion();
    const legs = parent.spec.components.find((c) => c.role === 'leg')!;

    await store.createJob({
      projectId: project.id,
      assetId: asset.id,
      kind: 'rebake_part',
      input: {
        versionId: parent.id,
        target: 'the legs underneath', // no exact match; must fall back to word overlap
        materialChange: { instruction: 'glossy black' },
      },
    });
    await drainAll();

    const finalAsset = await store.getAsset(asset.id);
    const version = await store.getAssetVersion(finalAsset!.currentVersionId!);
    expect(version!.rebakedPart!.componentNames).toEqual([legs.name]);
  });

  it('fails the job, without touching the current version, when the part cannot be resolved', async () => {
    const parent = await buildReadyVersion();

    const job = await store.createJob({
      projectId: project.id,
      assetId: asset.id,
      kind: 'rebake_part',
      input: {
        versionId: parent.id,
        target: 'the antigravity module',
        materialChange: { instruction: 'shinier' },
      },
      maxAttempts: 1,
    });
    await drainAll();

    const finished = await store.getJob(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/could not match/i);

    // No new version was created off the back of the failed attempt.
    const versions = await store.listAssetVersions(asset.id);
    expect(versions).toHaveLength(1);
  });

  it('binds the rebaked part to a library entry when libraryEntryId is given', async () => {
    const parent = await buildReadyVersion();
    const legs = parent.spec.components.find((c) => c.role === 'leg')!;

    const entry = await store.createMaterialLibraryEntry({
      ownerId: project.ownerId,
      name: 'Blackened steel',
      code: 'STL-014',
      kind: 'metal',
      baseColorHex: '#1A1A1D',
      roughness: 0.4,
      metalness: 1,
      sheen: 0,
      clearcoat: 0,
      finish: 'powder-coated',
      notes: '',
      swatchPath: null,
      archivedAt: null,
    });

    await store.createJob({
      projectId: project.id,
      assetId: asset.id,
      kind: 'rebake_part',
      input: {
        versionId: parent.id,
        target: legs.name,
        materialChange: { libraryEntryId: entry.id },
      },
    });
    await drainAll();

    const finalAsset = await store.getAsset(asset.id);
    const version = await store.getAssetVersion(finalAsset!.currentVersionId!);
    const newLegs = version!.spec.components.find((c) => c.name === legs.name)!;
    const newMaterial = version!.spec.materials.find((m) => m.id === newLegs.materialId)!;

    expect(newMaterial.libraryEntryId).toBe(entry.id);
    expect(newMaterial.invented).toBe(false);
    expect(newMaterial.baseColorHex).toBe(entry.baseColorHex);
    expect(version!.rebakedPart).toMatchObject({ materialSource: 'library', libraryEntryId: entry.id });
  });
});

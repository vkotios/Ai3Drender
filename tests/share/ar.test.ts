import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { describe, expect, it } from 'vitest';

import { buildMassingGlb } from '@/lib/ai/mesh/massing';
import { createBoxMaterial, createBoxNode } from '@/lib/render/box-mesh';
import { buildArGlb } from '@/lib/share/ar';

import { makeFurnitureSpec } from '../fixtures';

async function readScene(bytes: Uint8Array) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(bytes);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new Error('no scene in result');
  return { document, scene };
}

describe('buildArGlb', () => {
  it('leaves an already real-world-scale mesh unscaled, but grounds and re-centres it', async () => {
    const spec = makeFurnitureSpec();
    const glb = buildMassingGlb(spec);
    const targetLongestM =
      Math.max(spec.dimensions.widthMm, spec.dimensions.depthMm, spec.dimensions.heightMm) / 1000;

    const bytes = await buildArGlb({ glb, meshExtentMm: targetLongestM * 1000, targetLongestM });

    const { scene } = await readScene(bytes);
    // Reparented under one wrapper node, not left as several top-level nodes.
    expect(scene.listChildren()).toHaveLength(1);

    const { min, max } = getBounds(scene);
    const longestAxis = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    // fit === 1: unscaled, so the longest axis matches the spec's real-world size.
    expect(longestAxis).toBeCloseTo(targetLongestM, 2);
    // Grounded: lowest point sits on the floor.
    expect(min[1]).toBeCloseTo(0, 3);
    // Re-centred: the footprint is centred on the X/Z origin.
    expect((min[0] + max[0]) / 2).toBeCloseTo(0, 3);
    expect((min[2] + max[2]) / 2).toBeCloseTo(0, 3);
  });

  it('rescales a unit-normalised mesh to the spec-derived real-world size', async () => {
    // A 2m cube sitting well off-origin and off the floor - nothing like the
    // eventual real-world size, the way an unnormalised vendor mesh might be.
    const document = new Document();
    const scene = document.createScene('S');
    const material = createBoxMaterial(document, { name: 'm', baseColorHex: '#888888', roughness: 0.5, metalness: 0 });
    const node = createBoxNode(document, { name: 'box', size: [2, 2, 2], center: [5, 6, 7] }, material);
    scene.addChild(node);
    const glb = await new NodeIO().writeBinary(document);

    const targetLongestM = 0.8; // matches makeFurnitureSpec's heightMm (800mm)
    const bytes = await buildArGlb({ glb, meshExtentMm: null, targetLongestM });

    const { scene: outScene } = await readScene(bytes);
    const { min, max } = getBounds(outScene);
    const longestAxis = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

    expect(longestAxis).toBeCloseTo(targetLongestM, 3);
    expect(min[1]).toBeCloseTo(0, 3);
    expect((min[0] + max[0]) / 2).toBeCloseTo(0, 3);
    expect((min[2] + max[2]) / 2).toBeCloseTo(0, 3);
  });

  it('produces bytes that round-trip through a fresh reader (structurally valid glTF)', async () => {
    const spec = makeFurnitureSpec();
    const glb = buildMassingGlb(spec);
    const targetLongestM =
      Math.max(spec.dimensions.widthMm, spec.dimensions.depthMm, spec.dimensions.heightMm) / 1000;

    const bytes = await buildArGlb({ glb, meshExtentMm: targetLongestM * 1000, targetLongestM });

    expect(bytes.byteLength).toBeGreaterThan(0);
    // Throws on a structurally invalid document - the same check
    // writeAndValidateGlb (lib/render/build-scene.ts) relies on.
    await expect(new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes)).resolves.toBeDefined();
  });
});


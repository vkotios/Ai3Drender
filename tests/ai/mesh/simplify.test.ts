import { Document, NodeIO } from '@gltf-transform/core';
import { getSceneVertexCount, VertexCountMethod } from '@gltf-transform/functions';
import { describe, expect, it } from 'vitest';

import { createPreviewMesh } from '@/lib/ai/mesh/simplify';
import { writeGlb, type GlbBox, type GlbMaterial } from '@/lib/ai/mesh/glb';

const io = new NodeIO();

/**
 * A UV sphere with plenty of triangles - dense enough that `simplify` has
 * real freedom to collapse edges without exceeding its error budget, unlike
 * the massing generator's hard-edged boxes (see the "declines to reduce"
 * test below). Built straight against `@gltf-transform/core`'s Document API,
 * independent of anything the stub provider or three.js would give us, per
 * the verification note on issue #47 about constructing a denser synthetic
 * mesh.
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

  return io.writeBinary(document);
}

async function renderVertexCount(glb: Uint8Array): Promise<number> {
  const document = await io.readBinary(glb);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!;
  return getSceneVertexCount(scene, VertexCountMethod.RENDER);
}

describe('createPreviewMesh', () => {
  it('decimates a dense mesh down toward the target ratio and stays valid glTF', async () => {
    const glb = await makeSphereGlb(64);
    const sourceCount = await renderVertexCount(glb);

    const result = await createPreviewMesh(glb, 0.5);
    expect(result).not.toBeNull();
    expect(result!.sourceVertexCount).toBe(sourceCount);
    expect(result!.previewVertexCount).toBeLessThan(result!.sourceVertexCount);
    // Meshoptimizer aims for the target ratio; a UV sphere has no hard edges
    // to protect it, so it should land close to it rather than refusing.
    expect(result!.previewVertexCount).toBeLessThan(result!.sourceVertexCount * 0.75);

    // The stored bytes are themselves a smaller, structurally valid glTF.
    const document = await io.readBinary(result!.glb);
    const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!;
    expect(getSceneVertexCount(scene, VertexCountMethod.RENDER)).toBe(result!.previewVertexCount);
    expect(result!.glb.byteLength).toBeLessThan(glb.byteLength);
  });

  it('declines to reduce a mesh with nothing to give up, and returns null', async () => {
    // The massing generator's actual output: flat-shaded boxes whose faces
    // share no vertices (different normals per face) and whose quads can't
    // be simplified below two triangles without changing the silhouette -
    // the real case this pipeline hits for the stub provider.
    const box: GlbBox = { name: 'Seat', center: [0, 0.2, 0], size: [1, 0.4, 0.8], materialIndex: 0 };
    const material: GlbMaterial = { name: 'Upholstery', baseColorHex: '#8C8778', metallic: 0, roughness: 0.9 };
    const glb = writeGlb([box], [material]);

    const result = await createPreviewMesh(glb, 0.5);
    expect(result).toBeNull();
  });

  it('returns null rather than throwing for bytes that are not a readable glTF', async () => {
    const result = await createPreviewMesh(new Uint8Array([1, 2, 3, 4]), 0.5);
    expect(result).toBeNull();
  });

  it('returns null for an empty scene', async () => {
    const document = new Document();
    document.getRoot().setDefaultScene(document.createScene());
    const glb = await io.writeBinary(document);

    const result = await createPreviewMesh(glb, 0.5);
    expect(result).toBeNull();
  });
});

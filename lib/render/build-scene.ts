/**
 * Server-side equivalent of `lib/studio/export.ts`.
 *
 * The client exporter walks a *live* three.js scene graph - meshes already
 * loaded, GLTFExporter serialises what's on screen. There is no live three.js
 * scene on the server (no WebGL, no DOM, no GPU to load one into), so this
 * module reconstructs an equivalent scene graph directly from the `SceneDoc`
 * data model instead, using `@gltf-transform/core` to assemble one glTF
 * Document without needing three.js at all:
 *
 *  - Asset nodes: each `AssetVersion`'s mesh is already a stored glTF/GLB (the
 *    reconstruct stage wrote it). It is parsed, measured, and merged into the
 *    combined document under a wrapper node that reproduces the exact fit
 *    (real-world scale) and grounding offset `AssetNode.tsx` applies in the
 *    viewport, then the `SceneNode`'s own transform on top of that.
 *  - Prop, floor and wall geometry: authored directly as boxes via
 *    `lib/render/box-mesh.ts`, matching the sizes and colours
 *    `components/studio/Booth.tsx` and `PropNode.tsx` use.
 *  - Lights: emitted as `KHR_lights_punctual` point lights, matching the
 *    point lights `components/studio/Lighting.tsx` renders for light nodes.
 *  - Camera: emitted as a glTF perspective camera, oriented with a look-at
 *    computed from `SceneDoc.camera`.
 *
 * What this deliberately does NOT carry into the glTF: the HDRI image-based
 * lighting `EnvironmentSettings.hdriPreset` drives client-side (`drei`'s
 * `<Environment preset>` pulls a bundled HDRI file that only exists in the
 * browser bundle, not on this server) and the ambient/background intensities
 * that go with it. Those are real-render (world/film) settings rather than
 * scene geometry, so they travel to the Blender script as plain JSON
 * alongside the glTF instead - see `lib/pipeline/render.ts`.
 */
import { Document, type Node as GltfNode, NodeIO, type Scene } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRLightsPunctual, Light } from '@gltf-transform/extensions';
import { getBounds, mergeDocuments, unpartition } from '@gltf-transform/functions';

import { PROP_DEFINITIONS } from '@/lib/scene/presets';
import { isValidFootprintBoundary, wallSegmentPlacement } from '@/lib/scene/footprint';
import type { EnvironmentSettings, SceneDoc, SceneNode } from '@/lib/types';

import { createBoxMaterial, createBoxNode } from './box-mesh';
import { eulerXYZToQuaternion, lookAtQuaternion, type QuatTuple, type Vec3Tuple } from './gltf-math';
import { createPolygonFloorNode } from './polygon-mesh';

/** Matches `components/studio/Booth.tsx`'s WALL_THICKNESS - kept in sync manually, see note there. */
const WALL_THICKNESS = 0.06;

/**
 * glTF punctual point lights are photometric (candela); `SceneLight.intensity`
 * is an arbitrary three.js multiplier. There is no exact conversion between
 * the two, so this is a documented approximation, not a calibrated one - it
 * exists so a "brighter" light node reliably renders brighter, not to match
 * any particular physical unit.
 */
const LIGHT_INTENSITY_SCALE = 300;

export interface AssetMeshSource {
  /** The stored .glb bytes for this AssetVersion. */
  glb: Uint8Array;
  /** AssetVersion.meshExtentMm - already real-world scale when set. */
  meshExtentMm: number | null;
  /** max(widthMm, depthMm, heightMm) / 1000 from the version's FurnitureSpec. */
  targetLongestM: number;
}

export interface BuildSceneResult {
  document: Document;
  /** Non-fatal issues - a missing/unreadable asset mesh, etc. Rendering still proceeds. */
  warnings: string[];
  /** How many scene nodes (assets + props + lights) actually made it into the document. */
  renderableNodeCount: number;
}

function quatOf(x: number, y: number, z: number): QuatTuple {
  return eulerXYZToQuaternion(x, y, z);
}

function applyTransform(node: GltfNode, transform: SceneNode['transform']): GltfNode {
  return node
    .setTranslation([transform.position.x, transform.position.y, transform.position.z])
    .setRotation(quatOf(transform.rotation.x, transform.rotation.y, transform.rotation.z))
    .setScale([transform.scale.x, transform.scale.y, transform.scale.z]);
}

async function addAssetNode(
  document: Document,
  node: SceneNode,
  mesh: AssetMeshSource,
  warnings: string[],
): Promise<GltfNode | null> {
  let source: Document;
  try {
    const reader = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    source = await reader.readBinary(mesh.glb);
  } catch (cause) {
    warnings.push(
      `asset node "${node.name}": stored mesh is not a readable glTF (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
    return null;
  }

  const sourceScene = source.getRoot().getDefaultScene() ?? source.getRoot().listScenes()[0];
  if (!sourceScene) {
    warnings.push(`asset node "${node.name}": stored mesh has no scene`);
    return null;
  }

  // Measure in the mesh's own local space, before any scaling - mirrors
  // AssetNode.tsx's `new THREE.Box3().setFromObject(root)` on the raw import.
  const { min, max } = getBounds(sourceScene);
  const size: Vec3Tuple = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longestAxis = Math.max(size[0], size[1], size[2]) || 1;

  // meshExtentMm set means the provider already returned real-world units (the
  // massing generator does); null means unit-normalised, so fit it to the
  // spec's dimensions - identical rule to AssetNode.tsx.
  const fit = mesh.meshExtentMm === null ? mesh.targetLongestM / longestAxis : 1;
  const center: Vec3Tuple = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const offset: Vec3Tuple = [-center[0] * fit, -min[1] * fit, -center[2] * fit];

  const map = mergeDocuments(document, source);
  const mergedScene = map.get(sourceScene) as Scene | undefined;
  if (!mergedScene) {
    warnings.push(`asset node "${node.name}": merge did not produce a scene`);
    return null;
  }

  const inner = document.createNode(`${node.name} mesh`).setTranslation(offset).setScale([fit, fit, fit]);
  for (const child of mergedScene.listChildren()) inner.addChild(child);
  mergedScene.dispose();

  const outer = applyTransform(document.createNode(node.name), node.transform);
  outer.addChild(inner);
  return outer;
}

function addPropNode(document: Document, node: SceneNode): GltfNode | null {
  if (!node.propKind) return null;
  const definition = PROP_DEFINITIONS[node.propKind];
  const override = node.materialOverrides.prop;
  const [w, h, d] = definition.size;

  const material = createBoxMaterial(document, {
    name: `${node.name} material`,
    baseColorHex: override?.baseColorHex ?? definition.colorHex,
    roughness: override?.roughness ?? definition.roughness,
    metalness: override?.metalness ?? 0,
  });
  // Authored centred, lifted by half height to sit on the floor - matches PropNode.tsx.
  const inner = createBoxNode(document, { name: `${node.name} box`, size: [w, h, d], center: [0, h / 2, 0] }, material);

  const outer = applyTransform(document.createNode(node.name), node.transform);
  outer.addChild(inner);
  return outer;
}

function addLightNode(document: Document, lights: KHRLightsPunctual, node: SceneNode): GltfNode | null {
  if (!node.light) return null;
  const [r, g, b] = hexToLinear(node.light.colorHex);

  const light = lights
    .createLight(node.name)
    .setType(Light.Type.POINT)
    .setColor([r, g, b])
    .setIntensity(Math.max(0, node.light.intensity) * LIGHT_INTENSITY_SCALE);
  if (node.light.distance > 0) light.setRange(node.light.distance);

  const gltfNode = document.createNode(node.name).setExtension('KHR_lights_punctual', light);
  return gltfNode.setTranslation([
    node.transform.position.x,
    node.transform.position.y,
    node.transform.position.z,
  ]);
}

function hexToLinear(hex: string): Vec3Tuple {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}

/**
 * Floor + walls for a traced footprint (issue #52 Phase A), used instead of
 * the fixed rectangle below whenever `environment.footprint` has a usable
 * boundary. Wall height still comes from `environment.boothHeight` - the
 * traced polygon only ever replaces the *plan* the fixed model draws, not
 * the wall-height control in the inspector.
 */
function addFootprintGeometry(document: Document, environment: EnvironmentSettings): GltfNode[] {
  const footprint = environment.footprint;
  if (!footprint || !isValidFootprintBoundary(footprint.boundary)) return [];
  const nodes: GltfNode[] = [];

  const floorMaterial = createBoxMaterial(document, {
    name: 'Floor material',
    baseColorHex: environment.floorColorHex,
    roughness: 0.55,
    metalness: 0,
    // A hand-traced polygon can come in either winding order depending on
    // which way the user clicked around it - double-sided sidesteps that
    // rather than policing it, see lib/scene/footprint.ts's signedArea2.
    doubleSided: true,
  });
  const floorNode = createPolygonFloorNode(document, 'Floor', footprint.boundary, floorMaterial);
  if (floorNode) nodes.push(floorNode);

  const wallMaterial = createBoxMaterial(document, {
    name: 'Wall material',
    baseColorHex: environment.wallColorHex,
    roughness: 0.92,
    metalness: 0,
  });
  const h = environment.boothHeight;
  footprint.walls.forEach((wall, i) => {
    if (wall.open) return;
    const placement = wallSegmentPlacement(wall);
    if (placement.length < 1e-6) return; // a degenerate (zero-length) traced segment - nothing to build.
    const inner = createBoxNode(
      document,
      { name: `Footprint Wall ${i}`, size: [placement.length, h, WALL_THICKNESS], center: [0, h / 2, 0] },
      wallMaterial,
    );
    nodes.push(
      inner
        .setTranslation([placement.centerX, 0, placement.centerZ])
        .setRotation(eulerXYZToQuaternion(0, placement.rotationY, 0)),
    );
  });

  return nodes;
}

function addEnvironmentGeometry(document: Document, environment: EnvironmentSettings): GltfNode[] {
  const footprintNodes = addFootprintGeometry(document, environment);
  if (footprintNodes.length > 0) return footprintNodes;

  const { boothWidth: w, boothDepth: d, boothHeight: h, walls } = environment;
  const nodes: GltfNode[] = [];

  const floorMaterial = createBoxMaterial(document, {
    name: 'Floor material',
    baseColorHex: environment.floorColorHex,
    roughness: 0.55,
    metalness: 0,
  });
  // A thin slab rather than a true plane - box-mesh only authors boxes, and a
  // 2cm slab is visually identical to a plane at booth scale.
  nodes.push(createBoxNode(document, { name: 'Floor', size: [w, 0.02, d], center: [0, -0.01, 0] }, floorMaterial));

  const wallMaterial = createBoxMaterial(document, {
    name: 'Wall material',
    baseColorHex: environment.wallColorHex,
    roughness: 0.92,
    metalness: 0,
  });
  if (walls.back) {
    nodes.push(
      createBoxNode(document, { name: 'Wall Back', size: [w, h, WALL_THICKNESS], center: [0, h / 2, -d / 2] }, wallMaterial),
    );
  }
  if (walls.left) {
    nodes.push(
      createBoxNode(document, { name: 'Wall Left', size: [WALL_THICKNESS, h, d], center: [-w / 2, h / 2, 0] }, wallMaterial),
    );
  }
  if (walls.right) {
    nodes.push(
      createBoxNode(document, { name: 'Wall Right', size: [WALL_THICKNESS, h, d], center: [w / 2, h / 2, 0] }, wallMaterial),
    );
  }

  return nodes;
}

function addCameraNode(document: Document, sceneDoc: SceneDoc): GltfNode {
  const { camera, environment } = sceneDoc;
  const zFar = Math.max(environment.boothWidth, environment.boothDepth, environment.boothHeight, 10) * 20;

  const gltfCamera = document
    .createCamera('Scene Camera')
    .setType('perspective')
    .setZNear(0.05)
    .setZFar(zFar)
    .setYFov((camera.fov * Math.PI) / 180);

  const position: Vec3Tuple = [camera.position.x, camera.position.y, camera.position.z];
  const target: Vec3Tuple = [camera.target.x, camera.target.y, camera.target.z];

  return document
    .createNode('Camera')
    .setCamera(gltfCamera)
    .setTranslation(position)
    .setRotation(lookAtQuaternion(position, target));
}

export async function buildSceneDocument(
  sceneDoc: SceneDoc,
  loadAssetMesh: (assetVersionId: string) => Promise<AssetMeshSource | null>,
): Promise<BuildSceneResult> {
  const document = new Document();
  const scene = document.createScene('Scene');
  document.getRoot().setDefaultScene(scene);

  const warnings: string[] = [];
  let renderableNodeCount = 0;
  const lights = document.createExtension(KHRLightsPunctual);

  for (const box of addEnvironmentGeometry(document, sceneDoc.environment)) scene.addChild(box);

  for (const node of sceneDoc.nodes) {
    if (!node.visible) continue;

    if (node.kind === 'asset' && node.assetVersionId) {
      const mesh = await loadAssetMesh(node.assetVersionId);
      if (!mesh) {
        warnings.push(`asset node "${node.name}": no mesh available (version not ready yet)`);
        continue;
      }
      const added = await addAssetNode(document, node, mesh, warnings);
      if (added) {
        scene.addChild(added);
        renderableNodeCount += 1;
      }
    } else if (node.kind === 'prop') {
      const added = addPropNode(document, node);
      if (added) {
        scene.addChild(added);
        renderableNodeCount += 1;
      }
    } else if (node.kind === 'light') {
      const added = addLightNode(document, lights, node);
      if (added) {
        scene.addChild(added);
        renderableNodeCount += 1;
      }
    }
  }

  scene.addChild(addCameraNode(document, sceneDoc));

  return { document, warnings, renderableNodeCount };
}

/** Round-trip through NodeIO so a structurally invalid document fails loudly, before it ever reaches Blender. */
export async function writeAndValidateGlb(document: Document): Promise<Uint8Array> {
  // Merging several source documents (one per asset mesh) leaves one Buffer per
  // source; a .glb may only ever contain one.
  await document.transform(unpartition());

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const bytes = await io.writeBinary(document);
  // Re-parse: readBinary throws on a structurally invalid glTF, which is the
  // validation gltf-transform gives us without a separate validator package.
  await io.readBinary(bytes);
  return bytes;
}

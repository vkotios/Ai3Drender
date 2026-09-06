import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { NodeIO } from '@gltf-transform/core';

import { encodePng } from './png';

/**
 * Renders a couple of stock views of a reconstructed mesh, so the perceptual
 * QA pass (lib/ai/gemini.ts's `evaluateReconstruction`) has something to
 * actually compare against the source photographs.
 *
 * There is no headless WebGL/Blender-style renderer already wired up for a
 * single arbitrary mesh (the Blender path in lib/pipeline/render.ts renders a
 * whole *scene* and shells out to a `blender` binary that is not guaranteed
 * to exist on every deployment; three.js needs a live GL context this process
 * doesn't have). Rather than add either as a hard dependency of every
 * reconstruction, this is a small software rasterizer: flat-shaded,
 * perspective, single directional light plus ambient - enough for a vision
 * model to judge silhouette, proportion and colour, not a production
 * renderer. It only needs `@gltf-transform/core`, already a dependency for
 * exactly this kind of "read a stored .glb" job (see lib/render/build-scene.ts).
 */

export interface MeshView {
  angle: string;
  image: { bytes: Uint8Array; mimeType: string };
}

const IMAGE_SIZE = 320;
const VERTICAL_FOV_RAD = (32 * Math.PI) / 180;
const NEAR = 1e-4;
/** camera looks from slightly above eye level, never dead-on from the top or floor. */
const ELEVATION_RAD = (22 * Math.PI) / 180;
const LIGHT_DIR = normalize([0.4, 0.85, 0.55]);
const AMBIENT = 0.42;
const DIFFUSE = 0.58;
const BACKGROUND: Rgb = [0.13, 0.13, 0.14];
/** Hard cap so one pathological mesh cannot turn a soft QA step into a stuck job. */
const MAX_TRIANGLES = 150_000;

type Vec3 = [number, number, number];
type Rgb = [number, number, number];
/** Column-major 4x4, glTF/gl-matrix convention (translation in [12..14]). */
type Mat4 = number[];

/** One of a handful of fixed cameras a reconstructed piece is viewed from. */
const STOCK_ANGLES: { angle: string; azimuthRad: number }[] = [
  { angle: 'front', azimuthRad: 0 },
  { angle: 'three_quarter', azimuthRad: Math.PI / 4 },
  { angle: 'side', azimuthRad: Math.PI / 2 },
];

interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  color: Rgb;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len < 1e-8 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

/** Apply a column-major affine matrix to a point. */
function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** linear -> sRGB, for writing displayable pixels back out. glTF baseColorFactor is already linear. */
function toSrgb(c: number): number {
  const clamped = Math.min(1, Math.max(0, c));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/**
 * Flatten every primitive of the glTF's default scene into world-space
 * triangles with a flat colour each. Vertex normals are ignored deliberately:
 * flat per-triangle shading needs only the triangle itself, and this is a
 * silhouette/colour check, not a smoothness one.
 */
async function loadTriangles(glb: Uint8Array): Promise<Triangle[]> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(glb);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new Error('renderMeshViews: mesh has no scene');

  const triangles: Triangle[] = [];

  scene.traverse((node) => {
    if (triangles.length >= MAX_TRIANGLES) return;
    const mesh = node.getMesh();
    if (!mesh) return;
    const worldMatrix = node.getWorldMatrix() as unknown as Mat4;

    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const positions = position.getArray();
      if (!positions) continue;

      const material = primitive.getMaterial();
      const factor = material?.getBaseColorFactor() ?? [0.6, 0.6, 0.6, 1];
      const color: Rgb = [factor[0], factor[1], factor[2]];

      const indicesAccessor = primitive.getIndices();
      const indices = indicesAccessor
        ? indicesAccessor.getArray()
        : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
      if (!indices) continue;

      const vertexAt = (i: number): Vec3 => {
        const base = i * 3;
        return transformPoint(worldMatrix, [positions[base], positions[base + 1], positions[base + 2]]);
      };

      for (let i = 0; i + 2 < indices.length && triangles.length < MAX_TRIANGLES; i += 3) {
        triangles.push({
          a: vertexAt(indices[i]),
          b: vertexAt(indices[i + 1]),
          c: vertexAt(indices[i + 2]),
          color,
        });
      }
    }
  });

  return triangles;
}

function boundingSphere(triangles: Triangle[]): { center: Vec3; radius: number } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) {
    for (const v of [t.a, t.b, t.c]) {
      for (let axis = 0; axis < 3; axis += 1) {
        if (v[axis] < min[axis]) min[axis] = v[axis];
        if (v[axis] > max[axis]) max[axis] = v[axis];
      }
    }
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(length(sub(max, center)), 0.05);
  return { center, radius };
}

/** Rasterize `triangles` from one camera position into a small RGB image. */
function renderFrame(triangles: Triangle[], eye: Vec3, target: Vec3, size: number): Uint8Array {
  const color = new Float64Array(size * size * 3);
  for (let i = 0; i < color.length; i += 3) {
    color[i] = BACKGROUND[0];
    color[i + 1] = BACKGROUND[1];
    color[i + 2] = BACKGROUND[2];
  }
  const depth = new Float64Array(size * size).fill(Infinity);

  // Right-handed look-at basis: camera-space +Z points back toward the eye.
  let zAxis = normalize(sub(eye, target));
  if (length(zAxis) < 1e-8) zAxis = [0, 0, 1];
  let xAxis = normalize(cross([0, 1, 0], zAxis));
  if (length(xAxis) < 1e-8) xAxis = normalize(cross([0, 0, 1], zAxis));
  const yAxis = cross(zAxis, xAxis);

  const toView = (p: Vec3): Vec3 => {
    const rel = sub(p, eye);
    return [dot(rel, xAxis), dot(rel, yAxis), dot(rel, zAxis)];
  };

  const scale = 1 / Math.tan(VERTICAL_FOV_RAD / 2);
  const project = (v: Vec3): { x: number; y: number; depth: number } | null => {
    const viewZ = -v[2]; // distance in front of the camera (camera looks down -Z in its own space)
    if (viewZ <= NEAR) return null;
    const ndcX = (v[0] * scale) / viewZ;
    const ndcY = (v[1] * scale) / viewZ;
    return {
      x: ((ndcX + 1) / 2) * size,
      y: ((1 - ndcY) / 2) * size,
      depth: viewZ,
    };
  };

  for (const tri of triangles) {
    const va = toView(tri.a);
    const vb = toView(tri.b);
    const vc = toView(tri.c);
    const pa = project(va);
    const pb = project(vb);
    const pc = project(vc);
    if (!pa || !pb || !pc) continue; // simplest possible near-plane clip: drop the triangle

    // Flat shading: one normal per triangle, in world space, facing the camera.
    let normal = normalize(cross(sub(tri.b, tri.a), sub(tri.c, tri.a)));
    const towardEye = sub(eye, tri.a);
    if (dot(normal, towardEye) < 0) normal = [-normal[0], -normal[1], -normal[2]];
    const shade = AMBIENT + DIFFUSE * Math.max(0, dot(normal, LIGHT_DIR));
    const lit: Rgb = [tri.color[0] * shade, tri.color[1] * shade, tri.color[2] * shade];

    const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
    const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
    if (minX > maxX || minY > maxY) continue;

    const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
    if (Math.abs(area) < 1e-8) continue;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((pb.x - px) * (pc.y - py) - (pc.x - px) * (pb.y - py)) / area;
        const w1 = ((pc.x - px) * (pa.y - py) - (pa.x - px) * (pc.y - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const d = w0 * pa.depth + w1 * pb.depth + w2 * pc.depth;
        const idx = y * size + x;
        if (d >= depth[idx]) continue;
        depth[idx] = d;

        const ci = idx * 3;
        color[ci] = lit[0];
        color[ci + 1] = lit[1];
        color[ci + 2] = lit[2];
      }
    }
  }

  const bytes = new Uint8Array(size * size * 3);
  for (let i = 0; i < color.length; i += 1) bytes[i] = Math.round(toSrgb(color[i]) * 255);
  return bytes;
}

/**
 * Render `renderMeshViews.ANGLES.length` (currently 3) stock views of a
 * stored .glb: front, three-quarter and side, framed to the mesh's own
 * bounding sphere so it fills the frame regardless of real-world scale.
 */
export async function renderMeshViews(glb: Uint8Array): Promise<MeshView[]> {
  const triangles = await loadTriangles(glb);
  if (triangles.length === 0) return [];

  const { center, radius } = boundingSphere(triangles);
  // Margin so the silhouette does not touch the frame edge; distance derived
  // from the vertical FOV so the same framing works at any mesh scale.
  const distance = (radius * 1.35) / Math.tan(VERTICAL_FOV_RAD / 2);

  const views: MeshView[] = [];
  for (const { angle, azimuthRad } of STOCK_ANGLES) {
    const eye: Vec3 = [
      center[0] + distance * Math.sin(azimuthRad) * Math.cos(ELEVATION_RAD),
      center[1] + distance * Math.sin(ELEVATION_RAD) + radius * 0.15,
      center[2] + distance * Math.cos(azimuthRad) * Math.cos(ELEVATION_RAD),
    ];
    const rgb = renderFrame(triangles, eye, center, IMAGE_SIZE);
    views.push({ angle, image: { bytes: encodePng(IMAGE_SIZE, IMAGE_SIZE, rgb), mimeType: 'image/png' } });
  }
  return views;
}

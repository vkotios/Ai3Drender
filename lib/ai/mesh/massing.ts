import type { FurnitureSpec } from '@/lib/types';

import { writeGlb, type GlbBox, type GlbMaterial } from './glb';

/**
 * Turns a FurnitureSpec into a proportional block model ("massing").
 *
 * This is not reconstruction - it invents no shape the spec did not state. What
 * it does give you is a correctly-scaled, correctly-coloured stand-in with the
 * right footprint and seat height, which is enough to lay out a booth, check
 * clearances and sanity-check a scene before a real mesh vendor is wired up.
 *
 * Coordinates follow glTF: Y up, metres, origin on the floor at the centre of
 * the footprint, +Z toward the front of the piece.
 */

const MM = 1 / 1000;

interface Layout {
  width: number;
  depth: number;
  height: number;
  seatHeight: number;
}

/** Components are placed by role; anything unrecognised is stacked centrally. */
function placeComponent(
  role: string,
  size: [number, number, number],
  layout: Layout,
  stackCursor: { y: number },
): [number, number, number][] {
  const [w, h, d] = size;
  const { width, depth, height, seatHeight } = layout;
  const halfW = width / 2;
  const halfD = depth / 2;

  switch (role) {
    case 'leg': {
      // Four legs inset from the corners by half their own thickness.
      const x = halfW - w / 2;
      const z = halfD - d / 2;
      const y = h / 2;
      return [
        [x, y, z],
        [-x, y, z],
        [x, y, -z],
        [-x, y, -z],
      ];
    }
    case 'seat':
      return [[0, seatHeight - h / 2, 0]];
    case 'cushion':
      return [[0, seatHeight + h / 2, 0]];
    case 'backrest':
      // Against the back edge, rising from the seat.
      return [[0, seatHeight + h / 2, -halfD + d / 2]];
    case 'armrest':
      return [
        [halfW - w / 2, seatHeight + h / 2, 0],
        [-halfW + w / 2, seatHeight + h / 2, 0],
      ];
    case 'top':
      return [[0, height - h / 2, 0]];
    case 'shelf':
      return [[0, height / 2, 0]];
    case 'panel':
      // Doors and drawer fronts, split left/right across the face.
      return [
        [width / 4, height / 2, halfD - d / 2],
        [-width / 4, height / 2, halfD - d / 2],
      ];
    case 'frame':
    case 'carcass':
      return [[0, h / 2 + stackCursor.y, 0]];
    default: {
      const y = stackCursor.y + h / 2;
      stackCursor.y += h;
      return [[0, y, 0]];
    }
  }
}

export function buildMassing(spec: FurnitureSpec): { boxes: GlbBox[]; materials: GlbMaterial[] } {
  const width = Math.max(spec.dimensions.widthMm * MM, 0.05);
  const depth = Math.max(spec.dimensions.depthMm * MM, 0.05);
  const height = Math.max(spec.dimensions.heightMm * MM, 0.05);
  // Without a stated seat height, sit the seat at 55% of overall height, which
  // is where it lands on most seating.
  const seatHeight = (spec.seatHeightMm ?? spec.dimensions.heightMm * 0.55) * MM;
  const layout: Layout = { width, depth, height, seatHeight };

  const materials: GlbMaterial[] = spec.materials.map((m) => ({
    name: m.name,
    baseColorHex: m.baseColorHex,
    metallic: m.metalness,
    roughness: m.roughness,
  }));
  if (materials.length === 0) {
    materials.push({ name: 'default', baseColorHex: '#9a9a9a', metallic: 0, roughness: 0.7 });
  }
  const materialIndex = new Map(spec.materials.map((m, i) => [m.id, i]));

  const boxes: GlbBox[] = [];
  const stackCursor = { y: 0 };

  for (const component of spec.components) {
    const size: [number, number, number] = [
      Math.max(component.approxSizeMm.widthMm * MM, 0.01),
      Math.max(component.approxSizeMm.heightMm * MM, 0.01),
      Math.max(component.approxSizeMm.depthMm * MM, 0.01),
    ];
    const positions = placeComponent(component.role, size, layout, stackCursor);
    const index = materialIndex.get(component.materialId) ?? 0;
    positions.forEach((center, i) => {
      boxes.push({
        name: positions.length > 1 ? `${component.name} ${i + 1}` : component.name,
        center,
        size,
        materialIndex: index,
      });
    });
  }

  // A spec with no components still has to produce something loadable.
  if (boxes.length === 0) {
    boxes.push({
      name: spec.displayName,
      center: [0, height / 2, 0],
      size: [width, height, depth],
      materialIndex: 0,
    });
  }

  return { boxes, materials };
}

export function buildMassingGlb(spec: FurnitureSpec): Uint8Array {
  const { boxes, materials } = buildMassing(spec);
  return writeGlb(boxes, materials);
}

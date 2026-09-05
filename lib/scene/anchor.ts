import type { Dimensions3, FurnitureSpec, Vec3 } from '@/lib/types';

/**
 * Turning a click into something a model can act on.
 *
 * A raw anchor point is a triple of floats, which is useless in a prompt. What
 * makes an anchored note actionable is naming the part it landed on and where
 * that sits on the piece, the way someone in a workshop would point at it.
 */

/** Strip the "3" from "Legs 3" - repeated parts are numbered on export. */
function baseName(partName: string): string {
  return partName.replace(/[\s_]\d+$/, '').trim();
}

export interface ResolvedComponent {
  componentName: string | null;
  componentRole: string | null;
}

/**
 * Map a mesh part name back to the spec component it came from.
 *
 * Our own massing meshes name each part after its component, so this is exact.
 * Vendor meshes are often a single merged object, in which case nothing
 * resolves and the caller falls back to the positional description alone.
 */
export function resolveComponent(
  partName: string | null,
  spec: FurnitureSpec,
): ResolvedComponent {
  if (!partName) return { componentName: null, componentRole: null };

  const target = baseName(partName).toLowerCase();
  const match =
    spec.components.find((c) => c.name.toLowerCase() === target) ??
    spec.components.find((c) => c.role.toLowerCase() === target);

  return match
    ? { componentName: match.name, componentRole: match.role }
    : { componentName: null, componentRole: null };
}

/**
 * Describe where an anchor sits on the piece in plain language.
 *
 * The anchor is in the asset's local space: metres, origin on the floor at the
 * centre of the footprint, +Z toward the front. Thirds are used rather than
 * halves so that things genuinely near the middle are not arbitrarily pushed
 * to one side.
 */
export function describeAnchor(point: Vec3, dimensions: Dimensions3): string {
  const widthM = dimensions.widthMm / 1000;
  const depthM = dimensions.depthMm / 1000;

  const lateral =
    point.x < -widthM / 6 ? 'left' : point.x > widthM / 6 ? 'right' : 'centre';
  const longitudinal =
    point.z > depthM / 6 ? 'front' : point.z < -depthM / 6 ? 'back' : 'middle';

  // "centre-middle" reads badly; collapse it.
  const where =
    lateral === 'centre' && longitudinal === 'middle'
      ? 'centre'
      : lateral === 'centre'
        ? longitudinal
        : longitudinal === 'middle'
          ? lateral
          : `${longitudinal}-${lateral}`;

  const heightMm = Math.round(point.y * 1000);
  return `${where}, ${heightMm} mm above the floor`;
}

/** One line per note, as handed to the model. */
export function formatAnnotationForPrompt(annotation: {
  body: string;
  partName: string | null;
  componentName: string | null;
  anchorDescription: string;
}): string {
  const part = annotation.componentName ?? annotation.partName;
  const location = part ? `on the ${part} (${annotation.anchorDescription})` : `at ${annotation.anchorDescription}`;
  return `- ${location}: ${annotation.body}`;
}

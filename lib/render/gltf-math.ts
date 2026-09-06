/**
 * Pure vector/quaternion math for placing nodes in the server-built glTF
 * scene graph. No three.js: the whole point of this render path is to build
 * the scene without a live three.js instance, so the transform math it needs
 * is reimplemented here in plain arrays instead.
 */

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export const IDENTITY_QUAT: QuatTuple = [0, 0, 0, 1];

function sub(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(a: Vec3Tuple): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function normalize(a: Vec3Tuple): Vec3Tuple {
  const len = length(a);
  if (len < 1e-8) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/**
 * Euler XYZ (radians, intrinsic, same convention SceneDoc and three.js both
 * use) to a glTF/quaternion rotation.
 *
 * This is the standard XYZ-order Euler-to-quaternion composition (the same
 * one three.js's Quaternion.setFromEuler uses for order 'XYZ'), reimplemented
 * here so this module has no runtime dependency on three.
 */
export function eulerXYZToQuaternion(x: number, y: number, z: number): QuatTuple {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);

  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/**
 * Standard trace-based rotation-matrix-to-quaternion conversion, given the
 * matrix as its three columns (the world-space images of the local x/y/z
 * axes) rather than as a flat array - row/column mix-ups here are exactly
 * the kind of bug that only shows up as "the camera points slightly the
 * wrong way", so the element indices are spelled out from the columns
 * explicitly rather than destructured positionally.
 */
function quaternionFromAxes(xAxis: Vec3Tuple, yAxis: Vec3Tuple, zAxis: Vec3Tuple): QuatTuple {
  const m00 = xAxis[0];
  const m10 = xAxis[1];
  const m20 = xAxis[2];
  const m01 = yAxis[0];
  const m11 = yAxis[1];
  const m21 = yAxis[2];
  const m02 = zAxis[0];
  const m12 = zAxis[1];
  const m22 = zAxis[2];

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

/**
 * Rotation that points a node's local -Z axis at `target` from `eye`, with
 * local +Y as close to `up` as possible - the standard camera look-at
 * convention that glTF (and Blender, and three.js) cameras share.
 */
export function lookAtQuaternion(eye: Vec3Tuple, target: Vec3Tuple, up: Vec3Tuple = [0, 1, 0]): QuatTuple {
  // Camera-space +Z points away from the look direction.
  let zAxis = normalize(sub(eye, target));
  if (length(zAxis) < 1e-8) zAxis = [0, 0, 1]; // eye === target: look forward arbitrarily rather than NaN out.

  let xAxis = normalize(cross(up, zAxis));
  if (length(xAxis) < 1e-8) {
    // `up` was parallel to the view direction (looking straight up/down) - fall back to a
    // different reference axis so the basis stays orthonormal instead of degenerating.
    xAxis = normalize(cross([0, 0, 1], zAxis));
  }
  const yAxis = cross(zAxis, xAxis);

  return quaternionFromAxes(xAxis, yAxis, zAxis);
}

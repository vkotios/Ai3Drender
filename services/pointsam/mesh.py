"""
Mesh <-> point-cloud plumbing for the Point-SAM wrapper.

Point-SAM's own README says it "support[s] mesh segmentation by sampling
points from the mesh and propagat[ing] segmentation labels back to the
mesh", restricted to GLB input - but the upstream repo (zyc00/Point-SAM)
ships no reusable code for that: its own demo (demo/app.py) only ever
segments an already-sampled point cloud loaded from a .ply file, with the
sampling done by an offline/JS step outside the Python demo entirely. This
module is this wrapper's own implementation of that missing half, using
`trimesh` (already a listed Point-SAM dependency for its own data
pipeline) - not something ported from upstream.

Two functions:
  - `sample_point_cloud`: turn a mesh into the (xyz, rgb, face_index) point
    cloud Point-SAM's `set_pointcloud`/`predict_masks` expect, keeping track
    of which face each sampled point came from.
  - `propagate_face_labels`: turn a per-sample-point boolean mask back into
    a per-face boolean mask, the shape callers (services/pointsam/app.py)
    actually need to answer "which faces are in the clicked part".
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import trimesh


@dataclass
class SampledPointCloud:
    # (N, 3) float32, in the mesh's own original local coordinate space.
    xyz: np.ndarray
    # (N, 3) float32 in [0, 1] - vertex colour where the mesh has one,
    # otherwise a flat mid-grey (Point-SAM's colour channel matters far less
    # than xyz; a real color is a nice-to-have, not a requirement here).
    rgb: np.ndarray
    # (N,) int64 - which triangle (into mesh.faces) each sample came from.
    face_index: np.ndarray


def load_glb_mesh(glb_bytes: bytes) -> trimesh.Trimesh:
    """Parse a binary glTF (.glb) into a single triangulated mesh.

    A .glb can contain multiple primitives/nodes; `force='mesh'` concatenates
    them into one `Trimesh` with the same triangle order the primitives were
    stored in, which is what lets `PartSegment.faceIndices` on the TypeScript
    side (lib/ai/segmentation/types.ts) be interpreted as "primitive 0's
    triangles first, then primitive 1's, and so on" without this wrapper
    needing to expose per-primitive structure at all.
    """
    mesh = trimesh.load(trimesh.util.wrap_as_stream(glb_bytes), file_type="glb", force="mesh")
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        raise ValueError("uploaded .glb contained no triangulated geometry")
    return mesh


def sample_point_cloud(mesh: trimesh.Trimesh, max_points: int = 32_768) -> SampledPointCloud:
    """Sample an area-weighted point cloud off the mesh surface.

    `max_points` defaults near the upper end of what Point-SAM's own README
    recommends (`group_number=2048, group_size=64` => ~131k point *budget*
    for very dense scans; 32k keeps inference fast for typical furniture
    part counts while still giving every face a realistic chance of being
    sampled at least once - see `propagate_face_labels` for what happens to
    the faces that aren't).
    """
    n_samples = max(max_points, 1)
    xyz, face_index = trimesh.sample.sample_surface(mesh, n_samples)
    rgb = _sample_colors(mesh, face_index)
    return SampledPointCloud(xyz=xyz.astype(np.float32), rgb=rgb.astype(np.float32), face_index=face_index)


def _sample_colors(mesh: trimesh.Trimesh, face_index: np.ndarray) -> np.ndarray:
    """Best-effort per-sample colour: the mesh's own face colour where it has
    one, otherwise flat mid-grey. Never fails - a missing/unreadable texture
    must not block segmentation, since colour is a minor input signal here."""
    try:
        face_colors = mesh.visual.to_color().face_colors  # type: ignore[attr-defined]
        return (face_colors[face_index, :3] / 255.0).astype(np.float32)
    except Exception:
        return np.full((len(face_index), 3), 0.5, dtype=np.float32)


def normalize_points(xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Centre-and-scale to a unit sphere, matching demo/app.py's own
    `/pointcloud/<path>` loader (`shift = xyz.mean(0); scale =
    norm(xyz - shift).max(); xyz = (xyz - shift) / scale`). Point-SAM was
    trained on point clouds normalised this way, so an un-normalised mesh
    (real-world millimetre/metre scale) segments unreliably without it.

    Returns (normalized_xyz, shift, scale) - `shift`/`scale` must also be
    applied to the caller-supplied prompt point before it is handed to the
    model, and are otherwise irrelevant once inference is done (the output
    is a boolean per point/face, not a coordinate).
    """
    shift = xyz.mean(axis=0)
    centered = xyz - shift
    scale = float(np.linalg.norm(centered, axis=-1).max())
    if scale < 1e-8:
        scale = 1.0
    return (centered / scale).astype(np.float32), shift.astype(np.float32), scale


def propagate_face_labels(mesh: trimesh.Trimesh, sampled: SampledPointCloud, point_mask: np.ndarray) -> np.ndarray:
    """Turn a per-sample-point boolean mask into a per-face boolean mask.

    Every face that got at least one sample takes the majority vote of its
    own samples' labels (`sample_point_cloud` is area-weighted, so a face
    typically gets multiple samples for anything but a very fine mesh).
    A face with zero samples - possible for a tiny sliver triangle even
    under area weighting - is assigned via nearest-neighbour lookup against
    every sampled point, cheap enough at this point-cloud scale with a
    KD-tree.
    """
    n_faces = len(mesh.faces)
    face_labels = np.zeros(n_faces, dtype=bool)
    face_has_sample = np.zeros(n_faces, dtype=bool)

    # Majority vote per face from its own samples.
    sums = np.zeros(n_faces, dtype=np.int64)
    counts = np.zeros(n_faces, dtype=np.int64)
    np.add.at(sums, sampled.face_index, point_mask.astype(np.int64))
    np.add.at(counts, sampled.face_index, 1)
    sampled_faces = counts > 0
    face_labels[sampled_faces] = sums[sampled_faces] * 2 >= counts[sampled_faces]
    face_has_sample[sampled_faces] = True

    missing = ~face_has_sample
    if missing.any():
        from scipy.spatial import cKDTree  # local import: only needed on this rare path

        tree = cKDTree(sampled.xyz)
        centroids = mesh.triangles_center[missing]
        _, nearest = tree.query(centroids)
        face_labels[missing] = point_mask[nearest]

    return face_labels

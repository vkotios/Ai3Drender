"""
Minimal smoke test for the pure-geometry half of this service (mesh.py).

This repo has no Python test infrastructure elsewhere to match, so this is
intentionally small - just enough to catch an obviously broken sampling or
label-propagation change. It needs only `trimesh`/`numpy`/`scipy` (already
in requirements.txt), NOT torch/pc_sam/a GPU/a checkpoint, so it is the one
part of this service that actually ran in this evaluation - everything in
model.py and app.py's model-loading path was written against Point-SAM's
published API but could not be exercised (no GPU in this environment, see
README.md).

Run with: pip install trimesh numpy scipy pytest && pytest services/pointsam/test_mesh.py
"""

from __future__ import annotations

import numpy as np
import trimesh

from services.pointsam.mesh import normalize_points, propagate_face_labels, sample_point_cloud


def _unit_cube() -> trimesh.Trimesh:
    return trimesh.creation.box(extents=(1.0, 1.0, 1.0))


def test_sample_point_cloud_covers_every_face_of_a_simple_mesh():
    mesh = _unit_cube()
    sampled = sample_point_cloud(mesh, max_points=2_000)

    assert sampled.xyz.shape == (2_000, 3)
    assert sampled.rgb.shape == (2_000, 3)
    assert sampled.face_index.shape == (2_000,)
    # A cube has 12 triangles; 2000 area-weighted samples should hit all of them.
    assert set(sampled.face_index.tolist()) == set(range(len(mesh.faces)))
    assert (sampled.rgb >= 0).all() and (sampled.rgb <= 1).all()


def test_sample_point_cloud_caps_at_max_points_even_for_a_tiny_mesh():
    mesh = _unit_cube()
    sampled = sample_point_cloud(mesh, max_points=4)
    assert sampled.xyz.shape[0] == 4


def test_normalize_points_centers_and_unit_scales():
    xyz = np.array([[0, 0, 0], [10, 0, 0], [0, 10, 0]], dtype=np.float32)
    normalized, shift, scale = normalize_points(xyz)

    np.testing.assert_allclose(shift, xyz.mean(axis=0))
    assert scale > 0
    # The farthest point from the centroid must land exactly on the unit sphere.
    distances = np.linalg.norm(normalized, axis=-1)
    assert np.isclose(distances.max(), 1.0, atol=1e-5)


def test_propagate_face_labels_marks_only_the_sampled_faces_true():
    mesh = _unit_cube()
    sampled = sample_point_cloud(mesh, max_points=500)

    # Pretend only samples that came from face 0 were inside the clicked part.
    point_mask = sampled.face_index == 0
    face_mask = propagate_face_labels(mesh, sampled, point_mask)

    assert face_mask.shape == (len(mesh.faces),)
    assert face_mask.dtype == bool
    assert face_mask[0] == True  # noqa: E712 - explicit bool comparison reads clearer here
    # A cube's 12 triangles pair up into 6 axis-aligned quads; every OTHER
    # face is on a different plane from face 0 and must stay unmarked.
    assert face_mask.sum() >= 1
    assert face_mask.sum() < len(mesh.faces)


def test_propagate_face_labels_all_true_when_every_sample_is_true():
    mesh = _unit_cube()
    sampled = sample_point_cloud(mesh, max_points=500)
    face_mask = propagate_face_labels(mesh, sampled, np.ones(500, dtype=bool))
    assert face_mask.all()


if __name__ == "__main__":
    import sys

    failures = 0
    tests = [obj for name, obj in list(globals().items()) if name.startswith("test_")]
    for test in tests:
        try:
            test()
            print(f"ok  - {test.__name__}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL - {test.__name__}: {exc}")
    sys.exit(1 if failures else 0)

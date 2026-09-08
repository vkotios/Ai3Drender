"""
Self-hosted Point-SAM inference service (issue #57 evaluation - see
lib/ai/segmentation/pointsam.ts for the TypeScript side of this exact
contract, and services/pointsam/README.md for how to deploy this).

NOT part of the Next.js app's own build or deploy - this is a separate
Python process the maintainer runs themselves, on a machine with a CUDA
GPU. Nothing in the Next.js app talks to it unless POINTSAM_SERVICE_URL is
set (see lib/env.ts), and nothing today wires it into the production
Rebake flow either way.

Run with (see README.md for full setup):
    uvicorn services.pointsam.app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from services.pointsam.mesh import (
    load_glb_mesh,
    normalize_points,
    propagate_face_labels,
    sample_point_cloud,
)
from services.pointsam.model import PointSamModel

logger = logging.getLogger("pointsam")

_model: PointSamModel | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _model
    config_dir = os.environ.get("POINTSAM_CONFIG_DIR", "./Point-SAM/configs")
    config_name = os.environ.get("POINTSAM_CONFIG_NAME", "large")
    checkpoint_path = os.environ.get("POINTSAM_CHECKPOINT_PATH", "./pretrained/model.safetensors")
    logger.info("loading Point-SAM (%s / %s) from %s", config_dir, config_name, checkpoint_path)
    _model = PointSamModel(config_dir=config_dir, config_name=config_name, checkpoint_path=checkpoint_path)
    logger.info("Point-SAM ready")
    yield
    _model = None


app = FastAPI(title="Point-SAM segmentation service", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Request/response contract - keep in sync with lib/ai/segmentation/pointsam.ts
# ---------------------------------------------------------------------------


class SegmentRequest(BaseModel):
    # Binary glTF (.glb), base64-encoded - the same bytes any MeshProvider
    # (lib/ai/mesh) returns from `reconstruct`.
    mesh_glb_base64: str
    # [x, y, z] in the mesh's own local coordinate space (not normalized) -
    # see lib/ai/segmentation/types.ts's `promptPoint` doc comment for where
    # this is meant to come from.
    prompt_point: tuple[float, float, float]
    # SAM convention: 1 = inclusion click, 0 = exclusion click.
    prompt_label: int = Field(default=1, ge=0, le=1)
    # Cap on how many points are sampled off the mesh surface - see
    # mesh.sample_point_cloud's own docstring for the default.
    max_points: int = Field(default=32_768, ge=1024, le=131_072)


class SegmentResponseSegment(BaseModel):
    id: str
    face_indices: list[int]
    score: float


class SegmentResponse(BaseModel):
    job_id: str | None
    segments: list[SegmentResponseSegment]


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None}


@app.post("/segment", response_model=SegmentResponse)
def segment(request: SegmentRequest) -> SegmentResponse:
    if _model is None:
        raise HTTPException(status_code=503, detail="model is not loaded yet")

    import base64

    try:
        glb_bytes = base64.b64decode(request.mesh_glb_base64)
    except Exception as cause:  # noqa: BLE001 - reported to the caller either way
        raise HTTPException(status_code=400, detail=f"mesh_glb_base64 was not valid base64: {cause}") from cause

    try:
        mesh = load_glb_mesh(glb_bytes)
    except Exception as cause:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not parse mesh: {cause}") from cause

    sampled = sample_point_cloud(mesh, max_points=request.max_points)
    normalized_xyz, shift, scale = normalize_points(sampled.xyz)
    # The prompt point is given in the *original* mesh frame (see
    # SegmentRequest.prompt_point's doc comment) - it must go through the
    # same shift/scale the point cloud itself just did, or it lands nowhere
    # near the surface in the model's normalized space.
    normalized_prompt = (np.array(request.prompt_point, dtype=np.float32) - shift) / scale

    try:
        result = _model.segment(
            xyz=normalized_xyz,
            rgb=sampled.rgb,
            prompt_point=tuple(normalized_prompt.tolist()),
            prompt_label=request.prompt_label,
        )
    except Exception as cause:  # noqa: BLE001 - surfaced to the TS adapter as a 500
        logger.exception("segmentation failed")
        raise HTTPException(status_code=500, detail=f"segmentation failed: {cause}") from cause

    face_mask = propagate_face_labels(mesh, sampled, result.point_mask)
    face_indices = np.nonzero(face_mask)[0].tolist()

    if not face_indices:
        # A real but empty result - the click landed somewhere the model
        # assigned to no positive face after propagation. Returning zero
        # segments (rather than one empty one) lets a caller tell "found
        # nothing" apart from "found an empty part" without inspecting length.
        return SegmentResponse(job_id=None, segments=[])

    return SegmentResponse(
        job_id=None,
        segments=[SegmentResponseSegment(id="segment-0", face_indices=face_indices, score=result.score)],
    )

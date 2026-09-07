"""
Loads Point-SAM and runs one point-prompted segmentation call.

This mirrors zyc00/Point-SAM's own `demo/app.py` model setup and its
`/segment` route as closely as a stateless HTTP wrapper can - see the
docstring on `PointSamModel` for exactly which lines this was grounded in.
Point-SAM itself (the `pc_sam` package, its Hydra configs, and the
`third_party/torkit3d` and `third_party/apex` submodules it depends on) is
NOT vendored into this repo - see services/pointsam/README.md for how to
obtain it. This file imports it as an ordinary installed package.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import torch


@dataclass
class SegmentationOutput:
    # (N,) bool, aligned with the sampled point cloud handed in.
    point_mask: np.ndarray
    # The model's own confidence for the returned mask, 0-1.
    score: float


class PointSamModel:
    """
    Loads once at process startup (see app.py's FastAPI lifespan) and is
    reused across requests - the checkpoint load alone is the expensive
    part, matching demo/app.py loading its model once at import time rather
    than per-request.

    Grounded directly in demo/app.py's own model setup:

        with hydra.initialize(args.config_dir, version_base=None):
            cfg = hydra.compose(config_name=args.config)
            OmegaConf.resolve(cfg)
        model = hydra.utils.instantiate(cfg.model)
        model.apply(replace_with_fused_layernorm)
        load_model(model, args.ckpt_path)   # safetensors.torch.load_model
        sam = model

    and its `/segment` route:

        prompt_points = torch.from_numpy(np.array(prompts)).cuda().float()[None, ...]
        prompt_labels = torch.from_numpy(np.array(labels)).cuda()[None, ...]
        sam.set_pointcloud(pc_xyz, pc_rgb)
        mask, scores, logits = sam.predict_masks(
            prompt_points, prompt_labels, prompt_mask, prompt_mask is None
        )
        segment_mask = mask[0][torch.argmax(scores[0])] > 0

    This wrapper only ever does a single click per request (no iterative
    `/next`/`/clear` session state, and always passes `prompt_mask=None` /
    `multimask_output=True`, i.e. the 4th positional arg `prompt_mask is
    None` is always `True` here) - a stateless HTTP contract has no place to
    keep the previous mask between calls, and the two-stage design this
    evaluation is for (see lib/ai/segmentation/types.ts) only ever needs one
    click per part anyway.
    """

    def __init__(self, config_dir: str, config_name: str, checkpoint_path: str, device: str = "cuda"):
        import hydra
        from omegaconf import OmegaConf

        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError(
                "PointSamModel requires a CUDA GPU (Point-SAM has no supported CPU inference path); "
                "torch.cuda.is_available() is False on this machine"
            )
        self.device = device

        with hydra.initialize_config_dir(os.path.abspath(config_dir), version_base=None):
            cfg = hydra.compose(config_name=config_name)
            OmegaConf.resolve(cfg)

        # Deferred import: pc_sam is not a PyPI package (see README) and must
        # not be required just to import this module, e.g. for mesh.py's
        # GPU-free unit tests.
        from pc_sam.model.pc_sam import PointCloudSAM  # noqa: F401 (imported for the type; hydra instantiates it)
        from pc_sam.utils.torch_utils import replace_with_fused_layernorm
        from safetensors.torch import load_model

        model = hydra.utils.instantiate(cfg.model)
        model.apply(replace_with_fused_layernorm)
        load_model(model, checkpoint_path)
        self.sam = model.to(device).eval()

    @torch.no_grad()
    def segment(
        self,
        xyz: np.ndarray,
        rgb: np.ndarray,
        prompt_point: tuple[float, float, float],
        prompt_label: int,
    ) -> SegmentationOutput:
        """One click, one mask - see the class docstring for the upstream
        call shape this reproduces. `xyz`/`rgb` are the *normalized* point
        cloud (see mesh.normalize_points) and `prompt_point` must already be
        transformed into that same normalized space by the caller."""
        pc_xyz = torch.from_numpy(xyz).to(self.device).float().unsqueeze(0)
        pc_rgb = torch.from_numpy(rgb).to(self.device).float().unsqueeze(0)
        prompt_points = torch.tensor([[list(prompt_point)]], device=self.device, dtype=torch.float32)
        prompt_labels = torch.tensor([[prompt_label]], device=self.device, dtype=torch.long)

        self.sam.set_pointcloud(pc_xyz, pc_rgb)
        mask, scores, _logits = self.sam.predict_masks(prompt_points, prompt_labels, None, True)

        best = torch.argmax(scores[0])
        point_mask = (mask[0][best] > 0).cpu().numpy()
        score = float(scores[0][best].cpu().item())
        return SegmentationOutput(point_mask=point_mask, score=score)

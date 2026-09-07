# Point-SAM segmentation service (evaluation)

A small FastAPI wrapper around [Point-SAM](https://github.com/zyc00/Point-SAM)
(MIT licensed, ICLR 2025) that exposes one HTTP endpoint: mesh bytes + a 3D
prompt point in, the segment containing that point out. It is the
self-hosted counterpart to `lib/ai/segmentation/pointsam.ts` in this repo -
see that file, and `lib/ai/segmentation/types.ts`, for the TypeScript side of
this contract and why it exists (issue #57: replacing this app's
naming-convention part matching with real geometric segmentation).

**This is not part of the Next.js app's build or deploy.** It is a separate
Python process that needs a CUDA GPU, run and maintained independently of
`npm run build`/`npm run dev`. Nothing in the Next.js app calls it unless
`POINTSAM_SERVICE_URL` is set.

**Status: written, not run.** This was authored against Point-SAM's
published README and its `demo/app.py` source (quoted in `model.py`'s
docstring) without a GPU available in the environment that wrote it, so
`model.py`'s and `app.py`'s model-loading/inference path has never actually
executed. `mesh.py` (pure NumPy/trimesh/SciPy, no GPU needed) is the one part
that has - its tests actually pass, see `test_mesh.py`. Treat the rest as a
well-grounded first draft a maintainer needs to stand up and debug against a
real checkpoint before trusting it.

## Why a self-hosted service at all

Point-SAM is MIT licensed and real (464-star repo, ICLR 2025), but as of
this evaluation:

- There is no reliable hosted API or working public demo for it. The one
  known community Space (`yuchen0187/Point-SAM` on HuggingFace) was in a
  `BUILD_ERROR` state.
- It is point-prompted only - you give it a 3D point, it returns the
  segment containing that point. There is no "segment the whole mesh
  automatically" mode (unlike the sibling P3-SAM candidate this app is also
  evaluating, on a separate branch, under a more restrictive license).

So evaluating it for real means running the model yourself. This directory
is that scaffolding.

## What "where to click" means here

Point-SAM needs a 3D point on the mesh surface as its prompt - it has no
way to go from a free-text target ("the legs") to a point on its own. The
architecturally correct fit for this app (confirmed with the maintainer) is
a two-stage pipeline:

1. **Gemini vision picks a point** (not built in this task - see the
   `promptPoint` doc comment in `lib/ai/segmentation/types.ts` for exactly
   where this plugs in): render the mesh from a known camera, ask Gemini
   vision to point at the target description on that 2D image (the same way
   `resolvePartReference` in `lib/ai/gemini.ts` already resolves free text
   against this app's own component list, just visually), then unproject
   that pixel back onto the mesh surface using the same camera.
2. **Point-SAM segments from that point** - this service.

Until stage 1 exists, exercise this service with a point supplied some other
way - a manual raycast from a 3D viewer click, or a hand-picked coordinate in
`scripts/eval-pointsam.ts` (this repo's evaluation harness for the
TypeScript side of this contract).

## Setup

1. **A CUDA-capable GPU and driver.** Point-SAM has no supported CPU
   inference path - `model.py` raises immediately if `torch.cuda.is_available()`
   is `False`.

2. **Point-SAM itself, alongside this repo** (it is not a PyPI package):

   ```bash
   git clone --recursive https://github.com/zyc00/Point-SAM.git
   cd Point-SAM
   # g++ 9.3.0 recommended for compiling the CUDA extensions below
   conda install gxx_linux-64=9.3.0

   git submodule update --init third_party/torkit3d
   FORCE_CUDA=1 pip install third_party/torkit3d

   git submodule update --init third_party/apex
   pip install -v --disable-pip-version-check --no-cache-dir --no-build-isolation \
     --config-settings "--build-option=--cpp_ext" \
     --config-settings "--build-option=--cuda_ext" \
     third_party/apex

   pip install -e .   # installs the `pc_sam` package this wrapper imports
   ```

   These submodule/compile steps, the exact package name (`pc_sam`), and the
   Hydra config layout (`configs/large.yaml`) all come directly from
   Point-SAM's own README and `demo/app.py` - re-check them against whatever
   revision you clone, since none of it is pinned to a commit here.

3. **The ViT-L checkpoint**, from HuggingFace
   (`https://huggingface.co/yuchen0187/Point-SAM`):

   ```bash
   huggingface-cli download yuchen0187/Point-SAM --local-dir ./pretrained
   ```

4. **This wrapper's own dependencies**:

   ```bash
   pip install -r services/pointsam/requirements.txt
   ```

5. **Environment variables** (all optional - defaults match the layout
   above if you cloned Point-SAM into `./Point-SAM` from the repo root):

   | Variable | Default | Meaning |
   |---|---|---|
   | `POINTSAM_CONFIG_DIR` | `./Point-SAM/configs` | Hydra config directory |
   | `POINTSAM_CONFIG_NAME` | `large` | Hydra config name (ViT-L) |
   | `POINTSAM_CHECKPOINT_PATH` | `./pretrained/model.safetensors` | Downloaded checkpoint |

6. **Run it**, from this repo's root:

   ```bash
   uvicorn services.pointsam.app:app --host 0.0.0.0 --port 8000
   ```

   Then point the Next.js app's `POINTSAM_SERVICE_URL` at it (e.g.
   `http://localhost:8000` in `.env`), or drive it directly with
   `npm run eval:pointsam` (see `scripts/eval-pointsam.ts`).

## What a maintainer needs to do to actually validate this

None of the above has run end to end. To validate it for real:

1. Provision a CUDA machine, do the install above, confirm `GET /health`
   returns `{"status": "ok", "model_loaded": true}`.
2. Sanity-check the Hydra config name/path - `configs/large` is this
   wrapper's assumption from `demo/app.py`'s own `--config large` default;
   confirm it's still current for whatever checkpoint you download.
3. Send one real request (`npm run eval:pointsam -- --point x,y,z --mesh
   path/to/real/mesh.glb`) against a real reconstructed asset's `.glb`
   (export one from this app, or use a vendor sample) and eyeball the
   returned `face_indices` against the mesh in a viewer - do they actually
   correspond to one coherent part?
4. Only then does it make sense to compare this against the sibling P3-SAM
   branch's own harness output on the same mesh, which is the actual point
   of this evaluation.

## Request/response contract

```
POST /segment
{
  "mesh_glb_base64": "<base64-encoded .glb bytes>",
  "prompt_point": [x, y, z],   // in the mesh's own local coordinate space
  "prompt_label": 1,           // 1 = inclusion click, 0 = exclusion click
  "max_points": 32768           // optional - point-cloud sampling budget
}
```

```
200 OK
{
  "job_id": null,
  "segments": [
    { "id": "segment-0", "face_indices": [0, 1, 2, ...], "score": 0.87 }
  ]
}
```

`face_indices` are triangle indices into the mesh's flattened triangle list
in the same traversal order `lib/ai/segmentation/types.ts` documents (so
`lib/ai/segmentation/pointsam.ts` on the TypeScript side needs no
translation). An empty `segments` array is a real "found nothing here"
result, not an error.

## Design notes worth a reviewer's attention

- **Mesh -> point cloud -> mesh is this wrapper's own code, not
  Point-SAM's.** Point-SAM's README describes mesh support ("sampling
  points from the mesh and propagat[ing] segmentation labels back to the
  mesh", GLB only) but the upstream repo ships no reusable implementation of
  it - its own demo only ever segments a pre-sampled `.ply` point cloud. See
  `mesh.py` for the sampling (area-weighted `trimesh.sample.sample_surface`,
  tracking each sample's source face) and label-propagation (majority vote
  per sampled face, nearest-neighbour via a KD-tree for any face that ended
  up with zero samples) this wrapper implements to fill that gap.
- **Coordinate normalisation matters and is easy to get wrong.**
  Point-SAM was trained on point clouds centred and unit-scaled (see
  `demo/app.py`'s `/pointcloud/<path>` route) - a real-world-scale furniture
  mesh handed in raw will not segment reliably. `app.py` normalises the
  sampled point cloud AND applies the identical shift/scale to the caller's
  prompt point before calling the model - if you change the normalisation,
  change it in both places.
- **Stateless, single-click only.** Point-SAM's own demo supports iterative
  refinement (`/clear`, `/next`, accumulating multiple prompt points across
  calls via server-side session state). This wrapper deliberately does not -
  a stateless HTTP contract has nowhere to keep that state between calls,
  and the two-stage pipeline this evaluation is for only ever needs one
  click per part.

# ai3drender

Turn furniture photographs into **specified, versioned 3D assets**, stage them in a
photorealistic exhibition environment, and export the result as **glTF / GLB / OBJ**.

Built for furniture manufacturers preparing trade-show and catalogue visuals.

---

## The honest architecture note

Gemini — or any image model — **cannot generate 3D geometry**. So the "photo → 3D asset"
path is split across two AI layers that do what each is actually good at:

| Layer | Does | Provider |
|---|---|---|
| **Vision & direction** | Reads the photos into a structured spec (dimensions, components, PBR materials), synthesizes clean multi-view images, art-directs the booth, applies plain-language refinements | Gemini |
| **Reconstruction** | Turns those views into a textured `.glb` | A dedicated photo-to-3D vendor, behind a swappable port |

Reconstruction sits behind `MeshProvider` (`lib/ai/mesh/`), with adapters for **Meshy**,
**Tripo3D** and **fal.ai**, plus a **stub** that is the default.

The stub is not a mock: it generates a real, spec-valid `.glb` block model, correctly scaled
to the piece's real-world millimetres with the analyzed materials applied. That means the
entire pipeline — analysis, view synthesis, reconstruction, staging, export — runs with **no
API keys and no accounts**, and you can lay out a booth and check clearances before you pick
a reconstruction vendor. It does not perform reconstruction; set `MESH_PROVIDER` for that.

---

## Running it

```bash
npm install
cp .env.example .env.local     # optional — it runs with everything unset
npm run dev
```

Open http://localhost:3000.

With an empty `.env.local` you get: local disk storage, the offline analyzer, and stub
reconstruction. The home page shows exactly which mode each layer is in, so placeholder
output is never mistaken for the real thing.

### Turning the real layers on

```bash
GEMINI_API_KEY=...        # photo analysis, multi-view synthesis, art direction, refinement
MESH_PROVIDER=meshy       # or tripo | fal
MESHY_API_KEY=...
```

```bash
NEXT_PUBLIC_SUPABASE_URL=...      # Postgres + Auth + Storage instead of local disk
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...     # server-only, used by the queue worker
```

Apply `supabase/migrations/0001_init.sql` (schema, RLS, the `renders` storage bucket).
Every table is reachable only through a project the caller owns.

> **Vendors fetch images by URL.** Meshy and fal pull the synthesized views from
> `NEXT_PUBLIC_APP_URL`, so they cannot reach a `localhost` deployment. Use Supabase Storage
> (signed URLs) or a public tunnel when running those providers locally. Tripo uploads bytes
> directly and works either way.

---

## The pipeline

```
photos ──▶ analyze ──▶ synthesize_views ──▶ reconstruct ──▶ AssetVersion (.glb)
                                                                  │
                                              refine ◀────────────┘
                                                 │
                                      staged in a SceneDoc ──▶ glTF / GLB / OBJ
```

Each stage is a row in `jobs` that enqueues the next, so progress is visible and a failure
retries from the stage that broke rather than from the photographs again. The app drains its
own queue via `POST /api/jobs/tick` while work is outstanding; run `npm run worker` alongside
for a standalone drainer. Claims are atomic, so several drainers can run at once.

### Create, modify, refine

Versions are **immutable once accepted** — enforced by a Postgres trigger and mirrored in the
local store. An approved render can never change underneath a customer.

- **Refine without rebuilding** — "make the frame darker walnut, lower the seat 30 mm" revises
  the spec and materials and reuses the existing mesh. Cheap, instant, no vendor credit.
- **Refine with a rebuild** — re-runs reconstruction into a new version.
- **Per-scene material overrides** — change a finish for one booth without forking the
  product spec.

Every version records its parent and the instruction that produced it, so the refinement
history reads as a chain.

---

## The studio

`/projects/[id]/scenes/[id]` is a react-three-fiber viewport: five booth presets, HDRI-based
lighting, contact shadows, transform gizmos, staging props, and live material editing.

Meshes are scaled to real-world size on load. Vendor output is unit-normalised, so it is
fitted to the analyzed dimensions; meshes that already carry real-world scale (the stub's) are
left alone. Everything is then grounded so it sits on the floor rather than wherever the
vendor's origin fell.

Export strips helpers (grid, selection cages, gizmos) and serialises the booth and the pieces.

---

## Layout

```
app/                     routes and API handlers
components/studio/       viewport, outliner, inspector
lib/
  ai/gemini.ts           analysis, view synthesis, art direction, refinement
  ai/offline.ts          deterministic fallback when no key is set
  ai/mesh/               MeshProvider port, vendor adapters, GLB writer, massing generator
  db/                    Store port; Supabase and local-disk implementations
  pipeline/              job stages and the runner
  scene/                 booth presets, scene document defaults
  studio/                client store and exporters
supabase/migrations/     schema, RLS, storage policy
```

## Known limits

- The stub produces block massing, not reconstruction. It is for layout, not for hero renders.
- Without `GEMINI_API_KEY`, dimensions come from category conventions and are flagged
  `rough` throughout the UI. Do not quote from them.
- The studio renders in real time in the browser. It is not a path-traced offline renderer —
  for final print imagery, export the GLB and render it in your DCC of choice.

# Scoping: rigged/animated furniture pieces

Status: **scoping only, not scheduled**. Tracked as
[#50](https://github.com/vkotios/Ai3Drender/issues/50). Per that issue, this
is worth building only once there's a specific manufacturer request for it —
this document exists so the shape of the work is understood in advance, not
so it gets picked up speculatively.

Source: `docs/competitive-gap-analysis.md`, §04 ("Auto-rig/animation") —
Meshy, Tripo3D Studio, and CSM.ai's Cube all offer one-click auto-rig plus
animation presets on top of mesh generation.

## 1. The problem, in this app's terms

Every piece this pipeline produces today is a static mesh: one `.glb` per
`AssetVersion`, scaled and grounded, sat motionless in a booth scene. Most
furniture is fine like that. Some isn't — a recliner that doesn't recline, a
drawer that doesn't open, an adjustable table that can't show its adjustment
range aren't wrong, exactly, but they under-sell the piece next to a
manufacturer's actual product. The ask is: for pieces with moving parts, let
the booth demo show the motion — open/close a drawer, recline a chair,
raise/lower a table — instead of presenting them frozen in one pose.

That means three things the pipeline doesn't have at all today:

1. A **rigged mesh** — skeleton + skin weights on the moving parts, produced
   either by a vendor's auto-rig step or a local heuristic.
2. A way to **author and store** a small library of named poses/clips
   (open/close, recline, raise/lower) per piece.
3. A **studio-viewport control** to play or scrub those clips on a staged
   instance, so a demo can be driven live in front of a client.

## 2. Minimal vs. full-built

**Phase 1 — minimal (proves the concept end to end)**

- One rigged asset kind: single hinge/slide joints only (drawer front,
  recliner backrest, table leg extension) — no multi-bone skeletons, no IK.
- One vendor path: whichever mesh vendor already in `lib/ai/mesh/` exposes
  auto-rig most directly (Meshy is the most likely first integration, since
  it's already wired in `lib/ai/mesh/meshy.ts`). No local/heuristic rigging.
- Exactly one clip per moving part: a two-keyframe open↔closed pose, no
  blending between multiple clips.
- Viewport: a play/pause button and a scrub slider per rigged node, driving
  the GLTF `AnimationClip` already embedded in the `.glb` via three.js's
  standard animation mixer. No timeline UI, no per-part isolation.
- No rig authoring UI — whatever the vendor returns is used as-is, or the
  asset falls back to being treated as unrigged.

**Phase 2 — full-built**

- Multiple named clips per asset (open, partially-open, recline stages),
  selectable, with a scrub timeline and named presets in the UI.
- A local/heuristic rigging fallback for vendors or meshes where auto-rig
  isn't available or fails, driven off `FurnitureComponent` boundaries
  already in `FurnitureSpec` (e.g. a `role: "drawer_front"` component gets a
  synthesized slide joint) — likely reusing the massing generator's
  part-naming convention (`lib/ai/mesh/massing.ts`) rather than vendor mesh
  parts, since only that path names parts predictably today (the same
  "front/back-left/back-right leg" naming it already produces).
- A minimal QA/preview pass to catch degenerate rigs (interpenetrating
  geometry mid-clip, a joint that moves the wrong part) before a version is
  presented to a client — an animation-specific analogue of the "score the
  mesh against source photos" QA idea also flagged in the gap analysis
  (§03), since a bad auto-rig is a defect category "does it look right"
  QA doesn't currently catch at all.
- Export support: a client-facing GLB/glTF export that carries the
  animation clips through (today's export path is a static-pose snapshot).
- Possibly: exposing the clip as a control in the read-only client share
  view, not just the studio.

## 3. Where this plugs into the existing architecture

The mesh vendor adapters (`lib/ai/mesh/types.ts`) define one narrow port,
`MeshProvider.reconstruct()`, returning a static `.glb`. Two shapes are
possible for auto-rig, and they aren't equivalent:

- **New adapter capability** — extend `MeshProvider` with an optional
  `rig?(input): Promise<RigResult>` method, called by a **new pipeline
  stage** (`rig`, alongside `analyze` / `synthesize_views` / `reconstruct` /
  `refine` in `JobKind`) that runs *after* `reconstruct` succeeds, only when
  the asset is flagged as having moving parts. This matches how Meshy,
  Tripo3D, and CSM.ai actually offer it: auto-rig is a separate API call
  against an already-generated mesh, not a `reconstruct`-time option. It also
  keeps `reconstruct` provider-agnostic — a provider without `rig` just
  never gets asked, same pattern as `provider.configured` gating today in
  `getMeshProvider()`.
- **A capability flag rather than a new port**, since `MeshProvider` is
  deliberately a narrow interface ("swapping vendors... must not require
  touching the pipeline or the UI") — `rig` should be optional on the
  interface, and a provider that doesn't implement it should behave exactly
  as if the asset had no moving parts, not throw.

Either way, this is **not** something that belongs inside `reconstruct`
itself: rigging is conditional (most furniture has no moving parts at all),
vendor-specific in ways reconstruction isn't (not every reconstruction
vendor offers it), and produces a materially different output shape
(skeleton + clips, not just geometry) that the rest of the pipeline
(`refine`, QA, export) needs to know to preserve rather than silently drop.

Concretely, the new stage would look like `runReconstruct` in
`lib/pipeline/index.ts`: read the version, call `provider.rig(...)` with the
just-stored `meshPath`, store the returned rigged `.glb` (or a rig
descriptor sitting alongside the existing mesh), and update the version.
It would only run when `FurnitureSpec` or the asset says the piece has
rig-able parts — see §4.

## 4. Data model sketch

**`FurnitureSpec`** — the vision pass (`lib/ai/vision`, feeding
`FurnitureSpec`) would need to flag *which* components move and *how*, since
that's the only place a piece's moving parts are already named:

```ts
export type JointMotion = 'hinge' | 'slide' | 'telescopic';

export interface RiggablePart {
  /** Matches a FurnitureComponent.name/role this joint moves. */
  componentName: string;
  motion: JointMotion;
  /** e.g. "0 to 45 degrees", "0 to 120mm" — informs clip generation. */
  rangeNotes: string;
}

export interface FurnitureSpec {
  // ...existing fields
  riggableParts: RiggablePart[]; // empty for the overwhelming majority of pieces
}
```

**`AssetVersion`** — needs to carry the rig itself, and it must stay
optional so most versions (unrigged) are unaffected:

```ts
export interface RigClip {
  name: string;          // "open", "recline_full"
  durationSeconds: number;
  /** Name of the glTF AnimationClip inside `rigMeshPath`'s .glb. */
  clipName: string;
}

export interface Rig {
  /** Storage key of the rigged .glb (skeleton + skin weights + clips). Separate
   *  from AssetVersion.meshPath so an unrigged base mesh is never overwritten -
   *  a rig step can fail or be skipped without blocking the static asset. */
  rigMeshPath: string;
  provider: string;       // which vendor/heuristic produced it
  clips: RigClip[];
}

export interface AssetVersion {
  // ...existing fields
  rig: Rig | null;
}
```

Keeping `rig` as a nullable, additive field (rather than replacing
`meshPath`) matches how `meshExtentMm`, `previewPath` etc. are already
optional/nullable on `AssetVersion` — every existing static-mesh asset stays
valid with `rig: null`, and nothing downstream (export, thumbnailing,
material overrides) needs to change unless it explicitly wants to handle
rigs.

**Studio viewport (react-three-fiber)** — `AssetNode`/`AssetMesh`
(`components/studio/AssetNode.tsx`) currently loads a static scene via
`useGLTF(meshUrl)` and clones it once. Playing a clip needs:

- `useGLTF` already returns `animations` alongside `scene` — swap in
  `useAnimations(animations, groupRef)` from `@react-three/drei` (already a
  dependency, used elsewhere for `Html` overlays) to get a
  `THREE.AnimationMixer` wired to the cloned root.
- A small per-node UI control (play/pause, scrub slider bound to
  `action.time / action.getClip().duration`) added to whatever panel
  currently shows node properties, visible only when `version.rig` is set.
- The mixer needs `useFrame((_, delta) => mixer.update(delta))` — a new
  per-rigged-node hook, since nothing in the viewport currently drives an
  animation clock.
- Scrubbing while paused means setting `action.paused = true` and driving
  `action.time` directly rather than through `mixer.update`.

## 5. Non-goals for a first pass

- No IK, no physics-driven motion, no procedural joint limits beyond what
  the vendor/heuristic bakes into the clip.
- No arbitrary user-authored rigging UI (skinning by hand) — the studio is
  not becoming a rigging tool.
- No animation in offline Blender/Cycles renders (`OfflineRenderRequest`) —
  those stay single-pose beauty shots; scope is the live studio viewport
  only.
- No physically simulated collision between a moving part and neighboring
  scene nodes (a reclining chair clipping through a side table is a
  known-acceptable gap, same as the general "no interference detection"
  gap already flagged in §04 of the competitive gap analysis).
- No export of animated GLB to the client share view in phase 1 — the share
  view stays a static snapshot.
- No retrofitting existing accepted `AssetVersion`s with rigs after the
  fact — rigging only applies going forward, on new versions.

## 6. Open questions (blocked on a real manufacturer request)

These are exactly the questions issue #50 says shouldn't be answered
speculatively:

- Which motion actually matters to a real request — recline angle, drawer
  travel, table height — since that decides whether one hinge-joint clip
  covers it or a family of joint types is needed from day one.
- Is Meshy's (or another single vendor's) auto-rig output good enough
  out-of-the-box for furniture specifically, or does it need the kind of
  per-part correction/QA pass sketched in Phase 2 before it's presentable to
  a client? Nobody has run a real piece through it yet.
- Does the manufacturer want this in the live studio viewport only, or also
  baked into a deliverable (an animated GLB handed to their web team, an AR
  view)? That materially changes whether Phase 1's viewport-only scope is
  sufficient or the export work has to move up.
- Is one clip per moving part enough, or do manufacturers expect combined
  sequences (open the drawer *and* recline the chair in one demo pass)?
- What's the acceptable failure mode when auto-rig produces a broken result
  (common with thin/complex geometry) — silently fall back to static, or
  surface a retry/manual-fix path to the user?

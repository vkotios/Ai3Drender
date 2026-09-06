# CAD / floor-plan import — scoping

Tracks [#52](https://github.com/vkotios/Ai3Drender/issues/52). This is a scoping
document, not an implementation plan — per the issue itself, this is a large
lift that deserves design discussion before anyone starts a stage.

## 1. The problem

Every booth in this app starts from one of five `BoothPreset`s (`lib/scene/presets.ts`)
— fixed `boothWidth` / `boothDepth` / `boothHeight` plus a `walls: { back, left, right }`
flags — and gets refined by dragging numbers in the inspector or nudging asset
nodes by hand in the viewport (`components/studio/Booth.tsx`,
`components/studio/StudioCanvas.tsx`). That's a fine model for "stage a piece
of furniture attractively." It has no relationship to the footprint an
exhibition hall actually hands out, which arrives as a DWG or DXF drawing of
the real, often irregular, stand boundary — angled walls, columns, fixed
utility points — not a rectangle with optional sides. Today a designer either
eyeballs that drawing and approximates it with the box-and-flags model, or
works outside this app entirely and only brings the finished layout in as
screenshots. pCon.planner and CET Designer both start from the native CAD
file instead (`docs/competitive-gap-analysis.md`, §04) — that's the gap.

## 2. What a minimal ingestion path looks like

DWG is Autodesk's proprietary binary format; there is no complete open
specification, and the two realistic ways to read it are a paid conversion
API (Autodesk's own Platform Services, CloudConvert, or similar — recurring
per-conversion cost, an external network dependency, and a file round-trip)
or a heavyweight library like the ODA (Open Design Alliance) SDK, which is
commercial-licensed, large, and not a natural fit for a Next.js app that
otherwise depends on nothing beyond `@gltf-transform` and `three` for
geometry.

DXF is different: it's Autodesk's companion *interchange* format, documented
in a public reference, and in its common ASCII flavor is a readable
tag-value text stream (group codes + values) rather than a binary blob.
Reading the entities that matter here — `LINE`, `LWPOLYLINE`/`POLYLINE`
(walls, boundaries), `INSERT` (blocks), `TEXT`/`MTEXT` (room labels),
`LAYER` — is tractable with a pure-JS parser (e.g. `dxf-parser` or writing a
narrow group-code reader by hand for just those entity types) with no native
dependency and no external service. Binary DXF exists too but ASCII is the
overwhelmingly common export.

**Recommendation:** scope this as *DXF only* for any first cut. Treat DWG as
"ask the sender to export/save-as DXF" (nearly every CAD tool that emits DWG
can also emit DXF) or, if that's ever a hard blocker for a real customer,
revisit paid conversion as a follow-on — not as part of this scope.

## 3. What it would actually drive

Realistically: booth footprint and wall geometry, nothing more. A floor plan
import in this app should extend `EnvironmentSettings` — most plausibly by
replacing the fixed `boothWidth`/`boothDepth`/`walls` rectangle with an
optional polygon boundary and a list of wall segments (each with a start/end
point and open/closed state) for the cases where the venue footprint isn't a
box CET/pCon-style tools model full architectural BIM — doors, columns,
ceiling grids, utility runs. None of that is in scope here: this pipeline's
whole downstream chain (`Booth.tsx`'s floor/wall meshes, the path tracer, the
Blender export) only understands "floor plane + vertical wall panels for
lighting bounce." A footprint polygon is the largest useful surface to
target without redesigning that chain. Room labels, furniture blocks already
on the drawing, and dimension annotations are readable from DXF but have no
present consumer — worth flagging as future scope, not building against
speculatively.

## 4. Two phases

**Phase A — reference underlay.** Import the DXF (or even a rasterized
PDF/photo of the plan) as a flat, to-scale image plane in the viewport that
the user manually traces: click points to define the booth polygon and wall
runs against the underlay, same as tracing over a lightbox. No DXF entity
parsing beyond extracting the drawing's extents to set the underlay's scale
and origin.

**Phase B — real entity parsing.** Parse `LWPOLYLINE`/`LINE` entities on a
recognized layer (e.g. an `A-WALL`-style convention, or the largest closed
polyline as a fallback) and construct the booth polygon and wall segments
directly from geometry, no manual tracing.

**Recommendation: build Phase A first.** It's a much smaller surface (an
image plane and a polygon-drawing tool that a booth layout tool arguably
wants anyway, independent of CAD import), it degrades gracefully to *any*
input the customer actually has — including a phone photo of a printed
plan, which needs no parser at all — and it sidesteps the open question in
§6 about how consistent real-world DXF exports are. Phase B is a
meaningfully larger, format-fragile lift (layer-naming conventions vary by
firm, units and scale blocks vary, arcs and blocks complicate "just read the
polyline") that's only worth it once Phase A has shown people actually bring
in CAD files and want the tracing step gone.

## 5. Non-goals

- Full BIM/IFC import (doors, ceilings, MEP, structural columns as real objects).
- Multi-room or multi-story floor plans — one booth footprint per scene, matching the current `SceneDoc` model.
- Revit/SketchUp native import (the issue mentions these as prior art; both are separate, heavier formats than DXF and are out of scope here).
- Live sync back to the source CAD file — this is one-way ingestion, not a CAD round-trip.
- Automatic door-swing/clearance/collision checking (a separate gap, see competitive-gap-analysis §04 second bullet).

## 6. Open questions before this is buildable

- **Does this app's actual customer segment receive DXF/DWG at all?** The
  target users are furniture manufacturers staging their own products, not
  necessarily exhibition-hall operators. It's unverified whether a typical
  customer gets a real CAD file from the venue, or whether the realistic
  input is a PDF or a photographed printed floor plan handed over at a
  site visit — which would make Phase A's underlay-and-trace flow the *only*
  useful path, and make Phase B moot regardless of parser quality.
- If DXF files are the real input, how consistent are their units, scale,
  and layer-naming conventions across the exhibition-hall CAD packages
  customers actually encounter? That determines how much Phase B can be
  automated versus needing a manual "which layer is the wall?" confirmation
  step.
- Where does the underlay/polygon live in `SceneDoc` — a new field on
  `EnvironmentSettings`, or a separate import-provenance record referenced
  by it? Needs a schema decision, not assumed here.
- Is there actual customer demand pulling this, or is it a competitive
  checkbox against pCon.planner/CET Designer? Worth confirming before either
  phase gets scheduled.

# Competitive gap analysis

What the photo → spec → mesh → booth pipeline doesn't do yet, read off three
adjacent fields: AI mesh-generation platforms, furniture/space-planning
configurators, and 3D review/exhibition tooling. Each gap below is tracked as
its own GitHub issue; this document is the research behind them, kept as a
single reference rather than split across issue bodies.

Rendered version (with a priority chart): see the "Missing Spec" artifact
linked from the PR/commit that added this file, or regenerate by re-running
the research described below.

## Methodology

Three parallel research passes were run against the app's current feature
set — Gemini-driven spec extraction, pluggable mesh vendors (Meshy / Tripo /
fal.ai Hunyuan3D), booth staging with path-traced and offline Blender render,
an annotation-and-refine review loop, tokenized client links, and a shared
material library:

1. AI photo/text-to-3D mesh generation platforms and open research
2. Furniture-specific and general space-planning/configurator platforms
3. 3D review/annotation tooling and exhibition/trade-show booth design tools

Forty-plus named products and papers came back with a capability this
pipeline doesn't have. What follows keeps the ones specific enough to act on.

## Where to start

Ranked by fit with what's already built, not by category size:

1. Turn on the `viewer` share-link role — the schema already reserves it, unused
2. Resolved filter + threaded replies on annotations, once a piece has several revisions of notes
3. A Gemini-vision pass after `reconstruct` scoring the mesh against its source photos
4. Parts-list export off the material library — codes already exist, quantities don't
5. Slack or email ping on client review activity — no more checking the app for the badge

## 01 — Capture & Reconstruction

Everything upstream of the mesh that reaches the studio viewport.

- **Mesh topology** — [Rodin](https://hyper3d.ai/) (Hyper3D Gen-2) ships quad-based
  topology instead of triangle soup, built specifically to skip the manual
  retopology pass before rigging or clean subdivision.
- **Polycount/LOD tiers** — [Meshy](https://www.meshy.ai/) exposes target
  polycount, remesh, and symmetry per generation, so a light mesh for the live
  viewport and a dense one for a Cycles hero shot needn't be the same file.
- **Auto-retopology as its own stage** — [Tripo3D Studio](https://www.tripo3d.ai/)'s
  "Smart Mesh" turns retopology into its own few-second pass, separate from
  the initial generation call.

## 02 — Materials

Where the vision pass matches a piece against the shared library.

- **Spot-fix repaint** — Tripo3D's Magic Brush and Meshy's Retexture API each
  let you repaint or regenerate one region while keeping the original UVs —
  a lightweight fix that doesn't need a full spec-and-mesh refine round.
- **Per-part re-bake** — Home3D 1.0 (Alibaba research, furniture-specific,
  [arXiv:2606.27923](https://arxiv.org/abs/2606.27923)) segments material per
  component and can re-bake a single part without touching the rest of the
  mesh.
- **Multi-view-consistent PBR** — MaterialMVP
  ([arXiv:2503.10289](https://arxiv.org/pdf/2503.10289)), MCMat
  ([arXiv:2412.14148](https://arxiv.org/pdf/2412.14148)), and PBR3DGen
  ([arXiv:2503.11368](https://arxiv.org/pdf/2503.11368)) target
  illumination-invariant, multi-view-consistent PBR estimation — precisely
  the risk at the one step where this pipeline matches photos to the
  material library.

## 03 — Quality Assurance

The gltf-transform round-trip proves a mesh is structurally valid glTF.
Nothing checks whether it looks right.

- **Defect taxonomy** — 3D-DefectBench
  ([arXiv:2607.10826](https://arxiv.org/html/2607.10826)) defines nine defect
  categories (fused parts, missing geometry, surface/texture faults) — a
  structured rubric this pipeline has no equivalent of.
- **VLM-based scoring** — Gen3DEval
  ([arXiv:2504.08125](https://arxiv.org/abs/2504.08125)), Hi3DEval
  ([arXiv:2508.05609](https://arxiv.org/pdf/2508.05609)), and 3DGen-Bench use
  a vision-LLM to score a mesh against its source photos — exactly one more
  Gemini vision call after `reconstruct`, reusing infrastructure already in
  place.
- **Per-generation confidence** — [Kaedim](https://www.kaedim3d.com/) publishes
  per-category confidence (85–90% hard-surface, 70–80% organic) so a user
  knows in advance when to expect a manual pass.

## 04 — Staging & Scene

The booth: presets, walls, HDRI, props, camera.

- **CAD/floor-plan import** — [pCon.planner](https://pcon-solutions.com/) and
  [CET Designer](https://www.configura.com/products/cet) both take native
  DWG/DXF/Revit/SketchUp import, so a stand can start from the venue's actual
  floor plan, not only photos.
- **Collision/clearance detection** — [Cedreo](https://cedreo.com/) flags
  door-swing conflicts automatically; general BIM tools ([Solibri](https://www.solibri.com/),
  Autodesk Forma) do full collision/accessibility checks. This pipeline has
  no interference detection between staged pieces at all.
- **Auto-rig/animation** — Meshy, Tripo3D Studio, and [CSM.ai](https://www.csm.ai/)'s
  Cube all one-click auto-rig — relevant the moment a piece with moving parts
  (recliner, drawer, adjustable table) needs to be demoed articulated rather
  than static.
- **AR/mobile viewer** — [Zakeke](https://www.zakeke.com/) and
  [Threekit](https://www.threekit.com/) place the staged product via phone AR
  and ship a built-in viewer-engagement dashboard alongside it.

## 05 — Review & Collaboration

The annotation-and-refine loop, and the client's own read-only link.

- **Threaded replies** — Frame.io and [Ziflow](https://ziflow.com/) let a
  reply live inside one comment thread, instead of every reply becoming its
  own flat pin.
- **@mentions** — Fusion 360's web client and [Vectary](https://www.vectary.com/)
  notify a specifically tagged person, not just "someone commented."
  Depends on notification infra (see §06) to actually deliver.
- **Resolved/unresolved filter** — Figma and Ziflow hide resolved comments by
  default — worth having once a piece has accumulated notes across several
  mesh revisions.
- **Side-by-side compare** — Fusion 360's Compare workspace puts two versions
  side by side, beyond history-plus-restore.
- **Granular review states** — Ziflow offers five states per reviewer
  (approved, approved-with-changes, not-relevant, pending,
  changes-required), richer than a binary approve/request-changes.
- **Tiered link permissions** — [Filestage](https://filestage.io/) and Ziflow
  grant view-only, comment, or approve on the same link mechanism. This
  app's own schema already reserves a `viewer` role for exactly this — it's
  just never been switched on.

## 06 — Notifications

Right now, checking the approval badge means opening the app.

- **Slack** — [Approval Studio](https://approval.studio/) posts every comment
  and approval into a Slack channel as it happens.
- **Email reply** — Ziflow lets a reviewer reply to a comment by plain email,
  no login required — closer to how a client actually behaves.
- **Reminders** — Filestage sends an automatic nudge when a reviewer hasn't
  responded by a due date.

## 07 — Exhibition-Specific

A different scope call: full show-floor logistics is arguably its own
product, not a natural next step — flagged here in case the roadmap wants to
go there.

- **Venue map** — MapYourShow and ExpoCAD place a booth design against the
  real show-hall aisle map, with live space availability.
- **Cost/quote generation** — Skyline Exhibits' Exhibit Studio walks booth
  size and configuration straight into an automatic price-and-timeline
  quote.
- **Sightline simulation** — RoomToDo simulates what's visible approaching
  the booth from different aisle angles, rather than an orbit/authoring view
  alone.

## 08 — Commerce Layer

Downstream of the pipeline — what a manufacturer does with a finished,
approved piece.

- **BOM export** — pCon.planner, CET Designer, and 2020 Spaces all export a
  real parts list (SKUs, quantities, pricing) tied to the catalog. This
  app's material library already has codes; it has no order-quantity path
  yet.
- **Customer-facing configurator** — Threekit and Zakeke let an end customer
  live-swap material, finish, and size with instant re-render, embedded on
  the manufacturer's own site — a customer-facing surface downstream of
  everything built so far.

## 09 — A Cautionary Note

Modsy raised $72.7M in AI-assisted room design and shut down in 2022. The 3D
technology wasn't the failure mode — the per-customer designer-labor and
rendering cost was. It cut design-team pay and offshored roles trying to
survive the unit economics, then got squeezed further when pandemic
furniture-supply delays broke the "see it before you buy it" promise it was
selling ([TechCrunch](https://techcrunch.com/2022/07/17/modsy-quietly-shut-down-while-some-customers-were-still-awaiting-refunds/)).

The lesson for this pipeline specifically: every stage that stays automated
end to end — which the adapter-and-queue architecture already leans toward —
is a stage that doesn't reproduce Modsy's cost structure. The moment a human
has to touch each render by hand is the moment that risk comes back.

## Sources

Meshy · Tripo3D · Rodin/Hyper3D · CSM.ai · Kaedim · Spline · pCon.planner ·
CET Designer · 2020 Spaces · Cedreo · Zakeke · Threekit · Frame.io · Ziflow ·
Filestage · Figma · Fusion 360 · Vectary · Approval Studio · Skyline
Exhibits · MapYourShow · ExpoCAD · RoomToDo · Solibri · TechCrunch (Modsy) ·
arXiv 2606.27923 / 2503.10289 / 2503.11368 / 2412.14148 / 2607.10826 /
2508.05609 / 2504.08125

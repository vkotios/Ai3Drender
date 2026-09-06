# Exhibition logistics: scope decision, not a backlog

Tracks [#54](https://github.com/vkotios/Ai3Drender/issues/54). Related, not duplicated
here: [#64](https://github.com/vkotios/Ai3Drender/issues/64) (booth rigging/structural
constraints) and [#65](https://github.com/vkotios/Ai3Drender/issues/65) (foot-traffic and
wayfinding simulation) — both filed as separate Phase 2 issues, both contingent on the same
decision this document makes. Source research: `docs/competitive-gap-analysis.md`, §07 (and
§04 for the collision-detection item referenced below).

## The actual question

This app currently does one thing: turn a photo of a piece of furniture into a specified,
versioned 3D asset and stage it in a photorealistic booth vignette. Every gap-analysis issue
before #54 sharpens that one pipeline — better meshes, better materials, better review tools.

#54 and its two related issues are different in kind, not degree. They're not about staging
one piece better; they're about modeling the show floor a piece sits on — venue maps, booth
inventory and pricing, sightlines and foot traffic across dozens of booths at once. That's a
trade-show floor-planning product. Its customer is a show organizer or exhibit-design firm
managing an entire hall, not a furniture manufacturer producing a catalogue render of one
item. Building it well means venue-map/CAD ingestion, a booth-inventory and availability
model, and crowd/sightline simulation — none of which share code, data model, or customer
with the render pipeline.

So the real decision isn't "which of these three features first" — it's whether this app
stays a furniture-manufacturer render/staging tool, or becomes a second product for a
different buyer that happens to reuse the booth-vignette renderer as one component.

## The three candidates, plus the two Phase 2 issues

- **Venue map / aisle placement with live availability** — MapYourShow and ExpoCAD place a
  booth design against the real show-hall floor plan and track which spaces are sold. This
  app has no concept of a "hall" or "booth inventory" at all — it stages one preset-sized
  booth in isolation. Adding it means importing venue CAD/floor plans and modeling
  availability across many booths, not just rendering the one a manufacturer bought.
- **Automatic cost/quote generation** — Skyline Exhibits' Exhibit Studio turns booth size and
  configuration directly into a price-and-timeline quote. This is the shallowest of the
  three: it's a pricing formula over data (booth dimensions, wall count, prop list) this app
  already has in `lib/scene/presets.ts`, with no new geometry or CAD work required.
- **Sightline simulation** — RoomToDo simulates what's visible approaching a booth from
  different aisle angles, versus this app's orbit/authoring viewport only. Doing this
  properly needs a multi-booth scene (neighboring stands occluding sightlines), not just the
  one booth this app stages — closer in scope to venue-map work than to a camera feature.
- **[#64] Booth rigging/structural constraints** — overhead truss load limits, island-booth
  minimum clearances, and similar checks that Vectorworks/ExpoCAD validate and this app's
  scene builder doesn't. Distinct from #54's three items, but the same underlying question:
  it only matters once booths are modeled as physical structures subject to a venue's
  engineering rules, which is show-floor-product territory, not render-pipeline territory.
  (Nearer-term and cheaper: §04's plain collision/clearance detection between staged
  pieces — Cedreo-style — fits the current single-booth model and needs no venue data.)
- **[#65] Foot-traffic and wayfinding simulation** — ExpoFP and Swapcard treat the floor plan
  as a booth-sales and attendee-wayfinding tool with traffic-flow visualization across the
  whole hall. Of everything on this page, this is the furthest from a natural extension: it
  requires modeling visitor movement across dozens of booths, not staging or rendering any
  one of them.

## Recommendation

Stay scoped to "stage and render one piece well." Don't start any of these five without a
specific pull, and the pull that would justify it looks like: a furniture manufacturer or
exhibit-builder customer asking, unprompted, to place their booth against an actual venue
map or hall inventory — not a competitor doing it, not "this would be a nice module to
offer." Two customers, two roadmaps, and this app doesn't have evidence yet that its actual
customer (a furniture manufacturer) wants the second one. Chasing all five now on
"competitors have it" risks the Modsy failure mode this repo's own gap analysis flags in
§09 — spreading a small team across a materially different product, before demand for it is
confirmed, is exactly the kind of scope creep that inflates the cost structure of a business
that isn't validated yet.

If that signal shows up, don't open all five at once. The cost/quote estimator is the one
piece that's genuinely a small, self-contained addition rather than a second product:
`BOOTH_PRESETS` in `lib/scene/presets.ts` already carries `boothWidth` / `boothDepth` /
`boothHeight` and a suggested-prop list per preset, so a price-and-timeline formula keyed off
those needs no new geometry, no CAD import, and no venue data model — it's a pricing table
over data this app already has. Venue-map integration, sightline simulation, structural
constraint checking, and foot-traffic/wayfinding all require the venue-as-data model this app
doesn't have and shouldn't build speculatively; treat the quote estimator as the low-cost
toe-in-the-water, and treat committing to the other four as the actual fork-in-the-road
decision, to be made only once there's a customer on the other side of it.

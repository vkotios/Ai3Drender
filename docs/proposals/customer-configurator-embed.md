# Customer-facing configurator embed — scoping (issue #53)

> Note on sourcing: `docs/competitive-gap-analysis.md` does not exist yet on
> `main` at the time of writing (it may land from a concurrent scoping pass on
> a sibling issue). This document is grounded instead in issue #53's own text,
> the current codebase (`lib/types.ts`, `lib/share/`, the material library
> endpoints under `app/api/materials/` and `app/api/assets/.../materials/`),
> and general knowledge of the named competitors. Re-check against §08 once
> that doc exists and adjust if it says something different.

## 1. What this actually is

Everything shipped so far — intake, reconstruction, refinement, staging,
review share links, offline render — is **manufacturer-facing**. A studio user
(the manufacturer or an agency working for them) drives the whole pipeline,
and the one external-facing surface that exists today (`/share/[token]`) is
still aimed at a human reviewer signing off on a *stand design*, not a
shopper configuring a *product*.

Issue #53 is asking for something categorically different: an **end
customer** — a shopper on the manufacturer's own commerce site, with no
Ai3Drender account and typically no relationship with this product at all —
live-swaps material/finish/(maybe) size on a single **accepted** asset
version and sees a near-instant re-render, inside a widget embedded on a page
this project does not own or control. This is the Threekit/Zakeke pattern:
configure-and-visualize as a point-of-sale conversion tool, not a design
review tool.

The key framing to hold onto: this is a **second product surface**
downstream of the existing pipeline, not a mode or a route added to the
studio. It reads an accepted `AssetVersion` and the account's
`MaterialLibraryEntry` catalogue; it never writes to a `Scene`, a `Project`,
or a spec. Everything below treats it that way.

## 2. Why it's a genuinely separate surface

| | Studio (existing) | Share/review link (existing) | Customer configurator (proposed) |
|---|---|---|---|
| **Who** | Manufacturer's own staff, authenticated | A named client reviewer, holds a bearer token | Anonymous public shopper |
| **Auth** | Session/account | Per-scene tokenized grant (`SceneShareLink`) | Per-**manufacturer** embed key, not per-resource |
| **Surface** | Full Next.js studio app | Read-only studio shell, annotate + approve | Narrow configurator widget: swatch picker, viewport, price/CTA |
| **Hosting** | This app, this domain | This app, this domain, token in URL path | Iframe or JS snippet **on the manufacturer's site** |
| **Mutates** | Everything | `clientApproval`, `Annotation` | Nothing in the pipeline's domain model — only its own session/analytics state |
| **Analytics** | None today | None today | Core to the value prop: which configs get viewed, selected, abandoned |

The auth model is the sharpest difference. `SceneShareLink` (see
`lib/share/token.ts`, `lib/share/access.ts`) grants access to **one scene**,
created by an authenticated owner, holding a hashed bearer token checked on
every request. That shape doesn't fit a commerce embed at all: a
manufacturer wants to drop one snippet on a product page and have it work for
every accepted asset in their catalogue, for an unbounded number of anonymous
visitors, without minting and distributing a token per visitor or per
product. The natural grant here is scoped to the **manufacturer account**
(an embed key, maybe further scoped to "which assets/versions are
publishable"), not to a single resource — a materially different shape from
today's `resourceType`/`resourceId` grant, even though the *hashed-token,
resolve-then-scope* mechanism is the right pattern to copy.

The UI is different in kind, not just in styling: a configurator widget is a
handful of swatch/size controls plus a viewport, meant to sit inside a
manufacturer's product-page layout at an arbitrary size, not a full-screen
app shell. And it needs its own lightweight analytics (impressions,
configuration changes, "add to cart"/CTA clicks) that nothing in the current
domain model captures — `SceneRender` and `Job` are pipeline bookkeeping, not
funnel analytics.

## 3. What already exists to build on

This would not start from zero:

- **Material swap logic.** `resolveMaterialOverrideKey` and
  `migrateSceneMaterialOverrides` (`lib/scene/materialOverrides.ts`) already
  solve "swap the material bound to a mesh part, keyed stably by
  `MaterialSpec.id`." The rebind endpoint,
  `PATCH /api/assets/[assetId]/versions/[versionId]/materials/[materialId]`,
  already does "point this material at a different `MaterialLibraryEntry`
  and pick up its canonical PBR values" — precisely the "swap finish, see it
  update" interaction a configurator needs. It's currently gated on the
  version being *unaccepted* (`version.acceptedAt` blocks it) and it mutates
  the version in place; a configurator needs the same resolve-and-apply logic
  but as a **client-side, ephemeral, per-visitor** override that never writes
  back to the version — closer to a `SceneNode.materialOverrides` entry
  (already exists, already designed to not fork the asset) than to a rebind.
- **The read-only tokenized-viewer pattern.** `lib/share/token.ts` +
  `lib/share/access.ts` is the right template for "resolve an opaque bearer
  credential to a scoped, read-only grant, fail closed in Supabase mode via
  RLS, fail closed in local mode by construction." An embed-key resolver
  would follow the same shape: hash-and-look-up, check revoked/expiration,
  hand back a store scoped to what the key is allowed to see — just scoped to
  an account's published catalogue rather than one scene.
- **glTF/GLB export and the existing Three.js viewer stack.** The mesh
  pipeline already produces web-ready `.glb` per version
  (`AssetVersion.meshPath`), and the studio already knows how to load and
  material-override a glTF scene client-side. The configurator's rendering
  layer is largely "the existing viewer component, with the studio chrome
  removed."
- **The material library itself.** `MaterialLibraryEntry` is already
  account-scoped (not project-scoped) with swatches, codes, and an
  archived/discontinued flag — exactly the catalogue a manufacturer would
  want to expose (a subset of) to their storefront.

## 4. What's genuinely new

- **Embed-key / widget-auth model, scoped per manufacturer account, not per
  resource.** Needs its own table (or a generalization of
  `SceneShareLink`'s shape with `granteeToken` but a broader
  `resourceType`) plus a decision on granularity: one key per account, or
  per-asset allow-listing so a manufacturer can stage new pieces before they
  go live on the storefront.
- **A "what's publishable" concept.** Today "accepted" (`acceptedAt` on
  `AssetVersion`) means *frozen*, not *public*. Exposing a version to an
  anonymous embed likely needs its own flag/state distinct from acceptance —
  a manufacturer may accept a version internally well before deciding it's
  ready to face customers.
- **Size/dimension swap, if in scope, is a much bigger lift than material
  swap.** The pipeline treats `Dimensions3` as fixed per accepted version —
  it's baked into the mesh at reconstruction time
  (`AssetVersion.meshExtentMm` scales a fixed mesh). A customer picking "the
  96" sofa instead of the 84"" is not a material override; it either means
  (a) pre-generating a small fixed set of size variants as their own accepted
  versions and letting the widget switch between sibling versions (cheap,
  bounded, no new pipeline), or (b) re-triggering reconstruction per
  customer-chosen dimension (expensive, slow, and exactly the unit-economics
  trap that sank Modsy: rendering cost per customer interaction that doesn't
  shrink with scale). (a) is very likely the only defensible option for a
  first version; (b) should not be built without an explicit, costed
  decision from product/business, not an engineering default.
- **A lightweight embeddable frontend, not the Next.js studio app.** The
  studio is a full authenticated app; an embed needs a small, fast,
  framework-light bundle (iframe content, or a JS snippet + web component)
  that a manufacturer can drop into an arbitrary commerce page without
  pulling in the studio's auth, routing, or bundle size. This is closer to a
  new deployable artifact than a new route.
- **Configurator analytics**: views, configuration changes chosen, CTA
  clicks, per manufacturer/asset — nothing like this exists in the schema
  today.

## 5. Phased recommendation

**Smallest useful version ("v0"):**
- One accepted asset version, explicitly marked publishable.
- Material/finish swap only, driven by the account's material library —
  reusing the override-and-render path, not the rebind-and-mutate path.
- No size/dimension swap (ship the one accepted size; a manufacturer with
  multiple sizes lists them as separate publishable versions/products, no
  new mechanism needed).
- Single piece, not a whole booth/scene — sidesteps `SceneDoc`,
  environment/staging, and multi-node complexity entirely.
- Embed as a plain iframe (simplest embed story, least new surface area)
  pointed at a public route gated by one embed key per manufacturer account.
- No configurator-specific analytics beyond basic access logging — defer the
  funnel/analytics product until there's a real customer asking for it.

**Full vision (later, only if v0 validates demand):** size/dimension swap via
pre-generated variants (still avoiding on-demand reconstruction), a JS
snippet/web-component embed with more storefront integration (pricing hooks,
add-to-cart callbacks), per-configuration analytics and a
manufacturer-facing dashboard for it, and possibly multi-piece/room
configurators built on the existing `SceneDoc` staging model.

## 6. Non-goals and open business-model questions

Explicitly **not** answered here — these are product/business calls, not
engineering ones:

- Is this a paid tier / add-on, or bundled? Pricing model (per-embed-view,
  per-manufacturer flat fee, revenue share on conversions)?
- Does v0 need a real commerce integration (cart/checkout hooks, price
  lookup), or is "visualize, then click through to the manufacturer's own
  buy flow" enough to start?
- Who owns/hosts the embed-key lifecycle from a support standpoint — can a
  manufacturer self-serve generate/revoke keys, or is that a manual step?
- Is on-demand size/dimension reconstruction ever in scope, given its cost
  profile — or is "pre-generated size variants only" a permanent constraint,
  not just a v0 shortcut?
- Does this need its own SLA/uptime bar distinct from the studio, given it's
  now embedded on a manufacturer's revenue-generating page rather than an
  internal tool?
- Multi-tenant abuse/rate-limiting posture for a public, no-login surface —
  out of scope for this document but a real requirement before any public
  launch.

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

Apply the migrations in `supabase/migrations/` in order (schema, RLS, the `renders` storage
bucket, then annotations and renders). Every table is reachable only through a project the
caller owns.

> **The two `NEXT_PUBLIC_` values must be set at BUILD time, not just at run time.** The server
> reads them at runtime, but Next.js inlines them into the browser bundle when the app is
> built. Supplying them only at run time produces a half-configured deployment: the server
> redirects everyone to sign-in, while the sign-in form has no project to talk to. The form
> detects this and says so rather than failing on click, but the fix is to rebuild.

### Signing in

With Supabase configured the app requires a user, and middleware redirects anything else to
`/sign-in`. Two methods are offered:

- **Password** — works immediately on a fresh project, including one with no SMTP configured.
- **Email link** — no passwords to manage, but needs working email delivery. Supabase's
  built-in sender is rate-limited hard enough that it should not be your only route in.

In the Supabase dashboard, under **Authentication → URL Configuration**, set the Site URL to
your deployment and add `<your-app>/auth/callback` to the redirect allow-list. Without that,
email links and confirmations bounce.

Whether sign-up returns a usable session immediately depends on the **Confirm email** setting;
with it on, the form says to go and confirm rather than appearing to hang.

Local-disk mode has no accounts at all — middleware never gates anything, and the header says
so instead of showing a sign-out control that would do nothing.

> **Vendors fetch images by URL.** Meshy and fal pull the synthesized views from
> `NEXT_PUBLIC_APP_URL`, so they cannot reach a `localhost` deployment. Use Supabase Storage
> (signed URLs) or a public tunnel when running those providers locally. Tripo uploads bytes
> directly and works either way.

---

## The pipeline

```
photos ──▶ analyze ──▶ synthesize_views ──▶ reconstruct ──▶ AssetVersion (.glb)
                                                                  │
                            pinned notes ──▶ refine ◀─────────────┘
                                                 │
                                      staged in a SceneDoc ──┬─▶ glTF / GLB / OBJ
                                                             ├─▶ path-traced PNG
                                                             └─▶ concept PNG
```

Each stage is a row in `jobs` that enqueues the next, so progress is visible and a failure
retries from the stage that broke rather than from the photographs again. The studio and
workbench nudge the queue via `POST /api/jobs/tick` while they have work outstanding, which
is enough for local development but is not the intended drainer in production — see
[Deployment](#deployment) for `npm run worker` as an always-on process, and the zero-infra
scheduled-trigger fallback. Claims are atomic, so several drainers can run at once — in
Supabase mode through a guarded conditional update, and on the local disk store through an
advisory lock around each read-modify-write.

### When things go wrong

Reconstruction is the longest stage and the one that calls a third party, so the queue is
built to survive both a flaky vendor and a worker that dies mid-job.

**Retries are opt-in per failure, not blanket.** A failure is retried only when it looks
transient — a network error, a 5xx, a 429, an "overloaded" or "try again later" from a
vendor. Anything deterministic (bad input, a missing row, a bug, a 401) fails immediately,
because retrying it would just spend the same vendor credit three times for the same answer.
Retries back off exponentially from 15s with jitter, so several jobs failing against one
vendor do not come back in lockstep. The default is three attempts, per job.

**Claims are leased.** A worker that dies cannot release its own claim, so every claim carries
a five-minute deadline that the stage renews each time it reports progress. Whoever drains the
queue next returns anything past its deadline to the queue — or fails it, if its attempts are
spent. A stage that is genuinely alive keeps its claim; one that has wedged loses it.

Note that with only the in-app drainer, a job backing off for 15s resumes when someone next
has the app open — which is exactly why it isn't the intended drainer in production. See
[Deployment](#deployment).

### The local disk store and concurrency

`LocalStore` is safe to use from more than one process — the dev server and `npm run worker`
together, which is exactly what the instructions above suggest.

It gets there in two layers. An in-process promise chain orders this process's own writes, and
an advisory lock file around each read-modify-write keeps separate processes from clobbering
each other. Reads are deliberately unlocked: a write only becomes visible via an atomic
rename, so a reader sees either the whole previous file or the whole next one.

Without that lock the rename is atomic but the read-modify-write around it is not. Measured
with four processes doing 25 operations each: half the writes were silently lost, and 37 jobs
were claimed by more than one process — each of those a duplicate vendor call you would pay
for. With it, 100 of 100 writes land and every claim is unique.

It is still the development store. Production is `SupabaseStore`.

### Reviewing by pointing at things

The studio has two modes. **Layout** stages the stand. **Comment** turns a click into a note
pinned to that exact spot on the piece — the review loop a workshop actually runs, where
someone points at the thing and says what is wrong with it.

Anchoring the note to geometry is what makes it actionable. The server resolves each pin to
the mesh part it landed on, maps that back to a spec component, and derives a plain-language
location, so the model receives:

```
- on the Legs (front-left, 180 mm above the floor): slim these to 40mm square
```

rather than "make the legs thinner". Notes are stored in the **asset's** local space, not the
scene's, so they survive the piece being moved, rotated or restaged in another booth — and
stay meaningful if the mesh is later rebuilt at a different vendor scale.

Open notes on one piece are applied as a single revision round, producing one new version
that answers all of them. Each note is then marked applied and linked to the version that
resolved it. Choosing **Apply & rebuild mesh** also appends the notes to the reconstruction
prompt, so a rebuilt mesh reflects them too — not just the specification.

Gizmos are hidden in Comment mode, so reviewing can never nudge an approved layout.

### Rendering

Two ways out of the viewport, with deliberately different trust levels:

| | Path-traced | Quick concept |
|---|---|---|
| What | Progressive path tracing of the real scene, in-browser | Image model repaints a viewport capture |
| Time | Seconds to minutes, converges as it goes | A few seconds |
| Faithful? | **Yes** — real geometry, real light transport | **No** — it will invent detail |
| Use for | Anything a buyer sees | A starting base for art direction |

The path tracer takes over the render loop while active and restarts accumulation whenever
the camera moves, so you frame the shot roughly and leave it to converge. Every operator aid —
grid, selection cages, pins, gizmo, the faked contact shadows — is suppressed while it runs, so
nothing gets baked in. If the HDRI failed to load there would be nothing lighting the scene, so
a gradient built from the booth's own colours stands in rather than rendering black.

The concept pass is labelled as non-faithful everywhere it appears, and the button explains
itself when `GEMINI_API_KEY` is unset rather than failing on click. Saved frames of both kinds
are listed in the panel.

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

## Deployment

Reconstruction is the stage most likely to run for minutes, and it's the one people most want
to walk away from — so the queue needs something draining it that isn't "a browser tab happens
to be open." Pick one of the two below for a real deployment; `POST /api/jobs/tick` (above)
stays around as a same-process convenience, not a substitute.

### An always-on worker (the intended way)

`npm run worker` (`scripts/worker.ts`) polls `drainJobs` in a loop until it's stopped. Run it as
its own long-running process alongside the web app, not as a request handler:

- **Railway** — add a second service from the same repo/image with the start command
  `npm run worker` instead of `npm run start`. It needs the same environment variables as the
  web service (`SUPABASE_SERVICE_ROLE_KEY` in particular — the worker writes as the service
  role, not a signed-in user) but no public domain.
- **systemd** — a plain unit works:
  ```ini
  [Unit]
  Description=ai3drender queue worker
  After=network.target

  [Service]
  WorkingDirectory=/opt/ai3drender
  EnvironmentFile=/opt/ai3drender/.env
  ExecStart=/usr/bin/npm run worker
  Restart=on-failure

  [Install]
  WantedBy=multi-user.target
  ```
- **A container** — build the same image as the web app and override its command to
  `npm run worker` for a second container/task instead of `npm run start`. Any platform that
  lets you run two services from one image (Railway, Fly, ECS, a k8s Deployment, docker-compose)
  works the same way: one process serves HTTP, the other runs the loop.

Since claims are atomic, running the worker *and* leaving the in-app poll in place is safe —
either one might pick up a given job, never both.

### Zero-infrastructure fallback: a scheduled trigger

For a small or serverless deployment where running a second process is the friction you're
trying to avoid, point a scheduler at `/api/jobs/tick` instead. The route accepts a scheduled
call without a signed-in user when it carries `Authorization: Bearer $CRON_SECRET` — set
`CRON_SECRET` in your environment to turn this on (see `.env.example`); unset, that branch is
simply never taken and the route still requires a session, same as before.

- **Vercel Cron** — `vercel.json` in this repo already declares
  `{ "path": "/api/jobs/tick", "schedule": "*/5 * * * *" }`. Set `CRON_SECRET` as a project
  environment variable and Vercel signs its own cron requests with it automatically (it appends
  `Authorization: Bearer $CRON_SECRET` for you) — nothing else to wire up. **Caveat:** the
  Hobby plan only runs cron jobs once a day regardless of the schedule you configure; a `*/5`
  schedule needs a Pro (or higher) plan to actually fire every five minutes. On Hobby, either
  upgrade or use an external cron service below for anything more frequent than daily.
- **An external cron service** (cron-job.org, GitHub Actions' `schedule:` trigger, etc.) — have
  it send `POST https://<your-app>/api/jobs/tick` with header
  `Authorization: Bearer <CRON_SECRET>` on whatever interval you like. This works on any host,
  including Hobby-tier Vercel, since the scheduling happens outside the app entirely.

**What this PR could and couldn't verify locally:** the standalone worker was run and confirmed
to drain a real job end-to-end against `LocalStore` (see the PR description). The
`CRON_SECRET` bearer-auth branch on `/api/jobs/tick` was exercised directly with `curl` against
a running `next start`. Neither a real Vercel Cron firing nor an external cron service actually
calling a deployed URL was — that requires a live Vercel deployment and public domain, which
this sandbox doesn't have; wiring correctness there rests on Vercel's documented cron-request
behavior (it sends the `Authorization` header itself when `CRON_SECRET` is set), not on an
end-to-end test.

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
app/sign-in, app/auth/   sign-in page, magic-link callback, sign-out
proxy.ts                 refreshes auth cookies and gates protected routes
components/studio/       viewport, outliner, inspector
lib/
  ai/gemini.ts           analysis, view synthesis, art direction, refinement
  ai/offline.ts          deterministic fallback when no key is set
  ai/mesh/               MeshProvider port, vendor adapters, GLB writer, massing generator
  db/                    Store port; Supabase and local-disk implementations
  pipeline/              job stages and the runner
  scene/                 booth presets, scene defaults, anchor resolution
  studio/                client store and exporters
components/studio/       viewport, outliner, inspector, annotations, render panel
supabase/migrations/     schema, RLS, storage policy, annotations and renders
```

## Known limits

- There is no team or sharing model yet: every project belongs to exactly one owner, and RLS
  is written against `projects.owner_id`. Client review links and multi-user access both need
  a real grant model.
- The stub produces block massing, not reconstruction. It is for layout, not for hero renders.
- Without `GEMINI_API_KEY`, dimensions come from category conventions and are flagged
  `rough` throughout the UI. Do not quote from them.
- Path tracing runs on the viewer's GPU. It converges in seconds on a discrete GPU and is
  painfully slow on software rendering; drop the resolution scale on weaker machines. For
  print-resolution stills, export the GLB and render it offline in your DCC of choice.
- Concept renders are not a record of the product. They are labelled as such in the UI, and
  that labelling should survive any redesign of it.
- Notes resolve to a named part only when the mesh carries part names. Our own meshes do;
  a vendor mesh that arrives as one merged object falls back to the positional description
  alone, which is still enough for the model to act on.

-- ---------------------------------------------------------------------------
-- Anchored review notes, and the render outputs they get compared against.
-- ---------------------------------------------------------------------------

-- preview_path was carried through the whole data layer but every pipeline
-- stage wrote it as null. Render output lives in scene_renders instead.
alter table asset_versions drop column if exists preview_path;

-- The concept-render stage is a new job kind.
alter table jobs drop constraint if exists jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('analyze', 'synthesize_views', 'reconstruct', 'refine',
                  'direct_scene', 'concept_render'));

-- Annotations ----------------------------------------------------------------

create table if not exists annotations (
  id                   uuid primary key default gen_random_uuid(),
  asset_id             uuid not null references furniture_assets (id) on delete cascade,
  asset_version_id     uuid not null references asset_versions (id) on delete cascade,
  scene_id             uuid references scenes (id) on delete set null,
  -- Anchor is in the asset's local space, so a note survives the piece being
  -- moved or restaged.
  point                jsonb not null,
  normal               jsonb not null,
  part_name            text,
  component_name       text,
  component_role       text,
  anchor_description   text not null default '',
  body                 text not null,
  status               text not null default 'open'
                       check (status in ('open', 'applied', 'dismissed')),
  resolved_by_version_id uuid references asset_versions (id) on delete set null,
  created_at           timestamptz not null default now()
);

create index if not exists annotations_asset_idx on annotations (asset_id, created_at);
-- The apply-notes path only ever reads the open ones.
create index if not exists annotations_open_idx
  on annotations (asset_id) where status = 'open';

-- Scene renders --------------------------------------------------------------

create table if not exists scene_renders (
  id         uuid primary key default gen_random_uuid(),
  scene_id   uuid not null references scenes (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  kind       text not null check (kind in ('pathtraced', 'concept')),
  path       text not null,
  width      integer not null default 0,
  height     integer not null default 0,
  samples    integer,
  prompt     text,
  created_at timestamptz not null default now()
);

create index if not exists scene_renders_scene_idx on scene_renders (scene_id, created_at desc);

-- Row level security ----------------------------------------------------------

alter table annotations   enable row level security;
alter table scene_renders enable row level security;

drop policy if exists annotations_owner on annotations;
create policy annotations_owner on annotations
  for all using (owns_asset(asset_id)) with check (owns_asset(asset_id));

drop policy if exists scene_renders_owner on scene_renders;
create policy scene_renders_owner on scene_renders
  for all using (owns_project(project_id)) with check (owns_project(project_id));

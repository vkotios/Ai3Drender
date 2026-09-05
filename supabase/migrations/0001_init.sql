-- ---------------------------------------------------------------------------
-- ai3drender: furniture photos -> versioned 3D assets -> exhibition scenes
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- Projects -------------------------------------------------------------------

create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  client      text,
  brief       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists projects_owner_idx on projects (owner_id, updated_at desc);

-- Source photos --------------------------------------------------------------

create table if not exists source_images (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  path        text not null,
  filename    text not null,
  mime_type   text not null,
  byte_size   bigint not null default 0,
  role        text not null default 'primary'
              check (role in ('primary', 'detail', 'alternate', 'mood')),
  created_at  timestamptz not null default now()
);

create index if not exists source_images_project_idx on source_images (project_id, created_at);

-- Furniture assets and their immutable versions -------------------------------

create table if not exists furniture_assets (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects (id) on delete cascade,
  name               text not null,
  status             text not null default 'draft'
                     check (status in ('draft', 'analyzing', 'generating_views',
                                       'reconstructing', 'ready', 'failed')),
  current_version_id uuid,
  source_image_ids   uuid[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists furniture_assets_project_idx
  on furniture_assets (project_id, updated_at desc);

create table if not exists asset_versions (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid not null references furniture_assets (id) on delete cascade,
  version_number    integer not null,
  label             text not null default '',
  parent_version_id uuid references asset_versions (id) on delete set null,
  spec              jsonb not null,
  views             jsonb not null default '[]',
  mesh_path         text,
  mesh_extent_mm    numeric,
  preview_path      text,
  provider          text not null default 'stub',
  provider_job_id   text,
  refinement        jsonb,
  accepted_at       timestamptz,
  created_at        timestamptz not null default now(),
  unique (asset_id, version_number)
);

create index if not exists asset_versions_asset_idx
  on asset_versions (asset_id, version_number desc);

-- current_version_id is only added now that asset_versions exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'furniture_assets_current_version_fkey'
  ) then
    alter table furniture_assets
      add constraint furniture_assets_current_version_fkey
      foreign key (current_version_id) references asset_versions (id) on delete set null;
  end if;
end $$;

-- An accepted version is a contract with the customer: freeze it.
create or replace function reject_accepted_version_edit()
returns trigger
language plpgsql
as $$
begin
  if old.accepted_at is not null and new.accepted_at is not null then
    raise exception
      'asset_version % is accepted and immutable; create a new version instead', old.id;
  end if;
  return new;
end $$;

drop trigger if exists asset_versions_immutable on asset_versions;
create trigger asset_versions_immutable
  before update on asset_versions
  for each row execute function reject_accepted_version_edit();

-- Exhibition scenes -----------------------------------------------------------

create table if not exists scenes (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  name        text not null,
  doc         jsonb not null,
  direction   jsonb,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists scenes_project_idx on scenes (project_id, updated_at desc);

-- Every save of a scene is retained so staging can be rolled back.
create table if not exists scene_versions (
  id             uuid primary key default gen_random_uuid(),
  scene_id       uuid not null references scenes (id) on delete cascade,
  version_number integer not null,
  doc            jsonb not null,
  note           text not null default '',
  created_at     timestamptz not null default now(),
  unique (scene_id, version_number)
);

-- Pipeline jobs ---------------------------------------------------------------

create table if not exists jobs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  asset_id    uuid references furniture_assets (id) on delete cascade,
  kind        text not null
              check (kind in ('analyze', 'synthesize_views', 'reconstruct',
                              'refine', 'direct_scene')),
  status      text not null default 'queued'
              check (status in ('queued', 'running', 'succeeded', 'failed')),
  progress    numeric not null default 0,
  message     text not null default '',
  error       text,
  input       jsonb not null default '{}',
  output      jsonb,
  attempts    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The worker claims work with this index; keep it tight.
create index if not exists jobs_queued_idx
  on jobs (status, created_at) where status = 'queued';
create index if not exists jobs_project_idx on jobs (project_id, created_at desc);

-- updated_at maintenance ------------------------------------------------------

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['projects', 'furniture_assets', 'scenes', 'jobs'] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format(
      'create trigger %I_touch before update on %I
         for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- Row level security ----------------------------------------------------------
-- Everything is reachable only through a project the caller owns.

alter table projects         enable row level security;
alter table source_images    enable row level security;
alter table furniture_assets enable row level security;
alter table asset_versions   enable row level security;
alter table scenes           enable row level security;
alter table scene_versions   enable row level security;
alter table jobs             enable row level security;

drop policy if exists projects_owner on projects;
create policy projects_owner on projects
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function owns_project(pid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from projects p where p.id = pid and p.owner_id = auth.uid());
$$;

drop policy if exists source_images_owner on source_images;
create policy source_images_owner on source_images
  for all using (owns_project(project_id)) with check (owns_project(project_id));

drop policy if exists furniture_assets_owner on furniture_assets;
create policy furniture_assets_owner on furniture_assets
  for all using (owns_project(project_id)) with check (owns_project(project_id));

drop policy if exists scenes_owner on scenes;
create policy scenes_owner on scenes
  for all using (owns_project(project_id)) with check (owns_project(project_id));

drop policy if exists jobs_owner on jobs;
create policy jobs_owner on jobs
  for all using (owns_project(project_id)) with check (owns_project(project_id));

create or replace function owns_asset(aid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from furniture_assets a
    join projects p on p.id = a.project_id
    where a.id = aid and p.owner_id = auth.uid()
  );
$$;

drop policy if exists asset_versions_owner on asset_versions;
create policy asset_versions_owner on asset_versions
  for all using (owns_asset(asset_id)) with check (owns_asset(asset_id));

create or replace function owns_scene(sid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from scenes s
    join projects p on p.id = s.project_id
    where s.id = sid and p.owner_id = auth.uid()
  );
$$;

drop policy if exists scene_versions_owner on scene_versions;
create policy scene_versions_owner on scene_versions
  for all using (owns_scene(scene_id)) with check (owns_scene(scene_id));

-- Storage ---------------------------------------------------------------------
-- Keys are laid out as <project_id>/<kind>/<file>, so ownership is decided by
-- the leading path segment.

insert into storage.buckets (id, name, public)
values ('renders', 'renders', false)
on conflict (id) do nothing;

drop policy if exists renders_owner on storage.objects;
create policy renders_owner on storage.objects
  for all
  using (
    bucket_id = 'renders'
    and owns_project(nullif(split_part(name, '/', 1), '')::uuid)
  )
  with check (
    bucket_id = 'renders'
    and owns_project(nullif(split_part(name, '/', 1), '')::uuid)
  );

-- ---------------------------------------------------------------------------
-- Shared material library (#15).
--
-- A manufacturer has a finite range of fabrics, timbers, finishes and
-- powder-coat colours. Before this, every asset version's materials[] was
-- invented fresh by the vision pass from photographs, so the same oak came
-- out as several near-misses across different pieces. This table is the
-- account-wide catalogue of real materials that the vision pass now matches
-- against first, and that components can be explicitly bound to.
--
-- Scoped by owner_id (account-level), not project_id: a manufacturer's range
-- of finishes does not reset with every new exhibition stand, and
-- project-scoping would fragment one catalogue across every project the same
-- account runs. Bindings live inside asset_versions.spec (jsonb) as they
-- always have - materials[].libraryEntryId - so this migration adds no
-- foreign key from asset_versions and needs no backfill.
-- ---------------------------------------------------------------------------

create table if not exists material_library_entries (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  code          text,
  kind          text not null
                check (kind in ('wood', 'metal', 'fabric', 'leather', 'glass',
                                'stone', 'plastic', 'composite')),
  base_color_hex text not null,
  roughness     numeric not null default 0.5 check (roughness between 0 and 1),
  metalness     numeric not null default 0 check (metalness between 0 and 1),
  sheen         numeric not null default 0 check (sheen between 0 and 1),
  clearcoat     numeric not null default 0 check (clearcoat between 0 and 1),
  finish        text not null default '',
  notes         text not null default '',
  swatch_path   text,
  -- Discontinued materials are archived, not deleted, so existing bindings
  -- and usage history (what a discontinued fabric affects) stay traceable.
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists material_library_entries_owner_idx
  on material_library_entries (owner_id, name);
create index if not exists material_library_entries_active_idx
  on material_library_entries (owner_id) where archived_at is null;

drop trigger if exists material_library_entries_touch on material_library_entries;
create trigger material_library_entries_touch
  before update on material_library_entries
  for each row execute function touch_updated_at();

-- Row level security ----------------------------------------------------------

alter table material_library_entries enable row level security;

drop policy if exists material_library_entries_owner on material_library_entries;
create policy material_library_entries_owner on material_library_entries
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Storage -----------------------------------------------------------------
-- Swatch photos are account-level, not project-level, so they cannot use the
-- existing `owns_project` policy on the renders bucket (which reads the first
-- path segment as a project id). Keys are laid out as
-- library/<owner_id>/<file>, mirroring the project-scoped convention.

drop policy if exists library_swatches_owner on storage.objects;
create policy library_swatches_owner on storage.objects
  for all
  using (
    bucket_id = 'renders'
    and split_part(name, '/', 1) = 'library'
    and nullif(split_part(name, '/', 2), '')::uuid = auth.uid()
  )
  with check (
    bucket_id = 'renders'
    and split_part(name, '/', 1) = 'library'
    and nullif(split_part(name, '/', 2), '')::uuid = auth.uid()
  );

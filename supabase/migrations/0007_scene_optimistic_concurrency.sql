-- ---------------------------------------------------------------------------
-- Optimistic concurrency for scene saves (#10).
--
-- Two people staging the same stand - or one person with the studio open in
-- two tabs - could silently clobber each other: PATCH /api/scenes/:id wrote
-- `doc` unconditionally, so the later save won with no warning. `scenes.version`
-- gives every save something to check against: the client sends back the
-- version it loaded, and the application layer only accepts the write when it
-- still matches (see `SupabaseStore.updateScene`).
-- ---------------------------------------------------------------------------

alter table scenes add column if not exists version integer not null default 1;

-- Backfill existing rows to how many saves scene_versions already recorded,
-- so a scene's version lines up with its history instead of resetting to 1.
update scenes s
set version = coalesce((
  select max(v.version_number) from scene_versions v where v.scene_id = s.id
), 1)
where s.version = 1;

-- Bumped automatically whenever `doc` actually changes, so the application
-- layer never has to compute or set it directly - it only ever reads it back
-- and, on the next save, asserts it in the update's WHERE clause.
create or replace function bump_scene_version()
returns trigger
language plpgsql
as $$
begin
  if new.doc is distinct from old.doc then
    new.version = old.version + 1;
  end if;
  return new;
end $$;

drop trigger if exists scenes_bump_version on scenes;
create trigger scenes_bump_version
  before update on scenes
  for each row execute function bump_scene_version();

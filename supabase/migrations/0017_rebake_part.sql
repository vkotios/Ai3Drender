-- ---------------------------------------------------------------------------
-- Per-part material re-bake (issue #57).
--
-- A new 'rebake_part' job kind re-bakes ONE named part's material/texture
-- directly into a new asset version's mesh, permanently - distinct from the
-- material spot-fix (issue #48, `PATCH .../materials/:materialId`), which
-- only patches the spec's descriptive PBR values and never touches the
-- stored mesh, and from `SceneNode.materialOverrides` (issue #7), a
-- viewer-side override that never persists into a new version at all.
--
-- `rebaked_part` records what the job changed (target part, resolved
-- component/mesh names, where the new material came from) on the version it
-- produced, the same way `refinement` already does for a `refine` job - see
-- `RebakePartRequest` in lib/types.ts. Null on every other version, including
-- everything recorded before this column existed.
-- ---------------------------------------------------------------------------

alter table asset_versions add column if not exists rebaked_part jsonb;

alter table jobs drop constraint if exists jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('analyze', 'synthesize_views', 'reconstruct', 'refine',
                  'direct_scene', 'concept_render', 'render', 'rebake_part'));

-- ---------------------------------------------------------------------------
-- One-click floor-plan-to-scene generation (issue #58).
--
-- A new 'floorplan_scene' job kind reads an uploaded floor-plan image and
-- produces a whole new SceneDoc from it - a traced booth boundary
-- (EnvironmentSettings.footprint, issue #52) plus staged furniture - in one
-- job, rather than the operator tracing the boundary and placing every piece
-- by hand. Unlike every other job kind, it creates its own new `scenes` row
-- rather than acting on an existing one - see
-- `lib/pipeline/index.ts`'s `runGenerateSceneFromFloorPlan`.
--
-- No new columns: the job's input/output already live in the existing
-- generic `input`/`output` jsonb columns, same as every other job kind.
-- ---------------------------------------------------------------------------

alter table jobs drop constraint if exists jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('analyze', 'synthesize_views', 'reconstruct', 'refine',
                  'direct_scene', 'concept_render', 'render', 'rebake_part',
                  'floorplan_scene'));

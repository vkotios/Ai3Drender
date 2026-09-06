-- ---------------------------------------------------------------------------
-- Offline render worker: a 'render' job kind that drives a headless
-- Blender/Cycles pass, and a matching 'render' scene_renders kind for its
-- output. Print-resolution and geometrically faithful, unlike the fast
-- 'concept' pass and decoupled from the viewport size unlike 'pathtraced'.
-- ---------------------------------------------------------------------------

alter table jobs drop constraint if exists jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('analyze', 'synthesize_views', 'reconstruct', 'refine',
                  'direct_scene', 'concept_render', 'render'));

alter table scene_renders drop constraint if exists scene_renders_kind_check;
alter table scene_renders add constraint scene_renders_kind_check
  check (kind in ('pathtraced', 'concept', 'render'));

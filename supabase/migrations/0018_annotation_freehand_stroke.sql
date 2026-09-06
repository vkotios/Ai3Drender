-- ---------------------------------------------------------------------------
-- Freehand stroke markup (issue #63): a note can now be a drawn line across
-- the mesh surface - "shave this whole edge down", a circled region - not
-- only a clicked point or a whole named part.
-- ---------------------------------------------------------------------------

alter table annotations
  drop constraint if exists annotations_selection_kind_check;

alter table annotations
  add constraint annotations_selection_kind_check
    check (selection_kind in ('point', 'part', 'freehand'));

-- Ordered [{point:{x,y,z}, partName}] samples along the stroke, anchored in
-- the asset's local space exactly like the point/normal columns above - see
-- lib/scene/stroke.ts and Annotation.strokePoints. Null for every note that
-- isn't a freehand selection.
alter table annotations
  add column if not exists stroke_points jsonb;

comment on column annotations.stroke_points is
  'Ordered [{point:{x,y,z}, partName}] samples for a freehand stroke. Null unless selection_kind = ''freehand''. See migration 0017.';

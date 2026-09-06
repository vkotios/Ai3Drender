-- ---------------------------------------------------------------------------
-- Carry still-open annotations forward across asset versions (issue #12).
--
-- An annotation used to go stale the moment its version was superseded: it
-- stayed pinned to the old `asset_version_id` forever, invisible against the
-- version the studio actually shows. `refine` (lib/pipeline/index.ts) now
-- re-points any note still `open` on the version it revises at the new
-- version it produces, refreshing everything derived from the spec
-- (`component_name`, `component_role`, `anchor_description`) rather than
-- copying those fields blindly.
--
-- Two columns track that history:
--   - origin_version_id / origin_version_number: the version the note was
--     first pinned on. Set once at creation, never touched again, so a note
--     that has moved across several versions can still say "since v1".
--   - stale_note: populated only when a carried-forward note's anchor could
--     not be cleanly reconciled with the new spec (the part it named no
--     longer resolves to a component, or the anchor point now falls outside
--     the piece's bounding box). The note stays `open` either way - this is
--     a heads-up, not a status change - so a reviewer sees it flagged rather
--     than acted on as if nothing had changed underneath it.
-- ---------------------------------------------------------------------------

alter table annotations add column if not exists origin_version_id uuid
  references asset_versions (id) on delete cascade;
alter table annotations add column if not exists origin_version_number integer;
alter table annotations add column if not exists stale_note text;

-- Backfill existing rows: a note with no recorded origin started life on the
-- version it currently points to.
update annotations
   set origin_version_id = asset_version_id
 where origin_version_id is null;

update annotations
   set origin_version_number = av.version_number
  from asset_versions av
 where annotations.origin_version_id = av.id
   and annotations.origin_version_number is null;

alter table annotations alter column origin_version_id set not null;
alter table annotations alter column origin_version_number set not null;

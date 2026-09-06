-- ---------------------------------------------------------------------------
-- Annotation panel: threaded replies and @mentions (issue #40).
--
-- Threaded replies
-- ----------------
-- A reply nests under the note it answers rather than becoming its own flat
-- pin. Rather than a separate `annotation_replies` table, a reply is just
-- another row in `annotations` with `parent_annotation_id` set: it needs the
-- exact same shape as a top-level note (body, source/client_name, mentions),
-- and every anchor field a separate table would otherwise have to duplicate
-- (point, normal, part_name, component_name/role, anchor_description,
-- asset_version_id, origin_version_id/number, scene_id) is simply inherited
-- from the parent at insert time - see app/api/assets/[assetId]/annotations
-- and app/api/annotations/[annotationId]. `on delete cascade` means removing
-- a note takes its replies with it, mirrored in LocalStore for parity.
--
-- Kept one level deep on purpose: the API rejects a reply to a reply, so this
-- models a note-and-its-replies thread, not an arbitrary tree.
--
-- @mentions
-- ---------
-- `mentions` is the plain names captured out of an `@name` token in `body` at
-- write time (see lib/annotations/mentions.ts), so the panel can render them
-- distinctly without re-parsing the body from scratch. UI-only, as the issue
-- specifies: nothing here notifies the person named (tracked separately as
-- issue #46).
-- ---------------------------------------------------------------------------

alter table annotations
  add column if not exists parent_annotation_id uuid
    references annotations (id) on delete cascade;

alter table annotations
  add column if not exists mentions text[] not null default '{}';

-- The panel's thread view looks up a note's replies by parent.
create index if not exists annotations_parent_idx
  on annotations (parent_annotation_id) where parent_annotation_id is not null;

-- A reply is never itself carried forward or listed as an applicable note,
-- but the apply-notes / carry-forward paths still filter on
-- (asset_id, status = 'open') first - keep that index useful for the
-- top-level rows it actually matters for.
comment on column annotations.parent_annotation_id is
  'Set only on a reply; null for a top-level pinned note. See migration 0011.';
comment on column annotations.mentions is
  '@name tokens captured from body at write time. UI-only - see migration 0011.';

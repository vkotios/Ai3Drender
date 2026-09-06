-- ---------------------------------------------------------------------------
-- Region selection for review notes (part 1): a note can now cover a whole
-- named part as a unit, not only one clicked point.
-- ---------------------------------------------------------------------------

alter table annotations
  add column if not exists selection_kind text not null default 'point'
    check (selection_kind in ('point', 'part'));

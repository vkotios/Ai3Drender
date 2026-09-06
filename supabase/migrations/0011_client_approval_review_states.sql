-- ---------------------------------------------------------------------------
-- Richer client review states (issue #41).
--
-- `client_approval` was binary-plus-pending (pending / approved /
-- changes_requested). Extended to five states, modelled on Ziflow's
-- per-reviewer verdict (docs/competitive-gap-analysis.md §05):
--   pending, approved, approved_with_changes, changes_requested, not_relevant.
--
-- This stays a single column on `scenes` rather than a per-annotation
-- reviewer-verdict table - see the doc comment on `ClientApproval` in
-- lib/types.ts and the PR description for the full reasoning. Existing rows
-- (all currently pending/approved/changes_requested) need no backfill, the
-- constraint just widens to admit the two new values.
-- ---------------------------------------------------------------------------

alter table scenes drop constraint if exists scenes_client_approval_check;

alter table scenes
  add constraint scenes_client_approval_check
    check (client_approval in (
      'pending',
      'approved',
      'approved_with_changes',
      'changes_requested',
      'not_relevant'
    ));

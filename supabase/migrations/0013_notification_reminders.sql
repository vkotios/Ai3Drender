-- ---------------------------------------------------------------------------
-- Reminder emails for share links nobody has opened yet (issue #46).
--
-- The reminder sweep (lib/notify/reminders.ts, driven by
-- POST /api/notifications/reminders/tick) needs to tell "never sent a
-- reminder" apart from "sent one already this threshold window" so it does
-- not re-email the owner every time it runs. That state has to survive
-- between ticks, so it is a column on the link itself rather than something
-- kept in memory.
-- ---------------------------------------------------------------------------

alter table scene_share_links
  add column if not exists last_reminder_sent_at timestamptz;

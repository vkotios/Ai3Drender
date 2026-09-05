-- ---------------------------------------------------------------------------
-- Make the job queue survive transient failures and dead workers.
--
-- Before this, `attempts` was incremented on claim and never read: a vendor
-- 503 failed a piece permanently, and a worker that died mid-job left its row
-- in `running` forever with nothing to reclaim it.
-- ---------------------------------------------------------------------------

alter table jobs
  add column if not exists max_attempts integer not null default 3,
  -- When the current claim lapses. Null while the job is not running.
  add column if not exists lease_expires_at timestamptz,
  -- Earliest time the job may be claimed again, set when a retry is scheduled.
  add column if not exists next_attempt_at timestamptz;

alter table jobs drop constraint if exists jobs_max_attempts_check;
alter table jobs add constraint jobs_max_attempts_check
  check (max_attempts between 1 and 10);

-- The claim query filters on next_attempt_at as well as status, so the partial
-- index has to carry it or every claim degrades to a sequential scan.
drop index if exists jobs_queued_idx;
create index if not exists jobs_claimable_idx
  on jobs (next_attempt_at nulls first, created_at) where status = 'queued';

-- Reclaiming expired leases scans running rows by their deadline.
create index if not exists jobs_lease_idx
  on jobs (lease_expires_at) where status = 'running';

-- Any job left running by an earlier deploy has no lease, so it would never be
-- reclaimed. Give them an already-expired one to sweep them up once.
update jobs set lease_expires_at = now() - interval '1 minute'
  where status = 'running' and lease_expires_at is null;

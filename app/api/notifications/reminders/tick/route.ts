import { isAuthorizedCron, json, withSession } from '@/lib/api';
import { getWorkerStore } from '@/lib/db';
import { runReminderSweep } from '@/lib/notify/reminders';

// The sweep touches every active share link across every project; generous
// but bounded, same reasoning as /api/jobs/tick's maxDuration.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Email owners about share links nobody has opened in `REMINDER_THRESHOLD_DAYS`.
 *
 * Same shape as `POST /api/jobs/tick`: a scheduled trigger (Vercel Cron, or
 * any external cron service) calls this with `Authorization: Bearer
 * $CRON_SECRET`, since there is nobody's studio tab open to run it
 * otherwise - unlike the job queue, there is no in-app poll for this, so an
 * unset `CRON_SECRET` leaves the sweep authenticated-session-only, useful for
 * triggering a manual run while developing.
 *
 * `runReminderSweep` itself no-ops (`{ checked: 0, sent: 0 }`) when
 * `RESEND_API_KEY` is unset, so hitting this route with no email provider
 * configured is always a harmless, fast no-op.
 */
export async function POST(request: Request) {
  if (isAuthorizedCron(request)) {
    return json(await runReminderSweep(getWorkerStore()));
  }
  return withSession(async () => json(await runReminderSweep(getWorkerStore())));
}

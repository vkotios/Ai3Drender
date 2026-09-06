import { getWorkerStore, type Store } from '@/lib/db';
import { env, hasEmail } from '@/lib/env';
import type { SceneShareLink } from '@/lib/types';

import { sendEmail } from './email';
import { resolveOwnerEmail } from './owner';

export interface ReminderSweepResult {
  /** Active share links examined. */
  checked: number;
  /** Reminder emails actually sent. */
  sent: number;
}

/**
 * A link needs a nudge once it has gone `REMINDER_THRESHOLD_DAYS` (or longer,
 * if the sweep hasn't run in a while) without the one signal the app already
 * tracks for "has anyone even looked at this": `lastAccessedAt`, set by
 * `Store.touchShareLink` whenever the share view loads (see its doc comment
 * in `lib/db/store.ts`). A link that has been opened at least once is not
 * silent, even if the client hasn't left a verdict yet - that's a normal
 * "still deciding," not the "this never reached them" case a reminder is for.
 *
 * `lastReminderSentAt` (falling back to `createdAt` when unset) is the clock
 * the threshold counts from, so a link that stays unopened keeps getting
 * nudged every `REMINDER_THRESHOLD_DAYS` rather than exactly once.
 */
function needsReminder(link: SceneShareLink, thresholdMs: number, nowMs: number): boolean {
  if (link.lastAccessedAt) return false;
  const since = Date.parse(link.lastReminderSentAt ?? link.createdAt);
  return nowMs - since >= thresholdMs;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sweep every active share link and email the owner about ones nobody has
 * opened yet. Meant to be called from a scheduled trigger - see
 * `POST /api/notifications/reminders/tick` - the same `CRON_SECRET`-gated
 * shape as the job queue's `/api/jobs/tick`, since this has the same
 * "nobody's tab is open to run it" problem.
 *
 * No-op (an immediate `{ checked: 0, sent: 0 }`) when `RESEND_API_KEY` is
 * unset - there is nowhere to send a reminder, so skip the sweep's store
 * queries entirely rather than doing the work and discarding it.
 *
 * Takes the store explicitly, same as `drainJobs` - the route passes
 * `getWorkerStore()` (service-role in Supabase mode, since there's no
 * signed-in owner to scope a per-project query by), and tests pass a
 * `LocalStore` directly instead of exercising the module-level singleton.
 */
export async function runReminderSweep(store: Store = getWorkerStore()): Promise<ReminderSweepResult> {
  if (!hasEmail) return { checked: 0, sent: 0 };

  const links = await store.listActiveShareLinks();
  const thresholdMs = env.reminderThresholdDays * 24 * 60 * 60_000;
  const nowMs = Date.now();

  let sent = 0;
  for (const link of links) {
    if (!needsReminder(link, thresholdMs, nowMs)) continue;
    try {
      const scene = await store.getScene(link.sceneId);
      if (!scene) continue;
      const project = await store.getProject(scene.projectId);
      if (!project) continue;
      const ownerEmail = await resolveOwnerEmail(project.ownerId);
      if (!ownerEmail) continue;

      const label = link.label ?? scene.name;
      const daysSince = Math.max(1, Math.round((nowMs - Date.parse(link.createdAt)) / (24 * 60 * 60_000)));
      const subject = `No response yet on "${label}"`;
      const studioLink = `${env.appUrl}/projects/${project.id}/scenes/${scene.id}`;
      const body =
        `The client review link for "${project.name} / ${scene.name}" (label: ${label}) ` +
        `hasn't been opened in ${daysSince} day${daysSince === 1 ? '' : 's'}. It's still ` +
        'waiting on their sign-off.';

      await sendEmail({
        to: ownerEmail,
        subject,
        text: `${body}\n\n${studioLink}`,
        html: `<p>${escapeHtml(body)}</p><p><a href="${studioLink}">${studioLink}</a></p>`,
      });
      await store.markShareLinkReminded(link.id);
      sent += 1;
    } catch (cause) {
      console.error(`[notify] reminder sweep failed for share link ${link.id}`, cause);
    }
  }
  return { checked: links.length, sent };
}

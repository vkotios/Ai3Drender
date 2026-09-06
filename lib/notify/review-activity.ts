import { getWorkerStore, type Store } from '@/lib/db';
import { env, hasEmail, hasSlack } from '@/lib/env';
import type { ClientApproval, Scene } from '@/lib/types';

import { sendEmail } from './email';
import { resolveOwnerEmail } from './owner';
import { postSlackMessage } from './slack';

export type ReviewActivityEvent =
  | { kind: 'annotation'; clientName: string; body: string }
  | { kind: 'review'; clientName: string; status: ClientApproval; note: string | null };

const STATUS_LABEL: Record<ClientApproval, string> = {
  pending: 'marked pending',
  approved: 'approved',
  approved_with_changes: 'approved, with changes',
  changes_requested: 'requested changes',
  not_relevant: 'marked not relevant',
};

function describe(event: ReviewActivityEvent): { headline: string; detail: string | null } {
  if (event.kind === 'annotation') {
    return { headline: `${event.clientName} left a note`, detail: event.body };
  }
  return {
    headline: `${event.clientName} ${STATUS_LABEL[event.status]}`,
    detail: event.note,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Best-effort fan-out for one piece of client review activity on a shared
 * scene - a pinned note, or an approval verdict - to whichever of Slack/email
 * are configured.
 *
 * Called from the share-link annotation and review routes after the write
 * that matters (the note or the verdict) has already succeeded, and is
 * itself never allowed to throw or reject: notifying the owner is a
 * convenience on top of that write, not a precondition for it. Both
 * `postSlackMessage` and `sendEmail` already no-op silently when unconfigured
 * and never throw either, but the lookups here (the owning project, the
 * owner's email) are wrapped too, so a lookup failure can't surface as a
 * failed review submission.
 *
 * `store` defaults to `getWorkerStore()` (service-role in Supabase mode, so
 * it can read the owning project regardless of whether the share request's
 * own client is RLS-scoped down to just the shared scene); tests pass a
 * `LocalStore` directly.
 */
export async function notifyReviewActivity(
  scene: Scene,
  event: ReviewActivityEvent,
  store: Store = getWorkerStore(),
): Promise<void> {
  if (!hasSlack && !hasEmail) return;
  try {
    const project = await store.getProject(scene.projectId);
    const sceneLabel = project ? `${project.name} / ${scene.name}` : scene.name;
    const studioLink = project
      ? `${env.appUrl}/projects/${project.id}/scenes/${scene.id}`
      : env.appUrl;
    const { headline, detail } = describe(event);
    const summary = `${headline} on "${sceneLabel}"`;

    await Promise.allSettled([
      postSlackMessage(
        [summary, detail ? `> ${detail}` : null, studioLink].filter(Boolean).join('\n'),
      ),
      (async () => {
        if (!project) return;
        const ownerEmail = await resolveOwnerEmail(project.ownerId);
        if (!ownerEmail) return;
        await sendEmail({
          to: ownerEmail,
          subject: summary,
          text: [summary, detail ?? null, studioLink].filter(Boolean).join('\n\n'),
          html: [
            `<p>${escapeHtml(summary)}</p>`,
            detail ? `<blockquote>${escapeHtml(detail)}</blockquote>` : '',
            `<p><a href="${studioLink}">${studioLink}</a></p>`,
          ]
            .filter(Boolean)
            .join('\n'),
        });
      })(),
    ]);
  } catch (cause) {
    console.error('[notify] notifyReviewActivity failed', cause);
  }
}

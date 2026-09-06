import { apiError, json } from '@/lib/api';
import { resolveShareToken } from '@/lib/share/access';
import type { ClientApproval } from '@/lib/types';

type Params = { params: Promise<{ token: string }> };

const STATUSES: ClientApproval[] = [
  'pending',
  'approved',
  'approved_with_changes',
  'changes_requested',
  'not_relevant',
];

/** "Client signed off on this stand" - set from the share view, read by the owner. */
export async function POST(request: Request, { params }: Params) {
  const { token } = await params;
  const resolution = await resolveShareToken(token);
  if (!resolution.ok) return apiError(resolution.message, resolution.status);
  const { store, scene, role } = resolution.context;
  // Same reasoning as app/api/share/[token]/annotations: the UI hides the
  // approve/request-changes controls on a viewer link, but that is not the
  // security boundary - reject the write server-side too.
  if (role !== 'commenter') return apiError('This link is view-only', 403);

  const body = (await request.json()) as {
    status?: ClientApproval;
    reviewerName?: string;
    note?: string;
  };

  if (!body.status || !STATUSES.includes(body.status)) {
    return apiError(`status must be one of ${STATUSES.join(', ')}`);
  }
  const reviewerName = body.reviewerName?.trim();
  if (!reviewerName) return apiError('Your name is required');

  return json(
    await store.updateScene(scene.id, {
      clientApproval: body.status,
      clientApprovalAt: new Date().toISOString(),
      clientApprovalName: reviewerName,
      clientApprovalNote: body.note?.trim() || null,
    }),
  );
}

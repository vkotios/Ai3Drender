import { apiError, json } from '@/lib/api';
import { extractMentions } from '@/lib/annotations/mentions';
import { notifyReviewActivity } from '@/lib/notify/review-activity';
import { describeAnchor, resolveComponent } from '@/lib/scene/anchor';
import { referencedAssetVersionIds, resolveShareToken } from '@/lib/share/access';
import type { Vec3 } from '@/lib/types';

type Params = { params: Promise<{ token: string }> };

const isVec3 = (value: unknown): value is Vec3 =>
  typeof value === 'object' &&
  value !== null &&
  ['x', 'y', 'z'].every((axis) => Number.isFinite((value as Record<string, unknown>)[axis]));

/**
 * Pin a note through a share link.
 *
 * Same anchoring machinery as the internal route
 * (app/api/assets/[assetId]/annotations/route.ts) - a client's note is
 * exactly as actionable as a workshop reviewer's - but scoped to whatever the
 * shared scene actually stages, and always attributed to a typed-in name
 * rather than an account.
 */
export async function POST(request: Request, { params }: Params) {
  const { token } = await params;
  const resolution = await resolveShareToken(token);
  if (!resolution.ok) return apiError(resolution.message, resolution.status);
  const { store, scene, role } = resolution.context;
  // The UI never offers a way to pin a note on a viewer link, but that is not
  // the security boundary - a viewer-role token must be rejected here too.
  if (role !== 'commenter') return apiError('This link is view-only', 403);

  const body = (await request.json()) as {
    clientName?: string;
    body?: string;
    point?: unknown;
    normal?: unknown;
    partName?: string | null;
    assetVersionId?: string;
  };

  const clientName = body.clientName?.trim();
  if (!clientName) return apiError('Your name is required');
  if (!body.body?.trim()) return apiError('A note cannot be empty');
  if (!isVec3(body.point)) return apiError('A valid anchor point is required');
  if (!body.assetVersionId || !referencedAssetVersionIds(scene).has(body.assetVersionId)) {
    return apiError('That piece is not part of this shared scene', 404);
  }

  const version = await store.getAssetVersion(body.assetVersionId);
  if (!version) return apiError('Version not found', 404);

  const { componentName, componentRole } = resolveComponent(body.partName ?? null, version.spec);
  const trimmedBody = body.body.trim();

  const annotation = await store.createAnnotation({
    assetId: version.assetId,
    assetVersionId: version.id,
    originVersionId: version.id,
    originVersionNumber: version.versionNumber,
    sceneId: scene.id,
    point: body.point,
    normal: isVec3(body.normal) ? body.normal : { x: 0, y: 1, z: 0 },
    partName: body.partName ?? null,
    componentName,
    componentRole,
    anchorDescription: describeAnchor(body.point, version.spec.dimensions),
    body: trimmedBody,
    source: 'client',
    clientName,
    staleNote: null,
    selectionKind: 'point',
    // Threaded replies and @mentions are reviewed from the studio panel
    // only (issue #40) - a share-view note is always a fresh top-level pin.
    parentAnnotationId: null,
    mentions: extractMentions(trimmedBody),
  });

  // Best-effort - see notifyReviewActivity's doc comment. Never blocks or
  // fails the note itself, and no-ops instantly with no Slack/email configured.
  await notifyReviewActivity(scene, {
    kind: 'annotation',
    clientName,
    body: annotation.body,
  });

  return json(annotation, 201);
}

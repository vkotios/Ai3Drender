import { apiError, json, withAsset } from '@/lib/api';
import { extractMentions } from '@/lib/annotations/mentions';
import { describeAnchor, describeWholePart, resolveComponent } from '@/lib/scene/anchor';
import type { AnnotationStatus, SelectionKind, Vec3 } from '@/lib/types';

type Params = { params: Promise<{ assetId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { assetId } = await params;
  const status = new URL(request.url).searchParams.get('status');
  return withAsset(assetId, async ({ store }, asset) =>
    json(
      await store.listAnnotations(
        [asset.id],
        status ? (status.split(',') as AnnotationStatus[]) : undefined,
      ),
    ),
  );
}

const isVec3 = (value: unknown): value is Vec3 =>
  typeof value === 'object' &&
  value !== null &&
  ['x', 'y', 'z'].every((axis) => Number.isFinite((value as Record<string, unknown>)[axis]));

const isSelectionKind = (value: unknown): value is SelectionKind =>
  value === 'point' || value === 'part';

/**
 * Pin a note to a point on the piece, or to a whole named part taken as a
 * unit - or, given `parentAnnotationId`, add a threaded reply to an existing
 * note instead of a new pin.
 *
 * The client sends the anchor in the asset's local space plus whatever mesh
 * part it hit (for a whole-part selection, the centroid of every matching
 * instance and how many there are). The server resolves the part to a spec
 * component and a plain-language location, so the stored note carries the
 * context the model needs even if the mesh is later replaced - a component
 * reference and a short description, never a raw point or vertex set.
 *
 * A reply needs none of that: it inherits every anchor field from its parent
 * (see `Annotation.parentAnnotationId`), so only `body` (and, implicitly,
 * `parentAnnotationId`) has to be sent.
 */
export async function POST(request: Request, { params }: Params) {
  const { assetId } = await params;
  return withAsset(assetId, async ({ store }, asset) => {
    const body = (await request.json()) as {
      body?: string;
      point?: unknown;
      normal?: unknown;
      partName?: string | null;
      selectionKind?: unknown;
      instanceCount?: unknown;
      assetVersionId?: string;
      sceneId?: string | null;
      parentAnnotationId?: string | null;
    };

    if (!body.body?.trim()) return apiError('A note cannot be empty');
    const trimmedBody = body.body.trim();

    if (body.parentAnnotationId) {
      const parent = await store.getAnnotation(body.parentAnnotationId);
      if (!parent || parent.assetId !== asset.id) return apiError('Note not found', 404);
      if (parent.parentAnnotationId) {
        return apiError('A reply cannot itself be replied to');
      }

      return json(
        await store.createAnnotation({
          assetId: asset.id,
          assetVersionId: parent.assetVersionId,
          originVersionId: parent.originVersionId,
          originVersionNumber: parent.originVersionNumber,
          sceneId: parent.sceneId,
          selectionKind: parent.selectionKind,
          point: parent.point,
          normal: parent.normal,
          partName: parent.partName,
          componentName: parent.componentName,
          componentRole: parent.componentRole,
          anchorDescription: parent.anchorDescription,
          body: trimmedBody,
          source: 'internal',
          clientName: null,
          staleNote: null,
          parentAnnotationId: parent.id,
          mentions: extractMentions(trimmedBody),
        }),
        201,
      );
    }

    if (!isVec3(body.point)) return apiError('A valid anchor point is required');

    const selectionKind: SelectionKind = isSelectionKind(body.selectionKind)
      ? body.selectionKind
      : 'point';
    if (selectionKind === 'part' && !body.partName?.trim()) {
      return apiError('A whole-part selection needs a part name');
    }
    const instanceCount =
      typeof body.instanceCount === 'number' && Number.isFinite(body.instanceCount)
        ? Math.max(1, Math.round(body.instanceCount))
        : 1;

    const versionId = body.assetVersionId ?? asset.currentVersionId;
    if (!versionId) return apiError('This piece has no version to annotate');
    const version = await store.getAssetVersion(versionId);
    if (!version || version.assetId !== asset.id) return apiError('Version not found', 404);

    const { componentName, componentRole } = resolveComponent(
      body.partName ?? null,
      version.spec,
    );

    return json(
      await store.createAnnotation({
        assetId: asset.id,
        assetVersionId: version.id,
        originVersionId: version.id,
        originVersionNumber: version.versionNumber,
        sceneId: body.sceneId ?? null,
        selectionKind,
        point: body.point,
        normal: isVec3(body.normal) ? body.normal : { x: 0, y: 1, z: 0 },
        partName: body.partName ?? null,
        componentName,
        componentRole,
        anchorDescription:
          selectionKind === 'part'
            ? describeWholePart(instanceCount)
            : describeAnchor(body.point, version.spec.dimensions),
        body: trimmedBody,
        source: 'internal',
        clientName: null,
        staleNote: null,
        parentAnnotationId: null,
        mentions: extractMentions(trimmedBody),
      }),
      201,
    );
  });
}

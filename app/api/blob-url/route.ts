import { blobUrlWithExpiry } from '@/lib/db';
import { apiError, json, withSession } from '@/lib/api';

/**
 * On-demand resolution for a stored object's fetchable URL.
 *
 * In Supabase mode `blobUrl()` hands out a signed URL good for
 * `SIGNED_URL_TTL_SECONDS`, so one resolved when a page renders goes stale
 * long before a studio session ends. Anything that needs to keep fetching a
 * blob for as long as the page stays open re-resolves it here instead of
 * trusting a URL handed to it once - see `lib/studio/blobUrl.ts` for the
 * client side of this, wired into mesh loading in
 * `components/studio/AssetNode.tsx`.
 *
 * Auth-checked the same way as `app/api/blob/[...key]/route.ts`: every key is
 * project-scoped (`<projectId>/...`, see `storageKeys` in
 * lib/pipeline/index.ts), so the caller must own that project. In local-disk
 * mode `blobUrlWithExpiry` returns the same stable `/api/blob/...` path
 * `blobUrl()` always has, with a null `expiresAt` - that route re-checks
 * ownership itself on every fetch, so nothing here weakens it.
 */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return apiError('Missing key', 400);

  return withSession(async (session) => {
    const [projectId] = key.split('/');
    const project = await session.store.getProject(projectId);
    if (!project || project.ownerId !== session.viewer.id) return apiError('Not found', 404);

    return json(await blobUrlWithExpiry(session.store, key));
  });
}

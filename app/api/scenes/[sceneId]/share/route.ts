import { apiError, json, withScene } from '@/lib/api';
import { env } from '@/lib/env';
import type { IsoDate } from '@/lib/types';

type Params = { params: Promise<{ sceneId: string }> };

/** List the owner's share links for one scene. Tokens are never returned here - only at creation. */
export async function GET(_request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => json(await store.listShareLinks(scene.id)));
}

/**
 * Generate a new read-only share link for a scene.
 *
 * The raw token is returned exactly once, in this response - it is hashed
 * before it is ever written to storage (see lib/share/token.ts), so there is
 * no way to recover it afterwards short of revoking and creating a new one.
 */
export async function POST(request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store, viewer }, scene) => {
    const body = (await request.json().catch(() => ({}))) as {
      label?: string | null;
      expiresInDays?: number | null;
    };

    let expiresAt: IsoDate | null = null;
    if (body.expiresInDays != null) {
      if (!Number.isFinite(body.expiresInDays) || body.expiresInDays <= 0) {
        return apiError('expiresInDays must be a positive number');
      }
      expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const { link, token } = await store.createShareLink({
      sceneId: scene.id,
      createdBy: viewer.id,
      label: body.label?.trim() || null,
      expiresAt,
    });

    return json({ link, token, url: `${env.appUrl}/share/${token}` }, 201);
  });
}

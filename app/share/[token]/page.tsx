import { ShareStudioShell } from '@/components/studio/ShareStudioShell';
import { referencedAssetVersionIds, resolveShareToken } from '@/lib/share/access';
import { shareBlobUrl } from '@/lib/share/blob';
import type { LoadedVersion } from '@/lib/studio/store';

export const dynamic = 'force-dynamic';

/**
 * The client's view of a scene: orbit and inspect, pin notes, sign off.
 *
 * No account, no session - the token in the URL is the only credential, and
 * `resolveShareToken` is the only place that is checked. Nothing here can
 * stage a piece, drag a gizmo, save, or export: this route never gives the
 * browser the pieces it would need to (see ShareStudioShell).
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolution = await resolveShareToken(token);

  if (!resolution.ok) {
    return (
      <div className="flex h-screen items-center justify-center bg-shell-950 px-4">
        <div className="max-w-sm rounded-lg border border-shell-800 bg-shell-900 p-6 text-center">
          <p className="text-sm font-medium text-shell-100">
            {resolution.status === 410 ? 'This link is no longer active' : 'Link not found'}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-shell-400">{resolution.message}</p>
        </div>
      </div>
    );
  }

  const { store, scene } = resolution.context;

  const versionIds = [...referencedAssetVersionIds(scene)];
  const versions: LoadedVersion[] = [];
  for (const id of versionIds) {
    const version = await store.getAssetVersion(id);
    if (!version?.meshPath) continue;
    versions.push({
      version,
      meshUrl: await shareBlobUrl(store, token, version.meshPath),
      // MeshUrlBoundary's refresh route is session-gated, which an anonymous
      // share viewer never has - so there's nothing to schedule a proactive
      // refresh through here. A share link that outlives the signed URL's
      // TTL in Supabase mode needs a page reload; the token itself is
      // reissued separately from Share panel.
      meshUrlExpiresAt: null,
    });
  }

  const assetIds = [...new Set(versions.map((v) => v.version.assetId))];
  const annotations = await store.listAnnotations(assetIds);

  return <ShareStudioShell token={token} scene={scene} versions={versions} annotations={annotations} />;
}

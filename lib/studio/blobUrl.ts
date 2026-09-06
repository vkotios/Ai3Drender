/** A blob's URL and, in Supabase mode, when it goes stale. See `GET /api/blob-url`. */
export interface ResolvedBlobUrl {
  url: string;
  /** Null in local-disk mode: that path is stable and never expires. */
  expiresAt: string | null;
}

/**
 * Ask the server for a fresh URL for a stored object.
 *
 * Used to keep a mesh (or anything else handed to the browser as a
 * short-lived signed URL) reachable for as long as a page stays open, rather
 * than trusting the URL it was first given forever. See
 * `components/studio/MeshUrlBoundary.tsx` for the scheduling around this.
 */
export async function fetchBlobUrl(key: string): Promise<ResolvedBlobUrl> {
  const response = await fetch(`/api/blob-url?key=${encodeURIComponent(key)}`);
  if (!response.ok) {
    throw new Error(`fetchBlobUrl ${key}: ${response.status}`);
  }
  return response.json();
}

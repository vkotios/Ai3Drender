'use client';

import { Component, type ReactNode } from 'react';

import { fetchBlobUrl } from '@/lib/studio/blobUrl';

/**
 * How long before a signed URL's known expiry to swap it out. Generous on
 * purpose: refreshing early costs nothing, and a laptop can sleep through a
 * tighter margin and wake up past it.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Never schedule sooner than this, even for a URL that is already past its margin. */
const MIN_REFRESH_DELAY_MS = 5_000;
/** Backoff before trying again after a failed attempt to fetch a fresh URL. */
const REFRESH_RETRY_DELAY_MS = 15_000;

interface Props {
  /** Storage key this URL was resolved from - what a refresh re-resolves. */
  meshKey: string;
  initialUrl: string;
  /** Null in local-disk mode: that URL is stable, so nothing is ever scheduled. */
  initialExpiresAt: string | null;
  children: (url: string) => ReactNode;
}

interface State {
  url: string;
  expiresAt: string | null;
  /** Set once loading `url` has thrown, so children stay unmounted until refreshed. */
  failed: boolean;
}

/**
 * Keeps one mesh's fetchable URL alive for as long as it stays on the stand.
 *
 * A signed mesh URL resolved when the studio page rendered is good for
 * `SIGNED_URL_TTL_SECONDS` (an hour) and no longer - see `SupabaseStore.
 * blobUrl`. Left alone, `useGLTF` inside `AssetNode` eventually re-resolves
 * that stale URL (a remount, restaging, `useGLTF.preload` running again) and
 * gets a 403 back. This re-resolves the URL proactively ahead of its known
 * expiry via `GET /api/blob-url`, and - belt and braces - retries once
 * through the same route if loading it ever throws anyway (a token that
 * outlived its margin, clock skew between browser and server, ...). A second
 * failure after that retry is left alone rather than looped forever.
 *
 * Local-disk mode resolves with `expiresAt: null` (the `/api/blob/...` path
 * `LocalStore.blobUrl` returns is stable), so nothing is ever scheduled and
 * this adds no request beyond the one already needed to render the mesh.
 */
export class MeshUrlBoundary extends Component<Props, State> {
  state: State = {
    url: this.props.initialUrl,
    expiresAt: this.props.initialExpiresAt,
    failed: false,
  };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private retriedAfterError = false;
  private mounted = false;

  componentDidMount() {
    this.mounted = true;
    this.scheduleRefresh();
  }

  componentDidUpdate(prevProps: Props) {
    // A different mesh entirely (the node was restaged with another version) -
    // start over from what the parent just gave us rather than keep polling
    // the old key.
    if (prevProps.meshKey === this.props.meshKey) return;
    this.retriedAfterError = false;
    this.setState(
      { url: this.props.initialUrl, expiresAt: this.props.initialExpiresAt, failed: false },
      () => this.scheduleRefresh(),
    );
  }

  componentWillUnmount() {
    this.mounted = false;
    if (this.timer) clearTimeout(this.timer);
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (this.retriedAfterError) {
      console.error(`Mesh stayed unreachable after a retry: ${this.props.meshKey}`, error);
      return;
    }
    this.retriedAfterError = true;
    console.warn(`Mesh failed to load, retrying with a freshly signed URL: ${this.props.meshKey}`, error);
    this.clearTimer();
    void this.refresh();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleRefresh() {
    this.clearTimer();
    if (!this.state.expiresAt) return;
    const msLeft = new Date(this.state.expiresAt).getTime() - Date.now();
    const delay = Math.max(MIN_REFRESH_DELAY_MS, msLeft - REFRESH_MARGIN_MS);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  private async refresh() {
    try {
      const next = await fetchBlobUrl(this.props.meshKey);
      if (!this.mounted) return;
      this.retriedAfterError = false;
      this.setState({ url: next.url, expiresAt: next.expiresAt, failed: false }, () =>
        this.scheduleRefresh(),
      );
    } catch (error) {
      if (!this.mounted) return;
      console.warn(`Could not refresh mesh URL, retrying shortly: ${this.props.meshKey}`, error);
      this.timer = setTimeout(() => void this.refresh(), REFRESH_RETRY_DELAY_MS);
    }
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children(this.state.url);
  }
}

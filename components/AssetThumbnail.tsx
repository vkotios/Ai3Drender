'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import { acquireCaptureSlot } from '@/lib/studio/captureQueue';

// WebGL cannot render on the server.
const ThumbnailCapture = dynamic(
  () => import('./ThumbnailCapture').then((m) => m.ThumbnailCapture),
  { ssr: false },
);

const SIZE = 'h-16 w-16 shrink-0 overflow-hidden rounded-md border border-shell-800 bg-shell-850';

/**
 * A small render of one asset version, for scanning a list of pieces without
 * opening each one.
 *
 * Falls back through three states: an already-cached preview image, a live
 * capture (which caches itself for next time via
 * POST /api/assets/:assetId/versions/:versionId/preview), or a plain
 * placeholder while there is no mesh yet to render.
 */
export function AssetThumbnail({
  assetId,
  versionId,
  meshUrl,
  previewUrl,
}: {
  assetId: string;
  versionId: string;
  meshUrl: string | null;
  previewUrl: string | null;
}) {
  const [captured, setCaptured] = useState<string | null>(previewUrl);
  const [hasSlot, setHasSlot] = useState(false);

  useEffect(() => {
    if (captured || !meshUrl) return;
    let release: (() => void) | null = null;
    let cancelled = false;
    acquireCaptureSlot().then((r) => {
      if (cancelled) {
        r();
        return;
      }
      release = r;
      setHasSlot(true);
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [captured, meshUrl]);

  if (captured) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={captured} alt="" className={`${SIZE} object-contain`} />
    );
  }

  if (!meshUrl) {
    return (
      <div className={`${SIZE} flex items-center justify-center text-[9px] uppercase text-shell-500`}>
        no mesh
      </div>
    );
  }

  if (!hasSlot) {
    return <div className={`${SIZE} animate-pulse`} />;
  }

  return (
    <div className={SIZE}>
      <ThumbnailCapture
        assetId={assetId}
        versionId={versionId}
        meshUrl={meshUrl}
        onCaptured={setCaptured}
      />
    </div>
  );
}

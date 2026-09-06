'use client';

import Script from 'next/script';

const MODEL_VIEWER_VERSION = '4.3.1';
const MODEL_VIEWER_SRC = `https://cdnjs.cloudflare.com/ajax/libs/model-viewer/${MODEL_VIEWER_VERSION}/model-viewer.min.js`;

/**
 * Google's `<model-viewer>` web component - one element gives a phone both
 * WebXR AR (Android Chrome) and Scene Viewer, plus a Quick Look launcher on
 * iOS *if* a USDZ variant is also supplied via `ios-src`. This route only
 * has a GLB (see lib/share/ar.ts), so on iOS the AR button itself will not
 * appear - generating USDZ needs Apple's own USD toolchain, which is out of
 * scope here. WebXR/Scene Viewer AR on Android is unaffected.
 *
 * Loaded from cdnjs rather than as the `@google/model-viewer` npm package:
 * that package peer-depends on a `three` version well ahead of what this
 * repo's studio viewport already pins (@react-three/fiber, drei), so
 * installing it would force either a `three` bump that touches every
 * rendered scene or `--legacy-peer-deps` just to keep `npm ci` green. The
 * component is a self-contained custom element with no React integration
 * surface - this file only sets attributes on it - so the vendor's own
 * prebuilt bundle avoids that conflict entirely. `next/script` dedupes by
 * `src`, so mounting this more than once on a page still loads it once.
 */
export function ArViewer({ src, alt }: { src: string; alt: string }) {
  return (
    <>
      <Script src={MODEL_VIEWER_SRC} type="module" strategy="afterInteractive" />
      <model-viewer
        src={src}
        alt={alt}
        ar
        ar-modes="webxr scene-viewer quick-look"
        camera-controls
        auto-rotate
        shadow-intensity="1"
        exposure="1"
        style={{ width: '100%', height: '100%' }}
      />
    </>
  );
}

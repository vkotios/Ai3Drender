'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Wraps the real browser Fullscreen API around one DOM element - not just
 * full-viewport CSS (which every 3D-scene screen already uses via `h-screen`
 * / `fixed inset-0`), but actually hiding the browser chrome too, the way a
 * 3D viewport review on a projector or a second monitor wants. One instance
 * per viewport: the studio's main canvas, the client share view's canvas,
 * the version-compare overlay, and the AR viewer each get their own.
 *
 * `document.fullscreenElement` (not local state alone) is the source of
 * truth for `isFullscreen`, since fullscreen can also be exited by the
 * browser itself (Esc key, OS-level UI) without going through `toggle`.
 */
export function useFullscreen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement === ref.current) {
      void document.exitFullscreen();
    } else {
      void ref.current?.requestFullscreen();
    }
  }, []);

  const supported = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);

  return { ref, isFullscreen, toggle, supported };
}

'use client';

/**
 * Caps how many offscreen WebGL contexts the thumbnail capturer opens at
 * once.
 *
 * Browsers cap live WebGL contexts (commonly somewhere around a dozen); a
 * workbench with many never-thumbnailed pieces would otherwise try to mount
 * one <Canvas> per row simultaneously and start silently losing contexts.
 * Callers await a slot before mounting their canvas and release it once the
 * capture is done (or the component unmounts before it finishes).
 */
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];

export function acquireCaptureSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const attempt = () => {
      if (active >= MAX_CONCURRENT) {
        waiting.push(attempt);
        return;
      }
      active += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        const next = waiting.shift();
        if (next) next();
      });
    };
    attempt();
  });
}

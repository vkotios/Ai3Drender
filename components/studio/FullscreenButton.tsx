'use client';

import { Button } from '@/components/ui';

/** Paired with `useFullscreen` - renders nothing when the browser has no Fullscreen API. */
export function FullscreenButton({
  isFullscreen,
  onToggle,
  supported,
  size = 'sm',
}: {
  isFullscreen: boolean;
  onToggle: () => void;
  supported: boolean;
  size?: 'sm' | 'md';
}) {
  if (!supported) return null;
  return (
    <Button size={size} onClick={onToggle} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
      {isFullscreen ? 'Exit fullscreen' : 'Fullscreen ⤢'}
    </Button>
  );
}

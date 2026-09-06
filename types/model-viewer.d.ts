import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * `<model-viewer>` is Google's web component (see components/studio/ArViewer.tsx
 * for why it's loaded from cdnjs rather than as an npm dependency), not a
 * React component - there is no bundled JSX typing for it. This is just
 * enough to type-check the one place it is used; it does not attempt to
 * model the component's full attribute surface.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        alt?: string;
        ar?: boolean;
        'ar-modes'?: string;
        'camera-controls'?: boolean;
        'auto-rotate'?: boolean;
        'shadow-intensity'?: string;
        exposure?: string;
      };
    }
  }
}

export {};

'use client';

import { Component, Suspense, type ReactNode } from 'react';

/**
 * drei's <Environment preset> streams its HDRI from a CDN and suspends while
 * it does. Without a boundary a blocked or offline fetch leaves the whole
 * viewport stuck on a blank frame, which reads as a broken app rather than as
 * missing image-based lighting.
 *
 * This renders the children when the HDRI loads and a plain three-point rig
 * when it does not, so the scene is always visible.
 */
export class EnvironmentBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('Environment map unavailable; falling back to analytic lights.', error);
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
  }
}

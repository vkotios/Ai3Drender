import { describe, expect, it } from 'vitest';

import { viewportMeshPath } from '@/lib/db/store';

/**
 * The one function that decides which mesh key the studio viewport (and,
 * since it renders the same live scene, the in-browser path tracer) ask for -
 * `components/studio/StudioCanvas.tsx` and the pages that build `LoadedVersion`
 * (app/projects/.../scenes/[sceneId]/page.tsx, app/share/[token]/page.tsx) all
 * go through this rather than reading `meshPath`/`previewMeshPath` directly,
 * so this is the one place issue #47's "viewport prefers the preview, falls
 * back to the full mesh" contract needs to hold.
 */
describe('viewportMeshPath', () => {
  it('prefers the decimated preview mesh when reconstruct produced one', () => {
    expect(viewportMeshPath({ meshPath: 'p/meshes/v1.glb', previewMeshPath: 'p/meshes/v1-preview.glb' })).toBe(
      'p/meshes/v1-preview.glb',
    );
  });

  it('falls back to the full-detail mesh when there is no preview', () => {
    // Simplification hasn't run yet, failed, or would not have reduced the
    // mesh at all (see lib/ai/mesh/simplify.ts) - never a broken viewport.
    expect(viewportMeshPath({ meshPath: 'p/meshes/v1.glb', previewMeshPath: null })).toBe('p/meshes/v1.glb');
  });

  it('is null when reconstruction has not produced a mesh yet', () => {
    expect(viewportMeshPath({ meshPath: null, previewMeshPath: null })).toBeNull();
  });
});

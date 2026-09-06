import { randomUUID } from 'node:crypto';

/**
 * Split out of `index.ts` so stage modules that live in their own file (like
 * `render.ts`) can depend on this without importing `index.ts` itself and
 * creating a cycle. Re-exported from `index.ts` for existing callers.
 */
export const storageKeys = {
  source: (projectId: string, ext: string) => `${projectId}/sources/${randomUUID()}.${ext}`,
  view: (projectId: string, versionId: string, angle: string) =>
    `${projectId}/views/${versionId}/${angle}.png`,
  render: (projectId: string, sceneId: string, kind: string, ext: string) =>
    `${projectId}/renders/${sceneId}/${kind}-${randomUUID()}.${ext}`,
  mesh: (projectId: string, versionId: string) => `${projectId}/meshes/${versionId}.glb`,
  /** Decimated viewport copy of `mesh()` - see `lib/ai/mesh/simplify.ts`. */
  previewMesh: (projectId: string, versionId: string) => `${projectId}/meshes/${versionId}-preview.glb`,
  preview: (projectId: string, versionId: string) => `${projectId}/previews/${versionId}.png`,
  /** Reference underlay image for a traced floor-plan footprint (issue #52). */
  floorPlan: (projectId: string, ext: string) => `${projectId}/floorplans/${randomUUID()}.${ext}`,
};

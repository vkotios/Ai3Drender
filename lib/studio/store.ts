'use client';

import { create } from 'zustand';

import type { AssetVersion, Scene, SceneDoc, SceneNode, Uuid } from '@/lib/types';

export interface LoadedVersion {
  version: AssetVersion;
  meshUrl: string | null;
}

interface StudioState {
  scene: Scene | null;
  doc: SceneDoc | null;
  /** Every asset version referenced by the scene, with a fetchable mesh URL. */
  versions: Record<Uuid, LoadedVersion>;
  selectedId: string | null;
  /** Set on any edit, cleared on save. Drives the "unsaved changes" affordance. */
  dirty: boolean;
  /** Suppresses OrbitControls while a transform gizmo is being dragged. */
  transforming: boolean;

  load(scene: Scene, versions: LoadedVersion[]): void;
  select(id: string | null): void;
  setTransforming(value: boolean): void;
  setDoc(doc: SceneDoc): void;
  patchEnvironment(patch: Partial<SceneDoc['environment']>): void;
  patchCamera(patch: Partial<SceneDoc['camera']>): void;
  addNode(node: SceneNode): void;
  patchNode(id: string, patch: Partial<SceneNode>): void;
  removeNode(id: string): void;
  registerVersion(loaded: LoadedVersion): void;
  markSaved(scene?: Scene): void;
}

export const useStudio = create<StudioState>((set) => ({
  scene: null,
  doc: null,
  versions: {},
  selectedId: null,
  dirty: false,
  transforming: false,

  load: (scene, versions) =>
    set({
      scene,
      doc: scene.doc,
      versions: Object.fromEntries(versions.map((v) => [v.version.id, v])),
      selectedId: null,
      dirty: false,
    }),

  select: (selectedId) => set({ selectedId }),
  setTransforming: (transforming) => set({ transforming }),
  setDoc: (doc) => set({ doc, dirty: true }),

  patchEnvironment: (patch) =>
    set((state) =>
      state.doc
        ? { doc: { ...state.doc, environment: { ...state.doc.environment, ...patch } }, dirty: true }
        : state,
    ),

  patchCamera: (patch) =>
    set((state) =>
      state.doc
        ? { doc: { ...state.doc, camera: { ...state.doc.camera, ...patch } }, dirty: true }
        : state,
    ),

  addNode: (node) =>
    set((state) =>
      state.doc
        ? {
            doc: { ...state.doc, nodes: [...state.doc.nodes, node] },
            selectedId: node.id,
            dirty: true,
          }
        : state,
    ),

  patchNode: (id, patch) =>
    set((state) =>
      state.doc
        ? {
            doc: {
              ...state.doc,
              nodes: state.doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
            },
            dirty: true,
          }
        : state,
    ),

  removeNode: (id) =>
    set((state) =>
      state.doc
        ? {
            doc: { ...state.doc, nodes: state.doc.nodes.filter((n) => n.id !== id) },
            selectedId: state.selectedId === id ? null : state.selectedId,
            dirty: true,
          }
        : state,
    ),

  registerVersion: (loaded) =>
    set((state) => ({ versions: { ...state.versions, [loaded.version.id]: loaded } })),

  markSaved: (scene) =>
    set((state) => ({ dirty: false, scene: scene ?? state.scene })),
}));

/** Stable no-op selector helpers, so components subscribe to the least state. */
export const selectNodeById = (id: string | null) => (state: StudioState) =>
  id ? (state.doc?.nodes.find((n) => n.id === id) ?? null) : null;

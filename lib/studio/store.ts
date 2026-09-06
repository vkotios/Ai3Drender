'use client';

import { create } from 'zustand';

import type { Annotation, AssetVersion, Scene, SceneDoc, SceneNode, Uuid } from '@/lib/types';

export interface LoadedVersion {
  version: AssetVersion;
  meshUrl: string | null;
}

/**
 * What the viewport is for right now.
 *
 * 'layout' is the staging tool - click selects, gizmos move. 'comment' turns
 * a click into a pinned note instead, so reviewing never risks nudging an
 * approved layout.
 */
export type StudioMode = 'layout' | 'comment';

/** A click in comment mode, held until the note is written or discarded. */
export interface PendingPin {
  nodeId: string;
  assetId: Uuid;
  assetVersionId: Uuid;
  /** Asset-local space: metres, origin on the floor at the footprint centre. */
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  partName: string | null;
}

interface StudioState {
  scene: Scene | null;
  doc: SceneDoc | null;
  /** Every asset version referenced by the scene, with a fetchable mesh URL. */
  versions: Record<Uuid, LoadedVersion>;
  selectedId: string | null;
  mode: StudioMode;
  /** Notes on every piece staged in this scene. */
  annotations: Annotation[];
  pendingPin: PendingPin | null;
  selectedAnnotationId: string | null;
  /** Set on any edit, cleared on save. Drives the "unsaved changes" affordance. */
  dirty: boolean;
  /** Suppresses OrbitControls while a transform gizmo is being dragged. */
  transforming: boolean;

  load(scene: Scene, versions: LoadedVersion[], annotations?: Annotation[]): void;
  setMode(mode: StudioMode): void;
  setPendingPin(pin: PendingPin | null): void;
  selectAnnotation(id: string | null): void;
  setAnnotations(annotations: Annotation[]): void;
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
  mode: 'layout',
  annotations: [],
  pendingPin: null,
  selectedAnnotationId: null,
  dirty: false,
  transforming: false,

  load: (scene, versions, annotations = []) =>
    set({
      scene,
      doc: scene.doc,
      versions: Object.fromEntries(versions.map((v) => [v.version.id, v])),
      annotations,
      selectedId: null,
      selectedAnnotationId: null,
      pendingPin: null,
      dirty: false,
    }),

  // Leaving comment mode drops a half-written pin rather than letting it
  // reappear unexpectedly the next time the mode is entered.
  setMode: (mode) => set({ mode, pendingPin: null }),
  setPendingPin: (pendingPin) => set({ pendingPin }),
  selectAnnotation: (selectedAnnotationId) => set({ selectedAnnotationId }),
  setAnnotations: (annotations) => set({ annotations }),

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

  // A scene is passed on every successful save and restore, and its `doc` is
  // the server's own record of what got written - syncing local `doc` from it
  // (rather than trusting whatever was in flight) is what makes a restore's
  // content actually show up in the viewport.
  markSaved: (scene) =>
    set((state) => ({
      dirty: false,
      scene: scene ?? state.scene,
      doc: scene ? scene.doc : state.doc,
    })),
}));

/** Stable no-op selector helpers, so components subscribe to the least state. */
export const selectNodeById = (id: string | null) => (state: StudioState) =>
  id ? (state.doc?.nodes.find((n) => n.id === id) ?? null) : null;

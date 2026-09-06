import { randomUUID } from 'node:crypto';

import type { MaterialKind } from '@/lib/types';

/** Kept in one place so the API routes and any future UI validate identically. */
export const MATERIAL_KINDS: readonly MaterialKind[] = [
  'wood',
  'metal',
  'fabric',
  'leather',
  'glass',
  'stone',
  'plastic',
  'composite',
];

export const isMaterialKind = (value: unknown): value is MaterialKind =>
  typeof value === 'string' && (MATERIAL_KINDS as readonly string[]).includes(value);

export const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** 0..1 inclusive, matching MaterialSpec's roughness/metalness/sheen/clearcoat. */
export const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Library swatches are account-level, not project-level, so they cannot use
 * the project-prefixed key layout the rest of storage uses. Mirrors that
 * convention with the owner id standing in for a project id - see the storage
 * RLS policy in 0004_material_library.sql.
 */
export const librarySwatchKey = (ownerId: string, ext: string) =>
  `library/${ownerId}/${randomUUID()}.${ext}`;

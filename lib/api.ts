import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { getSession, requireProject, type Session } from '@/lib/db';
import { env } from '@/lib/env';
import type { Project } from '@/lib/types';

export const json = <T>(data: T, status = 200) => NextResponse.json(data, { status });

export const apiError = (message: string, status = 400) =>
  NextResponse.json({ error: message }, { status });

/**
 * Constant-time bearer check for `CRON_SECRET`, shared by every scheduled-
 * trigger route (`POST /api/jobs/tick`, `POST /api/notifications/reminders/tick`)
 * so a scheduler can call them without a signed-in session. Unset =>
 * always false, same as before this existed for either route.
 */
export function isAuthorizedCron(request: Request): boolean {
  if (!env.cronSecret) return false;
  const header = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env.cronSecret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Wrap a handler so it always runs with an authenticated session.
 *
 * In local mode `getSession` never returns null, so this collapses to a plain
 * call; in Supabase mode it is the single place unauthenticated requests are
 * turned away.
 */
export async function withSession<T>(
  handler: (session: Session) => Promise<NextResponse<T> | NextResponse>,
): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return apiError('Not signed in', 401);
  try {
    return await handler(session);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error('[api]', message);
    return apiError(message, 500);
  }
}

/** Same as `withSession`, but also resolves and authorises a project. */
export async function withProject(
  projectId: string,
  handler: (session: Session, project: Project) => Promise<NextResponse>,
): Promise<NextResponse> {
  return withSession(async (session) => {
    const project = await requireProject(session, projectId);
    if (!project) return apiError('Project not found', 404);
    return handler(session, project);
  });
}

/**
 * Resolve the project an asset belongs to and check the caller owns it.
 * Asset and scene routes are addressed by their own id, so ownership has to be
 * walked back to the project explicitly.
 */
export async function withAsset(
  assetId: string,
  handler: (session: Session, asset: NonNullable<Awaited<ReturnType<Session['store']['getAsset']>>>) => Promise<NextResponse>,
): Promise<NextResponse> {
  return withSession(async (session) => {
    const asset = await session.store.getAsset(assetId);
    if (!asset) return apiError('Asset not found', 404);
    if (!(await requireProject(session, asset.projectId))) return apiError('Asset not found', 404);
    return handler(session, asset);
  });
}

export async function withScene(
  sceneId: string,
  handler: (session: Session, scene: NonNullable<Awaited<ReturnType<Session['store']['getScene']>>>) => Promise<NextResponse>,
): Promise<NextResponse> {
  return withSession(async (session) => {
    const scene = await session.store.getScene(sceneId);
    if (!scene) return apiError('Scene not found', 404);
    if (!(await requireProject(session, scene.projectId))) return apiError('Scene not found', 404);
    return handler(session, scene);
  });
}

/**
 * Resolve a material library entry and check the caller owns it. The library
 * is account-scoped (ownerId), not project-scoped, so ownership is a direct
 * comparison rather than a walk back through a project.
 */
export async function withMaterialLibraryEntry(
  entryId: string,
  handler: (
    session: Session,
    entry: NonNullable<Awaited<ReturnType<Session['store']['getMaterialLibraryEntry']>>>,
  ) => Promise<NextResponse>,
): Promise<NextResponse> {
  return withSession(async (session) => {
    const entry = await session.store.getMaterialLibraryEntry(entryId);
    if (!entry || entry.ownerId !== session.viewer.id) return apiError('Material not found', 404);
    return handler(session, entry);
  });
}

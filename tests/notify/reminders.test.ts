import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { LOCAL_USER_EMAIL, LOCAL_USER_ID } from '@/lib/env';
import { createSceneDoc } from '@/lib/scene/defaults';
import type { Project, Scene } from '@/lib/types';

const mockSendEmail = vi.fn();

/**
 * Same reasoning as tests/notify/slack.test.ts's helper: `env.reminderThresholdDays`
 * and `hasEmail` are read once at module-import time, so exercising both the
 * configured and unset shapes means re-mocking and re-importing fresh.
 */
async function importSweep(opts: { hasEmail: boolean; reminderThresholdDays?: number }) {
  vi.resetModules();
  vi.doMock('@/lib/notify/email', () => ({ sendEmail: mockSendEmail, hasEmail: opts.hasEmail }));
  vi.doMock('@/lib/env', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/env')>();
    return {
      ...actual,
      hasEmail: opts.hasEmail,
      env: { ...actual.env, reminderThresholdDays: opts.reminderThresholdDays ?? 3 },
    };
  });
  return import('@/lib/notify/reminders');
}

let dir: string;
let dbFile: string;
let store: LocalStore;
let project: Project;
let scene: Scene;

/** Reach past `NewShareLink`'s public shape to backdate a link's timestamps for a test. */
async function patchShareLink(id: string, patch: Record<string, unknown>) {
  const raw = JSON.parse(await readFile(dbFile, 'utf8')) as { shareLinks: Record<string, unknown>[] };
  const link = raw.shareLinks.find((l) => l.id === id);
  if (!link) throw new Error(`share link ${id} not found in fixture db`);
  Object.assign(link, patch);
  await writeFile(dbFile, JSON.stringify(raw, null, 2), 'utf8');
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-reminders-'));
  dbFile = path.join(dir, 'db.json');
  store = new LocalStore(dir);
  project = await store.createProject({ ownerId: LOCAL_USER_ID, name: 'Acme Corp' });
  scene = await store.createScene({ projectId: project.id, name: 'Main stand', doc: createSceneDoc() });
  mockSendEmail.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.doUnmock('@/lib/notify/email');
  vi.doUnmock('@/lib/env');
  vi.resetModules();
});

describe('runReminderSweep', () => {
  it('emails the owner about a link created past the threshold that was never opened', async () => {
    const { runReminderSweep } = await importSweep({ hasEmail: true, reminderThresholdDays: 3 });
    const { link } = await store.createShareLink({
      sceneId: scene.id,
      createdBy: LOCAL_USER_ID,
      label: 'First pass',
    });
    await patchShareLink(link.id, { createdAt: daysAgo(5) });

    const result = await runReminderSweep(store);

    expect(result).toEqual({ checked: 1, sent: 1 });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [message] = mockSendEmail.mock.calls[0];
    expect(message.to).toBe(LOCAL_USER_EMAIL);
    expect(message.subject).toContain('First pass');
    expect(message.text).toContain('5 days');
    expect(message.text).toContain(scene.id);

    const updated = await store.getShareLink(link.id);
    expect(updated?.lastReminderSentAt).not.toBeNull();
  });

  it('skips a link that has been opened at least once, even if long unresolved', async () => {
    const { runReminderSweep } = await importSweep({ hasEmail: true });
    const { link } = await store.createShareLink({ sceneId: scene.id, createdBy: LOCAL_USER_ID });
    await patchShareLink(link.id, { createdAt: daysAgo(10), lastAccessedAt: daysAgo(1) });

    const result = await runReminderSweep(store);

    expect(result).toEqual({ checked: 1, sent: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('skips a link that has not yet reached the threshold', async () => {
    const { runReminderSweep } = await importSweep({ hasEmail: true, reminderThresholdDays: 3 });
    await store.createShareLink({ sceneId: scene.id, createdBy: LOCAL_USER_ID }); // createdAt: now

    const result = await runReminderSweep(store);

    expect(result).toEqual({ checked: 1, sent: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does not re-send before the threshold has passed again since the last reminder', async () => {
    const { runReminderSweep } = await importSweep({ hasEmail: true, reminderThresholdDays: 3 });
    const { link } = await store.createShareLink({ sceneId: scene.id, createdBy: LOCAL_USER_ID });
    await patchShareLink(link.id, { createdAt: daysAgo(30), lastReminderSentAt: daysAgo(1) });

    const result = await runReminderSweep(store);

    expect(result).toEqual({ checked: 1, sent: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('excludes revoked and expired links from the sweep entirely', async () => {
    const { runReminderSweep } = await importSweep({ hasEmail: true });

    const { link: revoked } = await store.createShareLink({ sceneId: scene.id, createdBy: LOCAL_USER_ID });
    await store.revokeShareLink(revoked.id);
    await patchShareLink(revoked.id, { createdAt: daysAgo(10) });

    const { link: expired } = await store.createShareLink({
      sceneId: scene.id,
      createdBy: LOCAL_USER_ID,
      expiresAt: daysAgo(1),
    });
    await patchShareLink(expired.id, { createdAt: daysAgo(10) });

    const result = await runReminderSweep(store);

    expect(result).toEqual({ checked: 0, sent: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('is a no-op with RESEND_API_KEY unset, skipping the store entirely', async () => {
    const { runReminderSweep } = await importSweep({ hasEmail: false });
    await store.createShareLink({ sceneId: scene.id, createdBy: LOCAL_USER_ID });
    await patchShareLink((await store.listShareLinks(scene.id))[0].id, { createdAt: daysAgo(30) });

    const listSpy = vi.spyOn(store, 'listActiveShareLinks');
    const result = await runReminderSweep(store);

    expect(result).toEqual({ checked: 0, sent: 0 });
    expect(listSpy).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

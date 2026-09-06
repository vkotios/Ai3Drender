import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { LOCAL_USER_EMAIL, LOCAL_USER_ID } from '@/lib/env';
import { createSceneDoc } from '@/lib/scene/defaults';
import type { Project, Scene } from '@/lib/types';

const mockPostSlackMessage = vi.fn();
const mockSendEmail = vi.fn();

vi.mock('@/lib/notify/slack', () => ({ postSlackMessage: mockPostSlackMessage, hasSlack: true }));
vi.mock('@/lib/notify/email', () => ({ sendEmail: mockSendEmail, hasEmail: true }));
// Everything except hasSlack/hasEmail comes from the real module - in
// particular env.appUrl and hasSupabase (unset by tests/setup.ts), so
// resolveOwnerEmail (unmocked) takes its real local-mode branch.
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, hasSlack: true, hasEmail: true };
});

// Imported after the mocks above so it picks them up.
const { notifyReviewActivity } = await import('@/lib/notify/review-activity');

describe('notifyReviewActivity', () => {
  let dir: string;
  let store: LocalStore;
  let project: Project;
  let scene: Scene;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-notify-'));
    store = new LocalStore(dir);
    // The fixed local-mode owner id, so resolveOwnerEmail resolves it to
    // LOCAL_USER_EMAIL without needing a real Supabase admin client.
    project = await store.createProject({ ownerId: LOCAL_USER_ID, name: 'Acme Corp' });
    scene = await store.createScene({ projectId: project.id, name: 'Main stand', doc: createSceneDoc() });

    mockPostSlackMessage.mockReset().mockResolvedValue(undefined);
    mockSendEmail.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('posts to Slack and emails the owner when a client leaves a note', async () => {
    await notifyReviewActivity(
      scene,
      { kind: 'annotation', clientName: 'Jane', body: 'Slim the legs down.' },
      store,
    );

    expect(mockPostSlackMessage).toHaveBeenCalledTimes(1);
    const [slackText] = mockPostSlackMessage.mock.calls[0];
    expect(slackText).toContain('Jane left a note');
    expect(slackText).toContain('Acme Corp / Main stand');
    expect(slackText).toContain('Slim the legs down.');
    expect(slackText).toContain(scene.id);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [emailArg] = mockSendEmail.mock.calls[0];
    expect(emailArg.to).toBe(LOCAL_USER_EMAIL);
    expect(emailArg.subject).toContain('Jane left a note');
    expect(emailArg.text).toContain('Slim the legs down.');
    expect(emailArg.html).toContain('Slim the legs down.');
  });

  it('describes an approval verdict, including the note when one was given', async () => {
    await notifyReviewActivity(
      scene,
      { kind: 'review', clientName: 'Jane', status: 'changes_requested', note: 'Too dark.' },
      store,
    );

    const [slackText] = mockPostSlackMessage.mock.calls[0];
    expect(slackText).toContain('Jane requested changes');
    expect(slackText).toContain('Too dark.');
  });

  it('omits the quoted detail block when there is no note', async () => {
    await notifyReviewActivity(
      scene,
      { kind: 'review', clientName: 'Jane', status: 'approved', note: null },
      store,
    );

    const [slackText] = mockPostSlackMessage.mock.calls[0];
    expect(slackText).toContain('Jane approved');
    expect(slackText).not.toContain('>'); // no blockquote line was added
  });

  it('never throws when the owning project cannot be found', async () => {
    const orphan: Scene = { ...scene, projectId: 'does-not-exist' };
    await expect(
      notifyReviewActivity(orphan, { kind: 'annotation', clientName: 'Jane', body: 'hi' }, store),
    ).resolves.toBeUndefined();
    // Slack has no per-project dependency, so it still goes out...
    expect(mockPostSlackMessage).toHaveBeenCalledTimes(1);
    // ...but there is no owner to email without a project to resolve one from.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('is a no-op when a store call throws', async () => {
    const throwingStore = {
      ...store,
      getProject: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as LocalStore;

    await expect(
      notifyReviewActivity(scene, { kind: 'annotation', clientName: 'Jane', body: 'hi' }, throwingStore),
    ).resolves.toBeUndefined();
  });
});

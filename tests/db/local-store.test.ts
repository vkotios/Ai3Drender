import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { defineStoreConformance } from './conformance';

describe('LocalStore conformance', () => {
  let dir: string;
  let store: LocalStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-store-'));
    store = new LocalStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  defineStoreConformance(() => store);
});

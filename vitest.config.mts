import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs against real Node (LocalStore writes real temp files, the pipeline
 * runs for real against the offline/stub providers) - nothing here is mocked
 * at the framework level, only at explicit test boundaries (e.g. a fake
 * Supabase client for the immutability trigger test).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: {
      // Mirrors tsconfig's "@/*": ["./*"].
      '@': rootDir,
    },
  },
});

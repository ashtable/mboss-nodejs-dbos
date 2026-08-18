import { defineConfig } from 'vitest/config';

import { aliases } from './vitest.aliases.js';

/**
 * The local-only suite. It needs a real Postgres because what it proves — that DBOS keeps to its
 * own schema, that a queue cannot be registered before launch, that a repeated workflow id runs
 * once — is not a claim a doubled SDK can make. Never run in CI.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration.test.ts'],
    // DBOS is a process-wide singleton — one file
    // at a time, no parallel launches.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: { alias: aliases },
});

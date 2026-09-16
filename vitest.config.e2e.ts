import { defineConfig } from 'vitest/config';

const concurrency = Number(process.env.LENS_TEST_CONCURRENCY ?? 1);

export default defineConfig({
  test: {
    name: 'e2e',
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // Browser sessions are heavyweight and share one artifact directory; running
    // files in sequence keeps failures attributable and the machine responsive.
    fileParallelism: concurrency > 1,
    maxWorkers: concurrency,
    minWorkers: 1,
    pool: 'forks',
  },
});

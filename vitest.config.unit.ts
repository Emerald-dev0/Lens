import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'threads',
    reporters: process.env.CI ? ['default'] : ['default'],
  },
});

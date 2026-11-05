import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/api/**/*.test.mjs', 'tests/unit/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 30_000,
    maxWorkers: 2,
  },
});

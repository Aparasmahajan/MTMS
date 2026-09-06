import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Node environment only — nothing under test touches the DOM. The rules live in
 * `lib/shared` (pure) and `lib/server` (store-backed), and both are exercised
 * directly rather than through HTTP, so the tests stay fast and the route
 * handlers keep their one job of translating errors into statuses.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Route-integration tests bind an ephemeral localhost port; unit tests
    // do not touch the network at all.
    testTimeout: 30_000,
    pool: 'forks',
  },
});

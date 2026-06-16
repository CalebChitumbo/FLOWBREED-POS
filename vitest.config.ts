import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    environment: 'node',
    globals: true,
    // Native modules (better-sqlite3, argon2) are loaded in the Node ABI here.
    // Forks pool avoids worker-thread issues with native addons.
    pool: 'forks',
    include: ['tests/unit/**/*.test.ts'],
  },
});

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The shipped better-sqlite3 is pinned to 9.6.0 — the last release with
 * prebuilt binaries for Electron 22, which is the last Electron that runs on
 * the business's Windows 7 till. Its installer only succeeds on Node 18–20, so
 * it lives in optionalDependencies: on newer dev Nodes npm skips it and tests
 * transparently use the dev-only `better-sqlite3-modern` copy instead (same
 * API, newer ABI). The packaged app always ships 9.6.0.
 */
function sqliteAlias(): Record<string, string> {
  return existsSync(resolve(__dirname, 'node_modules/better-sqlite3/package.json'))
    ? {}
    : { 'better-sqlite3': resolve(__dirname, 'node_modules/better-sqlite3-modern') };
}

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      ...sqliteAlias(),
    },
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

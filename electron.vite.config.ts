import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const shared = resolve(__dirname, 'src/shared');

// Electron 22 is pinned deliberately: it is the last Electron that runs on the
// business's Windows 7 till (Chromium 108 renderer, Node 16.17 in main). The
// explicit build targets below make esbuild transpile anything newer.
const MAIN_TARGET = 'node16.17';
const RENDERER_TARGET = 'chrome108';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared },
    },
    build: {
      target: MAIN_TARGET,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // better-sqlite3 sits in optionalDependencies (see vitest.config.ts),
        // which externalizeDepsPlugin does not scan — keep it external here.
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared },
    },
    build: {
      target: MAIN_TARGET,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react()],
    build: {
      target: RENDERER_TARGET,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  plugins: [swc.vite()],
  test: {
    fileParallelism: false,
    include: ['test/manual/*.manual.ts', 'test/installer-posix-toolchain.test.ts'],
    setupFiles: ['./test/support/installation/manual-diagnostic-side-effect-sentinel.mjs'],
    testTimeout: 20 * 60_000,
    hookTimeout: 60_000,
  },
});

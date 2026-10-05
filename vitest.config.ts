import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  plugins: [swc.vite()],
  test: {
    globalSetup: ['./test/support/global-socket-cleanup.ts'],
    fileParallelism: false,
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    include: ['test/**/*.test.{mjs,ts}'],
  },
});

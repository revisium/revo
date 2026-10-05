import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  plugins: [swc.vite()],
  test: {
    globalSetup: ['./test/support/global-socket-root.ts'],
    fileParallelism: false,
    // Real processes and PostgreSQL run noticeably slower on the macos-15-intel release runner.
    testTimeout: 20_000,
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    include: ['test/**/*.test.{mjs,ts}'],
  },
});

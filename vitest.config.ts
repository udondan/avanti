import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    exclude: [...configDefaults.exclude, 'dist/**'],
    // Default (5000ms) is too tight on windows-2022 GitHub Actions runners,
    // which are measurably slower/more variable than ubuntu-latest for
    // process-spawning tests (e.g. applyWriteHook/applyPost via spawnSync).
    testTimeout: 20_000,
    globalSetup: ['test/setup/child-coverage-global.ts'],
    setupFiles: ['test/setup/child-coverage.ts'],
    coverage: {
      provider: 'v8',
      // Count every source file, also the ones no test imports.
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
    },
  },
});

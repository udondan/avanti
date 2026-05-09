import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
});

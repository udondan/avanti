import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    exclude: ['dist/**', 'node_modules/**'],
  },
});

// @ts-check
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
);

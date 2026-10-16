import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '.data', 'server/drizzle', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  /**
   * Three type-aware rules, and only three.
   *
   * The rest of this config needs no type information, which keeps it fast. These three cannot be
   * decided without it, and they are the ones whose absence is expensive: a promise nobody awaits
   * loses its rejection silently, so a write that failed reads exactly like a write that worked --
   * in a product whose whole claim is that it can tell you what happened to your records, that is
   * the worst available failure mode.
   *
   * Enabled at zero cost: the server had no violation of any of them when this was turned on. What
   * it buys is that the first one cannot arrive unnoticed.
   */
  {
    files: ['server/src/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.server.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'e2e/**/*.{ts,mjs}', 'server/src/db/migrate-cli.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' },
  },
);

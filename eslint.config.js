import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  fetch: 'readonly',
  confirm: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  URL: 'readonly',
  Blob: 'readonly',
  Node: 'readonly',
};

export default tseslint.config(
  { ignores: ['node_modules/', 'apps/extension/dist/', 'data/', 'output/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/admin-web/**/*.js'],
    languageOptions: { globals: browserGlobals },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
);

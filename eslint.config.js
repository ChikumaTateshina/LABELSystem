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
  TextEncoder: 'readonly',
  Event: 'readonly',
  ResizeObserver: 'readonly',
  TextDecoder: 'readonly',
  Uint8Array: 'readonly',
  FileReader: 'readonly',
  Image: 'readonly',
  DOMParser: 'readonly',
  XMLSerializer: 'readonly',
  btoa: 'readonly',
};

export default tseslint.config(
  { ignores: ['node_modules/', 'extension/dist/', 'dist/', 'data/', 'output/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/ui/**/*.js'],
    languageOptions: { globals: browserGlobals },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly', Buffer: 'readonly' } },
  },
);

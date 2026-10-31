import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/output/**',
      'artifacts/**',
      '.data/**',
      '.pnpm-store/**',
      'docs/.vitepress/cache/**',
      'docs/.vitepress/dist/**',
      'docs/.vitepress/.temp/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
  },
  {
    files: [
      '*.{js,mjs,cjs,ts}',
      'scripts/**/*.{js,mjs,cjs,ts}',
      'apps/*/*.config.ts',
      'apps/server/**/*.ts',
      'packages/**/*.ts',
      'tests/**/*.{ts,tsx}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx,js}'],
    ignores: ['apps/web/src/audio/core/pcm-worklet.js'],
    languageOptions: { globals: globals.browser },
    // Register only the rules; the plugin's nested presets use legacy config types.
    plugins: {
      'react-hooks': { meta: reactHooks.meta, rules: reactHooks.rules },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['apps/web/src/audio/core/pcm-worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },
);

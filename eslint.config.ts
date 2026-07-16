/**
 * @pwngh/economy-ops
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import eslint from '@eslint/js';
import n from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

const BANNED_GLOBALS = [
  {
    name: 'Buffer',
    message: 'Use Uint8Array; Buffer is Node-only.',
  },
  {
    name: 'process',
    message: 'The supervisor takes typed deps; it never reads process.',
  },
  {
    name: 'setInterval',
    message:
      'The supervisor schedules nothing; the host-injected Scheduler drives it.',
  },
  {
    name: 'setTimeout',
    message:
      'The supervisor schedules nothing; the host-injected Scheduler drives it.',
  },
  {
    name: 'Date',
    message: 'Time comes from the injected Clock, never from the wall.',
  },
  {
    name: 'EventEmitter',
    message: 'The supervisor returns audit records; it does not emit events.',
  },
];

const NON_SHIPPED_IMPORTS = [
  {
    regex: '^#test/',
    message:
      'Production code (src/) must not import test code (#test/*); it is dev-only.',
  },
];

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  n.configs['flat/recommended-module'],

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-extraneous-import': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-lines-per-function': [
        'error',
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      'max-params': ['error', 4],
      'max-nested-callbacks': ['error', 3],
    },
  },

  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...BANNED_GLOBALS],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'The supervisor core is runtime-agnostic; hosts own all I/O — node:* never ships in src/.',
            },
            ...NON_SHIPPED_IMPORTS,
          ],
        },
      ],
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-nested-callbacks': 'off',
    },
  },
);

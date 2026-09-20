'use strict';

const { defineConfig, globalIgnores } = require('eslint/config');
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

const nodeGlobals = {
  ...globals.node,
  fetch: 'readonly'
};

module.exports = defineConfig([
  globalIgnores(['node_modules/', 'public/', 'test/', 'tests/', 'render.yaml', '.env']),
  {
    ...js.configs.recommended,
    files: ['**/*.js']
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs'
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      'prefer-template': 'warn',
      'no-unneeded-ternary': 'warn',
      quotes: ['warn', 'single', { avoidEscape: true }],
      semi: ['warn', 'always']
    }
  },
  {
    files: ['server.js'],
    languageOptions: { globals: nodeGlobals }
  },
  prettier
]);

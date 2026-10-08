import neostandard from 'neostandard'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import prettier from 'eslint-config-prettier'

export default [
  {
    ignores: [
      'node_modules/**',
      '.venv/**',
      'dist/**',
      'dist-electron/**',
      'release/**',
      'resources/**',
      '.test-artifacts/**',
      '.playwright-cli/**',
      'data/**',
      'output/**',
    ],
  },
  ...neostandard({ ts: true, noStyle: true }),
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tsParser, extraFileExtensions: ['.vue'] },
    },
  },
  {
    files: ['**/*.{ts,vue}'],
    rules: {
      curly: ['error', 'all'],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'vue/multi-word-component-names': 'off',
      'no-void': 'off',
      'no-undef': 'off',
      'no-control-regex': 'off',
      'promise/param-names': 'off',
    },
  },
  {
    files: ['scripts/**/*.{mjs,cjs}'],
    rules: { 'promise/param-names': 'off' },
    languageOptions: {
      globals: { innerWidth: 'readonly', innerHeight: 'readonly', getComputedStyle: 'readonly' },
    },
  },
  prettier,
  { files: ['**/*.{ts,vue,mjs,cjs}'], rules: { curly: ['error', 'all'] } },
]

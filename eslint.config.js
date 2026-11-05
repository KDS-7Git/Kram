import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/**', 'secrets/**', 'backups/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.serviceworker } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }], '@typescript-eslint/no-explicit-any': 'error' } },
  { files: ['packages/engine-*/src/**/*.ts'], ignores: ['**/*.test.ts'], rules: {
    'no-restricted-syntax': ['error', { selector: "NewExpression[callee.name='Date']", message: 'Use the time package and Luxon; engines never read the clock.' }, { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Pass an injected Clock or an explicit instant.' }],
    'no-restricted-imports': ['error', { patterns: ['@prisma/*', 'express', 'node:fs', 'node:http', 'node:crypto'] }]
  } }
);

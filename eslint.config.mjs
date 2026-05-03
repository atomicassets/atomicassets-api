// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
    {
        ignores: [
            '**/node_modules/**',
            '**/build/**',
            '**/dist/**',
            '**/coverage/**',
            '**/.nyc_output/**',
            '**/*.d.ts',
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintConfigPrettier,
    {
        files: ['**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2022,
            },
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'off',
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-inferrable-types': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrors: 'none',
                },
            ],
            '@typescript-eslint/no-duplicate-enum-values': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unsafe-function-type': 'off',
            quotes: ['error', 'single', { avoidEscape: true }],
            semi: ['error', 'always'],
            'no-async-promise-executor': 'off',
            'no-debugger': 'error',
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        files: ['**/*.test.ts', 'test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unused-expressions': 'off',
        },
    },
);

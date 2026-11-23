import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Files share database fixtures and advisory-lock tests. Keep files and
        // tests serial, with a fresh module environment for each file.
        pool: 'forks',
        isolate: true,
        fileParallelism: false,
        maxWorkers: 1,
        maxConcurrency: 1,
        sequence: { concurrent: false, hooks: 'list' },
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/**/test.ts', 'src/**/test-helper.ts', 'src/**/effective-mint-suite.ts', 'src/utils/test-config.ts', 'src/types/**'],
            reporter: ['text', 'html', 'lcov', 'json'],
        },
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    environment: 'node',
                    setupFiles: ['./test/setup.ts'],
                    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
                    exclude: ['src/**/*.integration.test.ts'],
                    testTimeout: 5_000,
                    hookTimeout: 5_000,
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    environment: 'node',
                    setupFiles: ['./test/setup.ts'],
                    include: ['src/**/*.integration.test.ts'],
                    testTimeout: 30_000,
                    hookTimeout: 30_000,
                },
            },
        ],
    },
});

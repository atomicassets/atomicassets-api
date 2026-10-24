import * as path from 'path';

process.env.DO_NOT_TRACK = '1';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

// config-path.ts resolves CONFIG_DIR once, at module load time, so it has to
// be set before Vitest imports any spec file - this setup file runs
// first. Pinned unconditionally, not merely defaulted: points at a fixture
// readers.config.json (zero contracts) so upgrade-db.ts's runMigrations(),
// which requires readers.config.json off this directory, resolves the
// fixture in tests rather than an operator's real config. README.md tells
// developers running the filler/server directly to `export CONFIG_DIR`
// in their shell - the test harness must not honor that export, or the
// runMigrations unit tests load the operator's real readers.config.json
// and fail on any machine with it set, while passing in CI.
process.env.CONFIG_DIR = path.join(__dirname, 'fixtures', 'config');

// ConnectionManager also accepts runtime environment overrides. Do not let an
// operator's exported production endpoints bypass the test-only connection config.
for (const key of Object.keys(process.env)) {
    if (/^(POSTGRES|REDIS|CHAIN)_/.test(key) && !/^(POSTGRES|REDIS)_TEST_/.test(key)) {
        delete process.env[key];
    }
}

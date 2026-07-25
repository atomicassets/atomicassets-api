import * as path from 'path';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);

process.env.DO_NOT_TRACK = '1';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

// config-path.ts resolves CONFIG_DIR once, at module load time, so it has to
// be set before mocha requires any spec file - this --require hook runs
// first. Pinned unconditionally, not merely defaulted: points at a fixture
// readers.config.json (zero contracts) so upgrade-db.ts's runMigrations(),
// which requires readers.config.json off this directory, resolves the
// fixture in tests rather than an operator's real config. README.md tells
// developers running the filler/server directly to `export CONFIG_DIR`
// in their shell - the test harness must not honor that export, or the
// runMigrations unit tests load the operator's real readers.config.json
// and fail on any machine with it set, while passing in CI.
process.env.CONFIG_DIR = path.join(__dirname, 'fixtures', 'config');

export default chai;

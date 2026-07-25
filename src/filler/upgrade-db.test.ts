import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';

import { resolveMigrationStatementTimeoutMs, runMigrations } from './upgrade-db';
import { compareVersionString } from '../utils';
import PostgresConnection from '../connections/postgres';

const ENV_KEY = 'MIGRATION_STATEMENT_TIMEOUT_MS';

describe('resolveMigrationStatementTimeoutMs', () => {
    afterEach(() => {
        delete process.env[ENV_KEY];
    });

    it('defaults to 0 (unbounded) when unset, so no migration statement is cancelled by a cap the operator did not choose', () => {
        expect(resolveMigrationStatementTimeoutMs()).to.equal(0);
    });

    it('resolves a configured positive integer, so an operator can impose a ceiling', () => {
        process.env[ENV_KEY] = '5000';
        expect(resolveMigrationStatementTimeoutMs()).to.equal(5000);
    });

    it('resolves an explicit "0" the same as unset', () => {
        process.env[ENV_KEY] = '0';
        expect(resolveMigrationStatementTimeoutMs()).to.equal(0);
    });

    it('resolves an empty string the same as unset, since a blank almost always means an unrendered template, not an operator-chosen ceiling', () => {
        process.env[ENV_KEY] = '';
        expect(resolveMigrationStatementTimeoutMs()).to.equal(0);
    });

    it('resolves a whitespace-only value the same as unset', () => {
        process.env[ENV_KEY] = '   ';
        expect(resolveMigrationStatementTimeoutMs()).to.equal(0);
    });

    for (const bad of ['abc', '-1', '-500', '12.5', 'NaN', 'Infinity', '0x10', '1e3']) {
        it(`throws rather than silently falling back for "${bad}"`, () => {
            process.env[ENV_KEY] = bad;
            expect(() => resolveMigrationStatementTimeoutMs()).to.throw();
        });
    }

    it('throws for a value above Postgres\'s accepted range, so an hours-for-milliseconds slip fails here rather than reaching Postgres', () => {
        process.env[ENV_KEY] = '3600000000';
        expect(() => resolveMigrationStatementTimeoutMs()).to.throw();
    });
});

/**
 * Everything below drives runMigrations() against a stubbed PostgresConnection.
 * runMigrations() reaches the real filesystem (definitions/migrations, the
 * readers.config.json it requires via configFile()) and real contract
 * handlers. test/setup.ts points CONFIG_DIR at test/fixtures/config, whose
 * readers.config.json declares zero contracts: that keeps every
 * handler.setup()/handler.upgrade() call unreached (the "init contracts" and
 * per-version handler loops both iterate availableContracts, which is empty),
 * so nothing here needs a live database. Driving an actual migration is out
 * of scope for this lane - see upgrade-db-statement-timeout.integration.test.ts
 * for the propositions that need a real Postgres connection.
 */
describe('runMigrations - wiring and lifecycle', () => {
    let availableVersions: string[];

    before(() => {
        availableVersions = fs.readdirSync('./definitions/migrations').sort(compareVersionString);
    });

    function latestVersion(): string {
        return availableVersions[availableVersions.length - 1];
    }

    function versionBefore(version: string): string {
        const idx = availableVersions.indexOf(version);
        return availableVersions[idx - 1];
    }

    /**
     * A stub PoolClient that records every query it receives (in `events`,
     * shared with the harness below so ordering across query/release/pool.end
     * can be asserted). `dbinfoVersion` seeds the "SELECT ... FROM dbinfo"
     * lookup runMigrations makes to find where to resume from; any query that
     * isn't one of the fixed control statements is treated as migration SQL
     * content (real file contents, since availableContracts=[] means the only
     * such query in the version loop is the database.sql read) and rejects
     * when `failOnMigrationSql` is set, to exercise the rollback path.
     */
    function makeStubClient(opts: { dbinfoVersion: string; failOnMigrationSql?: boolean }): {
        client: { query: sinon.SinonStub; release: sinon.SinonStub };
        events: string[];
    } {
        const events: string[] = [];

        const isControl = (text: string): boolean =>
            text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' ||
            text === 'SET search_path TO public' ||
            text.startsWith('SET statement_timeout') ||
            text.startsWith('SET lock_timeout') ||
            text.startsWith('SELECT "value" FROM dbinfo');

        const query = sinon.stub().callsFake(async (text: string) => {
            events.push(`query:${text}`);

            if (text.startsWith('SELECT "value" FROM dbinfo')) {
                return { rows: [{ value: opts.dbinfoVersion }] };
            }

            if (!isControl(text) && opts.failOnMigrationSql) {
                throw new Error('simulated migration failure');
            }

            return { rows: [] };
        });

        const release = sinon.stub().callsFake(() => {
            events.push('client.release');
        });

        return { client: { query, release }, events };
    }

    function makeMigrationPoolStub(client: { query: sinon.SinonStub; release: sinon.SinonStub }, events: string[]): {
        connect: sinon.SinonStub;
        on: sinon.SinonStub;
        end: sinon.SinonStub;
    } {
        return {
            connect: sinon.stub().resolves(client),
            on: sinon.stub(),
            end: sinon.stub().callsFake(async () => {
                events.push('pool.end');
            }),
        };
    }

    function makeDeferredPoolStub(): { on: sinon.SinonStub; query: sinon.SinonStub; end: sinon.SinonStub } {
        return {
            on: sinon.stub(),
            query: sinon.stub().resolves({ rows: [] }),
            end: sinon.stub().resolves(),
        };
    }

    function makeDatabaseStub(migrationPool: { connect: sinon.SinonStub; end: sinon.SinonStub }): {
        database: PostgresConnection;
        createPool: sinon.SinonStub;
        begin: sinon.SinonStub;
        deferredPools: ReturnType<typeof makeDeferredPoolStub>[];
    } {
        const deferredPools: ReturnType<typeof makeDeferredPoolStub>[] = [];
        let callCount = 0;

        const createPool = sinon.stub().callsFake(() => {
            callCount += 1;
            if (callCount === 1) {
                return migrationPool;
            }
            const deferredPool = makeDeferredPoolStub();
            deferredPools.push(deferredPool);
            return deferredPool;
        });

        const begin = sinon.stub().rejects(new Error('database.begin() must not be called by runMigrations'));

        return {
            database: { createPool, begin } as unknown as PostgresConnection,
            createPool,
            begin,
            deferredPools,
        };
    }

    it('builds its client from a dedicated pool, not the shared runtime pool (database.begin())', async () => {
        const { client, events } = makeStubClient({ dbinfoVersion: latestVersion() });
        const migrationPool = makeMigrationPoolStub(client, events);
        const { database, createPool, begin } = makeDatabaseStub(migrationPool);

        await runMigrations(database);

        expect(begin.called).to.equal(false);
        expect(migrationPool.connect.calledOnce).to.equal(true);
        expect(createPool.firstCall.args[0]).to.deep.equal({ max: 1 });
    });

    it('configures the connection before the first migration statement runs, so no version executes under the role defaults', async () => {
        const { client, events } = makeStubClient({ dbinfoVersion: latestVersion() });
        const migrationPool = makeMigrationPoolStub(client, events);
        const { database } = makeDatabaseStub(migrationPool);

        await runMigrations(database);

        // These three connection-setup statements must be the first three
        // queries on the client - i.e. they precede BEGIN and the version
        // lookup, which is everything else the run issues.
        const queryEvents = events.filter(e => e.startsWith('query:'));
        expect(queryEvents[0]).to.equal('query:SET search_path TO public');
        expect(queryEvents[1]).to.equal('query:SET statement_timeout = 0');
        expect(queryEvents[2]).to.equal('query:SET lock_timeout = \'60s\'');
    });

    it('honors MIGRATION_STATEMENT_TIMEOUT_MS when configuring the connection', async () => {
        process.env[ENV_KEY] = '15000';
        try {
            const { client, events } = makeStubClient({ dbinfoVersion: latestVersion() });
            const migrationPool = makeMigrationPoolStub(client, events);
            const { database } = makeDatabaseStub(migrationPool);

            await runMigrations(database);

            expect(events).to.include('query:SET statement_timeout = 15000');
        } finally {
            delete process.env[ENV_KEY];
        }
    });

    it('a migration that throws rolls back its open transaction, releases the client, and ends the migration pool, in that order', async () => {
        const target = latestVersion();
        const priorVersion = versionBefore(target);

        const { client, events } = makeStubClient({ dbinfoVersion: priorVersion, failOnMigrationSql: true });
        const migrationPool = makeMigrationPoolStub(client, events);
        const { database } = makeDatabaseStub(migrationPool);

        let thrown: Error | undefined;
        try {
            await runMigrations(database);
        } catch (err) {
            thrown = err as Error;
        }

        expect(thrown).to.not.equal(undefined);
        expect(thrown!.message).to.equal('simulated migration failure');

        const rollbackIndex = events.indexOf('query:ROLLBACK');
        const releaseIndex = events.indexOf('client.release');
        const poolEndIndex = events.indexOf('pool.end');

        expect(rollbackIndex).to.be.greaterThan(-1);
        expect(releaseIndex).to.be.greaterThan(rollbackIndex);
        expect(poolEndIndex).to.be.greaterThan(releaseIndex);
    });

    it('a successful run ends the migration pool exactly once', async () => {
        const { client, events } = makeStubClient({ dbinfoVersion: latestVersion() });
        const migrationPool = makeMigrationPoolStub(client, events);
        const { database } = makeDatabaseStub(migrationPool);

        await runMigrations(database);

        expect(migrationPool.end.calledOnce).to.equal(true);
        expect(events.filter(e => e === 'pool.end')).to.have.length(1);
        expect(events).to.not.include('query:ROLLBACK');
    });
});

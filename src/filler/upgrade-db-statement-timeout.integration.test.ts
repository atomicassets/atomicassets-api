import 'mocha';
import { expect } from 'chai';
import { Pool, PoolClient } from 'pg';

import { resolveMigrationStatementTimeoutMs, configureMigrationConnection, applyDeferredPoolStatementTimeout } from './upgrade-db';
import { getTestPostgresConfig } from '../utils/test';

// Effectiveness coverage for the migration-connection statement_timeout fix
// (ECA: migrations must not run under the runtime statement timeout). These
// tests run against a real Postgres (not a mocked pg client) because what's
// being verified - session-level SET surviving past the point a pool-level
// truthiness gate would have dropped it, and a role-level default being
// overridden rather than inherited - is a real driver/server interaction a
// mock cannot exercise. Pattern follows
// atomicmarket/template-prices-statement-timeout.integration.test.ts.
describe('migration connection statement_timeout - effectiveness against a real Postgres', () => {
    const TEST_ROLE = 'eca_migration_timeout_test_role';
    const TEST_ROLE_PASSWORD = 'eca_migration_timeout_test_role_password';
    // The role's own default (5s) is deliberately different from both the
    // resolved migration timeout (0, unbounded) and the runtime pool's 30s
    // cap, so a test that observes 5s proves the role default leaked through
    // instead of being overridden.
    const ROLE_STATEMENT_TIMEOUT_MS = 5_000;

    let adminPool: Pool;

    before(async () => {
        adminPool = new Pool({ ...getTestPostgresConfig(), max: 1 });

        // A role that carries its own statement_timeout is what actually
        // exercises the trap this effort fixes: pg/lib/client.js only
        // forwards a pool-level statement_timeout option when it's truthy,
        // so a naive fix that resolved to zero and passed it as a pool
        // option would silently leave a role default like this one in
        // place instead of disabling the cap.
        await adminPool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
        await adminPool.query(`CREATE ROLE ${TEST_ROLE} LOGIN PASSWORD '${TEST_ROLE_PASSWORD}'`);
        await adminPool.query(`ALTER ROLE ${TEST_ROLE} SET statement_timeout = ${ROLE_STATEMENT_TIMEOUT_MS}`);
        await adminPool.query(`GRANT CONNECT ON DATABASE "${getTestPostgresConfig().database}" TO ${TEST_ROLE}`);
    });

    after(async () => {
        // GRANT CONNECT registers a dependency (pg_shdepend) on the role, so
        // DROP ROLE fails until it's revoked - REVOKE first, then DROP.
        await adminPool.query(`REVOKE CONNECT ON DATABASE "${getTestPostgresConfig().database}" FROM ${TEST_ROLE}`);
        await adminPool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
        await adminPool.end();
    });

    describe('the migration connection, on a role with its own statement_timeout', () => {
        let rolePool: Pool;
        let client: PoolClient;

        before(async () => {
            rolePool = new Pool({
                ...getTestPostgresConfig(),
                user: TEST_ROLE,
                password: TEST_ROLE_PASSWORD,
                max: 1,
            });
            client = await rolePool.connect();

            // Mirrors exactly what runMigrations does after checking out its
            // client: resolve the configured timeout (unset here, so 0 -
            // unbounded) and apply it via configureMigrationConnection.
            await configureMigrationConnection(client, resolveMigrationStatementTimeoutMs());
        });

        after(async () => {
            client.release();
            await rolePool.end();
        });

        it('reports the intended statement_timeout, not the role default and not the driver-dropped zero', async () => {
            const { rows } = await client.query('SHOW statement_timeout');
            expect(rows[0].statement_timeout).to.equal('0');
        });

        it('reports 60s lock_timeout, bounding the indefinite lock wait a disabled statement cap would otherwise allow', async () => {
            const { rows } = await client.query('SHOW lock_timeout');
            expect(rows[0].lock_timeout).to.equal('1min');
        });

        it('reports the public search_path, so schema-pinned existence checks agree with unqualified migration DDL', async () => {
            const { rows } = await client.query('SHOW search_path');
            expect(rows[0].search_path).to.equal('public');
        });

        it('completes a 31-second statement, because this connection carries its own statement_timeout instead of the runtime pool\'s 30s cap', async function () {
            this.timeout(45_000);

            const { rows } = await client.query('SELECT pg_sleep(31) IS NOT NULL AS completed');
            expect(rows[0].completed).to.equal(true);
        });
    });

    describe('the deferred-SQL pool connect hook', () => {
        const DEFERRED_STATEMENT_TIMEOUT_MS = 12_345;

        let pool: Pool;
        let heldClient: PoolClient;

        before(async () => {
            pool = new Pool({ ...getTestPostgresConfig(), max: 2 });
            applyDeferredPoolStatementTimeout(pool, DEFERRED_STATEMENT_TIMEOUT_MS);

            // Hold the first physical connection open so the assertions
            // below are forced onto a second, freshly-opened connection -
            // proving the hook applies on every connect, not just whichever
            // connection happened to be created first.
            heldClient = await pool.connect();
        });

        after(async () => {
            heldClient.release();
            await pool.end();
        });

        it('applies the configured statement_timeout to a fresh checkout, not only the first connection', async () => {
            const { rows } = await pool.query('SHOW statement_timeout');
            expect(rows[0].statement_timeout).to.equal(`${DEFERRED_STATEMENT_TIMEOUT_MS}ms`);
        });

        it('reports the public search_path, so unqualified deferred SQL (CREATE INDEX CONCURRENTLY and the like) runs against the schema the existence checks agree on', async () => {
            const { rows } = await pool.query('SHOW search_path');
            expect(rows[0].search_path).to.equal('public');
        });

        it('leaves lock_timeout at the server default, so a concurrent index build is not bounded by a lock wait it did not have before', async () => {
            const { rows } = await pool.query('SHOW lock_timeout');
            expect(rows[0].lock_timeout).to.equal('0');
        });
    });
});

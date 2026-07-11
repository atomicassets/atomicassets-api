import 'mocha';
import { expect } from 'chai';
import { Pool } from 'pg';

import { runWithWorkMem } from './index';
import { getTestPostgresConfig } from '../../../utils/test';

// Integration coverage for the template_prices per-transaction statement_timeout
// override (unattended-self-heal WS-C). A cold update_atomicmarket_template_prices()
// recompute measures 7-8 minutes, past longRunningPool's own 5min connection-level
// statement_timeout, so runWithWorkMem raises it via `SET LOCAL` before the call -
// the same PgBouncer-safe, txn-scoped mechanism the sales-filters drain already uses
// (see drainOneBatch/runWithWorkMem in ./index.ts). These tests run against a real
// Pool (max:1, matching production's longRunningPool shape) because the scoping
// behavior being verified - SET LOCAL taking effect for the statement's own
// transaction and reverting at COMMIT - is a Postgres session-state guarantee that a
// mocked pg client cannot exercise.
describe('runWithWorkMem - per-transaction statement_timeout override', () => {
    const POOL_STATEMENT_TIMEOUT_MS = 300_000; // mirrors longRunningPool's 5min default
    let pool: Pool;

    before(async () => {
        pool = new Pool({ ...getTestPostgresConfig(), max: 1, statement_timeout: POOL_STATEMENT_TIMEOUT_MS });
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wsc_statement_timeout_probe (
                id serial PRIMARY KEY,
                value text NOT NULL
            )
        `);
    });

    beforeEach(async () => {
        await pool.query('DELETE FROM wsc_statement_timeout_probe');
    });

    after(async () => {
        await pool.query('DROP TABLE IF EXISTS wsc_statement_timeout_probe');
        await pool.end();
    });

    it('SHOW statement_timeout inside the transaction reflects the env-configured override (default 900s)', async () => {
        // Capture the setting FROM INSIDE the transaction by writing it to a real row
        // via the statement runWithWorkMem executes - runWithWorkMem itself doesn't
        // return query results, so this is the only way to observe the in-transaction
        // value without instrumenting production code for the test.
        await runWithWorkMem(
            pool,
            "INSERT INTO wsc_statement_timeout_probe(value) SELECT current_setting('statement_timeout')",
            1024,
            900, // the ATOMICMARKET_TEMPLATE_PRICES_STATEMENT_TIMEOUT_S default
        );

        const { rows } = await pool.query<{ value: string }>('SELECT value FROM wsc_statement_timeout_probe');
        expect(rows).to.have.length(1);
        // Postgres's canonical SHOW/current_setting format for 900_000ms is "15min",
        // not "900s" - confirmed against a live postgres:18 instance, not guessed.
        expect(rows[0].value).to.equal('15min');
    });

    it('after commit, a subsequent query on the same pool connection is back on the pool default statement_timeout', async () => {
        await runWithWorkMem(pool, 'SELECT 1', 1024, 900);

        // max:1 guarantees this reuses the SAME physical connection runWithWorkMem just
        // released. If SET LOCAL had leaked (e.g. a plain SET had been used instead),
        // this would still read the 900s override instead of the pool's own 5min.
        const { rows } = await pool.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value");
        expect(rows[0].value).to.equal('5min');
    });
});

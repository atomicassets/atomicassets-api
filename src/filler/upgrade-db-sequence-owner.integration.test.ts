import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';
import { Pool, PoolClient } from 'pg';

import { configureMigrationConnection, resolveMigrationStatementTimeoutMs } from './upgrade-db';
import { getTestPostgresConfig } from '../utils/test';

// The OWNED BY comment in definitions/migrations/1.7.11/database.sql explains the
// owner-identity rule these tests exercise. They put the queue table under a
// foreign owner and replay 1.7.11 as the role that trips the rule: the test
// superuser, and a member of the owning role. Every test runs inside one
// transaction that is rolled back, so the shared test database keeps its
// current schema. The connection must be a superuser, as in CI: it creates
// roles and moves table ownership to them.
// The refused-handover case needs PostgreSQL 16 or later for the SET option on
// a role grant, so it skips on an older server.
describe('migration 1.7.11 against a queue table the migrating role does not own', () => {
    const TABLE = 'atomicmarket_sales_filters_updates';
    const SEQUENCE = 'atomicmarket_sales_filters_updates_seq';
    const OWNER_ROLE = 'eca_seq_owner_test_role';
    const MEMBER_ROLE = 'eca_seq_owner_test_member';
    const MIGRATION = `${__dirname}/../../definitions/migrations/1.7.11/database.sql`;
    const ROLE_GRANT_OPTIONS_SINCE = 160000;

    let pool: Pool;
    let client: PoolClient;
    let serverVersionNum: number;

    before(async () => {
        pool = new Pool({ ...getTestPostgresConfig(), max: 1 });
        await pool.query(`DROP ROLE IF EXISTS ${MEMBER_ROLE}`);
        await pool.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
        await pool.query(`CREATE ROLE ${OWNER_ROLE}`);

        const { rows } = await pool.query('SHOW server_version_num');
        serverVersionNum = parseInt(rows[0].server_version_num, 10);
    });

    after(async () => {
        await pool.query(`DROP ROLE IF EXISTS ${MEMBER_ROLE}`);
        await pool.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`);
        await pool.end();
    });

    beforeEach(async () => {
        client = await pool.connect();
        // The same session state the runner gives its migration client:
        // search_path pinned to public, and the migration timeouts.
        await configureMigrationConnection(client, resolveMigrationStatementTimeoutMs());
        await client.query('BEGIN');
    });

    afterEach(async () => {
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    });

    // The shared test database is already past 1.7.11. Hand the table to a role
    // the connection is not, and drop the column so the sequence it owns goes
    // with it: that is the 1.7.5 shape the migration starts from.
    async function rewindToForeignOwner(): Promise<void> {
        await client.query(`ALTER TABLE ${TABLE} OWNER TO ${OWNER_ROLE}`);
        await client.query(`ALTER TABLE ${TABLE} DROP COLUMN seq`);
    }

    // The shape a non-superuser operator runs: every table belongs to one role,
    // and the filler connects as a member of it. SET LOCAL ROLE makes the rest of
    // the transaction run with that member's privileges, and ends with it.
    async function continueAsMember(setOption: 'SET TRUE' | 'SET FALSE'): Promise<void> {
        await client.query(`ALTER TABLE dbinfo OWNER TO ${OWNER_ROLE}`);
        await client.query(`GRANT CREATE ON SCHEMA public TO ${OWNER_ROLE}`);
        await client.query(`CREATE ROLE ${MEMBER_ROLE}`);
        // Before 16 a membership always carries INHERIT and SET ROLE, so the plain
        // grant is the SET TRUE shape, and SET FALSE has no equivalent there.
        const options = serverVersionNum < ROLE_GRANT_OPTIONS_SINCE ? '' : ` WITH INHERIT TRUE, ${setOption}`;
        await client.query(`GRANT ${OWNER_ROLE} TO ${MEMBER_ROLE}${options}`);
        await client.query(`SET LOCAL ROLE ${MEMBER_ROLE}`);
    }

    async function replayMigration(): Promise<void> {
        await client.query(fs.readFileSync(MIGRATION, { encoding: 'utf8' }));
    }

    async function enqueue(saleId: number): Promise<number> {
        await client.query(`INSERT INTO ${TABLE} (market_contract, sale_id) VALUES ('atomicmarket', $1)`, [saleId]);
        const { rows } = await client.query(`SELECT seq FROM ${TABLE} WHERE market_contract = 'atomicmarket' AND sale_id = $1`, [saleId]);

        return Number(rows[0].seq);
    }

    it('applies for a superuser, handing the sequence to the table owner and tying it to the column', async () => {
        await rewindToForeignOwner();

        await replayMigration();

        const { rows } = await client.query(`
            SELECT t.relowner = s.relowner AS same_owner,
                   pg_get_userbyid(s.relowner) AS sequence_owner,
                   EXISTS (
                       SELECT 1
                       FROM pg_depend d
                       WHERE d.objid = s.oid
                         AND d.refobjid = t.oid
                         AND d.refobjsubid = (
                             SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = 'seq'
                         )
                         AND d.deptype = 'a'
                   ) AS owned_by_column
            FROM pg_class t, pg_class s
            WHERE t.oid = '${TABLE}'::regclass
              AND s.oid = '${SEQUENCE}'::regclass
        `);

        expect(rows[0].same_owner).to.equal(true);
        expect(rows[0].sequence_owner).to.equal(OWNER_ROLE);
        expect(rows[0].owned_by_column).to.equal(true);
    });

    it('applies for a member of the owning role, which can still number the backlog and enqueue', async () => {
        // A queued row from before the upgrade, so the ADD COLUMN rewrite calls
        // nextval as the member on a sequence the member no longer owns.
        await enqueue(1);
        await rewindToForeignOwner();
        await continueAsMember('SET TRUE');

        await replayMigration();

        const { rows } = await client.query(`
            SELECT current_user, pg_get_userbyid(relowner) AS sequence_owner
            FROM pg_class WHERE oid = '${SEQUENCE}'::regclass
        `);
        const backlog = await client.query(`SELECT seq FROM ${TABLE} WHERE market_contract = 'atomicmarket' AND sale_id = 1`);
        const next = await enqueue(2);

        expect(rows[0].current_user).to.equal(MEMBER_ROLE);
        expect(rows[0].sequence_owner).to.equal(OWNER_ROLE);
        expect(Number(backlog.rows[0].seq)).to.be.greaterThan(0);
        expect(next).to.be.greaterThan(Number(backlog.rows[0].seq));
    });

    it('names both roles and keeps the Postgres detail when the migrating role cannot hand the sequence over', async function () {
        if (serverVersionNum < ROLE_GRANT_OPTIONS_SINCE) {
            this.skip();
        }

        await rewindToForeignOwner();
        await continueAsMember('SET FALSE');

        let failure: (Error & { code?: string, detail?: string }) | undefined;
        try {
            await replayMigration();
        } catch (err) {
            failure = err as Error & { code?: string, detail?: string };
        }

        expect(failure, 'the migration must not succeed').to.not.equal(undefined);
        expect(failure?.code).to.equal('P0001');
        expect(failure?.message).to.contain(`owned by ${OWNER_ROLE}`);
        expect(failure?.message).to.contain(`migrating role ${MEMBER_ROLE}`);
        expect(failure?.detail, 'the Postgres cause survives as DETAIL').to.contain('SET ROLE');
    });

    it('replays cleanly on a database that already carries the column and the sequence', async () => {
        await replayMigration();

        const { rows } = await client.query('SELECT "value" FROM dbinfo WHERE name = \'version\'');

        expect(rows[0].value).to.equal('1.7.11');
    });
});

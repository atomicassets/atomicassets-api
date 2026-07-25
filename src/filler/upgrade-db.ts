import logger from '../utils/winston';
import * as fs from 'fs';
import { ClientBase, Pool, PoolClient } from 'pg';
import { handlers } from './handlers/loader';
import { compareVersionString } from '../utils';
import PostgresConnection from '../connections/postgres';
import { IReaderConfig } from '../types/config';
import { configFile } from '../utils/config-path';

/**
 * Resolves the statement_timeout (ms) migrations run under, from
 * `MIGRATION_STATEMENT_TIMEOUT_MS`. Defaults to `0` (disabled): the runtime
 * pool's 30s cap (postgres.ts) exists to cancel zombie API/filler queries and
 * is unrelated to how long a migration's own DDL - e.g. a non-concurrent
 * index build on a populated table - legitimately needs to run.
 *
 * Deliberately does NOT use `positiveIntEnv` from '../utils/env'. That helper
 * cannot represent zero (it treats 0 as invalid input and falls back to its
 * default) and silently falls back to its default on a bad value. Both of
 * those are wrong for this knob: zero is the correct default here, not a
 * value to reject, and an operator-mistyped ceiling must fail loudly rather
 * than silently resolve to unbounded (or anything else the operator did not
 * ask for). Do not "fix" this back to positiveIntEnv - the mismatch is
 * intentional, not an oversight.
 *
 * The returned value is concatenated directly into a `SET statement_timeout`
 * statement (SET takes no bind parameters), so this validation is what makes
 * that interpolation safe - it must run, and must throw, before the value
 * ever reaches a query string.
 */
// Postgres's statement_timeout is a 4-byte signed int of milliseconds, so
// this is the largest value the server itself will accept - the resolver
// enforces it too, so an hours-vs-ms slip (e.g. 3_600_000_000) fails here
// with a clear message instead of inside Postgres with an out-of-range error.
const POSTGRES_MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;

export function resolveMigrationStatementTimeoutMs(): number {
    const raw = process.env.MIGRATION_STATEMENT_TIMEOUT_MS;

    if (raw === undefined) {
        return 0;
    }

    const trimmed = raw.trim();

    // An empty or whitespace-only value is treated as unset, not parsed (and
    // rejected) as garbage. This is a deliberate carve-out in an otherwise
    // "fail loudly on anything unexpected" resolver: a blank almost always
    // means a template rendered nothing for this var - not an operator
    // deliberately choosing a ceiling - and crash-looping the filler on a
    // blank is the wrong failure mode for a knob whose entire purpose is to
    // remove migration dead ends. An operator who mistypes an actual value
    // still gets the throw below; only a genuinely empty value falls back.
    if (trimmed.length === 0) {
        return 0;
    }

    // Accept only a plain decimal integer string. Number()'s coercion is far
    // looser than that: it accepts "0x10" as 16, "1e3" as 1000, and leading
    // "+"/whitespace-padded forms, none of which are the operator writing a
    // millisecond ceiling. Requiring digits-only up front also rejects
    // negative and fractional shapes before they ever reach Number().
    if (!/^\d+$/.test(trimmed)) {
        throw new Error(
            `MIGRATION_STATEMENT_TIMEOUT_MS must resolve to an integer between 0 and ${POSTGRES_MAX_STATEMENT_TIMEOUT_MS}, got "${raw}"`
        );
    }

    const value = Number(trimmed);

    if (!Number.isInteger(value) || value < 0 || value > POSTGRES_MAX_STATEMENT_TIMEOUT_MS) {
        throw new Error(
            `MIGRATION_STATEMENT_TIMEOUT_MS must resolve to an integer between 0 and ${POSTGRES_MAX_STATEMENT_TIMEOUT_MS}, got "${raw}"`
        );
    }

    return value;
}

/**
 * Configures a checked-out migration client: schema-pins the search_path and
 * lifts/bounds the statement and lock timeouts. Exported (alongside
 * resolveMigrationStatementTimeoutMs) so an integration test can assert the
 * resulting session state against a real Postgres connection instead of
 * re-deriving these statements.
 *
 * Uses plain SET, not SET LOCAL: search_path, statement_timeout and
 * lock_timeout all have to survive every version's COMMIT in runMigrations
 * below, not just one transaction.
 *
 * search_path is not optional here. createPool() never calls connect(), so
 * unlike the shared runtime pool (postgres.ts's connect() issues this same
 * SET once) this connection has never had it applied. The existence checks
 * are schema-pinned (tableExists, every handler `setup` query filters on
 * table_schema = 'public') while the migration DDL is unqualified, so a
 * connection left on the role's default search_path could create objects
 * those checks can't see.
 *
 * statementTimeoutMs is applied with an explicit SET rather than as a
 * pool/connection option: pg's driver only forwards statement_timeout at
 * startup when it is truthy (pg/lib/client.js), so a configured zero (the
 * default - unbounded) would be silently dropped and the connection would
 * fall back to the role's own statement_timeout instead of disabling the
 * cap. An explicit SET has no such gate. resolveMigrationStatementTimeoutMs()
 * is what makes concatenating the value into this statement safe - SET takes
 * no bind parameters, so validate-before-interpolate is the only guard
 * against a malformed value reaching the query string.
 *
 * lock_timeout bounds indefinite lock waits independently of
 * statement_timeout - a disabled (zero) statement cap leaves lock waits
 * with no bound of their own - matching every migration that already lifts
 * the cap itself with `SET LOCAL lock_timeout = '60s'`. The migration most
 * likely to wait on a lock is the one taking ACCESS EXCLUSIVE on
 * contract_traces to build its index.
 */
export async function configureMigrationConnection(client: PoolClient, statementTimeoutMs: number): Promise<void> {
    await client.query('SET search_path TO public');
    await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
    await client.query('SET lock_timeout = \'60s\'');
}

/**
 * Applies statementTimeoutMs, and pins search_path to public, on every fresh
 * connection the deferred-SQL pool opens. Unlike the migration pool above,
 * this pool holds no single client to configure after checkout - it checks
 * one out per statement (CREATE INDEX CONCURRENTLY cannot run inside a
 * transaction) - so both have to be applied through a connect hook instead.
 *
 * search_path is not optional here, for exactly the reason
 * configureMigrationConnection's doc comment gives for the migration
 * connection: createPool() never calls connect(), so this pool's connections
 * have never had it applied, and every `*-deferred.sql` file uses
 * unqualified table and index names with no `public.` qualification of its
 * own - a connection left on the role's default search_path would run
 * CREATE INDEX CONCURRENTLY against whatever schema that default resolves
 * to, silently. It is set first, ahead of statement_timeout, matching
 * configureMigrationConnection's ordering.
 *
 * This pool takes no statement_timeout pool option: pg's driver only
 * forwards statement_timeout at startup when it is truthy (pg/lib/client.js)
 * - the same trap configureMigrationConnection's doc comment describes - so
 * a pool option can't represent the disabled (zero) case; it would silently
 * reinstate a cap on every fresh connection this pool opens.
 *
 * Sets pg-pool's `onConnect` option (on the already-constructed pool, via
 * `pool.options` - pg-pool reads it lazily on each connect, so this is
 * equivalent to passing it to the constructor) rather than listening for the
 * 'connect' event: pg-pool awaits `onConnect` before handing the client back,
 * and a rejection there removes the client and fails the acquisition (pg-pool
 * 3.14.0 index.js:288-303). The 'connect' event has no such propagation path
 * - a failed SET could only be caught and logged, leaving the connection to
 * run at whatever statement_timeout createPool's base args carry. A failed
 * SET must fail loudly, not silently reinstate a cap.
 *
 * Deliberately sets no lock_timeout: no deferred file sets one, and bounding
 * lock waits on a concurrent index build would fail builds that would
 * otherwise succeed on a busy database.
 */
export function applyDeferredPoolStatementTimeout(pool: Pool, statementTimeoutMs: number): void {
    pool.options.onConnect = async (client: ClientBase) => {
        await client.query('SET search_path TO public');
        await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
    };
}

export async function initBaseTables(database: PostgresConnection): Promise<void> {
    if (!(await database.tableExists('dbinfo'))) {
        logger.info('Could not find base tables. Create them now...');

        await database.query(fs.readFileSync('./definitions/tables/base_tables.sql', {
            encoding: 'utf8'
        }));

        logger.info('Base tables successfully created');
    } else {
        logger.info('Base tables already exist');
    }
}

export async function runMigrations(database: PostgresConnection): Promise<void> {
    logger.info('Checking for available upgrades...');

    // Load reader configs inside function to avoid requiring config at module load time
    // This allows initBaseTables to run without config (for schema-init hooks)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const readerConfigs: IReaderConfig[] = require(configFile('readers.config.json'));

    const statementTimeoutMs = resolveMigrationStatementTimeoutMs();

    // Migrations run on a dedicated single-client pool rather than the shared
    // runtime pool (postgres.ts's statement_timeout: 30_000, sized to cancel
    // zombie API/filler queries). A populated database's migration DDL - e.g.
    // a non-concurrent index build over contract_traces - can legitimately
    // run far longer than that cap allows.
    const pool = database.createPool({ max: 1 });
    pool.on('error', (err) => {
        logger.warn('Migration pool error', err);
    });
    let client: PoolClient | undefined;
    let transactionOpen = false;

    try {
        client = await pool.connect();
        await configureMigrationConnection(client, statementTimeoutMs);

        await client.query('BEGIN');
        transactionOpen = true;

        const versionQuery = await client.query('SELECT "value" FROM dbinfo WHERE name = \'version\'');
        const currentVersion = versionQuery.rows.length > 0 ? versionQuery.rows[0].value : '1.0.0';

        const availableHandlers = handlers;
        const availableContracts: string[] = readerConfigs
            .reduce((prev, curr) => [...prev, ...curr.contracts.map(row => row.handler)], [])
            .filter((row, pos, arr) => arr.indexOf(row) === pos);
        const availableVersions: string[] = fs.readdirSync('./definitions/migrations')
            .sort((a, b) => compareVersionString(a, b));

        // init contracts
        for (const handlerName of availableContracts) {
            const handler = availableHandlers.find(row => row.handlerName === handlerName);

            if (!handler) {
                logger.error('Contract handler configured which does not exist: ' + handlerName);

                process.exit(1);
            }

            if (await handler.setup(client)) {
                logger.info('Tables for handler ' + handlerName + ' created.');

                const pastVersions = availableVersions.filter(version => compareVersionString(version, currentVersion) <= 0);

                for (const version of pastVersions) {
                    const filename = './definitions/migrations/' + version + '/' + handlerName + '.sql';

                    if (fs.existsSync(filename)) {
                        await client.query(fs.readFileSync(filename, { encoding: 'utf8' }));
                    }

                    await handler.upgrade(client, version);
                }
            }
        }

        await client.query('COMMIT');
        transactionOpen = false;

        const upgradeVersions = availableVersions.filter(version => compareVersionString(version, currentVersion) > 0);

        if (upgradeVersions.length > 0) {
            logger.info('Found ' + upgradeVersions.length + ' available upgrades. Starting to upgradeDB...');

            for (const version of upgradeVersions) {
                const versionDir = `${__dirname}/../../definitions/migrations/${version}/`;

                logger.info('Upgrade to ' + version + ' ...');

                await client.query('BEGIN');
                transactionOpen = true;

                await client.query(fs.readFileSync(`${versionDir}database.sql`, {
                    encoding: 'utf8'
                }));

                for (const handlerName of availableContracts) {
                    const handler = availableHandlers.find(row => row.handlerName === handlerName);

                    const handlerFilename = `${versionDir}${handlerName}.sql`;
                    if (fs.existsSync(handlerFilename)) {
                        await client.query(fs.readFileSync(handlerFilename, { encoding: 'utf8' }));
                    }

                    await handler.upgrade(client, version);

                    logger.info('Upgraded ' + handlerName + ' to ' + version);
                }

                logger.info('Successfully upgraded to ' + version);

                await client.query('COMMIT');
                transactionOpen = false;

                // Execute deferred SQL outside transaction. CREATE INDEX
                // CONCURRENTLY can take minutes/hours on large tables and
                // cannot run inside a transaction, so this uses a dedicated
                // pool - see applyDeferredPoolStatementTimeout's doc comment
                // for why this pool's timeout is applied through a connect
                // hook rather than after checkout, like the migration
                // connection above.
                const deferredPool = database.createPool({ max: 1 });
                deferredPool.on('error', (err) => {
                    logger.warn('Deferred SQL pool error', err);
                });
                applyDeferredPoolStatementTimeout(deferredPool, statementTimeoutMs);
                try {
                    for (const handlerName of availableContracts) {
                        const deferredFilename = `${versionDir}${handlerName}-deferred.sql`;
                        if (fs.existsSync(deferredFilename)) {
                            logger.info(`Running deferred SQL for ${handlerName} v${version}...`);
                            const sql = fs.readFileSync(deferredFilename, { encoding: 'utf8' });
                            // Strip SQL line comments before splitting on `;` so prose
                            // semicolons inside `-- ...` don't fragment statements.
                            // (1.6.1 shipped without this and crash-looped 6 fillers.)
                            const stripped = sql.replace(/--[^\n]*/g, '');
                            const statements = stripped.split(';').map(s => s.trim()).filter(s => s.length > 0);
                            for (const stmt of statements) {
                                logger.info(`Executing deferred: ${stmt.substring(0, 80)}...`);
                                await deferredPool.query(stmt);
                            }
                            logger.info(`Deferred SQL for ${handlerName} v${version} complete`);
                        }
                    }
                } finally {
                    await deferredPool.end();
                }
            }
        }
    } finally {
        // The version loop above issues BEGIN and nothing rolls back on the
        // throwing path, so a version left mid-transaction needs an explicit
        // ROLLBACK before the client goes back. Then release, then end the
        // pool - in that order, because awaiting end() while the client is
        // still checked out does not resolve until it is returned, which
        // would turn a fast crash-loop into a silent hang instead of the
        // exit the error above should cause.
        if (transactionOpen && client) {
            try {
                await client.query('ROLLBACK');
            } catch (err) {
                logger.warn('Failed to roll back open migration transaction during teardown', err as Error);
            }
        }

        if (client) {
            client.release();
        }

        await pool.end();
    }
}

export async function upgradeDb(database: PostgresConnection): Promise<void> {
    await initBaseTables(database);
    await runMigrations(database);
}

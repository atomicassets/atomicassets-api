import * as fs from 'fs';
import { Pool, PoolClient, PoolConfig, QueryResult } from 'pg';
// @ts-ignore
import exitHook from 'async-exit-hook';
import logger from '../utils/winston';

function buildSslConfig(): PoolConfig['ssl'] {
    const sslMode = process.env.PGSSLMODE || 'prefer';
    if (sslMode === 'disable') return false;

    const caPath = process.env.PGSSLROOTCERT;
    const ca = caPath && fs.existsSync(caPath) ? fs.readFileSync(caPath, 'utf8') : undefined;

    if (sslMode === 'verify-ca') {
        return { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined };
    }
    if (sslMode === 'verify-full') {
        return { rejectUnauthorized: true, ca };
    }
    // require, prefer, allow
    return { rejectUnauthorized: false };
}

export default class PostgresConnection {
    readonly pool: Pool;
    readonly name: string;

    private readonly args: PoolConfig;
    private initialized = false;

    constructor(host: string, port: number, user: string, password: string, database: string) {
        this.args = {
            host, port, user, password, database,
            application_name: 'eosio-contract-api',
            ssl: buildSslConfig(),
            keepAlive: true,
            keepAliveInitialDelayMillis: 30_000,
            // Fail after some seconds if a connection can't be acquired. An error like this can
            // help us understand if we have deadlocks due to non-released connections
            connectionTimeoutMillis: 5_000,
            // Cancel queries on the DB side after 30s to prevent zombie queries from accumulating
            // when pg-pool disconnects but the PostgreSQL query keeps running
            statement_timeout: 30_000,
        };
        this.pool = new Pool({
            ...this.args,
            max: parseInt(process.env.PG_POOL_MAX || '20', 10)
        });

        this.pool.on('error', (err) => {
            logger.warn('PG pool error', err);
        });

        this.name = host + '::' + port + '::' + database;
    }

    async connect(): Promise<void> {
        if (this.initialized) {
            return;
        }

        await this.pool.query('SET search_path TO public');

        this.initialized = true;

        exitHook((callback: () => void) => this.pool.end(callback));
    }

    createPool(args: Partial<PoolConfig>): Pool {
        return new Pool({
            ...this.args, ...args
        });
    }

    async query<T = any>(queryText: string, values: any[] = []): Promise<QueryResult<T>> {
        await this.connect();

        return await this.pool.query(queryText, values);
    }

    async fetchOne<T = any>(queryText: string, values: any[] = []): Promise<T> {
        const {rows} = await this.query(queryText, values);

        return rows[0];
    }

    async begin(): Promise<PoolClient> {
        await this.connect();

        const client = await this.pool.connect();

        await client.query('BEGIN');

        return client;
    }

    async tableExists(table: string): Promise<boolean> {
        const existsQuery = await this.query(
            'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2)',
            ['public', table]
        );

        return existsQuery.rows[0].exists;
    }

    async end(): Promise<void> {
        await this.pool.end();
    }
}

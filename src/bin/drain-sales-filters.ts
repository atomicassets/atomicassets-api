/*
  Partition-parallel drain for a large atomicmarket_sales_filters_updates backlog
  (see definitions/migrations/1.7.13/atomicmarket.sql for the design and lock protocol).

  Usage:
    node build/bin/drain-sales-filters.js [--partitions N] [--batch B] [--skip-offers]

  Safe to run while the filler is live: workers hold the drain advisory key SHARED,
  so the filler's own (exclusive) drain no-ops while a worker batch is in flight and
  resumes automatically afterwards. Asset-change queue rows are left to the filler's
  stock drain. Re-running, or running alongside an existing invocation, is harmless
  (per-partition advisory locks make duplicate workers clean no-ops).
*/

import PostgresConnection from '../connections/postgres';
import logger from '../utils/winston';
import { IConnectionsConfig } from '../types/config';

let connectionConfig: IConnectionsConfig = { postgres: {}, redis: {}, chain: {} } as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require('/home/node/app/config/connections.config.json');
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

function intArg(flag: string, def: number): number {
    const i = process.argv.indexOf(flag);
    const v = i >= 0 ? parseInt(process.argv[i + 1], 10) : NaN;
    return Number.isFinite(v) && v > 0 ? v : def;
}

const PARTITIONS = Math.min(intArg('--partitions', 8), 16);
const BATCH = intArg('--batch', 5000);
const SKIP_OFFERS = process.argv.includes('--skip-offers');

// removed=0 is ambiguous (drained vs locked out by the stock drain vs only
// re-enqueued-mid-batch rows left). After a 0, check the remaining count for the
// scope: if work remains, back off and retry up to MAX_IDLE_RETRIES times before
// concluding the leftovers are the live trickle (the filler's job handles those).
const MAX_IDLE_RETRIES = 5;
const IDLE_BACKOFF_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
    const pg = connectionConfig.postgres;
    const connection = new PostgresConnection(pg.host, pg.port, pg.user, pg.password, pg.database);

    const countSales = async (): Promise<number> => {
        const r = await connection.query(
            'SELECT COUNT(*)::bigint c FROM atomicmarket_sales_filters_updates WHERE sale_id IS NOT NULL'
        );
        return Number(r.rows[0].c);
    };
    const countOffers = async (): Promise<number> => {
        const r = await connection.query(
            'SELECT COUNT(*)::bigint c FROM atomicmarket_sales_filters_updates WHERE offer_id IS NOT NULL'
        );
        return Number(r.rows[0].c);
    };

    const startedAt = Date.now();
    logger.info(`Backlog: ${await countSales()} sale rows, ${await countOffers()} offer rows. ` +
        `Draining with ${PARTITIONS} partition workers, batch ${BATCH}.`);

    if (!SKIP_OFFERS) {
        // Normalize queued offer rows into sale rows so the partition workers own them.
        const client = await connection.pool.connect();
        try {
            await client.query('SET statement_timeout = 0');
            let idle = 0;
            while (idle < MAX_IDLE_RETRIES) {
                const r = await client.query('SELECT normalize_atomicmarket_sales_filters_offers($1) AS removed', [BATCH * 10]);
                const removed = Number(r.rows[0].removed);
                if (removed > 0) {
                    idle = 0;
                    logger.info(`offers: normalized ${removed} queue rows into sale rows`);
                    continue;
                }
                if (await countOffers() === 0) {
                    break;
                }
                idle += 1; // locked out by the stock drain, or only re-enqueued rows left
                await sleep(IDLE_BACKOFF_MS);
            }
        } finally {
            client.release();
        }
        logger.info(`offers normalized; ${await countOffers()} offer rows remain (live trickle is expected)`);
    }

    let totalRemoved = 0;

    const worker = async (partIndex: number): Promise<void> => {
        const client = await connection.pool.connect();
        try {
            await client.query('SET statement_timeout = 0');
            // Crash-safe to lose: every batch is one transaction, unprocessed rows stay queued.
            await client.query('SET synchronous_commit = off');
            let idle = 0;
            while (idle < MAX_IDLE_RETRIES) {
                const r = await client.query(
                    'SELECT update_atomicmarket_sales_filters_partition($1, $2, $3) AS removed',
                    [PARTITIONS, partIndex, BATCH],
                );
                const removed = Number(r.rows[0].removed);
                if (removed > 0) {
                    idle = 0;
                    totalRemoved += removed;
                    continue;
                }
                const remaining = await connection.query(
                    'SELECT COUNT(*)::bigint c FROM atomicmarket_sales_filters_updates WHERE sale_id IS NOT NULL AND sale_id % $1 = $2',
                    [PARTITIONS, partIndex],
                );
                if (Number(remaining.rows[0].c) === 0) {
                    break;
                }
                idle += 1; // locked out by an in-flight stock drain batch, or hot rows only
                await sleep(IDLE_BACKOFF_MS);
            }
            logger.info(`worker ${partIndex}: done`);
        } finally {
            client.release();
        }
    };

    const progress = setInterval(() => {
        countSales()
            .then(c => logger.info(`progress: ${totalRemoved} removed, ${c} sale rows remaining`))
            .catch(() => undefined);
    }, 30_000);

    try {
        await Promise.all(Array.from({ length: PARTITIONS }, (_, i) => worker(i)));
    } finally {
        clearInterval(progress);
    }

    logger.info(`drained ${totalRemoved} queue rows in ${Math.round((Date.now() - startedAt) / 1000)}s; ` +
        `${await countSales()} sale rows remaining (live trickle)`);

    // The run churns the filter partitions; refresh planner stats so API plans stay sane.
    const analyzeClient = await connection.pool.connect();
    try {
        await analyzeClient.query('SET statement_timeout = 0');
        await analyzeClient.query('ANALYZE atomicmarket_sales_filters, atomicmarket_sales_filters_updates');
        logger.info('ANALYZE done');
    } finally {
        analyzeClient.release();
    }

    process.exit(0);
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});

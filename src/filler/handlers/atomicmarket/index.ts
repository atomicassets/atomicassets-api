import * as fs from 'fs';
import { Pool, PoolClient } from 'pg';

import { ContractHandler } from '../interfaces';
import logger from '../../../utils/winston';
import { positiveIntEnv } from '../../../utils/env';
import { ConfigTableRow } from './types/tables';
import Filler  from '../../filler';
import { DELPHIORACLE_BASE_PRIORITY } from '../delphioracle';
import { ATOMICASSETS_BASE_PRIORITY } from '../atomicassets';
import DataProcessor from '../../processor';
import ApiNotificationSender from '../../notifier';
import { auctionProcessor } from './processors/auctions';
import { balanceProcessor } from './processors/balances';
import { configProcessor } from './processors/config';
import { logProcessor } from './processors/logs';
import { marketplaceProcessor } from './processors/marketplaces';
import { saleProcessor } from './processors/sales';
import { buyofferProcessor } from './processors/buyoffers';
import { bonusfeeProcessor } from './processors/bonusfees';
import { JobQueuePriority } from '../../jobqueue';
import { templateBuyofferProcessor } from './processors/template-buyoffers';

export const ATOMICMARKET_BASE_PRIORITY = Math.max(ATOMICASSETS_BASE_PRIORITY, DELPHIORACLE_BASE_PRIORITY) + 1000;

// Bounded sales-filters drain (see definitions/migrations/1.6.3). Each
// update_atomicmarket_sales_filters() call consumes at most BATCH_SIZE queue
// rows of each type in a short transaction; the job loops until the queue is
// drained or the per-tick time budget elapses. Env-tunable so ops can retune
// under load without a redeploy. Defaults: 5000 rows/batch, 30 s budget.
const SALES_FILTERS_BATCH_SIZE = positiveIntEnv('ATOMICMARKET_SALES_FILTERS_BATCH_SIZE', 5000);
const SALES_FILTERS_DRAIN_BUDGET_MS = positiveIntEnv('ATOMICMARKET_SALES_FILTERS_DRAIN_BUDGET_MS', 30_000);
// Per-batch statement_timeout for the drain query. This is the EFFECTIVE cap on
// a single update_atomicmarket_sales_filters() call. It is applied via
// `SET LOCAL` inside each batch's transaction (see below) — NOT via the pool's
// connection-level statement_timeout, which does not survive PgBouncer
// transaction pooling (the server backend is shared between transactions, so a
// connection-level SET is silently dropped). 2026-05-29 incident: the drain
// was effectively capped at the role's 30 s, timed out (57014) on heavy batches
// during a mint storm, and the queue grew to 9.3M rows. Default 5 min.
const SALES_FILTERS_STATEMENT_TIMEOUT_MS = positiveIntEnv('ATOMICMARKET_SALES_FILTERS_STATEMENT_TIMEOUT_MS', 300_000);
// Per-batch work_mem (MB) for the drain. The recompute (MATERIALIZED CTEs +
// jsonb_each aggregation + sorts) spills to temp files at the default 128MB on
// real batches (measured ~1 GB/call, ~16-20s, dominated by IO/BuffileWrite) and
// starves the reader's block writes. Raising it keeps the recompute in memory so
// each call is ~1s. Applied via `SET LOCAL` (same PgBouncer-safe, txn-scoped
// reason as statement_timeout) on the drain's single longRunningPool connection
// only, so memory use is bounded. Default 2048 MB.
const SALES_FILTERS_WORK_MEM_MB = positiveIntEnv('ATOMICMARKET_SALES_FILTERS_WORK_MEM_MB', 2048);

// Bounded mint backfill (update_atomicmarket_{sale,buyoffer,auction}_mints).
// Each call is a single set-based UPDATE over at most BATCH_SIZE unmint-ed rows
// and returns the rows resolved; the job loops until a batch resolves 0 rows or
// the budget elapses. Small batches keep each call well under the default pool's
// 30s statement_timeout (these are FUNCTIONs as of migration 1.6.5; before that
// they were procedures that timed out on a 50k-row-per-call loop). Budget stays
// under 30s so the per-tick loop bows out before any single call risks the cap.
const MINTS_BATCH_SIZE = positiveIntEnv('ATOMICMARKET_MINTS_BATCH_SIZE', 2000);
const MINTS_DRAIN_BUDGET_MS = positiveIntEnv('ATOMICMARKET_MINTS_DRAIN_BUDGET_MS', 25_000);

interface DrainClient {
    query(sql: string, params?: any[]): Promise<{ rows: Array<{ consumed?: number | string }> }>;
    release(): void;
}
interface DrainPool {
    connect(): Promise<DrainClient>;
}

/**
 * Run one bounded drain batch in its own transaction, with statement_timeout
 * raised via `SET LOCAL` BEFORE the drain query.
 *
 * Why the transaction + SET LOCAL (and not the pool's statement_timeout):
 *  - Through PgBouncer transaction pooling, a connection-level statement_timeout
 *    does not stick — so the drain inherited the role default (30 s) and timed
 *    out under load (2026-05-29 incident).
 *  - statement_timeout is armed when the outer statement starts, so raising it
 *    from INSIDE update_atomicmarket_sales_filters() cannot extend the running
 *    call. It must be SET as a separate statement before the drain query.
 *  - PgBouncer keeps one server backend for a transaction's whole lifetime, so
 *    `SET LOCAL` inside BEGIN…COMMIT reliably applies, then reverts at COMMIT.
 */
async function drainOneBatch(
    pool: DrainPool,
    batchSize: number,
    statementTimeoutMs: number,
    workMemMb: number,
): Promise<number> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        try {
            await client.query(`SET LOCAL statement_timeout = ${Number(statementTimeoutMs)}`);
            await client.query(`SET LOCAL work_mem = '${Number(workMemMb)}MB'`);
            const res = await client.query('SELECT update_atomicmarket_sales_filters($1) AS consumed', [batchSize]);
            await client.query('COMMIT');
            return Number(res.rows[0]?.consumed ?? 0);
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw e;
        }
    } finally {
        client.release();
    }
}

/**
 * Drain atomicmarket_sales_filters_updates in bounded batches. Each
 * drainOneBatch() consumes at most batchSize queue rows of each type in its own
 * short transaction (so locks release between batches) and returns the number
 * of queue rows consumed; we loop until the queue is empty (consumed=0), the
 * time budget elapses, OR `shouldYield()` returns true. Returns total rows
 * consumed across the loop.
 *
 * `shouldYield` is checked BETWEEN batches (not just at the start) so a reader
 * that falls behind mid-budget reclaims priority immediately instead of waiting
 * out the whole budget. This matters because a live (committed) batch is ~36s on
 * WAX (WAL + GIN index maintenance on the 46M-row filter table), and the gate
 * was previously only evaluated at tick start (runGatedDrain) — so a large budget
 * starved the block reader 1:1 for its whole window and tripped the watchdog
 * (2026-05-31). Checking it per batch lets the budget be large (fast draining
 * while the reader is idle) AND reader-safe (yield the instant blocksUntilHead
 * climbs). Wiring passes `() => filler.shouldDeferDrain()`.
 * `shouldYield` and `now` are injectable for tests.
 */
export async function drainAtomicmarketSalesFilters(
    pool: DrainPool,
    batchSize: number,
    budgetMs: number,
    statementTimeoutMs: number,
    workMemMb: number,
    shouldYield: () => boolean = () => false,
    now: () => number = Date.now,
): Promise<number> {
    const deadline = now() + budgetMs;
    let total = 0;
    let consumed: number;
    do {
        consumed = await drainOneBatch(pool, batchSize, statementTimeoutMs, workMemMb);
        total += consumed;
    } while (consumed > 0 && now() < deadline && !shouldYield());
    return total;
}

interface MintsPool {
    query(sql: string, params?: any[]): Promise<{ rows: Array<{ updated?: number | string }> }>;
}

// fnName is interpolated into the SQL (identifier context — can't be a bind
// param), so it MUST come from this fixed allowlist. The call sites pass
// constants; the guard in drainAtomicmarketMints makes that safe-by-construction
// and rejects any accidental/untrusted value rather than risk SQL injection.
const MINT_BACKFILL_FUNCTIONS = new Set([
    'update_atomicmarket_sale_mints',
    'update_atomicmarket_buyoffer_mints',
    'update_atomicmarket_auction_mints',
]);

/**
 * Backfill template_mint via the bounded mint FUNCTIONs in small batches.
 *
 * Each `SELECT <fnName>($1,$2,$3)` runs one set-based UPDATE over at most
 * batchSize unmint-ed rows (autocommit — the function is not wrapped in an
 * explicit txn, and unlike the sales-filter drain it needs no SET LOCAL because
 * small batches finish well under the statement_timeout) and returns the rows
 * resolved. We loop until a batch resolves 0 rows or the budget elapses.
 *
 * Stop on `updated === 0`, NOT on `updated < batchSize`: the function's HAVING
 * guard skips rows whose assets aren't minted yet, so a batch can resolve fewer
 * than batchSize while resolvable work remains — but when it resolves 0, nothing
 * is currently resolvable and the next 60s tick re-probes. `fnName` is checked
 * against MINT_BACKFILL_FUNCTIONS because it is interpolated into the SQL.
 * `shouldYield` is checked between batches (same reader-priority rationale as
 * drainAtomicmarketSalesFilters). `shouldYield` and `now` are injectable for tests.
 */
export async function drainAtomicmarketMints(
    pool: MintsPool,
    fnName: string,
    contract: string,
    lastIrreversibleBlock: number,
    batchSize: number,
    budgetMs: number,
    shouldYield: () => boolean = () => false,
    now: () => number = Date.now,
): Promise<number> {
    if (!MINT_BACKFILL_FUNCTIONS.has(fnName)) {
        throw new Error(`drainAtomicmarketMints: refusing to call unknown function "${fnName}"`);
    }
    const deadline = now() + budgetMs;
    let total = 0;
    let updated: number;
    do {
        const res = await pool.query(
            `SELECT ${fnName}($1, $2, $3) AS updated`,
            [contract, lastIrreversibleBlock, batchSize],
        );
        updated = Number(res.rows[0]?.updated ?? 0);
        total += updated;
    } while (updated > 0 && now() < deadline && !shouldYield());
    return total;
}

/**
 * Shared reader-priority wrapper for the maintenance drain jobs (sales filters +
 * the 3 mint backfills). Enforces the ordering the robustness fix depends on:
 *
 *   1. defer if the reader is catching up  (Filler.shouldDeferDrain — Layer 1)
 *   2. else skip if there's nothing queued  (cheap EXISTS probe)
 *   3. else run the bounded drain
 *
 * A deferred reader touches NEITHER the probe NOR the drain, so the gate gives
 * block-writes absolute priority during bursts / post-restart catch-up. Returns
 * a status purely so the wiring is unit-testable without a live Filler/DB; the
 * JobQueue callback ignores the return value.
 */
export async function runGatedDrain(
    filler: { shouldDeferDrain(): boolean },
    hasWork: () => Promise<boolean>,
    drain: () => Promise<number>,
): Promise<'deferred' | 'no-work' | number> {
    if (filler.shouldDeferDrain()) {
        return 'deferred';
    }
    if (!(await hasWork())) {
        return 'no-work';
    }
    return drain();
}

export type AtomicMarketArgs = {
    atomicmarket_account: string,
    atomicassets_account: string,
    delphioracle_account: string,

    store_logs: boolean
};

export enum SaleState {
    WAITING = 0,
    LISTED = 1,
    CANCELED = 2,
    SOLD = 3
}

export enum AuctionState {
    WAITING = 0,
    LISTED = 1,
    CANCELED = 2
}

export enum BuyofferState {
    PENDING = 0,
    DECLINED = 1,
    CANCELED = 2,
    ACCEPTED = 3
}

export enum TemplateBuyofferState {
    LISTED = 0,
    CANCELED = 1,
    SOLD = 2
}

export enum AtomicMarketUpdatePriority {
    TABLE_BALANCES = ATOMICMARKET_BASE_PRIORITY + 10,
    TABLE_MARKETPLACES = ATOMICMARKET_BASE_PRIORITY + 10,
    TABLE_CONFIG = ATOMICMARKET_BASE_PRIORITY + 10,
    TABLE_BONUSFEES = ATOMICMARKET_BASE_PRIORITY + 10,
    ACTION_CREATE_SALE = ATOMICMARKET_BASE_PRIORITY + 20,
    ACTION_CREATE_AUCTION = ATOMICMARKET_BASE_PRIORITY + 20,
    ACTION_CREATE_BUYOFFER = ATOMICMARKET_BASE_PRIORITY + 20,
    ACTION_CREATE_TEMPLATE_BUYOFFER = ATOMICMARKET_BASE_PRIORITY + 20,
    TABLE_AUCTIONS = ATOMICMARKET_BASE_PRIORITY + 30,
    ACTION_UPDATE_SALE = ATOMICMARKET_BASE_PRIORITY + 40,
    ACTION_UPDATE_AUCTION = ATOMICMARKET_BASE_PRIORITY + 40,
    ACTION_UPDATE_BUYOFFER = ATOMICMARKET_BASE_PRIORITY + 40,
    ACTION_UPDATE_TEMPLATE_BUYOFFER = ATOMICMARKET_BASE_PRIORITY + 40,
    LOGS = ATOMICMARKET_BASE_PRIORITY
}

export default class AtomicMarketHandler extends ContractHandler {
    static handlerName = 'atomicmarket';

    declare readonly args: AtomicMarketArgs;

    config: ConfigTableRow;

    static async setup(client: PoolClient): Promise<boolean> {
        const existsQuery = await client.query(
            'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2)',
            ['public', 'atomicmarket_config']
        );

        const views = [
            'atomicmarket_assets_master', 'atomicmarket_auctions_master',
            'atomicmarket_sales_master', 'atomicmarket_sale_prices_master',
            'atomicmarket_stats_prices_master', 'atomicmarket_buyoffers_master',
            'atomicmarket_template_buyoffers_master'
        ];

        const procedures = ['atomicmarket_auction_mints', 'atomicmarket_buyoffer_mints', 'atomicmarket_sale_mints'];

        if (!existsQuery.rows[0].exists) {
            logger.info('Could not find AtomicMarket tables. Create them now...');

            await client.query(fs.readFileSync('./definitions/tables/atomicmarket_tables.sql', {
                encoding: 'utf8'
            }));

            for (const view of views) {
                await client.query(fs.readFileSync('./definitions/views/' + view + '.sql', {encoding: 'utf8'}));
            }

            for (const procedure of procedures) {
                await client.query(fs.readFileSync('./definitions/procedures/' + procedure + '.sql', {encoding: 'utf8'}));
            }

            logger.info('AtomicMarket tables successfully created');

            return true;
        }

        return false;
    }

    static async upgrade(client: PoolClient, version: string): Promise<void> {
        if (version === '1.2.2') {
            await client.query('DROP VIEW IF EXISTS atomicmarket_assets_master CASCADE;');
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_assets_master.sql', {encoding: 'utf8'}));

            await client.query(fs.readFileSync('./definitions/procedures/atomicmarket_auction_mints.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/procedures/atomicmarket_buyoffer_mints.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/procedures/atomicmarket_sale_mints.sql', {encoding: 'utf8'}));
        }

        if (version === '1.3.4') {
            // hotfix broken filler
            const data = await client.query('SELECT * FROM atomicmarket_buyoffers_assets WHERE buyoffer_id = 609405 AND asset_id = 1099601520940');

            if (data.rowCount > 0) {
                await client.query('DELETE FROM atomicmarket_buyoffers_assets WHERE buyoffer_id = 609405;');
                await client.query('DELETE FROM atomicmarket_buyoffers WHERE buyoffer_id = 609405;');
            }
        }

        if (version === '1.3.13') {
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_stats_prices_master.sql', {encoding: 'utf8'}));
        }

        if (version === '1.3.20') {
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_auctions_master.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_buyoffers_master.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_sales_master.sql', {encoding: 'utf8'}));
        }

        if (version === '1.3.23') {
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_template_buyoffers_master.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/procedures/atomicmarket_template_buyoffer_mints.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_assets_master.sql', {encoding: 'utf8'}));
        }

        if (version === '1.3.24') {
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_auctions_master.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_buyoffers_master.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_template_buyoffers_master.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/views/atomicmarket_sales_master.sql', {encoding: 'utf8'}));
        }

    }

    constructor(filler: Filler, args: {[key: string]: any}) {
        super(filler, args);

        if (typeof args.atomicmarket_account !== 'string') {
            throw new Error('AtomicMarket: Argument missing in atomicmarket handler: atomicmarket_account');
        }
    }

    async init(client: PoolClient): Promise<void> {
        const configQuery = await client.query(
            'SELECT * FROM atomicmarket_config WHERE market_contract = $1',
            [this.args.atomicmarket_account]
        );

        if (configQuery.rows.length === 0) {
            const configTable = await this.connection.chain.rpc.get_table_rows({
                json: true, code: this.args.atomicmarket_account,
                scope: this.args.atomicmarket_account, table: 'config'
            });

            if (configTable.rows.length === 0) {
                throw new Error('AtomicMarket: Unable to fetch atomicmarket version');
            }

            const config: ConfigTableRow = configTable.rows[0];

            this.args.delphioracle_account = config.delphioracle_account;
            this.args.atomicassets_account = config.atomicassets_account;

            await client.query(
                'INSERT INTO atomicmarket_config ' +
                '(' +
                    'market_contract, assets_contract, delphi_contract, ' +
                    'version, maker_market_fee, taker_market_fee, ' +
                    'minimum_auction_duration, maximum_auction_duration, ' +
                    'minimum_bid_increase, auction_reset_duration' +
                ') ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                [
                    this.args.atomicmarket_account,
                    this.args.atomicassets_account,
                    config.delphioracle_account,
                    config.version,
                    config.maker_market_fee,
                    config.taker_market_fee,
                    config.minimum_auction_duration,
                    config.maximum_auction_duration,
                    config.minimum_bid_increase,
                    config.auction_reset_duration
                ]
            );

            // Seed supported tokens from chain config
            for (const token of config.supported_tokens) {
                await client.query(
                    'INSERT INTO atomicmarket_tokens (market_contract, token_contract, token_symbol, token_precision) ' +
                    'VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                    [
                        this.args.atomicmarket_account,
                        token.token_contract,
                        token.token_symbol.split(',')[1],
                        token.token_symbol.split(',')[0]
                    ]
                );
            }

            // Seed supported symbol pairs from chain config
            for (const pair of config.supported_symbol_pairs) {
                await client.query(
                    'INSERT INTO atomicmarket_symbol_pairs (market_contract, listing_symbol, settlement_symbol, delphi_contract, delphi_pair_name, invert_delphi_pair) ' +
                    'VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
                    [
                        this.args.atomicmarket_account,
                        pair.listing_symbol.split(',')[1],
                        pair.settlement_symbol.split(',')[1],
                        config.delphioracle_account,
                        pair.delphi_pair_name,
                        pair.invert_delphi_pair
                    ]
                );
            }

            this.config = config;
        } else {
            this.args.delphioracle_account = configQuery.rows[0].delphi_contract;
            this.args.atomicassets_account = configQuery.rows[0].assets_contract;

            const tokensQuery = await this.connection.database.query(
                'SELECT * FROM atomicmarket_tokens WHERE market_contract = $1',
                [this.args.atomicmarket_account]
            );

            const pairsQuery = await this.connection.database.query(
                'SELECT * FROM atomicmarket_symbol_pairs WHERE market_contract = $1',
                [this.args.atomicmarket_account]
            );

            this.config = {
                ...configQuery.rows[0],
                supported_symbol_pairs: pairsQuery.rows.map(row => ({
                    listing_symbol: 'X,' + row.listing_symbol,
                    settlement_symbol: 'X,' + row.settlement_symbol,
                    invert_delphi_pair: row.invert_delphi_pair,
                    delphi_pair_name: row.delphi_pair_name
                })),
                supported_tokens: tokensQuery.rows.map(row => ({
                    token_contract: row.token_contract,
                    token_symbol: row.token_precision + ',' + row.token_symbol
                })),
                auction_counter: 0,
                sale_counter: 0,
                delphioracle_account: this.args.delphioracle_account,
                atomicassets_account: this.args.atomicassets_account
            };
        }
    }

    async deleteDB(client: PoolClient): Promise<void> {
        const tables = [
            'atomicmarket_auctions', 'atomicmarket_auctions_assets', 'atomicmarket_auctions_bids',
            'atomicmarket_sales', 'atomicmarket_buyoffers', 'atomicmarket_buyoffers_assets',
            'atomicmarket_config', 'atomicmarket_delphi_pairs', 'atomicmarket_marketplaces',
            'atomicmarket_token_symbols', 'atomicmarket_bonusfees', 'atomicmarket_balances',
            'atomicmarket_stats_markets', 'atomicmarket_template_prices',
            'atomicmarket_template_buyoffers', 'atomicmarket_template_buyoffers_assets',
        ];

        for (const table of tables) {
            await client.query(
                'DELETE FROM ' + client.escapeIdentifier(table) + ' WHERE market_contract = $1',
                [this.args.atomicmarket_account]
            );
        }
    }

    async register(processor: DataProcessor, notifier: ApiNotificationSender): Promise<() => any> {
        const destructors: Array<() => any> = [];

        // Dedicated pool for long-running maintenance jobs (sales_filters, template_prices).
        // The main pool's 30s statement_timeout is too short and SET LOCAL is ineffective
        // through PgBouncer transaction pooling, so these jobs need their own pool.
        //
        // connectionTimeoutMillis must be ≥ statement_timeout: with max:1 and multi-minute
        // work units, queued calls would otherwise hit the parent pool's 5s acquire timeout
        // (postgres.ts:40) while the single client is still running the previous invocation.
        // Observed on WAX mainnet where update_atomicmarket_sales_filters() can run >5s and
        // every subsequent job call failed with "timeout exceeded when trying to connect".
        const longRunningPool: Pool = this.connection.database.createPool({
            connectionTimeoutMillis: 10 * 60 * 1_000, // 10 min — headroom over statement_timeout
            statement_timeout: 300_000, // 5 min
            max: 1,
        });
        destructors.push(() => { void longRunningPool.end().catch(() => {}); });

        destructors.push(auctionProcessor(this, processor, notifier));
        destructors.push(balanceProcessor(this, processor));
        destructors.push(bonusfeeProcessor(this, processor));
        destructors.push(buyofferProcessor(this, processor, notifier));
        destructors.push(templateBuyofferProcessor(this, processor, notifier));
        destructors.push(configProcessor(this, processor));
        destructors.push(marketplaceProcessor(this, processor));
        destructors.push(saleProcessor(this, processor, notifier));

        if (this.args.store_logs) {
            destructors.push(logProcessor(this, processor));
        }

        // Reader-priority gate + EXISTS probe + bounded drain are sequenced by
        // runGatedDrain (defer while the reader is catching up so it keeps
        // block-write priority during bursts / post-restart catch-up; the deduped
        // queue stays bounded meanwhile — see Filler.shouldDeferDrain).
        // `table` is a closed string-literal union, so it can only ever be one of
        // these three constants — the interpolation cannot carry untrusted input.
        const mintsHasWork = (
            table: 'atomicmarket_sales' | 'atomicmarket_buyoffers' | 'atomicmarket_auctions',
        ) => async (): Promise<boolean> => {
            const probe = await this.connection.database.query(
                `SELECT EXISTS(
                    SELECT 1 FROM ${table}
                    WHERE template_mint IS NULL
                        AND market_contract = $1
                        AND created_at_block <= $2
                    LIMIT 1
                ) AS has_work`,
                [this.args.atomicmarket_account, this.filler.reader.lastIrreversibleBlock]
            );
            return probe.rows[0]?.has_work === true;
        };
        const drainMints = (fnName: string) => (): Promise<number> => drainAtomicmarketMints(
            this.connection.database,
            fnName,
            this.args.atomicmarket_account,
            this.filler.reader.lastIrreversibleBlock,
            MINTS_BATCH_SIZE,
            MINTS_DRAIN_BUDGET_MS,
            // yield between batches the moment the reader falls behind (not just
            // at tick start) so the drain never starves block-writes for a full budget
            () => this.filler.shouldDeferDrain(),
        );

        this.filler.jobs.add('update_atomicmarket_sale_mints', 60, JobQueuePriority.MEDIUM, () =>
            runGatedDrain(
                this.filler,
                mintsHasWork('atomicmarket_sales'),
                drainMints('update_atomicmarket_sale_mints'),
            ));

        this.filler.jobs.add('update_atomicmarket_buyoffer_mints', 60, JobQueuePriority.MEDIUM, () =>
            runGatedDrain(
                this.filler,
                mintsHasWork('atomicmarket_buyoffers'),
                drainMints('update_atomicmarket_buyoffer_mints'),
            ));

        this.filler.jobs.add('update_atomicmarket_auction_mints', 60, JobQueuePriority.MEDIUM, () =>
            runGatedDrain(
                this.filler,
                mintsHasWork('atomicmarket_auctions'),
                drainMints('update_atomicmarket_auction_mints'),
            ));

        // Cadence bumped 20s → 60s and gated by a cheap EXISTS probe after the
        // 2026-04-24 00:01 UTC cliff where cold-cache joins across atomicassets_*
        // tables saturated Cinder I/O on eca-wax-mainnet-cluster. The proc is
        // event-driven (reads atomicmarket_sales_filters_updates queue) but
        // still pays temp-table + CTE-plan cost per empty-queue run. The probe
        // races harmlessly with the proc's own DELETE on the queue — a late
        // insertion between probe and call just falls through to the proc,
        // which returns quickly if the queue is drained by then.
        // Drain the queue in bounded batches. update_atomicmarket_sales_filters
        // ($1) consumes at most $1 queue rows of each type per call in a SHORT
        // transaction and returns the number consumed; the drain loops (each call
        // its own txn, so locks release between batches) until the queue is empty
        // or the time budget elapses.
        //
        // Reader-priority gate (re-added 1.6.6, via runGatedDrain): defer the drain
        // while the reader is catching up so it keeps block-write priority during
        // bursts and post-restart catch-up — the contention that repeatedly knocked
        // the reader behind and wedged it. The gate was REMOVED in 1.6.3 because the
        // then-unbounded drain + gate doom-looped (queue grew unbounded while
        // gated). 1.6.4 dedup (unique partial indexes) now caps
        // atomicmarket_sales_filters_updates at distinct changed keys, so gating is
        // safe again: the backlog stays bounded while deferred and drains quickly
        // (1.6.6 work_mem keeps each call in memory) once the reader is caught up.
        this.filler.jobs.add('update_atomicmarket_sales_filters', 60, JobQueuePriority.HIGH, () =>
            runGatedDrain(
                this.filler,
                async () => (await longRunningPool.query(
                    'SELECT EXISTS(SELECT 1 FROM atomicmarket_sales_filters_updates LIMIT 1) AS has_work'
                )).rows[0]?.has_work === true,
                () => drainAtomicmarketSalesFilters(
                    longRunningPool,
                    SALES_FILTERS_BATCH_SIZE,
                    SALES_FILTERS_DRAIN_BUDGET_MS,
                    SALES_FILTERS_STATEMENT_TIMEOUT_MS,
                    SALES_FILTERS_WORK_MEM_MB,
                    // yield between batches the moment the reader falls behind (not just
                    // at tick start) so a large budget stays reader-safe — the drain
                    // releases priority instantly instead of running out its whole window
                    () => this.filler.shouldDeferDrain(),
                ),
            ));

        this.filler.jobs.add('refresh_atomicmarket_sales_filters_price', 60 * 60, JobQueuePriority.LOW, async () => {
            await longRunningPool.query('SELECT refresh_atomicmarket_sales_filters_price()');
        });

        this.filler.jobs.add('update_atomicmarket_stats_market', 60 * 2, JobQueuePriority.MEDIUM, async () => {
            await this.connection.database.query(
                'SELECT update_atomicmarket_stats_market()'
            );
        });

        this.filler.jobs.add('update_atomicmarket_template_prices', 60 * 60, JobQueuePriority.LOW, async () => {
            await longRunningPool.query('SELECT update_atomicmarket_template_prices()');
        });

        // reconcile_atomicmarket_listings disabled 2026-04-15. This job called
        // get_table_rows on atomicmarket.{tbuyo,buyoffers,sales,auctions} every
        // 30 min as a drift canary; the upstream RPC node stopped accepting
        // the queries ("Invalid name at /v1/chain/get_table_rows") and the job
        // had been logging repeated errors ever since. Event-based filler ingest
        // is authoritative; reconcile method bodies (reconcileListings +
        // reconcileListingType) retained below for easy re-enable if we ever
        // want to reintroduce a drift check.

        return (): any => destructors.map(fn => fn());
    }

    private async reconcileListings(pool: Pool): Promise<void> {
        const lastIrreversibleBlock = this.filler.reader.lastIrreversibleBlock;

        if (!lastIrreversibleBlock) {
            return;
        }

        const configs: Array<{
            dbTable: string;
            idColumn: string;
            onChainTable: string;
            activeStates: number[];
            cancelState: number;
        }> = [
            {
                dbTable: 'atomicmarket_template_buyoffers',
                idColumn: 'buyoffer_id',
                onChainTable: 'tbuyo',
                activeStates: [TemplateBuyofferState.LISTED.valueOf()],
                cancelState: TemplateBuyofferState.CANCELED.valueOf(),
            },
            {
                dbTable: 'atomicmarket_buyoffers',
                idColumn: 'buyoffer_id',
                onChainTable: 'buyoffers',
                activeStates: [BuyofferState.PENDING.valueOf()],
                cancelState: BuyofferState.CANCELED.valueOf(),
            },
            {
                dbTable: 'atomicmarket_sales',
                idColumn: 'sale_id',
                onChainTable: 'sales',
                activeStates: [SaleState.WAITING.valueOf(), SaleState.LISTED.valueOf()],
                cancelState: SaleState.CANCELED.valueOf(),
            },
            {
                dbTable: 'atomicmarket_auctions',
                idColumn: 'auction_id',
                onChainTable: 'auctions',
                activeStates: [AuctionState.WAITING.valueOf(), AuctionState.LISTED.valueOf()],
                cancelState: AuctionState.CANCELED.valueOf(),
            },
        ];

        for (const config of configs) {
            try {
                const count = await this.reconcileListingType(config, lastIrreversibleBlock, pool);

                if (count > 0) {
                    logger.warn(`Reconciliation: marked ${count} stale entries as canceled in ${config.dbTable}`);
                }
            } catch (e) {
                logger.error(`Reconciliation failed for ${config.dbTable}: ${e.message}`);
            }
        }
    }

    private async reconcileListingType(
        config: {
            dbTable: string;
            idColumn: string;
            onChainTable: string;
            activeStates: number[];
            cancelState: number;
        },
        lastIrreversibleBlock: number,
        pool: Pool
    ): Promise<number> {
        const batchSize = 100;
        let totalReconciled = 0;
        let lastId = '0';

        while (true) {
            const dbResult = await pool.query(
                'SELECT ' + config.idColumn + ' FROM ' + config.dbTable +
                ' WHERE market_contract = $1 AND state = ANY($2) AND created_at_block <= $3 AND ' +
                config.idColumn + ' > $4 ORDER BY ' + config.idColumn + ' LIMIT $5',
                [this.args.atomicmarket_account, config.activeStates, lastIrreversibleBlock, lastId, batchSize]
            );

            if (dbResult.rows.length === 0) {
                break;
            }

            const dbIds: string[] = dbResult.rows.map((row: {[key: string]: string}) => row[config.idColumn]);
            lastId = dbIds[dbIds.length - 1];

            const onChainIds = new Set<string>();
            const minId = dbIds[0];
            const maxId = String(BigInt(dbIds[dbIds.length - 1]) + 1n);
            let lowerBound: string = minId;

            while (true) {
                const result = await this.connection.chain.rpc.get_table_rows({
                    json: true,
                    code: this.args.atomicmarket_account,
                    scope: this.args.atomicmarket_account,
                    table: config.onChainTable,
                    lower_bound: lowerBound,
                    upper_bound: maxId,
                    limit: 100,
                });

                for (const row of result.rows) {
                    onChainIds.add(String(row[config.idColumn]));
                }

                if (!result.more || result.rows.length === 0) {
                    break;
                }

                lowerBound = String(BigInt(result.rows[result.rows.length - 1][config.idColumn]) + 1n);
            }

            const staleIds = dbIds.filter(id => !onChainIds.has(id));

            if (staleIds.length > 0) {
                const now = Date.now();

                await pool.query(
                    'UPDATE ' + config.dbTable + ' SET state = $1, updated_at_time = $2 ' +
                    'WHERE market_contract = $3 AND ' + config.idColumn + ' = ANY($4) AND state = ANY($5)',
                    [config.cancelState, now, this.args.atomicmarket_account, staleIds, config.activeStates]
                );

                totalReconciled += staleIds.length;
            }
        }

        return totalReconciled;
    }
}

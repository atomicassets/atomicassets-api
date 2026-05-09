import * as fs from 'fs';
import { Pool, PoolClient } from 'pg';

import { ContractHandler } from '../interfaces';
import logger from '../../../utils/winston';
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

        this.filler.jobs.add('update_atomicmarket_sale_mints', 60, JobQueuePriority.MEDIUM, async () => {
            await this.connection.database.query(
                'CALL update_atomicmarket_sale_mints($1, $2)',
                [this.args.atomicmarket_account, this.filler.reader.lastIrreversibleBlock]
            );
        });

        this.filler.jobs.add('update_atomicmarket_buyoffer_mints', 60, JobQueuePriority.MEDIUM, async () => {
            await this.connection.database.query(
                'CALL update_atomicmarket_buyoffer_mints($1, $2)',
                [this.args.atomicmarket_account, this.filler.reader.lastIrreversibleBlock]
            );
        });

        this.filler.jobs.add('update_atomicmarket_auction_mints', 60, JobQueuePriority.MEDIUM, async () => {
            await this.connection.database.query(
                'CALL update_atomicmarket_auction_mints($1, $2)',
                [this.args.atomicmarket_account, this.filler.reader.lastIrreversibleBlock]
            );
        });

        // Cadence bumped 20s → 60s and gated by a cheap EXISTS probe after the
        // 2026-04-24 00:01 UTC cliff where cold-cache joins across atomicassets_*
        // tables saturated Cinder I/O on eca-wax-mainnet-cluster. The proc is
        // event-driven (reads atomicmarket_sales_filters_updates queue) but
        // still pays temp-table + CTE-plan cost per empty-queue run. The probe
        // races harmlessly with the proc's own DELETE on the queue — a late
        // insertion between probe and call just falls through to the proc,
        // which returns quickly if the queue is drained by then.
        this.filler.jobs.add('update_atomicmarket_sales_filters', 60, JobQueuePriority.HIGH, async () => {
            // Skip while the filler is catching up — the proc holds long
            // statement-timeout transactions that contend with block writes
            // on the same hot rows. See Filler.isFallingBehind for context.
            if (this.filler.isFallingBehind()) {
                return;
            }
            const probe = await longRunningPool.query(
                'SELECT EXISTS(SELECT 1 FROM atomicmarket_sales_filters_updates LIMIT 1) AS has_work'
            );
            if (!probe.rows[0]?.has_work) return;
            await longRunningPool.query('SELECT update_atomicmarket_sales_filters()');
        });

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

import * as fs from 'fs';
import { Pool, PoolClient } from 'pg';

import { ContractHandler } from '../interfaces';
import logger from '../../../utils/winston';
import { ConfigTableRow, TokenConfigsTableRow } from './types/tables';
import DataProcessor from '../../processor';
import ApiNotificationSender from '../../notifier';
import { assetProcessor } from './processors/assets';
import { balanceProcessor } from './processors/balances';
import { collectionProcessor } from './processors/collections';
import { configProcessor } from './processors/config';
import { logProcessor } from './processors/logs';
import { offerProcessor } from './processors/offers';
import { schemaProcessor } from './processors/schemas';
import { templateProcessor } from './processors/templates';
import Filler  from '../../filler';
import { JobQueuePriority } from '../../jobqueue';
import { positiveIntEnv } from '../../../utils/env';

export const ATOMICASSETS_BASE_PRIORITY = 0;

// AtomicAssetsHandler.init() skips its eager missing-mint reconciliation while the reader is more
// than this many blocks behind chain head (the deferred update_atomicassets_mints job fills the
// backlog once near head). Env-tunable per deployment.
const MINT_RECONCILIATION_MAX_LAG_BLOCKS = positiveIntEnv('ATOMICASSETS_MINT_RECONCILIATION_MAX_LAG_BLOCKS', 10_000);

/**
 * Decide whether init()'s eager missing-mint reconciliation runs for this start, from the
 * reader's persisted position and the chain head probe.
 *
 * Fail closed: if either position is unknown/non-numeric (missing contract_readers row, failed
 * probe), treat the reader as far behind and skip - never fall open into the expensive
 * reconciliation during catch-up. Lag clamps at >= 0 so a reader at or past the probed head
 * counts as caught up.
 */
export function shouldSkipMintReconciliation(
    readerBlock: number, headBlock: number, maxLagBlocks: number
): { skip: boolean, blocksBehindHead: number | null } {
    const blocksBehindHead = (Number.isFinite(readerBlock) && Number.isFinite(headBlock))
        ? Math.max(headBlock - readerBlock, 0)
        : null;

    return {
        skip: blocksBehindHead === null || blocksBehindHead > maxLagBlocks,
        blocksBehindHead,
    };
}

export enum OfferState {
    PENDING = 0,
    INVALID = 1,
    UNKNOWN = 2,
    ACCEPTED = 3,
    DECLINED = 4,
    CANCELLED = 5
}

export enum AtomicAssetsUpdatePriority {
    INDEPENDENT = ATOMICASSETS_BASE_PRIORITY + 10,
    TABLE_BALANCES = ATOMICASSETS_BASE_PRIORITY + 10,
    TABLE_CONFIG = ATOMICASSETS_BASE_PRIORITY + 10,
    TABLE_COLLECTIONS = ATOMICASSETS_BASE_PRIORITY + 20,
    TABLE_SCHEMAS = ATOMICASSETS_BASE_PRIORITY + 20,
    TABLE_TEMPLATES = ATOMICASSETS_BASE_PRIORITY + 40,
    ACTION_MINT_ASSET = ATOMICASSETS_BASE_PRIORITY + 50,
    ACTION_UPDATE_ASSET = ATOMICASSETS_BASE_PRIORITY + 60,
    ACTION_CREATE_OFFER = ATOMICASSETS_BASE_PRIORITY + 80,
    ACTION_UPDATE_OFFER = ATOMICASSETS_BASE_PRIORITY + 90,
    LOGS = 0
}

export type AtomicAssetsReaderArgs = {
    atomicassets_account: string,
    store_transfers: boolean,
    store_logs: boolean
};

export default class AtomicAssetsHandler extends ContractHandler {
    static handlerName = 'atomicassets';

    declare readonly args: AtomicAssetsReaderArgs;

    config: ConfigTableRow;
    tokenconfigs: TokenConfigsTableRow;

    static async setup(client: PoolClient): Promise<boolean> {
        const existsQuery = await client.query(
            'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2)',
            ['public', 'atomicassets_config']
        );

        const views = [
            'atomicassets_asset_mints_master', 'atomicassets_templates_master',
            'atomicassets_schemas_master', 'atomicassets_collections_master', 'atomicassets_offers_master',
            'atomicassets_transfers_master'
        ];

        if (!existsQuery.rows[0].exists) {
            logger.info('Could not find AtomicAssets tables. Create them now...');

            await client.query(fs.readFileSync('./definitions/tables/atomicassets_tables.sql', {
                encoding: 'utf8'
            }));

            for (const view of views) {
                await client.query(fs.readFileSync('./definitions/views/' + view + '.sql', {encoding: 'utf8'}));
            }

            await client.query(fs.readFileSync('./definitions/views/atomicassets_assets_master.sql', {encoding: 'utf8'}));

            await client.query(fs.readFileSync('./definitions/procedures/atomicassets_mints.sql', {encoding: 'utf8'}));

            logger.info('AtomicAssets tables successfully created');

            return true;
        }

        return false;
    }

    static async upgrade(client: PoolClient, version: string): Promise<void> {
        if (version === '1.2.1') {
            await client.query(fs.readFileSync('./definitions/procedures/atomicassets_mints.sql', {encoding: 'utf8'}));
        }

        if (version === '1.2.2') {
            await client.query(fs.readFileSync('./definitions/procedures/atomicassets_mints.sql', {encoding: 'utf8'}));

            await client.query('DROP VIEW IF EXISTS atomicassets_assets_master CASCADE;');
            await client.query(fs.readFileSync('./definitions/views/atomicassets_assets_master.sql', {encoding: 'utf8'}));

            await client.query('DROP VIEW IF EXISTS atomicassets_asset_mints_master CASCADE;');
            await client.query(fs.readFileSync('./definitions/views/atomicassets_asset_mints_master.sql', {encoding: 'utf8'}));
        }

        if (version === '1.3.20') {
            await client.query(fs.readFileSync('./definitions/views/atomicassets_schemas_master.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/views/atomicassets_templates_master.sql', {encoding: 'utf8'}));
            await client.query(fs.readFileSync('./definitions/views/atomicassets_assets_master.sql', {encoding: 'utf8'}));
        }
    }

    constructor(filler: Filler, args: {[key: string]: any}) {
        super(filler, args);

        if (typeof args.atomicassets_account !== 'string') {
            throw new Error('AtomicAssets: Argument missing in atomicassets handler: atomicassets_account');
        }

        if (!this.args.store_logs) {
            logger.warn('AtomicAssets: disabled store_logs');
        }

        if (!this.args.store_transfers) {
            logger.warn('AtomicAssets: disabled store_transfers');
        }
    }

    async init(client: PoolClient): Promise<void> {
        const configQuery = await client.query(
            'SELECT * FROM atomicassets_config WHERE contract = $1',
            [this.args.atomicassets_account]
        );

        if (configQuery.rows.length === 0) {
            const tokenconfigsTable = await this.connection.chain.rpc.get_table_rows({
                json: true, code: this.args.atomicassets_account,
                scope: this.args.atomicassets_account, table: 'tokenconfigs'
            });

            if (tokenconfigsTable.rows[0].standard !== 'atomicassets') {
                throw new Error('AtomicAssets: Contract not deployed on the account');
            }

            this.tokenconfigs = {
                version: tokenconfigsTable.rows[0].version,
                standard: tokenconfigsTable.rows[0].standard
            };

            if (tokenconfigsTable.rows.length === 0) {
                throw new Error('AtomicAssets: Tokenconfigs table empty');
            }

            // Seed config and supported tokens from chain
            const configTable = await this.connection.chain.rpc.get_table_rows({
                json: true, code: this.args.atomicassets_account,
                scope: this.args.atomicassets_account, table: 'config'
            });

            if (configTable.rows.length === 0) {
                throw new Error('AtomicAssets: Config table empty — cannot seed supported tokens');
            }

            await client.query(
                'INSERT INTO atomicassets_config (contract, version, collection_format) VALUES ($1, $2, $3)',
                [this.args.atomicassets_account, tokenconfigsTable.rows[0].version,
                    configTable.rows[0].collection_format.map((element: any) => JSON.stringify(element))]
            );

            for (const token of configTable.rows[0].supported_tokens) {
                await client.query(
                    'INSERT INTO atomicassets_tokens (contract, token_symbol, token_contract, token_precision) ' +
                    'VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                    [
                        this.args.atomicassets_account,
                        token.sym.split(',')[1],
                        token.contract,
                        token.sym.split(',')[0]
                    ]
                );
            }

            this.config = {
                supported_tokens: configTable.rows[0].supported_tokens,
                asset_counter: 0,
                offer_counter: 0,
                collection_format: configTable.rows[0].collection_format
            };
        } else {
            const tokensQuery = await this.connection.database.query(
                'SELECT * FROM atomicassets_tokens WHERE contract = $1',
                [this.args.atomicassets_account]
            );

            this.config = {
                supported_tokens: tokensQuery.rows.map(row => ({
                    contract: row.token_contract,
                    sym: row.token_precision + ',' + row.token_symbol
                })),
                asset_counter: 0,
                offer_counter: 0,
                collection_format: configQuery.rows[0].collection_format
            };

            this.tokenconfigs = {
                version: configQuery.rows[0].version,
                standard: 'atomicassets'
            };
        }

        const chainInfo = await this.connection.chain.rpc.get_info();
        const irreversibleBlockQuery = await this.connection.database.query(
            'SELECT MIN(block_num) "block" FROM reversible_blocks WHERE reader = $1',
            [this.filler.reader.name]
        );
        const lastIrreversibleBlock = irreversibleBlockQuery.rows[0].block ? (irreversibleBlockQuery.rows[0].block - 1) : chainInfo.last_irreversible_block_num;

        logger.info('Check for missing mint numbers of ' + this.args.atomicassets_account + '. Last irreversible block #' + lastIrreversibleBlock);

        // Reader-priority gate: the reconciliation below loops `CALL update_atomicassets_mints`
        // (bounded 50k/call) + a full atomicassets_assets COUNT until the missing-mint backlog is
        // under 50k. While the reader is catching up the update_atomicassets_mints job is deferred
        // (shouldDeferDrain), so on a large chain this backlog is millions of rows - running it at
        // boot then blocks the reader from starting for a very long time AND busts the connection
        // statement_timeout on the COUNT, turning any restart mid-catchup into a crash-loop.
        // shouldDeferDrain() can't be used here (reader.blocksUntilHead is still 0 before the
        // reader starts), so compare the reader's stored position to chain head directly. The
        // gated update_atomicassets_mints job fills the backlog once the reader reaches head.
        const readerPositionQuery = await this.connection.database.query(
            'SELECT block_num FROM contract_readers WHERE name = $1',
            [this.filler.reader.name]
        );
        const { skip: skipMintReconciliation, blocksBehindHead } = shouldSkipMintReconciliation(
            Number(readerPositionQuery.rows[0]?.block_num),
            Number(chainInfo.head_block_num),
            MINT_RECONCILIATION_MAX_LAG_BLOCKS
        );

        if (skipMintReconciliation) {
            logger.info('Skipping eager missing-mint reconciliation (reader ' +
                (blocksBehindHead === null ? 'position unknown' : '~' + blocksBehindHead + ' blocks behind head') +
                '); the update_atomicassets_mints job fills the backlog once near head');
        }

        const contractRows = skipMintReconciliation
            ? []
            : (await this.connection.database.query('SELECT * FROM atomicassets_config')).rows;

        for (const row of contractRows) {
            let emptyMints;

            do {
                if (emptyMints) {
                    await this.connection.database.query(
                        'CALL update_atomicassets_mints($1, $2)',
                        [row.contract, lastIrreversibleBlock]
                    );

                    logger.info(emptyMints + ' missing asset mints for contract ' + row.contract);
                }

                const countQuery = await this.connection.database.query(
                    'SELECT COUNT(*) "count" FROM atomicassets_assets WHERE template_id IS NOT NULL AND template_mint IS NULL AND contract = $1 AND minted_at_block <= $2',
                    [row.contract, lastIrreversibleBlock]
                );

                emptyMints = countQuery.rows[0].count;
            } while (emptyMints > 50000);
        }
    }

    async deleteDB(client: PoolClient): Promise<void> {
        const tables = [
            'atomicassets_assets', 'atomicassets_assets_backed_tokens', 'atomicassets_mints',
            'atomicassets_balances', 'atomicassets_collections', 'atomicassets_config',
            'atomicassets_offers', 'atomicassets_offers_assets',
            'atomicassets_templates', 'atomicassets_schemas',
            'atomicassets_tokens', 'atomicassets_transfers', 'atomicassets_transfers_assets'
        ];

        for (const table of tables) {
            await client.query(
                'DELETE FROM ' + client.escapeIdentifier(table) + ' WHERE contract = $1',
                [this.args.atomicassets_account]
            );
        }
    }

    async register(processor: DataProcessor, notifier: ApiNotificationSender): Promise<() => any> {
        const destructors: Array<() => any> = [];

        // Dedicated pool for long-running maintenance jobs (mints, template counts).
        // The main pool's 30s statement_timeout is too short and SET LOCAL is ineffective
        // through PgBouncer transaction pooling, so these jobs need their own pool.
        //
        // connectionTimeoutMillis must be ≥ statement_timeout: with max:1 and multi-minute
        // work units, queued calls would otherwise hit the parent pool's 5s acquire timeout
        // (postgres.ts:40) while the single client is still running the previous invocation.
        // Preemptive fix — atomicmarket's sibling pool had this exact failure on WAX.
        const longRunningPool: Pool = this.connection.database.createPool({
            connectionTimeoutMillis: 10 * 60 * 1_000, // 10 min — headroom over statement_timeout
            statement_timeout: 300_000, // 5 min
            max: 1,
        });
        destructors.push(() => { void longRunningPool.end().catch(() => {}); });

        destructors.push(assetProcessor(this, processor, notifier));
        destructors.push(balanceProcessor(this, processor));
        destructors.push(collectionProcessor(this, processor));
        destructors.push(configProcessor(this, processor));
        destructors.push(offerProcessor(this, processor, notifier));
        destructors.push(schemaProcessor(this, processor));
        destructors.push(templateProcessor(this, processor));

        if (this.args.store_logs) {
            destructors.push(logProcessor(this, processor));
        }

        this.filler.jobs.add('aggregate atomicassets_asset_counts', 60 * 10, JobQueuePriority.LOW, async () => {
            await longRunningPool.query(
                `
                WITH del AS (
                    DELETE FROM atomicassets_asset_counts
                    WHERE (contract, collection_name, schema_name, template_id) IN (
                        SELECT contract, collection_name, schema_name,template_id FROM atomicassets_asset_counts WHERE dirty AND contract = $1
                    )
                    RETURNING contract, collection_name, schema_name, template_id, assets, burned, owned
                )
                    INSERT INTO atomicassets_asset_counts(contract, collection_name, schema_name, template_id, assets, burned, owned, dirty)
                        SELECT contract, collection_name, schema_name, template_id,
                            COALESCE(SUM(assets)::INT, 0), COALESCE(SUM(burned)::INT, 0), COALESCE(SUM(owned)::INT, 0), NULL
                        FROM del
                        GROUP BY contract, collection_name, schema_name, template_id
                        HAVING COALESCE(SUM(assets)::INT, 0) != 0
                    ON CONFLICT (contract, collection_name, schema_name, template_id) WHERE dirty IS NULL
                    DO UPDATE SET
                        assets = EXCLUDED.assets,
                        burned = EXCLUDED.burned,
                        owned = EXCLUDED.owned
                `,
                [this.args.atomicassets_account]
            );
        });

        this.filler.jobs.add('update_atomicassets_mints', 30, JobQueuePriority.MEDIUM, async () => {
            // Skip while the reader is catching up — reader-priority gate with
            // hysteresis, shared with the atomicmarket drains (see
            // Filler.shouldDeferDrain).
            if (this.filler.shouldDeferDrain()) {
                return;
            }
            await longRunningPool.query(
                'CALL update_atomicassets_mints($1, $2)',
                [this.args.atomicassets_account, this.filler.reader.lastIrreversibleBlock]
            );
        });

        return (): any => destructors.map(fn => fn());
    }
}

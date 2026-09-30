import { ClientBase } from 'pg';

import { readSnapshotRows } from './snapshot-file';
import { ORIGINAL_MINTS_TABLE, originalMintsTableExists } from './processors/bridge';
import { encodeDatabaseJson } from '../../utils';
import logger from '../../../utils/winston';

type SnapshotFiles = {
    assets: string,
    cardTotals: string,
    config: string,
};

export type SnapshotImportOptions = {
    // Block S: the snapshot holds every change up to and including it.
    snapshotBlock: number,
    simpleassetsAccount: string,
    // The reader whose contracts hold this simpleassets entry: a block it processed above S is lost for good.
    simpleassetsReader: string,
    files: SnapshotFiles,
    // Without a bridge the import loads the three tables and links nothing. atomicassetsReader
    // names the reader that runs the atomicassets handler: the backfill sees only what it stored.
    bridge?: { atomicassetsAccount: string, bridgeAccount: string, atomicassetsReader: string },
    linkBatchSize?: number,
};

export type SnapshotImportResult = {
    assets: number,
    cardTotals: number,
    config: number,
    links: number,
    linksWithoutMint: number,
};

type StagedTable = {
    file: keyof SnapshotFiles,
    table: string,
    staging: string,
    columns: string[],
    requiredColumns: string[],
    jsonColumns: string[],
};

const STAGED_TABLES: StagedTable[] = [
    {
        file: 'assets',
        table: 'simpleassets_assets',
        staging: 'simpleassets_import_assets',
        columns: [
            'contract', 'asset_id', 'author', 'category', 'owner', 'mutable_data', 'immutable_data',
            'burned_by_account', 'burned_at_block', 'burned_at_time', 'transferred_at_block', 'transferred_at_time',
            'updated_at_block', 'updated_at_time', 'minted_at_block', 'minted_at_time', 'mint_number', 'mint_group',
        ],
        requiredColumns: [
            'contract', 'asset_id', 'author', 'category', 'owner', 'mutable_data', 'immutable_data',
            'transferred_at_block', 'transferred_at_time', 'updated_at_time', 'minted_at_block', 'minted_at_time',
            'mint_number', 'mint_group',
        ],
        jsonColumns: ['mutable_data', 'immutable_data'],
    },
    {
        file: 'cardTotals',
        table: 'simpleassets_card_totals',
        staging: 'simpleassets_import_card_totals',
        columns: ['contract', 'author', 'mint_group', 'total_ever'],
        requiredColumns: ['contract', 'author', 'mint_group', 'total_ever'],
        jsonColumns: [],
    },
    {
        file: 'config',
        table: 'simpleassets_config',
        staging: 'simpleassets_import_config',
        columns: ['contract', 'version', 'bootstrap_baseline_block'],
        requiredColumns: ['contract', 'version'],
        jsonColumns: [],
    },
];

const STAGE_BATCH_ROWS = 1000;
const DEFAULT_LINK_BATCH_SIZE = 10000;

// A sassets_id that is not a bigint links nothing. CASE keeps the cast behind the checks.
const SASSETS_ID_SQL = `CASE
    WHEN a.immutable_data->>'sassets_id' !~ '^[0-9]{1,19}$' THEN NULL
    WHEN (a.immutable_data->>'sassets_id')::numeric > 9223372036854775807 THEN NULL
    ELSE (a.immutable_data->>'sassets_id')::bigint END`;

function stagedValue(table: StagedTable, column: string, value: unknown): unknown {
    if (value === null || value === undefined) {
        return null;
    }

    if (table.jsonColumns.includes(column)) {
        return encodeDatabaseJson(typeof value === 'string' ? JSON.parse(value) : value);
    }

    // mint_group is the JSON array text the reader matches on, so an array is written in that form.
    if (column === 'mint_group' && Array.isArray(value)) {
        return JSON.stringify(value);
    }

    return value;
}

async function stageFile(client: ClientBase, table: StagedTable, file: string, account: string): Promise<void> {
    await client.query('DROP TABLE IF EXISTS pg_temp.' + table.staging);
    await client.query(
        'CREATE TEMP TABLE ' + table.staging + ' ON COMMIT DROP AS SELECT * FROM ' + table.table + ' WITH NO DATA'
    );

    let columns: string[] | null = null;
    let batch: unknown[][] = [];

    const flush = async (): Promise<void> => {
        if (batch.length === 0) {
            return;
        }

        const values: unknown[] = [];
        const rows = batch.map(row => '(' + row.map(value => '$' + values.push(value)).join(', ') + ')');

        await client.query(
            'INSERT INTO ' + table.staging + ' (' + columns.map(column => client.escapeIdentifier(column)).join(', ') + ') ' +
            'VALUES ' + rows.join(', '),
            values
        );

        batch = [];
    };

    for await (const row of readSnapshotRows(file)) {
        const keys = Object.keys(row).sort();

        if (columns === null) {
            const unknown = keys.filter(key => !table.columns.includes(key));

            if (unknown.length > 0) {
                throw new Error('Snapshot file ' + file + ' has columns that ' + table.table + ' does not: ' + unknown.join(', '));
            }

            // Every row has the first row's keys, so checking it covers the file.
            const missing = table.requiredColumns.filter(column => !keys.includes(column));

            if (missing.length > 0) {
                throw new Error('Snapshot file ' + file + ' lacks columns that ' + table.table + ' requires: ' + missing.join(', '));
            }

            columns = keys;
        } else if (keys.join(',') !== columns.join(',')) {
            throw new Error('Snapshot file ' + file + ' has rows with different columns: ' + keys.join(', '));
        }

        batch.push(columns.map(column => stagedValue(table, column, row[column])));

        if (batch.length >= STAGE_BATCH_ROWS) {
            await flush();
        }
    }

    await flush();

    const foreign = await client.query(
        'SELECT DISTINCT contract FROM ' + table.staging + ' WHERE contract IS DISTINCT FROM $1 LIMIT 5',
        [account]
    );

    if (foreign.rowCount > 0) {
        throw new Error('Snapshot file ' + file + ' holds rows of another contract: ' + foreign.rows.map(row => row.contract).join(', '));
    }
}

async function checkPreconditions(client: ClientBase, options: SnapshotImportOptions): Promise<void> {
    const block = options.snapshotBlock;

    const baseline = await client.query(
        'SELECT bootstrap_baseline_block FROM simpleassets_config WHERE contract = $1', [options.simpleassetsAccount]
    );

    if (baseline.rowCount > 0 && baseline.rows[0].bootstrap_baseline_block !== null &&
        Number(baseline.rows[0].bootstrap_baseline_block) !== block) {
        throw new Error(
            'SimpleAssets import: bootstrap_baseline_block of ' + options.simpleassetsAccount + ' is already ' +
            baseline.rows[0].bootstrap_baseline_block + ', not the snapshot block ' + block
        );
    }

    // A reader stores block_num 0 before its first block, so only a processed block above S refuses.
    const simpleassetsReader = await client.query(
        'SELECT block_num FROM contract_readers WHERE name = $1', [options.simpleassetsReader]
    );

    if (simpleassetsReader.rowCount > 0 && Number(simpleassetsReader.rows[0].block_num) > block) {
        throw new Error(
            'SimpleAssets import: simpleassets reader ' + options.simpleassetsReader + ' has processed block ' +
            simpleassetsReader.rows[0].block_num + ', above the snapshot block ' + block
        );
    }

    // Catches a reader that ran past S under another name.
    const mintedAbove = await client.query(
        'SELECT 1 FROM simpleassets_assets WHERE contract = $1 AND minted_at_block > $2 LIMIT 1',
        [options.simpleassetsAccount, block]
    );

    if (mintedAbove.rowCount > 0) {
        throw new Error(
            'SimpleAssets import: simpleassets_assets already holds assets minted above the snapshot block ' + block
        );
    }

    // Before the first import, stored rows predate S and would win over the snapshot under DO NOTHING,
    // and the reader restarting at S+1 never replays what changed them. After it, the baseline is S.
    if (baseline.rowCount === 0 || baseline.rows[0].bootstrap_baseline_block === null) {
        for (const table of ['simpleassets_assets', 'simpleassets_card_totals']) {
            const stored = await client.query('SELECT 1 FROM ' + table + ' WHERE contract = $1 LIMIT 1', [options.simpleassetsAccount]);

            if (stored.rowCount > 0) {
                throw new Error(
                    'SimpleAssets import: ' + table + ' already holds rows of ' + options.simpleassetsAccount +
                    ' and no import has committed, so the snapshot would not replace them'
                );
            }
        }
    }

    if (!options.bridge) {
        return;
    }

    if (!(await originalMintsTableExists(client))) {
        throw new Error('SimpleAssets import: table ' + ORIGINAL_MINTS_TABLE + ' does not exist, so no link can be backfilled');
    }

    // A bridge mint the atomicassets reader has not stored yet would never get a link.
    const reader = await client.query(
        'SELECT block_num FROM contract_readers WHERE name = $1', [options.bridge.atomicassetsReader]
    );

    if (reader.rowCount === 0 || Number(reader.rows[0].block_num) < block) {
        throw new Error(
            'SimpleAssets import: atomicassets reader ' + options.bridge.atomicassetsReader + ' stands at block ' +
            (reader.rowCount === 0 ? 'none (no contract_readers row)' : reader.rows[0].block_num) +
            ', below the snapshot block ' + block
        );
    }

    // Links above S come from a reader that already ran past the snapshot, so this snapshot is stale for them.
    const above = await client.query(
        'SELECT 1 FROM ' + ORIGINAL_MINTS_TABLE + ' WHERE contract = $1 AND original_contract = $2 AND block_num > $3 LIMIT 1',
        [options.bridge.atomicassetsAccount, options.simpleassetsAccount, block]
    );

    if (above.rowCount > 0) {
        throw new Error(
            'SimpleAssets import: ' + ORIGINAL_MINTS_TABLE + ' already holds links above the snapshot block ' + block
        );
    }
}

async function backfillLinks(
    client: ClientBase, options: SnapshotImportOptions
): Promise<{links: number, linksWithoutMint: number}> {
    const { atomicassetsAccount, bridgeAccount } = options.bridge;
    const batchSize = options.linkBatchSize ?? DEFAULT_LINK_BATCH_SIZE;

    let after = '-1';
    let links = 0;
    let linksWithoutMint = 0;

    for (;;) {
        const ids = await client.query(
            'SELECT asset_id FROM atomicassets_mints WHERE contract = $1 AND minter = $2 AND asset_id > $3 ' +
            'ORDER BY asset_id LIMIT $4',
            [atomicassetsAccount, bridgeAccount, after, batchSize]
        );

        if (ids.rowCount === 0) {
            break;
        }

        after = ids.rows[ids.rowCount - 1].asset_id;

        const inserted = await client.query(
            'INSERT INTO ' + ORIGINAL_MINTS_TABLE + ' ' +
            '(contract, asset_id, original_contract, original_asset_id, original_mint, block_num) ' +
            'SELECT b.contract, b.asset_id, $3, b.original_asset_id, s.mint_number, b.minted_at_block ' +
            'FROM (SELECT a.contract, a.asset_id, a.minted_at_block, ' + SASSETS_ID_SQL + ' AS original_asset_id ' +
            '    FROM atomicassets_assets a ' +
            '    WHERE a.contract = $1 AND a.asset_id = ANY($2::bigint[]) AND a.minted_at_block <= $4) b ' +
            'LEFT JOIN simpleassets_assets s ON s.contract = $3 AND s.asset_id = b.original_asset_id ' +
            'WHERE b.original_asset_id IS NOT NULL ' +
            'ON CONFLICT (contract, asset_id) DO NOTHING ' +
            'RETURNING original_mint',
            [atomicassetsAccount, ids.rows.map(row => row.asset_id), options.simpleassetsAccount, options.snapshotBlock]
        );

        links += inserted.rowCount;
        linksWithoutMint += inserted.rows.filter(row => row.original_mint === null).length;
    }

    return { links, linksWithoutMint };
}

/**
 * Loads a SimpleAssets snapshot taken at block S and backfills the links of
 * the bridge mints at or below S, inside the caller's transaction. Rows are
 * staged first and inserted with ON CONFLICT DO NOTHING, so a second run with
 * the same files changes nothing. Seed asset rows get updated_at_block S, so
 * a replayed trace from before S leaves them alone.
 */
export async function runSnapshotImport(client: ClientBase, options: SnapshotImportOptions): Promise<SnapshotImportResult> {
    if (!Number.isSafeInteger(options.snapshotBlock) || options.snapshotBlock <= 0) {
        throw new Error('SimpleAssets import: the snapshot block must be a positive integer');
    }

    const account = options.simpleassetsAccount;
    const block = options.snapshotBlock;

    // Two imports of one contract could both pass the checks, and DO NOTHING would drop the loser's
    // rows while it reports success. The lock ends with the caller's transaction.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['simpleassets-import:' + account]);

    await checkPreconditions(client, options);

    for (const table of STAGED_TABLES) {
        await stageFile(client, table, options.files[table.file], account);
    }

    const configRows = await client.query('SELECT count(*)::int AS n FROM simpleassets_import_config');

    if (configRows.rows[0].n !== 1) {
        throw new Error('SimpleAssets import: the config file must hold one row, found ' + configRows.rows[0].n);
    }

    const assetColumns = STAGED_TABLES[0].columns;
    const assets = await client.query(
        'INSERT INTO simpleassets_assets (' + assetColumns.join(', ') + ') ' +
        'SELECT ' + assetColumns.map(column => column === 'updated_at_block' ? '$1::bigint' : column).join(', ') + ' ' +
        'FROM simpleassets_import_assets ON CONFLICT (contract, asset_id) DO NOTHING',
        [block]
    );

    const cardTotals = await client.query(
        'INSERT INTO simpleassets_card_totals (contract, author, mint_group, total_ever) ' +
        'SELECT contract, author, mint_group, total_ever FROM simpleassets_import_card_totals ' +
        'ON CONFLICT (contract, author, mint_group) DO NOTHING'
    );

    // The handler inserts a config row with no baseline on its first start, so an import after it fills that in.
    const config = await client.query(
        'INSERT INTO simpleassets_config (contract, version, bootstrap_baseline_block) ' +
        'SELECT contract, version, $1::bigint FROM simpleassets_import_config ' +
        'ON CONFLICT (contract) DO UPDATE SET bootstrap_baseline_block = EXCLUDED.bootstrap_baseline_block ' +
        'WHERE simpleassets_config.bootstrap_baseline_block IS NULL',
        [block]
    );

    for (const table of STAGED_TABLES) {
        await client.query('DROP TABLE IF EXISTS pg_temp.' + table.staging);
    }

    const linked = options.bridge ? await backfillLinks(client, options) : { links: 0, linksWithoutMint: 0 };

    if (linked.linksWithoutMint > 0) {
        logger.warn('SimpleAssets import: backfilled links with no mint number', {
            contract: account, links: linked.linksWithoutMint
        });
    }

    return {
        assets: assets.rowCount,
        cardTotals: cardTotals.rowCount,
        config: config.rowCount,
        ...linked,
    };
}

/**
 * Runs the import in a transaction of its own: it commits every table and
 * link together, or nothing. The settings are LOCAL, so they end with the
 * transaction and never reach the next user of a pooled connection.
 */
export async function importSimpleAssetsSnapshot(client: ClientBase, options: SnapshotImportOptions): Promise<SnapshotImportResult> {
    await client.query('BEGIN');

    try {
        // One insert moves every seed row, past a pool's statement cap. The lock bound
        // keeps a wait on a running reader finite, and search_path makes the public.
        // table check and the unqualified writes resolve the same tables.
        await client.query('SET LOCAL statement_timeout = 0');
        await client.query('SET LOCAL lock_timeout = \'60s\'');
        await client.query('SET LOCAL search_path TO public');

        const result = await runSnapshotImport(client, options);

        await client.query('COMMIT');

        return result;
    } catch (error) {
        await client.query('ROLLBACK');

        throw error;
    }
}

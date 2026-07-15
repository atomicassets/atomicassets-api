/**
 * Recovery tooling for an AtomicAssets indexer that ran across the on-chain
 * v2 flip without the v2 filler subscribed (design.md "reconcile command").
 * Seeds current on-chain state for the v2-only tables (templates2,
 * schematypes, authorswaps) and diffs on-chain `templates` against the DB to
 * catch deletions a gap could have missed (deltemplate emits no log action,
 * so there is no trace to replay). Only runs while the target reader is
 * stopped - see assertReaderStopped.
 *
 * The RPC surface is injected (ReconcileRpc) so this module is testable
 * against a mocked pager without a live chain; src/bin/reconcile.ts wires it
 * to the real ConnectionManager.chain.rpc in production.
 */
import { PoolClient } from 'pg';
import { deserialize, ObjectSchema } from 'atomicassets';
import { encodeDatabaseJson } from '../../utils';
import logger from '../../../utils/winston';

export interface ReconcileRpc {
    get_info(): Promise<{ head_block_num: number | string }>;
    get_table_rows(params: {
        json: boolean; code: string; scope: string; table: string;
        limit: number; lower_bound?: any;
    }): Promise<{ rows: any[]; more: any; next_key?: any }>;
    get_table_by_scope(params: {
        code: string; table: string; limit: number; lower_bound?: string;
    }): Promise<{ rows: Array<{ scope: string }>; more: any }>;
}

export interface ReaderRow {
    live: boolean;
    updated: number | string;
}

export const RECONCILE_STOPPED_READER_SAFETY_THRESHOLD_MS = 60_000;

/**
 * Refuses to proceed unless the reader is stopped and has been for at least
 * the safety threshold - reconcile writes directly against tables the live
 * filler also writes, so running it concurrently races the reader's own
 * transactions.
 */
export function assertReaderStopped(
    reader: ReaderRow | undefined, readerName: string, now: number = Date.now(),
    thresholdMs: number = RECONCILE_STOPPED_READER_SAFETY_THRESHOLD_MS
): void {
    if (!reader) {
        throw new Error('AtomicAssets reconcile: no contract_readers row found for reader "' + readerName + '"');
    }

    if (reader.live) {
        throw new Error(
            'AtomicAssets reconcile: reader "' + readerName + '" is still live. Stop the filler before running reconcile.'
        );
    }

    const updatedAt = Number(reader.updated);
    const ageMs = now - updatedAt;

    if (!Number.isFinite(updatedAt) || ageMs < thresholdMs) {
        throw new Error(
            'AtomicAssets reconcile: reader "' + readerName + '" was updated too recently (' +
            (Number.isFinite(ageMs) ? ageMs + 'ms' : 'unknown time') + ' ago; needs >= ' + thresholdMs +
            'ms). Wait for the filler to fully stop before running reconcile.'
        );
    }
}

function decodeBytes(data: string | number[]): Uint8Array {
    return typeof data === 'string'
        ? Uint8Array.from(Buffer.from(data, 'hex'))
        : new Uint8Array(data);
}

// Generous per-table ceiling on rows walked in a single walkTable call - guards against a
// runaway/hostile RPC endpoint that keeps reporting more=true forever rather than making the
// reconcile loop iterate indefinitely. No legitimate table on this chain approaches this size.
const MAX_WALK_ROWS = 10_000_000;

/** Exported for unit testing the pagination guards in isolation, without a database. */
export async function walkTable(
    rpc: ReconcileRpc, code: string, scope: string, table: string
): Promise<any[]> {
    const rows: any[] = [];
    let lowerBound: any = '';

    for (;;) {
        const result = await rpc.get_table_rows({
            json: true, code, scope, table, limit: 1000, lower_bound: lowerBound
        });

        rows.push(...result.rows);

        if (rows.length > MAX_WALK_ROWS) {
            throw new Error(
                'AtomicAssets reconcile: get_table_rows for ' + code + '/' + scope + '/' + table +
                ' exceeded the ' + MAX_WALK_ROWS + ' row safety ceiling for a single table walk. Refusing to ' +
                'keep paging - this indicates a runaway or hostile RPC endpoint.'
            );
        }

        if (!result.more) {
            break;
        }

        if (result.next_key === undefined || result.next_key === null || result.next_key === '') {
            throw new Error(
                'AtomicAssets reconcile: get_table_rows for ' + code + '/' + scope + '/' + table +
                ' reported more rows available (more=true) but returned no next_key to page from. Refusing to ' +
                'fall back to "more" as a lower_bound, which would corrupt pagination.'
            );
        }

        if (result.next_key === lowerBound) {
            throw new Error(
                'AtomicAssets reconcile: get_table_rows for ' + code + '/' + scope + '/' + table +
                ' returned a next_key equal to the previous lower_bound. Refusing to loop on a page that is not ' +
                'advancing, which would otherwise re-fetch the same rows forever.'
            );
        }

        lowerBound = result.next_key;
    }

    return rows;
}

async function walkScopes(rpc: ReconcileRpc, code: string, table: string): Promise<string[]> {
    const scopes: string[] = [];
    let lowerBound: string | undefined;

    for (;;) {
        const result = await rpc.get_table_by_scope({ code, table, limit: 1000, lower_bound: lowerBound });

        scopes.push(...result.rows.map(row => row.scope));

        if (!result.more) {
            break;
        }

        lowerBound = typeof result.more === 'string' ? result.more : undefined;

        if (!lowerBound) {
            break;
        }
    }

    return scopes;
}

/** Walks a per-collection-scoped table across every collection scope, tagging each row with its scope. */
async function walkScopedTable(
    rpc: ReconcileRpc, code: string, table: string
): Promise<Array<{ scope: string; row: any }>> {
    const scopes = await walkScopes(rpc, code, table);
    const out: Array<{ scope: string; row: any }> = [];

    for (const scope of scopes) {
        const rows = await walkTable(rpc, code, scope, table);

        for (const row of rows) {
            out.push({ scope, row });
        }
    }

    return out;
}

export interface ReconcileCounts {
    templates2Seeded: number;
    templatesMutableDataNulled: number;
    templatesMarkedDeleted: number;
    schemaTypesSeeded: number;
    authorSwapsSeeded: number;
    authorSwapsCleared: number;
}

/**
 * Runs the reconcile pass for a single configured atomicassets contract.
 * Assumes the caller already verified the reader is stopped
 * (assertReaderStopped) - reconcile has no reader identity of its own, it
 * only knows the contract account it is repairing.
 */
export async function reconcileAtomicAssetsContract(
    client: PoolClient, rpc: ReconcileRpc, contract: string
): Promise<ReconcileCounts> {
    const info = await rpc.get_info();
    // Snapshot block captured once, before the first table walk: get_table_rows
    // serves head state, so a last-irreversible stamp would predate the data
    // read. The stamp is approximate either way (sequential table walks against
    // a moving chain) - documented in UPGRADING.md and in the log line below.
    const snapshotBlock = Number(info.head_block_num);
    const snapshotTime = Date.now();

    const counts: ReconcileCounts = {
        templates2Seeded: 0,
        templatesMutableDataNulled: 0,
        templatesMarkedDeleted: 0,
        schemaTypesSeeded: 0,
        authorSwapsSeeded: 0,
        authorSwapsCleared: 0,
    };

    // --- templates2: mutable_data seed + NULL-out for templates whose templates2 row is gone ---
    const templates2Rows = await walkScopedTable(rpc, contract, 'templates2');
    const onChainMutableTemplateIds: string[] = [];

    await client.query('BEGIN');
    try {
        for (const { scope, row } of templates2Rows) {
            const schemaQuery = await client.query(
                'SELECT format FROM atomicassets_schemas WHERE contract = $1 AND collection_name = $2 AND schema_name = $3',
                [contract, scope, row.schema_name]
            );

            if (schemaQuery.rowCount === 0) {
                // Schema this instance doesn't know about locally - the mutable_data can't be
                // decoded, but the template_id is still present on-chain in templates2. Excluding
                // it here would make the null-out below (in)correctly treat it as gone on-chain and
                // wipe its live mutable_data.
                onChainMutableTemplateIds.push(String(row.template_id));
                logger.warn(
                    'AtomicAssets reconcile: skipping templates2 row for unknown schema ' +
                    scope + '/' + row.schema_name + ' (template ' + row.template_id + ') - preserving its ' +
                    'existing mutable_data rather than nulling it out'
                );
                continue;
            }

            const mutableData = deserialize(decodeBytes(row.mutable_serialized_data), ObjectSchema(schemaQuery.rows[0].format));

            const result = await client.query(
                'UPDATE atomicassets_templates SET mutable_data = $1 ' +
                'WHERE contract = $2 AND template_id = $3 AND deleted_at_block IS NULL',
                [encodeDatabaseJson(mutableData), contract, row.template_id]
            );

            if (result.rowCount > 0) {
                counts.templates2Seeded += result.rowCount;
                onChainMutableTemplateIds.push(String(row.template_id));
            }
        }

        if (templates2Rows.length === 0) {
            const liveMutable = await client.query(
                'SELECT EXISTS(SELECT 1 FROM atomicassets_templates WHERE contract = $1 AND deleted_at_block IS NULL ' +
                'AND mutable_data IS NOT NULL) AS live',
                [contract]
            );

            if (liveMutable.rows[0].live) {
                throw new Error(
                    'AtomicAssets reconcile: on-chain templates2 enumeration for ' + contract + ' returned zero rows ' +
                    'while the database still has live templates with mutable_data set. Refusing to NULL out mutable_data ' +
                    'for every live template - this likely indicates an RPC/enumeration failure rather than a real empty ' +
                    'table. Nothing was changed.'
                );
            }
        }

        const nullOutResult = await client.query(
            'UPDATE atomicassets_templates SET mutable_data = NULL ' +
            'WHERE contract = $1 AND deleted_at_block IS NULL AND mutable_data IS NOT NULL ' +
            'AND NOT (template_id = ANY($2::bigint[]))',
            [contract, onChainMutableTemplateIds]
        );
        counts.templatesMutableDataNulled = nullOutResult.rowCount;

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }

    // --- templates: deletion diff (deltemplate emits no log action to replay) ---
    const templateRows = await walkScopedTable(rpc, contract, 'templates');
    const onChainTemplateIds = templateRows.map(({ row }) => String(row.template_id));

    await client.query('BEGIN');
    try {
        if (templateRows.length === 0) {
            const liveTemplates = await client.query(
                'SELECT EXISTS(SELECT 1 FROM atomicassets_templates WHERE contract = $1 AND deleted_at_block IS NULL) AS live',
                [contract]
            );

            if (liveTemplates.rows[0].live) {
                throw new Error(
                    'AtomicAssets reconcile: on-chain templates enumeration for ' + contract + ' returned zero rows ' +
                    'while the database still has live templates. Refusing to mark every live template deleted - this ' +
                    'likely indicates an RPC/enumeration failure rather than a real empty collection. Nothing was changed.'
                );
            }
        }

        const deletedResult = await client.query(
            'UPDATE atomicassets_templates SET deleted_at_block = $2, deleted_at_time = $3 ' +
            'WHERE contract = $1 AND deleted_at_block IS NULL AND NOT (template_id = ANY($4::bigint[]))',
            [contract, snapshotBlock, snapshotTime, onChainTemplateIds]
        );
        counts.templatesMarkedDeleted = deletedResult.rowCount;

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }

    // --- schematypes: media-type seed ---
    const schemaTypeRows = await walkScopedTable(rpc, contract, 'schematypes');

    await client.query('BEGIN');
    try {
        for (const { scope, row } of schemaTypeRows) {
            const result = await client.query(
                'UPDATE atomicassets_schemas SET types = $1 WHERE contract = $2 AND collection_name = $3 AND schema_name = $4',
                [row.format_type.map((entry: any) => JSON.stringify(entry)), contract, scope, row.schema_name]
            );
            counts.schemaTypesSeeded += result.rowCount;
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }

    // --- authorswaps: pending-author-change seed + clear for swaps resolved during the gap ---
    // Scoped by the contract account itself, not per collection (collection_name
    // is a field on the row, mirrored by the live authorswaps processor which
    // reads delta.value.collection_name rather than delta.scope).
    const authorSwapRows = await walkTable(rpc, contract, contract, 'authorswaps');
    const onChainSwapCollections = authorSwapRows.map(row => row.collection_name);

    await client.query('BEGIN');
    try {
        for (const row of authorSwapRows) {
            const result = await client.query(
                'UPDATE atomicassets_collections SET new_author_name = $1, new_author_date = $2 ' +
                'WHERE contract = $3 AND collection_name = $4',
                [row.new_author, Number(row.acceptance_date) * 1000, contract, row.collection_name]
            );
            counts.authorSwapsSeeded += result.rowCount;
        }

        if (authorSwapRows.length === 0) {
            const livePending = await client.query(
                'SELECT EXISTS(SELECT 1 FROM atomicassets_collections WHERE contract = $1 AND new_author_name IS NOT NULL) AS live',
                [contract]
            );

            if (livePending.rows[0].live) {
                throw new Error(
                    'AtomicAssets reconcile: on-chain authorswaps enumeration for ' + contract + ' returned zero rows ' +
                    'while the database still has pending author swaps. Refusing to clear every pending swap - this ' +
                    'likely indicates an RPC/enumeration failure rather than a real empty table. Nothing was changed.'
                );
            }
        }

        const clearedResult = await client.query(
            'UPDATE atomicassets_collections SET new_author_name = NULL, new_author_date = NULL ' +
            'WHERE contract = $1 AND new_author_name IS NOT NULL AND NOT (collection_name = ANY($2::varchar[]))',
            [contract, onChainSwapCollections]
        );
        counts.authorSwapsCleared = clearedResult.rowCount;

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }

    // --- v2 continuity marker: unconditional, reconcile is an explicit recovery action ---
    await client.query('BEGIN');
    try {
        await client.query(
            'UPDATE atomicassets_config SET v2_marker_block = $1 WHERE contract = $2',
            [snapshotBlock, contract]
        );

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }

    logger.info(
        'AtomicAssets reconcile complete for ' + contract + ' at snapshot block ' + snapshotBlock + ': ' +
        counts.templates2Seeded + ' templates2 rows seeded, ' +
        counts.templatesMutableDataNulled + ' templates had mutable_data cleared (templates2 gone on-chain), ' +
        counts.templatesMarkedDeleted + ' templates newly marked deleted, ' +
        counts.schemaTypesSeeded + ' schema type rows seeded, ' +
        counts.authorSwapsSeeded + ' author swap rows seeded, ' +
        counts.authorSwapsCleared + ' author swaps cleared (resolved on-chain during the gap). ' +
        'Deletion timestamps are approximate: stamped at the reconcile snapshot, the true deletion block ' +
        'is unrecoverable since deltemplate emits no log action.'
    );

    return counts;
}

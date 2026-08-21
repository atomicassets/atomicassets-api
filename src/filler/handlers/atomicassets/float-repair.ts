/**
 * One-time rewrite of float and double attribute values that an earlier
 * decoder persisted as JSON strings.
 *
 * The AtomicAssets contract carries attribute values twice: as serialized
 * bytes in the tables, and as an ATOMIC_ATTRIBUTE variant in the logmint /
 * logsetdata action payloads. The byte path always produced JSON numbers. The
 * payload path went through a wharfkit objectify, which renders Float32 and
 * Float64 wrappers as strings, so asset documents ended up holding a string
 * where template and collection documents hold a number. This module rewrites
 * those strings back to numbers so every endpoint serves one shape.
 *
 * The rewrite is safe to run against a live filler. Each batch is one
 * transaction holding a try-lock, and its write is a single UPDATE, so a
 * concurrent filler write to the same asset lands either fully before or fully
 * after it. Only string values under a float or double schema format are
 * touched; every other key keeps its stored value byte for byte, and a value
 * the guards reject is left alone and counted.
 *
 * A float value is rewritten through `real`, which rounds to the nearest
 * float32 exactly as the contract stores it. Where the string kept the value's
 * full precision the result is the chain value, which covers every magnitude at
 * or above 1 and the sub-unit values a short decimal names exactly. Under
 * @wharfkit/antelope 1.x `Float32.toString` is `toFixed(7)`, so a nonzero
 * magnitude below 1 that needed more than seven fractional decimals lost digits
 * in the string, and there the result is the nearest float32 to what was stored.
 * From 2.x the same wrapper renders the shortest round-trip string
 * (wharfkit/antelope f70dadd), so no digits are lost and the numeric objectify
 * is a shape choice.
 *
 * A non-finite value has no numeric form to restore. The 1.x wrapper rendered
 * one as `NaN`, `Infinity` or `-Infinity`, and the decoder that replaced it
 * yields the JavaScript value, which `JSON.stringify` writes as JSON null.
 * Those three strings therefore rewrite to JSON null, which is what the write
 * path now stores, and they are counted apart from the values the guards
 * reject.
 *
 * Progress lives in `dbinfo` under `atomicassets_float_repair:<contract>`, and
 * the cursor commits inside the same transaction as the rows it covers, so a
 * crash resumes without losing or double-counting work. Replaying a committed
 * batch is a no-op: a document already holding numbers compares equal and is
 * not written again.
 */
import { ClientBase, Pool } from 'pg';

import logger from '../../../utils/winston';

/** Advisory key, taken transaction-scoped so one batch runs at a time across the fleet. */
export const FLOAT_REPAIR_LOCK_NAME = 'atomicassets_float_repair';

/** dbinfo key prefix. dbinfo.name is varchar(64) and a contract account is at most 12 characters. */
const FLOAT_REPAIR_STATE_PREFIX = 'atomicassets_float_repair:';

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_PAUSE_MS = 250;

/**
 * Decimal literal the guards accept before any cast runs. The digit counts are
 * bounds, not decoration: an unbounded exponent lets a hostile or corrupt
 * string ("1e999999") overflow the numeric cast, and an aborted batch would
 * never advance its cursor, so the pass would retry the same rows forever.
 * The widest legitimate value is a float32 at the top of its range rendered
 * with seven decimal places, which is 39 integer digits and 7 fraction digits.
 */
const NUMERIC_STRING_PATTERN = '^-?[0-9]{1,64}(\\.[0-9]{1,64})?([eE][+-]?[0-9]{1,3})?$';

/**
 * Magnitude bounds of the two float types, as decimal literals read into
 * `numeric`. Both casts raise `22003` outside their own range, at the top and
 * at the bottom alike: `'1e400'::double precision`, `'1e-400'::double
 * precision`, `'1e39'::real` and `'1e-50'::real` all fail. See
 * NUMERIC_STRING_PATTERN above for why that matters to an aborted batch.
 * `numeric` carries any of those values, so the magnitude is measured there
 * before either cast runs.
 *
 * The bounds are the smallest subnormal and the largest finite value of each
 * type, which makes them strict at the rounding edge: a value between half the
 * smallest subnormal and the smallest subnormal is rejected rather than rounded
 * up. That leaves the row holding its string, and no real attribute value
 * reaches it.
 */
const FLOAT32_MIN_SUBNORMAL = '1.401298464324817e-45';
const FLOAT32_MAX = '3.4028234663852886e38';
const DOUBLE_MIN_SUBNORMAL = '5e-324';
const DOUBLE_MAX = '1.7976931348623157e308';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A schema whose format declares at least one float-shaped key, with the keys grouped by kind. */
export interface FloatSchema {
    collection_name: string;
    schema_name: string;
    double_keys: string[];
    float_keys: string[];
    double_vec_keys: string[];
    float_vec_keys: string[];
}

export interface FloatRepairState {
    status: 'running' | 'done';
    collection_name: string | null;
    schema_name: string | null;
    asset_id: string;
    rewritten: number;
    rejected: number;
    /** String values rewritten to JSON null because they name a non-finite float. */
    non_finite: number;
    /** Assets the pass has walked, cumulative across slices, so the completion line reads the pass. */
    scanned: number;
}

export interface FloatRepairBatchResult {
    /** True when the advisory lock was held elsewhere. Nothing was read, written or advanced. */
    skipped: boolean;
    /** Assets the keyset returned. A value below the batch size means the pair is exhausted. */
    scanned: number;
    /** Assets whose rebuilt documents differed from the stored ones. */
    rewritten: number;
    /** String values under a float format that the guards refused to convert. */
    rejected: number;
    /** String values rewritten to JSON null because they name a non-finite float. */
    non_finite: number;
    /** Highest asset_id of the batch, or null when the batch was empty. */
    last_asset_id: string | null;
}

export interface FloatRepairResult {
    /** True when the pass completed and the state row reads `done`. */
    done: boolean;
    /** True when a batch found the advisory lock held, which ends the slice without advancing. */
    skipped: boolean;
    batches: number;
    scanned: number;
    rewritten: number;
    rejected: number;
    /** String values rewritten to JSON null because they name a non-finite float. */
    non_finite: number;
}

/** Structural subset of the winston logger, so a test can pass a recorder. */
export interface RepairLogger {
    info(message: string, ...meta: any[]): any;
    warn(message: string, ...meta: any[]): any;
    error(message: string, ...meta: any[]): any;
}

export interface FloatRepairOptions {
    batchSize?: number;
    /** Batches this call may run before it returns unfinished. Unbounded by default. */
    maxBatches?: number;
    pauseMs?: number;
    logger?: RepairLogger;
    /** Discards the stored state first, so the pass runs again over every pair. */
    restart?: boolean;
}

export function floatRepairStateName(contract: string): string {
    return FLOAT_REPAIR_STATE_PREFIX + contract;
}

/**
 * Rebuild rule for one stored value, as a jsonb object
 * `{"v": <value>, "r": <rejected>, "n": <non-finite>}`.
 *
 * The value and its two counter flags come out of one expression so the guards
 * are written once. Order is load-bearing. The non-finite test runs before the
 * pattern test, because those three spellings are the one class of string that
 * names a float value rather than failing to name one, and the pattern gate
 * would otherwise reject them. The pattern test runs next, because the
 * `numeric` cast needs a decimal literal. The magnitude test runs after it, in
 * `numeric`, because both float casts raise outside their own range. Only then
 * does a cast to `double precision` or `real` run, and by that point it cannot
 * fail. A conversion that produces no value leaves the stored string in place
 * and counts it.
 *
 * The non-finite rewrite is `'null'::jsonb`, the JSON null value.
 * `to_jsonb(NULL)` is SQL NULL instead, which would drop the key out of the
 * rebuilt document rather than store a null under it.
 */
function conversionExpression(valueExpr: string, isFloatExpr: string): string {
    return `CASE
                    WHEN jsonb_typeof(${valueExpr}) <> 'string'
                        THEN jsonb_build_object('v', ${valueExpr}, 'r', 0, 'n', 0)
                    WHEN (${valueExpr} #>> '{}') IN ('NaN', 'Infinity', '-Infinity')
                        THEN jsonb_build_object('v', 'null'::jsonb, 'r', 0, 'n', 1)
                    WHEN NOT ((${valueExpr} #>> '{}') ~ '${NUMERIC_STRING_PATTERN}')
                        THEN jsonb_build_object('v', ${valueExpr}, 'r', 1, 'n', 0)
                    ELSE (
                        SELECT CASE
                            WHEN converted.result IS NULL THEN jsonb_build_object('v', ${valueExpr}, 'r', 1, 'n', 0)
                            ELSE jsonb_build_object('v', converted.result, 'r', 0, 'n', 0)
                        END
                        FROM (SELECT (${valueExpr} #>> '{}')::numeric AS n) AS parsed
                        CROSS JOIN LATERAL (
                            SELECT CASE
                                WHEN parsed.n = 0
                                    THEN to_jsonb(0::double precision)
                                WHEN (${isFloatExpr}) AND abs(parsed.n)
                                        BETWEEN '${FLOAT32_MIN_SUBNORMAL}'::numeric AND '${FLOAT32_MAX}'::numeric
                                    THEN to_jsonb(((parsed.n::double precision)::real)::double precision)
                                WHEN NOT (${isFloatExpr}) AND abs(parsed.n)
                                        BETWEEN '${DOUBLE_MIN_SUBNORMAL}'::numeric AND '${DOUBLE_MAX}'::numeric
                                    THEN to_jsonb(parsed.n::double precision)
                                ELSE NULL
                            END AS result
                        ) AS converted
                    )
                END`;
}

/**
 * The batch statement. Structural SQL only: every value the caller supplies
 * arrives as a bound parameter.
 *
 *   $1 contract, $2 collection_name, $3 schema_name, $4 cursor asset_id,
 *   $5 batch size, $6 double keys, $7 float keys, $8 double[] keys, $9 float[] keys
 */
const FLOAT_REPAIR_BATCH_SQL = `
    WITH batch AS (
        SELECT asset_id, mutable_data, immutable_data
        FROM atomicassets_assets
        WHERE contract = $1 AND collection_name = $2 AND schema_name = $3 AND asset_id > $4
        ORDER BY asset_id
        LIMIT $5
    ),
    docs AS (
        SELECT b.asset_id, d.col, d.doc
        FROM batch b
        CROSS JOIN LATERAL (VALUES ('mutable_data', b.mutable_data), ('immutable_data', b.immutable_data)) AS d(col, doc)
        WHERE d.doc IS NOT NULL AND jsonb_typeof(d.doc) = 'object'
    ),
    entries AS (
        SELECT d.asset_id, d.col, e.key, c.conv
        FROM docs d
        CROSS JOIN LATERAL jsonb_each(d.doc) AS e(key, value)
        CROSS JOIN LATERAL (
            SELECT CASE
                WHEN e.key = ANY($6::text[]) OR e.key = ANY($7::text[]) THEN
                    ${conversionExpression('e.value', 'e.key = ANY($7::text[])')}
                WHEN e.key = ANY($8::text[]) OR e.key = ANY($9::text[]) THEN
                    CASE
                        WHEN jsonb_typeof(e.value) = 'array' THEN (
                            SELECT jsonb_build_object(
                                'v', COALESCE(jsonb_agg(el.conv -> 'v' ORDER BY a.ord), '[]'::jsonb),
                                'r', COALESCE(SUM((el.conv ->> 'r')::int), 0),
                                'n', COALESCE(SUM((el.conv ->> 'n')::int), 0)
                            )
                            FROM jsonb_array_elements(e.value) WITH ORDINALITY AS a(elem, ord)
                            CROSS JOIN LATERAL (
                                SELECT ${conversionExpression('a.elem', 'e.key = ANY($9::text[])')}
                            ) AS el(conv)
                        )
                        WHEN jsonb_typeof(e.value) = 'string' THEN jsonb_build_object('v', e.value, 'r', 1, 'n', 0)
                        ELSE jsonb_build_object('v', e.value, 'r', 0, 'n', 0)
                    END
                ELSE jsonb_build_object('v', e.value, 'r', 0, 'n', 0)
            END
        ) AS c(conv)
    ),
    rebuilt AS (
        SELECT asset_id, col,
            COALESCE(jsonb_object_agg(key, conv -> 'v'), '{}'::jsonb) AS doc,
            COALESCE(SUM((conv ->> 'r')::int), 0) AS rejected,
            COALESCE(SUM((conv ->> 'n')::int), 0) AS non_finite
        FROM entries
        GROUP BY asset_id, col
    ),
    merged AS (
        SELECT b.asset_id,
            b.mutable_data AS old_mutable,
            b.immutable_data AS old_immutable,
            COALESCE(m.doc, b.mutable_data) AS new_mutable,
            COALESCE(i.doc, b.immutable_data) AS new_immutable,
            COALESCE(m.rejected, 0) + COALESCE(i.rejected, 0) AS rejected,
            COALESCE(m.non_finite, 0) + COALESCE(i.non_finite, 0) AS non_finite
        FROM batch b
        LEFT JOIN rebuilt m ON m.asset_id = b.asset_id AND m.col = 'mutable_data'
        LEFT JOIN rebuilt i ON i.asset_id = b.asset_id AND i.col = 'immutable_data'
    ),
    updated AS (
        UPDATE atomicassets_assets a
        SET mutable_data = r.new_mutable, immutable_data = r.new_immutable
        FROM merged r
        WHERE a.contract = $1 AND a.asset_id = r.asset_id
            AND (a.mutable_data IS DISTINCT FROM r.new_mutable OR a.immutable_data IS DISTINCT FROM r.new_immutable)
            AND a.mutable_data IS NOT DISTINCT FROM r.old_mutable AND a.immutable_data IS NOT DISTINCT FROM r.old_immutable
        RETURNING a.asset_id
    )
    SELECT
        (SELECT COUNT(*) FROM batch)::int AS scanned,
        (SELECT MAX(asset_id) FROM batch) AS last_asset_id,
        (SELECT COUNT(*) FROM updated)::int AS rewritten,
        (SELECT COALESCE(SUM(rejected), 0) FROM merged)::int AS rejected,
        (SELECT COALESCE(SUM(non_finite), 0) FROM merged)::int AS non_finite
`;

/**
 * The (collection_name, schema_name) pairs of a contract whose format declares
 * a float, double, float[] or double[] key, with the key names per kind.
 *
 * The ordering is the cursor's ordering, pinned to the C collation so the
 * resume comparison in TypeScript sees the same sequence the database walked.
 * Collection and schema names come from the Antelope name charset, where the C
 * collation and code point order agree.
 */
export async function loadFloatSchemas(client: ClientBase, contract: string): Promise<FloatSchema[]> {
    const query = await client.query(
        `
        SELECT s.collection_name, s.schema_name,
            COALESCE(ARRAY_AGG(entry ->> 'name') FILTER (WHERE entry ->> 'type' = 'double'), '{}') AS double_keys,
            COALESCE(ARRAY_AGG(entry ->> 'name') FILTER (WHERE entry ->> 'type' = 'float'), '{}') AS float_keys,
            COALESCE(ARRAY_AGG(entry ->> 'name') FILTER (WHERE entry ->> 'type' = 'double[]'), '{}') AS double_vec_keys,
            COALESCE(ARRAY_AGG(entry ->> 'name') FILTER (WHERE entry ->> 'type' = 'float[]'), '{}') AS float_vec_keys
        FROM atomicassets_schemas s
        CROSS JOIN LATERAL unnest(s.format) AS f(entry)
        WHERE s.contract = $1
        GROUP BY s.collection_name, s.schema_name
        HAVING COUNT(*) FILTER (WHERE entry ->> 'type' IN ('double', 'float', 'double[]', 'float[]')) > 0
        ORDER BY s.collection_name COLLATE "C", s.schema_name COLLATE "C"
        `,
        [contract]
    );

    return query.rows.map(row => ({
        collection_name: row.collection_name,
        schema_name: row.schema_name,
        double_keys: row.double_keys,
        float_keys: row.float_keys,
        double_vec_keys: row.double_vec_keys,
        float_vec_keys: row.float_vec_keys,
    }));
}

export async function readFloatRepairState(client: ClientBase, contract: string): Promise<FloatRepairState | null> {
    const query = await client.query(
        'SELECT "value" FROM dbinfo WHERE name = $1',
        [floatRepairStateName(contract)]
    );

    if (query.rows.length === 0) {
        return null;
    }

    try {
        return JSON.parse(query.rows[0].value) as FloatRepairState;
    } catch {
        // A state row that does not parse is treated as absent: the pass is
        // idempotent, so a full re-run is cheaper than refusing to start.
        logger.warn(
            'AtomicAssets float repair: state row for ' + contract + ' did not parse as JSON (' +
            query.rows[0].value.length + ' chars); starting a full re-scan'
        );

        return null;
    }
}

async function writeFloatRepairState(client: ClientBase, contract: string, state: FloatRepairState): Promise<void> {
    await client.query(
        `
        INSERT INTO dbinfo ("name", "value", updated)
            VALUES ($1, $2, extract(epoch from current_timestamp)::bigint)
        ON CONFLICT (name)
            DO UPDATE SET "value" = EXCLUDED.value, updated = EXCLUDED.updated
        `,
        [floatRepairStateName(contract), JSON.stringify(state)]
    );
}

export async function clearFloatRepairState(client: ClientBase, contract: string): Promise<void> {
    await client.query('DELETE FROM dbinfo WHERE name = $1', [floatRepairStateName(contract)]);
}

async function tryLock(client: ClientBase): Promise<boolean> {
    const query = await client.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS granted',
        [FLOAT_REPAIR_LOCK_NAME]
    );

    return query.rows[0].granted === true;
}

/**
 * Rewrites one keyset batch of a single (collection, schema) pair.
 *
 * Runs as one transaction on the client it is handed, which the caller checks
 * out for this batch alone and returns afterwards, so the jobs sharing the
 * single-client maintenance pool interleave between batches rather than
 * queueing behind a whole pass. The cursor commits in that same transaction
 * (see the module header above).
 */
export async function repairBatch(
    client: ClientBase, contract: string, pair: FloatSchema, afterAssetId: string, batchSize: number
): Promise<FloatRepairBatchResult> {
    await client.query('BEGIN');

    try {
        if (!(await tryLock(client))) {
            await client.query('ROLLBACK');

            return { skipped: true, scanned: 0, rewritten: 0, rejected: 0, non_finite: 0, last_asset_id: null };
        }

        const previous = await readFloatRepairState(client, contract);

        const query = await client.query(FLOAT_REPAIR_BATCH_SQL, [
            contract, pair.collection_name, pair.schema_name, afterAssetId, batchSize,
            pair.double_keys, pair.float_keys, pair.double_vec_keys, pair.float_vec_keys,
        ]);

        const row = query.rows[0];
        const result: FloatRepairBatchResult = {
            skipped: false,
            scanned: Number(row.scanned),
            rewritten: Number(row.rewritten),
            rejected: Number(row.rejected),
            non_finite: Number(row.non_finite),
            last_asset_id: row.last_asset_id === null ? null : String(row.last_asset_id),
        };

        await writeFloatRepairState(client, contract, {
            status: 'running',
            collection_name: pair.collection_name,
            schema_name: pair.schema_name,
            asset_id: result.last_asset_id ?? afterAssetId,
            rewritten: (previous?.rewritten ?? 0) + result.rewritten,
            rejected: (previous?.rejected ?? 0) + result.rejected,
            non_finite: (previous?.non_finite ?? 0) + result.non_finite,
            scanned: (previous?.scanned ?? 0) + result.scanned,
        });

        await client.query('COMMIT');

        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);

        throw error;
    }
}

/** Marks the pass complete and returns the cumulative state written. Returns null when the advisory lock was held elsewhere. */
async function markDone(client: ClientBase, contract: string): Promise<FloatRepairState | null> {
    await client.query('BEGIN');

    try {
        if (!(await tryLock(client))) {
            await client.query('ROLLBACK');

            return null;
        }

        const previous = await readFloatRepairState(client, contract);

        const state: FloatRepairState = {
            status: 'done',
            collection_name: previous?.collection_name ?? null,
            schema_name: previous?.schema_name ?? null,
            asset_id: previous?.asset_id ?? '0',
            rewritten: previous?.rewritten ?? 0,
            rejected: previous?.rejected ?? 0,
            non_finite: previous?.non_finite ?? 0,
            scanned: previous?.scanned ?? 0,
        };

        await writeFloatRepairState(client, contract, state);

        await client.query('COMMIT');

        return state;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);

        throw error;
    }
}

/**
 * Index of the pair to resume at, and whether the stored asset_id still
 * applies. A pair that no longer exists resumes at the first pair after it in
 * the cursor's ordering, from the start of that pair.
 */
function resumeAt(pairs: FloatSchema[], state: FloatRepairState | null): { index: number, exact: boolean } {
    if (!state || state.collection_name === null || state.schema_name === null) {
        return { index: 0, exact: false };
    }

    for (let index = 0; index < pairs.length; index++) {
        const pair = pairs[index];

        if (pair.collection_name === state.collection_name && pair.schema_name === state.schema_name) {
            return { index, exact: true };
        }

        if (pair.collection_name > state.collection_name
            || (pair.collection_name === state.collection_name && pair.schema_name > state.schema_name)) {
            return { index, exact: false };
        }
    }

    return { index: pairs.length, exact: false };
}

/**
 * Runs the repair for one contract, from the stored cursor, for at most
 * `maxBatches` batches.
 *
 * A slice that spends its batch budget returns unfinished and the next call
 * picks up where it stopped. A batch that finds the advisory lock held ends
 * the slice without advancing the cursor and without marking the pass done,
 * so a manual run and the filler's own job never write past each other.
 */
export async function runFloatRepair(
    pool: Pool, contract: string, options: FloatRepairOptions = {}
): Promise<FloatRepairResult> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
    const log: RepairLogger = options.logger ?? logger;

    const totals = { batches: 0, scanned: 0, rewritten: 0, rejected: 0, non_finite: 0 };

    let state: FloatRepairState | null;
    let pairs: FloatSchema[];

    const setupClient = await pool.connect();

    try {
        if (options.restart) {
            await clearFloatRepairState(setupClient, contract);
            log.info('AtomicAssets float repair: discarded the stored state for ' + contract + ' and starting a full pass');
            state = null;
        } else {
            state = await readFloatRepairState(setupClient, contract);
        }

        if (state?.status === 'done') {
            return { done: true, skipped: false, ...totals };
        }

        pairs = await loadFloatSchemas(setupClient, contract);
    } finally {
        setupClient.release();
    }

    const resume = resumeAt(pairs, state);
    let index = resume.index;
    let afterAssetId = resume.exact ? state.asset_id : '0';

    while (index < pairs.length) {
        if (totals.batches >= maxBatches) {
            return { done: false, skipped: false, ...totals };
        }

        if (totals.batches > 0 && pauseMs > 0) {
            await sleep(pauseMs);
        }

        const client = await pool.connect();
        let batch: FloatRepairBatchResult;

        try {
            batch = await repairBatch(client, contract, pairs[index], afterAssetId, batchSize);
        } finally {
            client.release();
        }

        if (batch.skipped) {
            log.info('AtomicAssets float repair: another pass holds the lock for ' + contract + ', ending this slice');

            return { done: false, skipped: true, ...totals };
        }

        totals.batches += 1;
        totals.scanned += batch.scanned;
        totals.rewritten += batch.rewritten;
        totals.rejected += batch.rejected;
        totals.non_finite += batch.non_finite;

        if (batch.last_asset_id !== null) {
            afterAssetId = batch.last_asset_id;
        }

        if (batch.scanned < batchSize) {
            index += 1;
            afterAssetId = '0';
        }
    }

    const doneClient = await pool.connect();
    let finalState: FloatRepairState | null;

    try {
        finalState = await markDone(doneClient, contract);

        if (finalState === null) {
            return { done: false, skipped: true, ...totals };
        }
    } finally {
        doneClient.release();
    }

    log.info(
        'AtomicAssets float repair: pass complete for ' + contract + ' (' + finalState.rewritten +
        ' assets rewritten, ' + finalState.rejected + ' values rejected, ' + finalState.non_finite +
        ' non-finite values nulled, ' + finalState.scanned + ' assets scanned)'
    );

    return { done: true, skipped: false, ...totals };
}

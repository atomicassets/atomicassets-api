/**
 * One-time script to correct drifted asset counts in atomicassets_asset_counts.
 *
 * The eosio-contract-api importer baked in stale counts for some templates.
 * This script compares actual counts (from atomicassets_assets) against the
 * sum of atomicassets_asset_counts rows per template, and inserts dirty
 * correction deltas that the batched aggregation job will absorb.
 *
 * Run via: node build/scripts/recount-asset-counts.js
 *
 * Env vars:
 *   DATABASE_URL    (required) — postgres connection string for eca_wax_mainnet
 *   DRY_RUN         (optional) — "true" (default) to only report, "false" to insert corrections
 *   MIN_DRIFT       (optional) — minimum absolute drift to correct (default: 1)
 *   CONTRACT        (optional) — contract account to recount (default: "atomicassets")
 */

import { Pool } from 'pg';
import logger from '../utils/winston';

interface CorrectionRow {
    template_id: string;
    assets: number;
    burned: number;
    owned: number;
}

async function main(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        logger.error('[RECOUNT]: DATABASE_URL env var is required');
        process.exit(1);
    }

    const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
    const minDrift = Math.max(1, parseInt(process.env.MIN_DRIFT ?? '1', 10) || 1);
    const contract = process.env.CONTRACT ?? 'atomicassets';

    logger.info('[RECOUNT]: === Asset Counts Recount ===');
    logger.info(`[RECOUNT]:   dry_run:    ${dryRun}`);
    logger.info(`[RECOUNT]:   min_drift:  ${minDrift}`);
    logger.info(`[RECOUNT]:   contract:   ${contract}`);

    const pool = new Pool({
        connectionString: databaseUrl,
        max: 2,
        application_name: 'recount_asset_counts',
        statement_timeout: 600_000, // 10 min — full table scan of atomicassets_assets
    });

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const result = await client.query<CorrectionRow>(`
                WITH actual AS (
                    SELECT contract, collection_name, schema_name, template_id,
                        COUNT(*) AS actual_assets,
                        COUNT(*) FILTER (WHERE owner IS NULL) AS actual_burned,
                        COUNT(*) FILTER (WHERE owner IS NOT NULL) AS actual_owned
                    FROM atomicassets_assets
                    WHERE contract = $1
                    GROUP BY contract, collection_name, schema_name, template_id
                ),
                recorded AS (
                    SELECT contract, collection_name, schema_name, template_id,
                        SUM(assets) AS recorded_assets,
                        SUM(burned) AS recorded_burned,
                        SUM(owned) AS recorded_owned
                    FROM atomicassets_asset_counts
                    WHERE contract = $1
                    GROUP BY contract, collection_name, schema_name, template_id
                ),
                drifted AS (
                    SELECT
                        a.contract, a.collection_name, a.schema_name, a.template_id,
                        (a.actual_assets - COALESCE(r.recorded_assets, 0))::int AS asset_delta,
                        (a.actual_burned - COALESCE(r.recorded_burned, 0))::int AS burn_delta,
                        (a.actual_owned - COALESCE(r.recorded_owned, 0))::int AS owned_delta
                    FROM actual a
                    LEFT JOIN recorded r USING (contract, collection_name, schema_name, template_id)
                    WHERE ABS(a.actual_assets - COALESCE(r.recorded_assets, 0)) >= $2
                       OR ABS(a.actual_burned - COALESCE(r.recorded_burned, 0)) >= $2
                )
                INSERT INTO atomicassets_asset_counts
                    (contract, collection_name, schema_name, template_id, assets, burned, owned, dirty)
                SELECT contract, collection_name, schema_name, template_id,
                    asset_delta, burn_delta, owned_delta, true
                FROM drifted
                RETURNING template_id, assets, burned, owned
            `, [contract, minDrift]);

            if (result.rowCount === 0) {
                logger.info('[RECOUNT]: No drifted templates found');
                await client.query('ROLLBACK');
                return;
            }

            logger.info(`[RECOUNT]: Found ${result.rowCount} drifted templates`);

            // Log the top 20 by absolute asset drift
            const sorted = result.rows.sort(
                (a, b) => Math.abs(b.assets) - Math.abs(a.assets),
            );
            for (const row of sorted.slice(0, 20)) {
                logger.info(
                    `[RECOUNT]:   template=${row.template_id} asset_delta=${row.assets} burn_delta=${row.burned} owned_delta=${row.owned}`,
                );
            }

            if (dryRun) {
                await client.query('ROLLBACK');
                logger.info('[RECOUNT]: Dry run — rolled back. Set DRY_RUN=false to apply.');
            } else {
                await client.query('COMMIT');
                logger.info(`[RECOUNT]: Committed ${result.rowCount} correction deltas`);
                logger.info('[RECOUNT]: The aggregation job runs every 10 min and will absorb these');
            }
        } finally {
            client.release();
        }
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    logger.error('[RECOUNT]: Fatal error', err);
    process.exit(1);
});

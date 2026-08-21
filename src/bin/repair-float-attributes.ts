/*
  Runs the float attribute repair to completion for every atomicassets contract
  in readers.config.json (see src/filler/handlers/atomicassets/float-repair.ts).

  Usage:
    node build/bin/repair-float-attributes.js [--restart]

  Safe to run while the filler is live: the filler's own repair job and this
  command take the same transaction-scoped advisory key, so whichever holds it
  runs and the other ends its slice and resumes later. The pass is idempotent,
  and rows already holding numbers are compared and left alone.

  --restart discards the stored state and runs a full pass again. That is the
  required step after a rollback to a string-emitting decoder followed by a roll
  forward, because the completion state would otherwise report a pass that did
  not cover the rows written in between.

  The command opens a Postgres connection and nothing else. It reads no chain
  and no Redis, so it runs in an environment where neither is reachable.
*/

import PostgresConnection from '../connections/postgres';
import logger from '../utils/winston';
import { IConnectionsConfig, IReaderConfig } from '../types/config';
import { configFile } from '../utils/config-path';
import { runFloatRepair } from '../filler/handlers/atomicassets/float-repair';

// The batch statement walks a keyset of at most 500 assets, but the GIN index
// updates on a wide document make it slower than the 30s the shared pool allows.
// This command has no reader to protect, so it gets the maintenance timeout the
// filler's own long-running pool uses.
const REPAIR_STATEMENT_TIMEOUT_MS = 300_000;

let connectionConfig: IConnectionsConfig = { postgres: {}, redis: {}, chain: {} } as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require(configFile('connections.config.json'));
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

let readerConfigs: IReaderConfig[] = [];

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    readerConfigs = require(configFile('readers.config.json'));
} catch (error) {
    logger.error('No readers.config.json found - the repair needs it to find the configured atomicassets contracts', error);
    process.exit(1);
}

const RESTART = process.argv.includes('--restart');

async function main(): Promise<void> {
    // Same precedence as ConnectionManager, so this command and the filler read
    // one configuration.
    const connection = new PostgresConnection(
        process.env.POSTGRES_HOST || connectionConfig.postgres.host,
        parseInt(process.env.POSTGRES_PORT, 10) || connectionConfig.postgres.port,
        process.env.POSTGRES_USER || connectionConfig.postgres.user,
        process.env.POSTGRES_PASSWORD || connectionConfig.postgres.password,
        process.env.POSTGRES_DATABASE || connectionConfig.postgres.database
    );

    await connection.connect();

    // One contract can be read by more than one reader, and the repair is per
    // contract, so run it once per account.
    const contracts = [...new Set(
        readerConfigs.flatMap(reader =>
            reader.contracts
                .filter(contract => contract.handler === 'atomicassets')
                .map(contract => contract.args.atomicassets_account as string)
        )
    )];

    if (contracts.length === 0) {
        logger.error('No atomicassets contracts found in readers.config.json - nothing to repair');
        process.exit(1);
    }

    const pool = connection.createPool({
        connectionTimeoutMillis: 10 * 60 * 1_000,
        statement_timeout: REPAIR_STATEMENT_TIMEOUT_MS,
        max: 1,
    });

    let exitCode = 0;

    try {
        for (const contract of contracts) {
            try {
                logger.info('AtomicAssets float repair: starting for contract ' + contract +
                    (RESTART ? ' (discarding the stored state first)' : ''));

                const result = await runFloatRepair(pool, contract, { restart: RESTART, pauseMs: 0 });

                logger.info(
                    'AtomicAssets float repair: contract ' + contract + ' ' +
                    (result.done ? 'complete' : 'stopped before completion') +
                    ' after ' + result.batches + ' batches - ' + result.scanned + ' assets scanned, ' +
                    result.rewritten + ' rewritten, ' + result.rejected + ' values left unconverted, ' +
                    result.non_finite + ' non-finite values nulled'
                );

                if (!result.done) {
                    // A slice that ends on the advisory lock means the filler
                    // holds it. Report it, so an operator re-runs rather than
                    // reading a partial pass as a finished one.
                    logger.warn('AtomicAssets float repair: contract ' + contract +
                        ' did not finish because another pass holds the lock. Run the command again.');
                    exitCode = 1;
                }
            } catch (error) {
                logger.error('AtomicAssets float repair failed for contract ' + contract, error);
                exitCode = 1;
            }
        }
    } finally {
        await pool.end().catch(() => undefined);
    }

    process.exit(exitCode);
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});

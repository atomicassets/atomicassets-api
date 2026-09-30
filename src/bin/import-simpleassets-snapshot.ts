/*
  Imports a SimpleAssets snapshot taken at block S (see
  src/filler/handlers/simpleassets/snapshot-import.ts and README.md).

  Usage:
    node build/bin/import-simpleassets-snapshot.js --snapshot-block S \
      --assets <file> --card-totals <file> --config <file> [--simpleassets-account <account>]

  The accounts come from the simpleassets entry in readers.config.json, so the
  import links with the same bridge_account the reader uses. The reader that
  runs atomicassets on the same account must have reached S, and the reader
  that holds the simpleassets entry must not have processed a block above S.
  The whole import commits in one transaction, and a second run with the same
  files changes nothing. Start the simpleassets reader at S+1.
*/

import PostgresConnection from '../connections/postgres';
import logger from '../utils/winston';
import { IConnectionsConfig, IReaderConfig } from '../types/config';
import { configFile } from '../utils/config-path';
import { importSimpleAssetsSnapshot } from '../filler/handlers/simpleassets/snapshot-import';

let connectionConfig: IConnectionsConfig = { postgres: {}, redis: {}, chain: {} } as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require(configFile('connections.config.json'));
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

function stringArg(flag: string): string | undefined {
    const index = process.argv.indexOf(flag);

    return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArg(flag: string): string {
    const value = stringArg(flag);

    if (!value) {
        logger.error('Missing argument ' + flag);
        process.exit(1);
    }

    return value;
}

function simpleAssetsEntry(
    readers: IReaderConfig[], account: string | undefined
): {reader: string, args: {[key: string]: any}} {
    const entries = readers
        .flatMap(reader => reader.contracts.map(contract => ({ reader: reader.name, contract })))
        .filter(entry => entry.contract.handler === 'simpleassets')
        .filter(entry => account === undefined || entry.contract.args.simpleassets_account === account);

    if (entries.length !== 1) {
        logger.error('Expected one simpleassets entry in readers.config.json, found ' + entries.length +
            '. Pass --simpleassets-account to pick one.');
        process.exit(1);
    }

    return { reader: entries[0].reader, args: entries[0].contract.args };
}

function atomicAssetsReader(readers: IReaderConfig[], account: string): string {
    const names = readers
        .filter(reader => reader.contracts.some(contract =>
            contract.handler === 'atomicassets' && contract.args.atomicassets_account === account
        ))
        .map(reader => reader.name);

    if (names.length !== 1) {
        logger.error('Expected one reader in readers.config.json that runs atomicassets on ' + account +
            ', found ' + names.length + (names.length > 0 ? ': ' + names.join(', ') : ''));
        process.exit(1);
    }

    return names[0];
}

async function main(): Promise<void> {
    const snapshotBlock = Number(requiredArg('--snapshot-block'));
    const files = {
        assets: requiredArg('--assets'),
        cardTotals: requiredArg('--card-totals'),
        config: requiredArg('--config'),
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const readers: IReaderConfig[] = require(configFile('readers.config.json'));
    const { reader: simpleassetsReader, args } = simpleAssetsEntry(readers, stringArg('--simpleassets-account'));
    const bridge = args.bridge_account ? {
        atomicassetsAccount: args.atomicassets_account,
        bridgeAccount: args.bridge_account,
        atomicassetsReader: atomicAssetsReader(readers, args.atomicassets_account),
    } : undefined;

    // The backfill needs that reader at S or past it, and the numbering needs this one at S or before it.
    if (bridge && bridge.atomicassetsReader === simpleassetsReader) {
        logger.error('Reader ' + simpleassetsReader + ' runs both the atomicassets and the simpleassets handler. ' +
            'The import needs a separate simpleassets reader that starts at S+1.');
        process.exit(1);
    }

    const connection = new PostgresConnection(
        process.env.POSTGRES_HOST || connectionConfig.postgres.host,
        parseInt(process.env.POSTGRES_PORT, 10) || connectionConfig.postgres.port,
        process.env.POSTGRES_USER || connectionConfig.postgres.user,
        process.env.POSTGRES_PASSWORD || connectionConfig.postgres.password,
        process.env.POSTGRES_DATABASE || connectionConfig.postgres.database
    );

    const pool = connection.createPool({ max: 1 });
    const client = await pool.connect();
    let exitCode = 0;

    try {
        const result = await importSimpleAssetsSnapshot(client, {
            snapshotBlock,
            simpleassetsAccount: args.simpleassets_account,
            simpleassetsReader,
            files,
            bridge,
        });

        logger.info('SimpleAssets import committed', { snapshot_block: snapshotBlock, ...result });
    } catch (error) {
        logger.error('SimpleAssets import failed and rolled back', error);
        exitCode = 1;
    } finally {
        client.release();
        await pool.end().catch(() => undefined);
    }

    process.exit(exitCode);
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});

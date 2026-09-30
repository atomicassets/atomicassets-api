import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import { getTestPostgresConfig } from '../../../utils/test';
import { createBlock, createTx, createActionTrace, createTestTransaction } from '../test-helper';
import { importSimpleAssetsSnapshot, runSnapshotImport, SnapshotImportOptions } from './snapshot-import';
import { assetProcessor } from './processors/assets';
import DataProcessor, { ProcessingState } from '../../processor';
import { ModuleLoader } from '../../modules';
import logger from '../../../utils/winston';

const SA = 'simpleassets';
const AA = 'atomicassets';
const BRIDGE = 'atomicbridge';
const GPK = 'gpk.topps';
const S = 5000;
const AA_READER = 'sa-import-aa-reader';
const SA_READER = 'sa-import-sa-reader';
const GROUP_A = JSON.stringify(['series1', '1', 'common', 'base']);

type AaAsset = { id: string, minter: string, block: number, sassetsId?: string };

const AA_ASSETS: AaAsset[] = [
    { id: '1099511627001', minter: BRIDGE, block: S - 10, sassetsId: '100' },
    { id: '1099511627002', minter: BRIDGE, block: S, sassetsId: '101' },
    { id: '1099511627003', minter: BRIDGE, block: S + 1, sassetsId: '102' },
    { id: '1099511627004', minter: 'gpkcrashpack', block: S - 10 },
    { id: '1099511627005', minter: BRIDGE, block: S - 5 },
];

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

describe('simpleassets snapshot import', () => {
    let client: Client;
    let dir: string;

    function seedAssetRow(assetId: string, mint: number | null): Record<string, unknown> {
        return {
            contract: SA, asset_id: assetId, author: GPK, category: 'series1', owner: 'alice',
            mint_number: mint, mint_group: GROUP_A,
            mutable_data: JSON.stringify({ cardid: 1, quality: 'common', variant: 'base' }), immutable_data: '{}',
            minted_at_block: 0, minted_at_time: 0, transferred_at_block: 0, transferred_at_time: 0,
            updated_at_block: 0, updated_at_time: 0,
        };
    }

    function writeLines(name: string, rows: Record<string, unknown>[]): string {
        const file = path.join(dir, name);
        fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');

        return file;
    }

    function options(overrides: Partial<SnapshotImportOptions> = {}): SnapshotImportOptions {
        return {
            snapshotBlock: S,
            simpleassetsAccount: SA,
            simpleassetsReader: SA_READER,
            bridge: { atomicassetsAccount: AA, bridgeAccount: BRIDGE, atomicassetsReader: AA_READER },
            files: {
                assets: writeLines('assets.jsonl', [seedAssetRow('100', 5), seedAssetRow('101', null)]),
                cardTotals: writeLines('card_totals.jsonl', [{ contract: SA, author: GPK, mint_group: GROUP_A, total_ever: 5 }]),
                config: writeLines('config.jsonl', [{ contract: SA, version: '1.1.0' }]),
            },
            linkBatchSize: 2,
            ...overrides,
        };
    }

    async function seedAtomicAssets(): Promise<void> {
        await client.query(
            'INSERT INTO atomicassets_collections (contract, collection_name, author, allow_notify, authorized_accounts, ' +
            'notify_accounts, market_fee, created_at_block, created_at_time) VALUES ($1, $2, $3, true, $4, $4, 0, 0, 0)',
            [AA, GPK, GPK, []]
        );
        await client.query(
            'INSERT INTO atomicassets_schemas (contract, collection_name, schema_name, format, created_at_block, created_at_time) ' +
            'VALUES ($1, $2, $3, $4, 0, 0)',
            [AA, GPK, 'series1', []]
        );

        for (const asset of AA_ASSETS) {
            const immutable = asset.sassetsId === undefined ? { cardid: 1 } : { cardid: 1, sassets_id: asset.sassetsId };

            await client.query(
                'INSERT INTO atomicassets_assets (contract, asset_id, collection_name, schema_name, owner, immutable_data, mutable_data, ' +
                'transferred_at_block, transferred_at_time, updated_at_block, updated_at_time, minted_at_block, minted_at_time) ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $8, 0, $8, 0)',
                [AA, asset.id, GPK, 'series1', BRIDGE, JSON.stringify(immutable), '{}', asset.block]
            );
            await client.query(
                'INSERT INTO atomicassets_mints (contract, asset_id, minter, receiver, txid) VALUES ($1, $2, $3, $4, $5)',
                [AA, asset.id, asset.minter, 'alice', Buffer.from('00', 'hex')]
            );
        }
    }

    async function tableState(): Promise<string> {
        const tables: Array<[string, string]> = [
            ['simpleassets_assets', 'contract = $1 ORDER BY asset_id'],
            ['simpleassets_card_totals', 'contract = $1 ORDER BY mint_group'],
            ['simpleassets_config', 'contract = $1'],
            ['atomicassets_original_mints', 'original_contract = $1 ORDER BY asset_id'],
        ];
        const state: Record<string, unknown> = {};

        for (const [table, where] of tables) {
            state[table] = (await client.query('SELECT * FROM ' + table + ' WHERE ' + where, [SA])).rows;
        }

        return JSON.stringify(state);
    }

    async function links(): Promise<Record<string, string | null>> {
        const result = await client.query(
            'SELECT asset_id, original_mint FROM atomicassets_original_mints WHERE original_contract = $1', [SA]
        );

        return Object.fromEntries(result.rows.map(row => [row.asset_id, row.original_mint]));
    }

    async function importError(run: () => Promise<unknown>): Promise<Error | null> {
        try {
            await run();
        } catch (e) {
            return e as Error;
        }

        return null;
    }

    before(async () => {
        client = new Client(getTestPostgresConfig());
        await client.connect();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-import-'));
    });

    after(async () => {
        await client.end();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function setReaderBlock(block: number | null, name = AA_READER): Promise<void> {
        await client.query('DELETE FROM contract_readers WHERE name = $1', [name]);

        if (block !== null) {
            await client.query(
                'INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, $2, 0, true, 0)',
                [name, block]
            );
        }
    }

    beforeEach(async () => {
        await client.query('BEGIN');
        await seedAtomicAssets();
        await setReaderBlock(S);
    });

    afterEach(async () => {
        sinon.restore();
        await client.query('ROLLBACK');
    });

    it('loads the three tables', async () => {
        await runSnapshotImport(client, options());

        const assets = await client.query('SELECT * FROM simpleassets_assets WHERE contract = $1 ORDER BY asset_id', [SA]);
        expect(assets.rows.map(row => [row.asset_id, row.mint_number])).to.deep.equal([['100', '5'], ['101', null]]);
        expect(assets.rows[0].mutable_data).to.deep.equal({ cardid: 1, quality: 'common', variant: 'base' });
        expect(assets.rows[0].mint_group).to.equal(GROUP_A);

        const totals = await client.query('SELECT total_ever FROM simpleassets_card_totals WHERE contract = $1', [SA]);
        expect(totals.rows.map(row => row.total_ever)).to.deep.equal(['5']);

        const config = await client.query('SELECT version FROM simpleassets_config WHERE contract = $1', [SA]);
        expect(config.rows[0].version).to.equal('1.1.0');
    });

    it('sets the baseline and the seed rows updated_at_block to the snapshot block', async () => {
        await runSnapshotImport(client, options());

        const config = await client.query('SELECT bootstrap_baseline_block FROM simpleassets_config WHERE contract = $1', [SA]);
        expect(config.rows[0].bootstrap_baseline_block).to.equal(String(S));

        const assets = await client.query('SELECT DISTINCT updated_at_block FROM simpleassets_assets WHERE contract = $1', [SA]);
        expect(assets.rows.map(row => row.updated_at_block)).to.deep.equal([String(S)]);
    });

    it('sets the baseline on a config row the handler created before the import', async () => {
        await client.query('INSERT INTO simpleassets_config (contract, version) VALUES ($1, $2)', [SA, '1.0.0']);

        await runSnapshotImport(client, options());

        const config = await client.query('SELECT version, bootstrap_baseline_block FROM simpleassets_config WHERE contract = $1', [SA]);
        expect(config.rows[0]).to.deep.equal({ version: '1.0.0', bootstrap_baseline_block: String(S) });
    });

    it('leaves a seed row unchanged when a trace from before the snapshot replays', async () => {
        await runSnapshotImport(client, options());

        const processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        const destroy = assetProcessor({ args: { simpleassets_account: SA, store_transfers: false } } as any, processor);
        const transfer = (block: number): void => processor.processActionTrace(
            createBlock({ block_num: block }), createTx(),
            createActionTrace(SA, 'transfer', { from: 'alice', to: 'bob', assetids: ['100'], memo: '' })
        );

        try {
            transfer(S - 1);
            await processor.executeHeadQueue(createTestTransaction(client));

            let row = (await client.query('SELECT owner, updated_at_block FROM simpleassets_assets WHERE contract = $1 AND asset_id = 100', [SA])).rows[0];
            expect(row).to.deep.equal({ owner: 'alice', updated_at_block: String(S) });

            transfer(S + 1);
            await processor.executeHeadQueue(createTestTransaction(client));

            row = (await client.query('SELECT owner FROM simpleassets_assets WHERE contract = $1 AND asset_id = 100', [SA])).rows[0];
            expect(row.owner).to.equal('bob');
        } finally {
            destroy();
        }
    });

    it('backfills links for bridge mints at or below the snapshot block only', async () => {
        const warn = sinon.stub(logger, 'warn');

        const result = await runSnapshotImport(client, options());

        expect(await links()).to.deep.equal({ '1099511627001': '5', '1099511627002': null });
        expect(result.links).to.equal(2);
        expect(result.linksWithoutMint).to.equal(1);
        expect(warn.calledWithMatch(sinon.match(/no mint/))).to.equal(true);
    });

    it('changes nothing on a second run', async () => {
        await runSnapshotImport(client, options());
        const before = await tableState();

        const result = await runSnapshotImport(client, options());

        expect(await tableState()).to.equal(before);
        expect(result).to.include({ assets: 0, cardTotals: 0, links: 0 });
    });

    it('loads no links without a bridge', async () => {
        await runSnapshotImport(client, options({ bridge: undefined }));

        expect(await links()).to.deep.equal({});
    });

    it('refuses when the link table holds rows above the snapshot block', async () => {
        await client.query(
            'INSERT INTO atomicassets_original_mints (contract, asset_id, original_contract, original_asset_id, original_mint, block_num) ' +
            'VALUES ($1, $2, $3, $4, $5, $6)',
            [AA, '1099511627003', SA, '102', 1, S + 1]
        );

        const error = await importError(() => runSnapshotImport(client, options()));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('atomicassets_original_mints').and.to.contain(String(S));
        expect((await client.query('SELECT 1 FROM simpleassets_assets WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('refuses when the atomicassets reader is below the snapshot block', async () => {
        await setReaderBlock(S - 1);

        const error = await importError(() => runSnapshotImport(client, options()));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain(AA_READER).and.to.contain(String(S - 1)).and.to.contain(String(S));
        expect((await client.query('SELECT 1 FROM simpleassets_assets WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('refuses when the atomicassets reader has no position', async () => {
        await setReaderBlock(null);

        const error = await importError(() => runSnapshotImport(client, options()));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain(AA_READER).and.to.contain(String(S));
        expect((await client.query('SELECT 1 FROM simpleassets_config WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('imports when the atomicassets reader stands exactly at the snapshot block', async () => {
        await setReaderBlock(S);

        const result = await runSnapshotImport(client, options());

        expect(result.links).to.equal(2);
    });

    it('refuses when the simpleassets reader has processed a block above the snapshot block', async () => {
        await setReaderBlock(S + 1, SA_READER);

        const error = await importError(() => runSnapshotImport(client, options()));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('simpleassets reader ' + SA_READER).and.to.contain(String(S + 1)).and.to.contain(String(S));
        expect((await client.query('SELECT 1 FROM simpleassets_config WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('refuses when simpleassets_assets holds a row minted above the snapshot block', async () => {
        await client.query(
            'INSERT INTO simpleassets_assets (contract, asset_id, author, category, owner, mutable_data, immutable_data, ' +
            'transferred_at_block, transferred_at_time, updated_at_block, updated_at_time, minted_at_block, minted_at_time) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 0, $7, 0, $7, 0)',
            [SA, '900', GPK, 'series1', 'alice', '{}', S + 1]
        );

        const error = await importError(() => runSnapshotImport(client, options()));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('simpleassets_assets already holds assets minted above the snapshot block ' + S);
        expect((await client.query('SELECT 1 FROM simpleassets_config WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('imports when the simpleassets reader row holds the value it stores before its first block', async () => {
        await setReaderBlock(0, SA_READER);

        const result = await runSnapshotImport(client, options());

        expect(result.assets).to.equal(2);
    });

    it('refuses a first import when simpleassets_assets already holds a row of the contract', async () => {
        await client.query(
            'INSERT INTO simpleassets_assets (contract, asset_id, author, category, owner, mutable_data, immutable_data, ' +
            'transferred_at_block, transferred_at_time, updated_at_block, updated_at_time, minted_at_block, minted_at_time) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 0, $7, 0, $7, 0)',
            [SA, '100', GPK, 'series1', 'carol', '{}', S - 100]
        );

        const error = await importError(() => runSnapshotImport(client, options()));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('simpleassets_assets already holds rows of ' + SA);
        expect((await client.query('SELECT owner FROM simpleassets_assets WHERE contract = $1', [SA])).rows)
            .to.deep.equal([{ owner: 'carol' }]);
        expect((await client.query('SELECT 1 FROM simpleassets_config WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('refuses a first import when simpleassets_card_totals already holds a row of the contract', async () => {
        await client.query(
            'INSERT INTO simpleassets_card_totals (contract, author, mint_group, total_ever) VALUES ($1, $2, $3, $4)',
            [SA, GPK, GROUP_A, 2]
        );

        const error = await importError(() => runSnapshotImport(client, options()));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('simpleassets_card_totals already holds rows of ' + SA);
        expect((await client.query('SELECT 1 FROM simpleassets_assets WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('refuses an asset_id above the safe integer range written as a JSON number', async () => {
        const assets = path.join(dir, 'big-number.jsonl');
        fs.writeFileSync(assets, JSON.stringify(seedAssetRow('0', 5)).replace('"asset_id":"0"', '"asset_id":9007199254740993') + '\n');

        const error = await importError(() => runSnapshotImport(client, options({ files: { ...options().files, assets } })));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain(assets).and.to.contain('asset_id');
        expect((await client.query('SELECT 1 FROM simpleassets_assets WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('imports an asset_id above the safe integer range written as a string with the exact id', async () => {
        const assets = writeLines('big-string.jsonl', [seedAssetRow('9007199254740993', 5)]);

        await runSnapshotImport(client, options({ files: { ...options().files, assets } }));

        expect((await client.query('SELECT asset_id::text AS id FROM simpleassets_assets WHERE contract = $1', [SA])).rows)
            .to.deep.equal([{ id: '9007199254740993' }]);
    });

    it('waits for another import of the same contract', async () => {
        const holder = new Client(getTestPostgresConfig());
        await holder.connect();

        try {
            await holder.query('SELECT pg_advisory_lock(hashtext($1))', ['simpleassets-import:' + SA]);
            await client.query('SET LOCAL lock_timeout = \'200ms\'');

            const error = await importError(() => runSnapshotImport(client, options()));

            expect(error?.message).to.contain('lock timeout');
        } finally {
            await holder.query('SELECT pg_advisory_unlock_all()');
            await holder.end();
        }
    });

    it('refuses when the baseline already holds another block', async () => {
        await client.query(
            'INSERT INTO simpleassets_config (contract, version, bootstrap_baseline_block) VALUES ($1, $2, $3)', [SA, '1.0.0', S - 1]
        );

        const error = await importError(() => runSnapshotImport(client, options()));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('bootstrap_baseline_block');
    });

    it('refuses a file row of another contract', async () => {
        const assets = writeLines('other.jsonl', [{ ...seedAssetRow('100', 5), contract: 'othercontrct' }]);

        const error = await importError(() => runSnapshotImport(client, options({ files: { ...options().files, assets } })));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('othercontrct');
    });

    it('refuses a file column that is not an ECA column', async () => {
        const assets = writeLines('unknown.jsonl', [{ ...seedAssetRow('100', 5), mint: 5 }]);

        const error = await importError(() => runSnapshotImport(client, options({ files: { ...options().files, assets } })));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('has columns that simpleassets_assets does not: mint');
    });

    it('refuses an assets file without a required column', async () => {
        const { owner, ...row } = seedAssetRow('100', 5);
        const assets = writeLines('no-owner.jsonl', [row]);

        const error = await importError(() => runSnapshotImport(client, options({ files: { ...options().files, assets } })));

        expect(owner).to.equal('alice');
        expect(error).to.not.equal(null);
        expect(error.message).to.contain(assets).and.to.contain('lacks columns that simpleassets_assets requires: owner');
        expect((await client.query('SELECT 1 FROM simpleassets_assets WHERE contract = $1', [SA])).rowCount).to.equal(0);
    });

    it('refuses a config file with two rows', async () => {
        const config = writeLines('two-config.jsonl', [{ contract: SA, version: '1.1.0' }, { contract: SA, version: '1.1.0' }]);

        const error = await importError(() => runSnapshotImport(client, options({ files: { ...options().files, config } })));

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('the config file must hold one row, found 2');
    });

    describe('importSimpleAssetsSnapshot', () => {
        it('bounds and pins the import transaction and leaves the session settings as they were', async () => {
            const own = new Client(getTestPostgresConfig());
            const ownReader = 'sa-import-own-reader';
            const settings = 'SELECT current_setting($1) AS st, current_setting($2) AS lt, current_setting($3) AS sp';
            const names = ['statement_timeout', 'lock_timeout', 'search_path'];
            await own.connect();
            const query = own.query.bind(own) as (text: string, values?: unknown[]) => Promise<{rowCount: number, rows: any[]}>;
            let inside: unknown = null;

            // A pooled connection arrives with a cap and a search_path of its own.
            await query('SET statement_timeout = \'30s\'');
            await query('SET lock_timeout = \'2s\'');
            await query('SET search_path TO public, pg_catalog');
            const session = (await query(settings, names)).rows[0];

            sinon.stub(own, 'query').callsFake((async (text: string, values?: unknown[]) => {
                if (inside === null && text.startsWith('DROP TABLE IF EXISTS pg_temp.')) {
                    inside = (await query(settings, names)).rows[0];
                }

                return query(text, values);
            }) as never);

            try {
                await query(
                    'INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, $2, 0, true, 0)',
                    [ownReader, S]
                );

                await importSimpleAssetsSnapshot(own, options({
                    bridge: { atomicassetsAccount: AA, bridgeAccount: BRIDGE, atomicassetsReader: ownReader },
                }));

                expect(inside).to.deep.equal({ st: '0', lt: '1min', sp: 'public' });
                expect((await query(settings, names)).rows[0]).to.deep.equal(session);
            } finally {
                for (const table of ['simpleassets_assets', 'simpleassets_card_totals', 'simpleassets_config']) {
                    await query('DELETE FROM ' + table + ' WHERE contract = $1', [SA]);
                }

                await query('DELETE FROM contract_readers WHERE name = $1', [ownReader]);
                await own.end();
            }
        });

        it('rolls every table back when the import fails after its inserts', async () => {
            // The wrapper owns its transaction, so it needs a connection outside the test one, and a
            // reader name the test transaction has not locked.
            const own = new Client(getTestPostgresConfig());
            const ownReader = 'sa-import-own-reader';
            await own.connect();
            const query = own.query.bind(own) as (text: string, values?: unknown[]) => Promise<{rowCount: number}>;

            // A client-side throw leaves the transaction open: only the wrapper's ROLLBACK undoes the
            // inserts. A server error would not test it, since Postgres turns COMMIT of a failed one into ROLLBACK.
            sinon.stub(own, 'query').callsFake(((text: string, values?: unknown[]) => {
                if (text.startsWith('SELECT asset_id FROM atomicassets_mints')) {
                    return Promise.reject(new Error('injected backfill failure'));
                }

                return query(text, values);
            }) as never);

            try {
                await query(
                    'INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, $2, 0, true, 0)',
                    [ownReader, S]
                );

                const error = await importError(() => importSimpleAssetsSnapshot(own, options({
                    bridge: { atomicassetsAccount: AA, bridgeAccount: BRIDGE, atomicassetsReader: ownReader },
                })));

                expect(error?.message).to.equal('injected backfill failure');

                for (const table of ['simpleassets_assets', 'simpleassets_card_totals', 'simpleassets_config']) {
                    expect((await query('SELECT 1 FROM ' + table + ' WHERE contract = $1', [SA])).rowCount, table).to.equal(0);
                }
            } finally {
                for (const table of ['simpleassets_assets', 'simpleassets_card_totals', 'simpleassets_config']) {
                    await query('DELETE FROM ' + table + ' WHERE contract = $1', [SA]);
                }

                await query('DELETE FROM contract_readers WHERE name = $1', [ownReader]);
                await own.end();
            }
        });
    });
});

import 'mocha';
import {expect} from 'chai';
import {Client} from 'pg';
import AtomicAssetsHandler from '../index';
import DataProcessor, {ProcessingState} from '../../../processor';
import {createBlock, createContractRow, createMockModuleLoader, createProcessorTestContext, createTestTransaction, processContractRow} from '../../test-helper';
import {getConfigAction} from '../../../../api/namespaces/atomicassets/handlers/config';
import {configProcessor} from './config';

const contract = 'aatokentest';
const token = (symbol: string): {sym: string; contract: string} => ({sym: `4,${symbol}`, contract: 'eosio.token'});

describe('configProcessor supported tokens on PostgreSQL', () => {
    let client: Client;
    before(async () => {client = createProcessorTestContext().client; await client.connect();});
    after(async () => {await client.end();});
    beforeEach(async () => {await client.query('BEGIN');});
    afterEach(async () => {await client.query('ROLLBACK');});

    for (const canonicalSymbol of ['BBB', 'CCC']) {
    it(`rolls back an orphaned token and accepts canonical ${canonicalSymbol}`, async () => {
        const reader = 'test-atomic-token-fork';
        try {
            await client.query('INSERT INTO atomicassets_config (contract, version, collection_format) VALUES ($1, $2, ARRAY[]::jsonb[])', [contract, '1.2.0']);
            await client.query('INSERT INTO atomicassets_tokens (contract, token_symbol, token_contract, token_precision) VALUES ($1,$2,$3,$4)',
                [contract, 'AAA', 'eosio.token', 4]);
            const core: any = {args: {atomicassets_account: contract}, config: {supported_tokens: [token('AAA')], collection_format: []},
                tokenconfigs: {standard: 'atomicassets', version: '1.2.0'}};
            const processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
            const destroy = configProcessor(core, processor);
            const orphan = createBlock({block_num: 3000});
            const db = createTestTransaction(client, reader, orphan.block_num);
            const apply = async (tx: any, tokens: ReturnType<typeof token>[]): Promise<void> => {
                await processContractRow(processor, tx, orphan, createContractRow(contract, 'config', {supported_tokens: tokens, collection_format: []}, true));
            };
            await apply(db, [token('AAA'), token('BBB')]);
            await db.rollbackReversibleBlocks(orphan.block_num);
            await processor.notifyFork(db);
            expect(core.config.supported_tokens).to.deep.equal([token('AAA')]);
            const canonical = createTestTransaction(client, reader, orphan.block_num);
            await apply(canonical, [token('AAA'), token(canonicalSymbol)]);
            await apply(canonical, [token('AAA'), token(canonicalSymbol)]);
            const rows = await client.query('SELECT token_symbol, token_contract, token_precision FROM atomicassets_tokens WHERE contract = $1 ORDER BY token_symbol', [contract]);
            expect(rows.rows).to.deep.equal(['AAA', canonicalSymbol].map(token_symbol => ({token_symbol, token_contract: 'eosio.token', token_precision: 4})));
            const database: any = {async query(sql: string, values: any[] = []): Promise<any> {
                if (sql.startsWith('SELECT MIN(block_num)')) return {rows: [{block: null}], rowCount: 1};
                if (sql.startsWith('SELECT block_num FROM contract_readers')) return {rows: [{block_num: 1}], rowCount: 1};
                return client.query(sql, values);
            }};
            const rpc = {async get_info(): Promise<any> {return {head_block_num: 100000, last_irreversible_block_num: 99999};},
                async get_table_rows(): Promise<any> {return {rows: [{standard: 'atomicassets', version: '1.2.0'}]};}};
            const restarted = new AtomicAssetsHandler({connection: {database, chain: {rpc}}, reader: {name: reader}} as any,
                {atomicassets_account: contract});
            await restarted.init(client as any);
            expect(restarted.config.supported_tokens.map((item: any) => item.sym).sort()).to.deep.equal(['4,AAA', `4,${canonicalSymbol}`].sort());
            const result = await getConfigAction({}, {db: database, coreArgs: {atomicassets_account: contract}} as any);
            expect(result.supported_tokens.map((item: any) => item.token_symbol).sort()).to.deep.equal(['AAA', canonicalSymbol].sort());
            destroy();
        } finally {
            // Fork rollback commits chunks; remove only this test's own rows.
            await client.query('COMMIT');
            await client.query('DELETE FROM atomicassets_tokens WHERE contract = $1', [contract]);
            await client.query('DELETE FROM atomicassets_config WHERE contract = $1', [contract]);
            await client.query('DELETE FROM reversible_queries WHERE reader = $1', [reader]);
            await client.query('DELETE FROM reversible_blocks WHERE reader = $1', [reader]);
            await client.query('BEGIN');
        }
    });
    }
});

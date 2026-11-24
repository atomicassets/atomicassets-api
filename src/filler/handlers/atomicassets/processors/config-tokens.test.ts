import 'mocha';
import {expect} from 'chai';
import DataProcessor, {ProcessingState} from '../../../processor';
import {createBlock, createContractRow, createMockModuleLoader, processContractRow} from '../../test-helper';
import {configProcessor} from './config';

const token = (symbol: string): {sym: string; contract: string} => ({sym: `4,${symbol}`, contract: 'eosio.token'});
function setup(): any {
    const core: any = {args: {atomicassets_account: 'atomicassets'}, config: {supported_tokens: [token('AAA')], collection_format: []},
        tokenconfigs: {standard: 'atomicassets', version: '1.2.0'}};
    const processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
    const destroy = configProcessor(core, processor), rows = new Map<string, any>([['AAA', {token_symbol: 'AAA', token_contract: 'eosio.token', token_precision: 4}]]);
    const db: any = {config: {version: '1.2.0', collection_format: []}, fail: false,
        async insert(table: string, row: any, _keys: any, _reversible: any, _lock: any, conflict: string): Promise<void> {
            expect(table).to.equal('atomicassets_tokens'); expect(conflict).to.equal('nothing');
            if (!rows.has(row.token_symbol)) rows.set(row.token_symbol, row);
        },
        async query(sql: string): Promise<any> {
            if (this.fail || (this.failTokens && sql.includes('FROM atomicassets_tokens'))) throw Error('database unavailable');
            if (sql.includes('FROM atomicassets_config')) return {rows: this.config ? [this.config] : [], rowCount: this.config ? 1 : 0};
            if (sql.includes('FROM atomicassets_tokens')) return {rows: [...rows.values()], rowCount: rows.size};
            throw Error(`Unexpected query ${sql}`);
        }};
    const apply = async (supported_tokens: ReturnType<typeof token>[]): Promise<void> => {
        await processContractRow(processor, db, createBlock(), createContractRow('atomicassets', 'config', {supported_tokens, collection_format: []}, true));
    };
    return {core, processor, db, rows, apply, destroy};
}

describe('configProcessor supported tokens after a fork', () => {
    for (const canonical of ['BBB', 'CCC']) {
        it(`restores the cache before the canonical add of ${canonical}`, async () => {
            const s = setup();await s.apply([token('AAA'), token('BBB')]);
            s.rows.delete('BBB'); // controlled model of the rollback, not PostgreSQL
            await s.processor.notifyFork(s.db);
            const restored = structuredClone(s.core.config.supported_tokens);
            await s.apply([token('AAA'), token(canonical)]);
            expect([...s.rows.keys()].sort()).to.deep.equal(['AAA', canonical].sort());
            expect(restored).to.deep.equal([token('AAA')]);
        });
    }
    it('restores format and version even when the canonical branch has no config delta', async () => {
        const s = setup();s.core.config.collection_format = [{name: 'orphan', type: 'string'}];s.core.tokenconfigs.version = '2.0.0';
        await s.processor.notifyFork(s.db);
        expect(s.core.config.collection_format).to.deep.equal([]);expect(s.core.tokenconfigs.version).to.equal('1.2.0');
    });
    it('fails closed on missing config or read errors without partially replacing the cache', async () => {
        for (const mode of ['missing', 'error', 'token-error']) {
            const s = setup(), before = structuredClone({config: s.core.config, tokenconfigs: s.core.tokenconfigs});
            if (mode === 'missing') s.db.config = null; else if (mode === 'token-error') s.db.failTokens = true; else s.db.fail = true;
            let error: unknown;try {await s.processor.notifyFork(s.db);} catch (e) {error = e;}
            expect(error).to.be.instanceOf(Error);expect({config: s.core.config, tokenconfigs: s.core.tokenconfigs}).to.deep.equal(before);
        }
    });
    it('retains an existing token row on re-add and replay', async () => {
        const s = setup(), retained = {token_symbol: 'BBB', token_contract: 'original', token_precision: 2};
        s.rows.set('BBB', retained);
        await s.apply([token('AAA'), token('BBB')]);
        await s.apply([token('AAA'), token('BBB')]);
        expect(s.rows.get('BBB')).to.equal(retained);
    });
    it('unregisters the fork listener with the processor destructor', async () => {
        const s = setup();s.destroy();s.db.fail = true;await s.processor.notifyFork(s.db);
    });
});

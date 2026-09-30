import 'mocha';
import { expect } from 'chai';
import SimpleAssetsHandler from './index';

const CONTRACT = 'simpleassets';

async function initError(tokenconfigsRows: any[]): Promise<Error | null> {
    const handler = {
        args: { simpleassets_account: CONTRACT },
        connection: { chain: { rpc: { get_table_rows: async (): Promise<any> => ({ rows: tokenconfigsRows }) } } },
    };
    const client = { query: async (): Promise<any> => ({ rows: [], rowCount: 0 }) };

    try {
        await SimpleAssetsHandler.prototype.init.call(handler, client);
    } catch (e) {
        return e as Error;
    }

    return null;
}

describe('SimpleAssetsHandler.init', () => {
    it('throws an error naming the contract when the tokenconfigs table is empty', async () => {
        const error = await initError([]);

        expect(error).to.not.equal(null);
        expect(error.message).to.contain(CONTRACT).and.to.contain('tokenconfigs');
    });

    it('throws an error naming the contract when the account runs another standard', async () => {
        const error = await initError([{ standard: 'other', version: '1.0.0' }]);

        expect(error).to.not.equal(null);
        expect(error.message).to.contain(CONTRACT).and.to.contain('not deployed');
    });
});

function construct(args: {[key: string]: any}): SimpleAssetsHandler {
    const filler = { connection: {} } as any;

    return new SimpleAssetsHandler(filler, { simpleassets_account: CONTRACT, store_transfers: true, ...args });
}

describe('SimpleAssetsHandler constructor', () => {
    it('defaults both numbering lists to empty', () => {
        const handler = construct({});

        expect(handler.args.numbered_authors).to.deep.equal([]);
        expect(handler.args.numbered_group_fields).to.deep.equal([]);
    });

    it('keeps configured numbering lists', () => {
        const handler = construct({ numbered_authors: ['gpk.topps'], numbered_group_fields: ['cardid', 'quality'] });

        expect(handler.args.numbered_authors).to.deep.equal(['gpk.topps']);
        expect(handler.args.numbered_group_fields).to.deep.equal(['cardid', 'quality']);
    });

    it('rejects a numbered_authors value that is not a list', () => {
        expect(() => construct({ numbered_authors: 'gpk.topps' })).to.throw('numbered_authors');
    });

    it('rejects a numbered_group_fields list that holds a non-string', () => {
        expect(() => construct({ numbered_group_fields: ['cardid', 3] })).to.throw('numbered_group_fields');
    });
});

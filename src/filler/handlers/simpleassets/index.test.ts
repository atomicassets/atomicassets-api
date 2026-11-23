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

describe('SimpleAssetsHandler bridge link arguments', () => {
    it('rejects bridge_account without atomicassets_account', () => {
        expect(() => construct({ bridge_account: 'atomicbridge' })).to.throw('atomicassets_account');
    });

    it('rejects atomicassets_account without bridge_account', () => {
        expect(() => construct({ atomicassets_account: 'atomicassets' })).to.throw('bridge_account');
    });

    it('rejects an empty bridge_account', () => {
        expect(() => construct({ bridge_account: '', atomicassets_account: 'atomicassets' })).to.throw('non-empty');
    });

    it('rejects an empty atomicassets_account', () => {
        expect(() => construct({ bridge_account: 'atomicbridge', atomicassets_account: '' })).to.throw('non-empty');
    });

    it('keeps bridge_account with atomicassets_account', () => {
        const handler = construct({ bridge_account: 'atomicbridge', atomicassets_account: 'atomicassets' });

        expect(handler.args.bridge_account).to.equal('atomicbridge');
        expect(handler.args.atomicassets_account).to.equal('atomicassets');
    });

    async function initWithLinkTable(args: {[key: string]: any}, tableExists: boolean): Promise<{error: Error | null, queries: string[]}> {
        const queries: string[] = [];
        const handler = { args: { simpleassets_account: CONTRACT, ...args } };
        const client = {
            query: async (sql: string): Promise<any> => {
                queries.push(sql);

                if (sql.includes('to_regclass')) {
                    return { rows: [{ exists: tableExists }], rowCount: 1 };
                }

                return { rows: [{ version: '1.0.0' }], rowCount: 1 };
            },
        };

        try {
            await SimpleAssetsHandler.prototype.init.call(handler, client);
        } catch (e) {
            return { error: e as Error, queries };
        }

        return { error: null, queries };
    }

    it('fails init with an error naming the link table when bridge_account is set and the table is missing', async () => {
        const { error } = await initWithLinkTable({ bridge_account: 'atomicbridge', atomicassets_account: 'atomicassets' }, false);

        expect(error).to.not.equal(null);
        expect(error.message).to.contain('atomicassets_original_mints');
    });

    it('passes init when bridge_account is set and the table exists', async () => {
        const { error } = await initWithLinkTable({ bridge_account: 'atomicbridge', atomicassets_account: 'atomicassets' }, true);

        expect(error).to.equal(null);
    });

    it('does not look for the link table without bridge_account', async () => {
        const { error, queries } = await initWithLinkTable({}, false);

        expect(error).to.equal(null);
        expect(queries.some(sql => sql.includes('to_regclass'))).to.equal(false);
    });
});

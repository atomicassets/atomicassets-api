import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
import {
    createBlock,
    createContractRow,
    createMockModuleLoader,
    createProcessorTestContext,
    createTestTransaction,
    processContractRow,
} from '../../test-helper';
import { authorProcessor } from './authors';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';

const CONTRACT = 'simpleassets';

function authorRow(dappinfo: Record<string, any>): Record<string, any> {
    return {
        author: 'gpk.topps',
        dappinfo: JSON.stringify(dappinfo),
        fieldtypes: '{"cardid":"txt"}',
        priorityimg: '{}',
    };
}

describe('simpleassets authorProcessor', () => {
    let client: Client;
    let processor: DataProcessor;
    let db: ContractDBTransaction;
    let destroyProcessor: (() => any) | null = null;

    before(async () => {
        const ctx = createProcessorTestContext();
        client = ctx.client;
        await client.connect();
    });

    after(async () => {
        await client.end();
    });

    beforeEach(async () => {
        await client.query('BEGIN');
        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        db = createTestTransaction(client);
        destroyProcessor = authorProcessor({ args: { simpleassets_account: CONTRACT } } as any, processor);
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
            destroyProcessor = null;
        }
        await client.query('ROLLBACK');
    });

    async function getAuthor(): Promise<Record<string, any> | null> {
        const result = await client.query(
            'SELECT * FROM simpleassets_authors WHERE contract = $1 AND author = $2',
            [CONTRACT, 'gpk.topps']
        );

        return result.rows[0] ?? null;
    }

    it('writes a new author row from an authors delta', async () => {
        await processContractRow(processor, db, createBlock(), createContractRow(CONTRACT, 'authors', authorRow({ name: 'GPK' })));

        const author = await getAuthor();
        expect(author).to.not.equal(null);
        expect(author.dappinfo).to.deep.equal({ name: 'GPK' });
        expect(author.fieldtypes).to.deep.equal({ cardid: 'txt' });
    });

    it('replaces an existing author row from a later delta', async () => {
        await processContractRow(processor, db, createBlock(), createContractRow(CONTRACT, 'authors', authorRow({ name: 'GPK' })));
        await processContractRow(processor, db, createBlock(), createContractRow(CONTRACT, 'authors', authorRow({ name: 'GPK 2' })));

        expect((await getAuthor()).dappinfo).to.deep.equal({ name: 'GPK 2' });
    });

    it('deletes the author row when the delta removes it', async () => {
        await processContractRow(processor, db, createBlock(), createContractRow(CONTRACT, 'authors', authorRow({ name: 'GPK' })));
        await processContractRow(processor, db, createBlock(), createContractRow(CONTRACT, 'authors', authorRow({ name: 'GPK' }), false));

        expect(await getAuthor()).to.equal(null);
    });
});

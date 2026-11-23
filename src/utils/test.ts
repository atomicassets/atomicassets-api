import { Client } from 'pg';
import { it } from 'vitest';
import { getTestPostgresConfig } from './test-config';
import { DB } from '../api/server';
import { RequestValues } from '../api/namespaces/utils';
import { AtomicMarketContext } from '../api/namespaces/atomicmarket';
import { IConnectionsConfig } from '../types/config';
import { initListValidator } from '../api/namespaces/lists';

export { getTestPostgresConfig } from './test-config';

// Never load an operator's connections.config.json from a test helper.
export const connectionConfig: IConnectionsConfig = {
    postgres: {
        host: process.env.POSTGRES_TEST_HOST || '127.0.0.1',
        port: Number(process.env.POSTGRES_TEST_PORT || 5432),
        user: process.env.POSTGRES_TEST_USER || 'root',
        password: process.env.POSTGRES_TEST_PASSWORD || 'testpassword',
        database: process.env.POSTGRES_TEST_DATABASE || 'test_db',
    },
    redis: {
        host: process.env.REDIS_TEST_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_TEST_PORT || 6379),
    },
    chain: {
        name: 'test',
        chain_id: '0'.repeat(64),
        http: 'http://127.0.0.1:8888',
        ship: 'ws://127.0.0.1:8080',
    },
} as IConnectionsConfig;

export class TestClient extends Client implements DB {

    private id: number = 1;

    constructor() {
        super(getTestPostgresConfig());

        // eslint-disable-next-line no-console
        this.connect().catch(console.error);
    }

    getId(): number {
        return ++this.id;
    }

    getName(): string {
        const replacements: Record<string, string> = {
            '6': 'a',
            '7': 'b',
            '8': 'c',
            '9': 'd',
            '0': 'e',
        };
        return `n${String(this.getId()).split('').map(char => replacements[char] ?? char).join('')}`;
    }

    async init(): Promise<void> {}

    async createContractCode(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return await this.insert('contract_codes', {
            account: 'account',
            block_num: this.getId(),
            block_time: this.getId(),
            ...values,
        });
    }

    async createContractTrace(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return await this.insert('contract_traces', {
            global_sequence: this.getId(),
            account: 'amtest',
            name: 'lognewsale',
            metadata: {},
            txid: Buffer.alloc(32),
            created_at_block: this.getId(),
            created_at_time: this.getId(),
            ...values,
        });
    }

    async createContractReader(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return await this.insert('contract_readers', {
            name: 'test-default',
            block_num: this.getId(),
            block_time: this.getId(),
            live: false,
            updated: this.getId(),
            ...values,
        });
    }

    async createList(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return this.insert('lists', {
            list_name: 'list1',
            ...values,
        });
    }

    async createListItem(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return this.insert('list_items', {
            item_name: 'item1',
            ...values,
        });
    }

    async createFullList(listValues: Record<string, any> = {}, itemValues: Record<string, any> = {}): Promise<Record<string, any>> {
        const list = await this.createList(listValues);

        const listItem = await this.createListItem({
            ...itemValues,
            list_id: list.id,
        });

        return {
            list,
            listItem,
        };
    }

    protected async insert(table: string, data: Record<string, any>): Promise<Record<string, any>> {
        data = data || {};

        const columns = Object.keys(data);

        const columnsSQL = (columns.length ? '('+columns.join(',')+')' : '');
        const valuesSQL = (columns.length ? `VALUES (${columns.map((c, i) => `$${i + 1}`).join(',')})` : 'DEFAULT VALUES');
        const values = columns.map(c => data[c]);

        const sql = `INSERT INTO ${table} ${columnsSQL} ${valuesSQL} RETURNING *`;

        const {rows} = await this.query(sql, values);

        return rows[0];
    }

    async fetchOne<T = any>(queryText: string, values: any[] = []): Promise<T> {
        const {rows} = await this.query(queryText, values);

        return rows[0];
    }

}

export function createTxIt(client: TestClient) {
    type TransactionTest = (client: TestClient) => Promise<void>;

    async function runTxTest(fn: TransactionTest): Promise<void> {
        await client.query('BEGIN');
        initListValidator(client);

        try {
            await client.init();
            await fn(client);
        } finally {
            await client.query('ROLLBACK');
        }
    }

    // Do not use concurrent tests: each helper owns one shared pg.Client.
    const txit = (title: string, fn: TransactionTest) => it(title, () => runTxTest(fn));
    txit.skip = (title: string, fn: TransactionTest) => it.skip(title, () => runTxTest(fn));
    txit.only = (title: string, fn: TransactionTest) => it.only(title, () => runTxTest(fn));

    return txit;
}

export function getTestContext(db: DB, pathParams: RequestValues = {}): AtomicMarketContext {
    return {
        pathParams,
        db,
        coreArgs: {
            atomicmarket_account: 'amtest',
            atomicassets_account: 'aatest',
            delphioracle_account: 'dotest',

            connected_reader: '',

            socket_features: {
                asset_update: false,
            },
        },
    };
}

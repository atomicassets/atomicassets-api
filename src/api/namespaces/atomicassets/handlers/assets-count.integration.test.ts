import 'mocha';
import {expect} from 'chai';
import {RequestValues} from '../../utils';
import {initAtomicAssetsTest} from '../test';
import {getTestContext} from '../../../../utils/test';
import {getAssetsCountAction, getRawAssetsAction} from './assets';
import {getMarketAssetsCountAction} from '../../atomicmarket/handlers/assets';

const {client, txit} = initAtomicAssetsTest();
const usedAggregate = (queries: string[]): boolean => queries.some(sql => /FROM atomicassets_asset_counts ac/.test(sql));
const usedRawCount = (queries: string[]): boolean => queries.some(sql => /SELECT COUNT\(\*\) counter/.test(sql));

function context(queries: string[] = [], enabled?: boolean) {
    const ctx = getTestContext({
        query: (sql: string, values?: any[]) => {
            queries.push(sql);
            return client.query(sql, values);
        },
        fetchOne: (sql: string, values?: any[]) => client.fetchOne(sql, values),
    } as any);
    Object.assign(ctx.coreArgs, {enable_fast_asset_counts: enabled});
    return ctx;
}

async function fixture(): Promise<string[]> {
    for (const [collection_name, authorized] of [['alpha', 'alice'], ['beta', 'bob']]) {
        await client.createCollection({collection_name, authorized_accounts: [authorized]});
        await client.createSchema({collection_name, schema_name: 'cards'});
    }
    await client.createSchema({collection_name: 'alpha', schema_name: 'special'});
    await client.createTemplate({template_id: 101, collection_name: 'alpha', schema_name: 'cards',
        immutable_data: JSON.stringify({name: 'Rare par%_tial card', rarity: 'rare'}),
        mutable_data: JSON.stringify({name: 'Modern par%_tial card'})});
    await client.createTemplate({template_id: 102, collection_name: 'alpha', schema_name: 'special',
        transferable: false, burnable: false, mutable_data: JSON.stringify({name: 'Bound card'})});
    await client.createTemplate({template_id: 103, collection_name: 'beta', schema_name: 'cards',
        transferable: false, burnable: true, immutable_data: JSON.stringify({name: 'Rare beta'}),
        mutable_data: JSON.stringify({name: 'Rare beta'})});
    const ids: string[] = [];
    for (const [collection_name, schema_name, template_id, owner] of [
        ['alpha', 'cards', 101, 'alice'], ['alpha', 'cards', 101, 'bob'], ['alpha', 'cards', 101, null],
        ['alpha', 'special', 102, 'alice'], ['alpha', 'cards', null, 'alice'], ['alpha', 'cards', null, null],
        ['beta', 'cards', 103, 'bob'], ['beta', 'cards', null, 'bob'],
    ]) {
        const asset = await client.createAsset({collection_name, schema_name, template_id, owner,
            immutable_data: JSON.stringify({rarity: 'rare'})});
        ids.push(String(asset.asset_id));
    }
    // A matching collection on a different contract must never contribute.
    await client.createCollection({contract: 'other', collection_name: 'alpha'});
    await client.createSchema({contract: 'other', collection_name: 'alpha', schema_name: 'cards'});
    await client.createAsset({contract: 'other', collection_name: 'alpha', schema_name: 'cards'});
    return ids;
}

async function consolidate(): Promise<void> {
    // Model the filler's consolidated shape: one dirty=NULL row per group,
    // with NULL delta columns coalesced to zero. New writes remain dirty rows.
    await client.query(`
        WITH del AS (
            DELETE FROM atomicassets_asset_counts WHERE contract = $1 RETURNING *
        )
        INSERT INTO atomicassets_asset_counts
            (contract, collection_name, schema_name, template_id, assets, owned, burned, dirty)
        SELECT contract, collection_name, schema_name, template_id,
            COALESCE(SUM(assets), 0), COALESCE(SUM(owned), 0), COALESCE(SUM(burned), 0), NULL
        FROM del GROUP BY contract, collection_name, schema_name, template_id
    `, ['aatest']);
}

describe('AtomicAssets aggregate count parity', () => {
    for (const key of ['template_id', 'template_whitelist']) {
        for (const value of ['0', '00', '-0', '-00', '0,101', '0,101,201,202,203,204,205,206,207,208,209']) {
            txit(`${key}=${value} preserves numeric zero semantics`, async () => {
                await fixture();
                const queries: string[] = [];
                const expected = value.includes('101') ? '3' : '0';
                expect(await getAssetsCountAction({[key]: value}, context(queries))).to.equal(expected);
                expect(usedAggregate(queries)).to.equal(false);
                expect(usedRawCount(queries)).to.equal(true);
            });
        }

        txit(`${key} expands zero-containing named lists before selecting a count path`, async () => {
            await fixture();
            // List names are unique because list expansion is cached across tests.
            const {list} = await client.createFullList({list_name: client.getName()}, {item_name: '0'});
            await client.createListItem({list_id: list.id, item_name: '101'});
            const queries: string[] = [];
            expect(await getAssetsCountAction({[key]: `$list:${list.list_name}`}, context(queries))).to.equal('3');
            expect(usedRawCount(queries)).to.equal(true);
            expect(usedAggregate(queries)).to.equal(false);
        });
    }

    for (const key of ['match', 'search']) {
        for (const [value, expected] of [['Modern', '3'], ['Bound', '1'], ['Rare', '4'], ['par%_tial', '3']]) {
            txit(`${key}=${value} reads both template data columns without counting twice`, async () => {
                await fixture();
                const queries: string[] = [];
                expect(await getAssetsCountAction({[key]: value}, context(queries))).to.equal(expected);
                expect(usedAggregate(queries)).to.equal(true);
                expect(queries).to.have.length(1);
            });
        }
    }

    for (const stage of ['dirty', 'consolidated', 'mixed']) {
        txit(`matches raw counts and listings with ${stage} aggregate rows`, async () => {
            const ids = await fixture();
            if (stage !== 'dirty') await consolidate();
            if (stage === 'mixed') {
                await client.query('UPDATE atomicassets_assets SET owner = NULL WHERE contract = $1 AND asset_id = $2', ['aatest', ids[0]]);
                await client.query('DELETE FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2', ['aatest', ids[3]]);
                await client.createAsset({collection_name: 'beta', schema_name: 'cards', template_id: 103, owner: 'alice'});
            }
            const {rows} = await client.query(`
                SELECT dirty, COUNT(*) rows FROM atomicassets_asset_counts WHERE contract = $1 GROUP BY dirty
            `, ['aatest']);
            expect(rows.some(row => row.dirty === true)).to.equal(stage !== 'consolidated');
            expect(rows.some(row => row.dirty === null)).to.equal(stage !== 'dirty');
            if (stage === 'mixed') {
                const {rows: [negative]} = await client.query('SELECT COUNT(*) n FROM atomicassets_asset_counts WHERE assets < 0');
                expect(Number(negative.n)).to.be.greaterThan(0);
            }

            const filters: RequestValues[] = [
                {}, {burned: 'true'}, {burned: 'false'}, {burned: 'empty'},
                {collection_name: 'alpha'}, {collection_name: 'alpha,beta'}, {collection_name: 'absent'},
                {schema_name: 'cards'}, {schema_name: 'cards,special'}, {collection_name: 'alpha', schema_name: 'cards'},
                {authorized_account: 'alice'}, {authorized_account: 'carol'},
                {template_id: '101'}, {template_id: '101,102'}, {template_id: '-1'}, {template_id: 'null'},
                {template_id: '0'}, {template_whitelist: '0'}, {template_id: '0,101'}, {template_whitelist: '0,101'},
                {template_id: '0', burned: 'true'}, {template_whitelist: '0', burned: 'false'},
                {template_whitelist: '101'}, {template_blacklist: '101'}, {template_blacklist: '0'},
                {template_blacklist: '0,101'}, {template_blacklist: '9223372036854775807'},
                {template_id: 'null', template_blacklist: '0'}, {template_id: 'null', template_whitelist: '0'},
                {collection_blacklist: 'alpha'}, {collection_whitelist: 'alpha'},
                {collection_whitelist: 'alpha,beta', collection_blacklist: 'alpha'},
                {collection_whitelist: 'alpha', collection_blacklist: 'alpha'},
                {is_transferable: 'true'}, {is_transferable: 'false'}, {is_burnable: 'true'}, {is_burnable: 'false'},
                {is_transferable: 'false', is_burnable: 'true'},
                {match: 'Rare'}, {match: 'Modern'}, {match: 'par%_tial'}, {match: 'absent'}, {match: ''},
                {search: 'Rare'}, {search: 'Modern'}, {search: 'par%_tial'}, {search: ''},
                {match: 'Rare', search: 'Modern'},
                {collection_name: 'alpha', schema_name: 'cards', burned: 'false', match: 'Rare', is_transferable: 'true', authorized_account: 'alice'},
                {sort: 'name'},
            ];
            for (const params of filters) {
                const description = JSON.stringify(params);
                const queries: string[] = [];
                const raw = await getRawAssetsAction({...params, count: 'true'}, context(queries), {extraTables: ' ', extraSort: {}});
                expect(usedRawCount(queries), description).to.equal(true);
                const count = await getAssetsCountAction(params, context());
                const listing = await getRawAssetsAction(params, context()) as number[];
                expect(count, description).to.equal(raw);
                expect(count, description).to.equal(String(listing.length));
            }
            const queries: string[] = [];
            expect(await getAssetsCountAction({sort: 'name', page: '2', limit: '1', order: 'asc'}, context(queries))).to.equal('8');
            expect(usedAggregate(queries)).to.equal(true);
            expect(queries.some(sql => /JOIN atomicassets_templates/.test(sql))).to.equal(false);
        });
    }

    txit('uses raw counts for asset-level filters and unknown keys', async () => {
        const ids = await fixture();
        for (const params of [
            {owner: 'alice'}, {ids: ids[0]}, {asset_id: ids[0]}, {hide_offers: 'true'}, {minter: 'alice'},
            {'data.rarity': 'rare'}, {'data:rarity': 'rare'}, {'template_data.rarity': 'rare'},
            {'immutable_data.rarity': 'rare'}, {'mutable_data.name': 'absent'},
            {lower_bound: ids[0]}, {unknown: 'ignored'},
        ]) {
            const queries: string[] = [];
            const count = await getAssetsCountAction(params, context(queries));
            const listing = await getRawAssetsAction(params, context()) as number[];
            expect(count, JSON.stringify(params)).to.equal(String(listing.length));
            expect(usedRawCount(queries), JSON.stringify(params)).to.equal(true);
            expect(usedAggregate(queries)).to.equal(false);
        }
    });

    txit('counts zero in an empty aggregate and returns large totals as decimal strings', async () => {
        expect(await getAssetsCountAction({}, context())).to.equal('0');
        await fixture();
        await client.query('DELETE FROM atomicassets_asset_counts WHERE contract = $1', ['aatest']);
        await client.query(`
            INSERT INTO atomicassets_asset_counts (contract, collection_name, schema_name, template_id, assets, owned, burned, dirty)
            VALUES ('aatest', 'alpha', 'cards', 101, 2147483647, 2147483647, 0, NULL),
                   ('aatest', 'alpha', 'cards', 101, 1, 1, 0, TRUE)
        `);
        expect(await getAssetsCountAction({}, context())).to.equal('2147483648');
        expect(await getAssetsCountAction({burned: 'false'}, context())).to.equal('2147483648');
    });

    for (const [name, action] of [['AtomicAssets', getAssetsCountAction], ['AtomicMarket', getMarketAssetsCountAction]] as const) {
        txit(`${name} restores raw authority when fast counts are disabled on a drifted aggregate`, async () => {
            await fixture();
            await consolidate();
            await client.query(`
                INSERT INTO atomicassets_asset_counts (contract, collection_name, schema_name, template_id, assets, owned, burned)
                VALUES ('aatest', 'alpha', 'cards', 101, 10, 10, 0)
            `);
            for (const params of [{}, {match: 'Modern'}, {search: 'Modern'}]) {
                const expected = Object.keys(params).length ? '3' : '8';
                const queries: string[] = [];
                expect(await action(params, context([], true))).to.equal(String(Number(expected) + 10));
                expect(await action(params, context([], undefined))).to.equal(String(Number(expected) + 10));
                expect(await action(params, context(queries, false))).to.equal(expected);
                expect(usedRawCount(queries)).to.equal(true);
                expect(usedAggregate(queries)).to.equal(false);
            }
        });
    }

    txit('preserves AtomicMarket zero filters and only skips fast counts for price joins', async () => {
        await fixture();
        for (const params of [{template_id: '0'}, {template_whitelist: '0'}, {template_id: '0', sort: 'median_price'}]) {
            expect(await getMarketAssetsCountAction(params, context())).to.equal('0');
        }
        const fastQueries: string[] = [];
        expect(await getMarketAssetsCountAction({}, context(fastQueries))).to.equal('8');
        expect(usedAggregate(fastQueries)).to.equal(true);
        const rawQueries: string[] = [];
        expect(await getMarketAssetsCountAction({sort: 'median_price'}, context(rawQueries))).to.equal('8');
        expect(usedRawCount(rawQueries)).to.equal(true);
        expect(usedAggregate(rawQueries)).to.equal(false);
    });
});

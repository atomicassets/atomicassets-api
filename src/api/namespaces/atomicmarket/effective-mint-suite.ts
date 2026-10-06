import {expect} from 'chai';
import {ApiError} from '../../error';
import {AtomicMarketTestClient} from './test';

/** One asset of a test listing: the template mint and the link row it may carry. */
export type MintAssetSpec = {
    template?: number | null,
    // undefined: no link row. null: a link row without a mint number.
    original?: number | null,
};

export type EffectiveMintSuiteOptions = {
    client: AtomicMarketTestClient,
    txit: any,
    // listingTemplateMint is the template mint range the listing stores, as [n,n], for the
    // handlers that read a stored column. The sales filter table derives it from the assets.
    makeListing: (collectionName: string, assets: MintAssetSpec[], listingTemplateMint?: number) => Promise<number>,
    query: (params: Record<string, string>) => Promise<number[]>,
    count: (params: Record<string, string>) => Promise<number>,
};

export async function createMintAsset(
    client: AtomicMarketTestClient, collectionName: string, spec: MintAssetSpec,
    assetValues: Record<string, any> = {}
): Promise<number> {
    const {asset_id} = await client.createAsset({
        collection_name: collectionName,
        template_mint: spec.template ?? null,
        ...assetValues,
    });

    if (spec.original !== undefined) {
        await client.createOriginalMint({asset_id, original_mint: spec.original});
    }

    return asset_id;
}

const SCOPE_MESSAGE = 'The effective mint filters and sort require collection_name';
const RANGE_MESSAGE = 'Min effective mint can\'t be greater than max effective mint';

async function expectApiError(promise: Promise<any>, code: number, message: string): Promise<void> {
    let err: any;
    try {
        await promise;
    } catch (e) {
        err = e;
    }

    expect(err).to.be.instanceof(ApiError);
    expect(err.code).to.equal(code);
    expect(err.message).to.equal(message);
}

export function defineEffectiveMintSuite(options: EffectiveMintSuiteOptions): void {
    const {client, txit, makeListing, query, count} = options;

    async function setup(): Promise<string> {
        return (await client.createCollection()).collection_name;
    }

    describe('effective mint filter and sort', () => {
        txit('matches a linked single-asset listing by its original mint', async () => {
            const c = await setup();
            const inRange = await makeListing(c, [{original: 5}]);
            await makeListing(c, [{original: 50}]);

            expect(await query({collection_name: c, min_effective_mint: '4', max_effective_mint: '6'}))
                .to.deep.equal([inRange]);
        });

        txit('matches an unlinked listing by its template mint', async () => {
            const c = await setup();
            const inRange = await makeListing(c, [{template: 5}]);
            await makeListing(c, [{template: 50}]);

            expect(await query({collection_name: c, min_effective_mint: '4', max_effective_mint: '6'}))
                .to.deep.equal([inRange]);
        });

        txit('lets the original mint win over the template mint', async () => {
            const c = await setup();
            const originalInRange = await makeListing(c, [{original: 5, template: 500}]);
            await makeListing(c, [{original: 500, template: 5}]);

            expect(await query({collection_name: c, min_effective_mint: '4', max_effective_mint: '6'}))
                .to.deep.equal([originalInRange]);
        });

        txit('falls back to the template mint for a link row without a mint', async () => {
            const c = await setup();
            const inRange = await makeListing(c, [{original: null, template: 5}]);
            await makeListing(c, [{original: null, template: 50}]);

            expect(await query({collection_name: c, min_effective_mint: '4', max_effective_mint: '6'}))
                .to.deep.equal([inRange]);
        });

        txit('matches a multi-asset listing only when every asset with a mint is in range', async () => {
            const c = await setup();
            const allIn = await makeListing(c, [{original: 5}, {template: 6}, {original: null, template: 4}]);
            await makeListing(c, [{original: 5}, {template: 60}]);
            await makeListing(c, [{original: 50}, {template: 5}]);
            await makeListing(c, [{original: 5}, {template: 2}]);
            // the asset without any mint is ignored
            const withIgnored = await makeListing(c, [{original: 5}, {}]);

            expect((await query({collection_name: c, min_effective_mint: '4', max_effective_mint: '6'})).sort())
                .to.deep.equal([allIn, withIgnored].sort());
        });

        txit('never matches a listing whose assets have no mint at all', async () => {
            const c = await setup();
            await makeListing(c, [{}]);
            await makeListing(c, [{}, {original: null}]);

            expect(await query({collection_name: c, min_effective_mint: '1'})).to.deep.equal([]);
            expect(await query({collection_name: c, max_effective_mint: '1000'})).to.deep.equal([]);
            expect(await query({collection_name: c, min_effective_mint: '1', max_effective_mint: '1000'}))
                .to.deep.equal([]);
        });

        txit('accepts a minimum alone and a maximum alone', async () => {
            const c = await setup();
            const low = await makeListing(c, [{original: 2}]);
            const high = await makeListing(c, [{template: 20}]);
            await makeListing(c, [{}]);

            expect(await query({collection_name: c, min_effective_mint: '10'})).to.deep.equal([high]);
            expect(await query({collection_name: c, max_effective_mint: '10'})).to.deep.equal([low]);
        });

        txit('orders by the lowest effective mint and leaves out listings without one', async () => {
            const c = await setup();
            const b = await makeListing(c, [{original: 30}, {template: 8}]);
            const a = await makeListing(c, [{original: 3, template: 90}]);
            const d = await makeListing(c, [{template: 20}]);
            await makeListing(c, [{}]);
            await makeListing(c, [{original: null}]);

            const asc = {collection_name: c, sort: 'effective_mint', order: 'asc'};
            const desc = {collection_name: c, sort: 'effective_mint', order: 'desc'};

            expect(await query(asc)).to.deep.equal([a, b, d]);
            expect(await query(desc)).to.deep.equal([d, b, a]);
            expect(await count(asc)).to.equal(3);
            expect(await query({...asc, limit: '1', page: '2'})).to.deep.equal([b]);
        });

        txit('applies a bound together with the sort', async () => {
            const c = await setup();
            const a = await makeListing(c, [{original: 9}]);
            const b = await makeListing(c, [{template: 5}]);
            await makeListing(c, [{template: 500}]);
            await makeListing(c, [{}]);

            const params = {collection_name: c, sort: 'effective_mint', order: 'asc', max_effective_mint: '10'};

            expect(await query(params)).to.deep.equal([b, a]);
            expect(await count(params)).to.equal(2);
        });

        txit('combines a template mint bound with an effective mint bound of the same value', async () => {
            const c = await setup();
            const both = await makeListing(c, [{original: 5, template: 5}], 5);
            // passes the template mint filter only: the original mint is out of range
            await makeListing(c, [{original: 50, template: 5}], 5);
            // passes the effective mint filter only: the stored template mint is out of range
            await makeListing(c, [{original: 6, template: 50}], 50);

            expect(await query({
                collection_name: c,
                min_template_mint: '5', min_effective_mint: '5',
                max_template_mint: '6', max_effective_mint: '6',
            })).to.deep.equal([both]);
            expect(await query({collection_name: c, max_template_mint: '5', max_effective_mint: '5'}))
                .to.deep.equal([both]);
        });

        txit('rejects the mint parameters without collection_name', async () => {
            await expectApiError(query({min_effective_mint: '1'}), 400, SCOPE_MESSAGE);
            await expectApiError(query({max_effective_mint: '1'}), 400, SCOPE_MESSAGE);
            await expectApiError(query({sort: 'effective_mint'}), 400, SCOPE_MESSAGE);
        });

        txit('rejects a minimum above the maximum', async () => {
            const c = await setup();

            await expectApiError(query({collection_name: c, min_effective_mint: '5', max_effective_mint: '4'}), 400, RANGE_MESSAGE);
        });
    });
}

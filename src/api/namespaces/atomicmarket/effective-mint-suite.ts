import {expect} from 'chai';
import {ApiError} from '../../error';
import {AtomicMarketTestClient} from './test';

/** One asset of a test listing: the template mint and the link row it may carry. */
export type MintAssetSpec = {
    template?: number | null,
    // undefined: no link row. null: a link row without a mint number.
    original?: number | null,
};

/**
 * The template mint range the filler stores on a listing: the lowest and highest template
 * mint of its assets, or 'empty' when no asset has one.
 */
export function storedTemplateRange(assets: MintAssetSpec[]): string {
    const mints = assets.map(a => a.template).filter((m): m is number => typeof m === 'number');

    return mints.length ? `[${Math.min(...mints)},${Math.max(...mints)}]` : 'empty';
}

export type EffectiveMintSuiteOptions = {
    // True when makeListing stores the given range. The sales filter table derives its own.
    canOverrideStoredRange?: boolean,
    client: AtomicMarketTestClient,
    txit: any,
    // listingTemplateMint is the template mint range the listing stores, as [n,n], or null for no
    // stored range yet, for the
    // handlers that read a stored column. The sales filter table derives it from the assets.
    makeListing: (collectionName: string, assets: MintAssetSpec[], listingTemplateMint?: number | null) => Promise<number>,
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
    const {client, txit, makeListing, query, count, canOverrideStoredRange} = options;

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

        txit('matches an unlinked listing by the template mint range it stores', async () => {
            const c = await setup();
            const single = await makeListing(c, [{template: 5}]);
            const multi = await makeListing(c, [{template: 4}, {template: 6}]);
            await makeListing(c, [{template: 4}, {template: 60}]);
            await makeListing(c, [{template: 3}]);

            expect((await query({collection_name: c, min_effective_mint: '4', max_effective_mint: '6'})).sort())
                .to.deep.equal([single, multi].sort());
        });

        txit('reads the aggregate, not the stored range, of a linked listing', async () => {
            const c = await setup();
            const originalIn = await makeListing(c, [{original: 5, template: 500}]);
            await makeListing(c, [{original: 50, template: 5}]);

            expect(await query({collection_name: c, min_effective_mint: '4', max_effective_mint: '6'}))
                .to.deep.equal([originalIn]);
        });

        txit('accepts a bound above the int4 range on an unlinked listing', async () => {
            const c = await setup();
            const low = await makeListing(c, [{template: 5}]);
            const high = await makeListing(c, [{template: 2000000000}]);
            const linked = await makeListing(c, [{original: 3000000000, template: 5}]);
            const huge = '9007199254740991';

            expect((await query({collection_name: c, min_effective_mint: '4', max_effective_mint: huge})).sort())
                .to.deep.equal([low, high, linked].sort());
            expect((await query({collection_name: c, max_effective_mint: huge})).sort())
                .to.deep.equal([low, high, linked].sort());
            expect(await query({collection_name: c, min_effective_mint: huge})).to.deep.equal([]);
        });

        txit('accepts a minimum alone and a maximum alone on unlinked listings', async () => {
            const c = await setup();
            const low = await makeListing(c, [{template: 2}]);
            const high = await makeListing(c, [{template: 20}]);
            await makeListing(c, [{}]);

            expect(await query({collection_name: c, min_effective_mint: '10'})).to.deep.equal([high]);
            expect(await query({collection_name: c, max_effective_mint: '10'})).to.deep.equal([low]);
            expect((await query({collection_name: c, min_effective_mint: '2', max_effective_mint: '20'})).sort())
                .to.deep.equal([low, high].sort());
        });

        txit('orders linked and unlinked listings together and counts the same rows', async () => {
            const c = await setup();
            const linkedLow = await makeListing(c, [{original: 1, template: 90}]);
            const unlinkedLow = await makeListing(c, [{template: 3}]);
            const linkedMid = await makeListing(c, [{original: 7}]);
            const unlinkedMulti = await makeListing(c, [{template: 12}, {template: 9}]);
            await makeListing(c, [{}]);

            const asc = {collection_name: c, sort: 'effective_mint', order: 'asc'};

            expect(await query(asc)).to.deep.equal([linkedLow, unlinkedLow, linkedMid, unlinkedMulti]);
            expect(await query({...asc, order: 'desc'}))
                .to.deep.equal([unlinkedMulti, linkedMid, unlinkedLow, linkedLow]);
            expect(await count(asc)).to.equal(4);
        });

        // The sales filter table derives its range from the assets, so only the stored-column
        // sources can hold a range that differs from them. /v2/sales proves it in its own file.
        if (canOverrideStoredRange) {
            txit('reads the stored range of an unlinked listing', async () => {
                const c = await setup();
                // the stored range holds the mints of the listing, so a range that differs from the
                // asset decides, which proves the filter reads the stored column
                const storedIn = await makeListing(c, [{template: 500}], 5);
                await makeListing(c, [{template: 5}], 500);

                expect(await query({collection_name: c, min_effective_mint: '4', max_effective_mint: '6'}))
                    .to.deep.equal([storedIn]);
                expect(await query({collection_name: c, sort: 'effective_mint', order: 'asc', max_effective_mint: '6'}))
                    .to.deep.equal([storedIn]);
            });

            txit('reads the assets of a listing whose stored range is not written yet', async () => {
                const c = await setup();
                const unlinkedNull = await makeListing(c, [{template: 5}], null);
                const linkedNull = await makeListing(c, [{original: 6, template: 500}], null);
                const third = await makeListing(c, [{template: 50}], null);
                await makeListing(c, [{}], null);

                const range = {collection_name: c, min_effective_mint: '4', max_effective_mint: '7'};
                const sort = {collection_name: c, sort: 'effective_mint', order: 'asc'};

                expect((await query(range)).sort()).to.deep.equal([unlinkedNull, linkedNull].sort());
                expect(await query({...range, sort: 'effective_mint', order: 'asc'}))
                    .to.deep.equal([unlinkedNull, linkedNull]);
                expect(await count(range)).to.equal(2);
                expect(await query(sort)).to.deep.equal([unlinkedNull, linkedNull, third]);
                expect(await count(sort)).to.equal(3);
            });
        }

        describe('collection name cap', () => {
            const others = (n: number): string[] => Array.from({length: n}, (_, i) =>
                `zz${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`);
            const CAP_MESSAGE = 'The effective mint filters and sort accept at most 50 collection names';

            txit('accepts 50 collection names with a mint parameter', async () => {
                const c = await setup();
                const id = await makeListing(c, [{original: 5}]);
                const names = [c, ...others(49)].join(',');

                expect(await query({collection_name: names, min_effective_mint: '1'})).to.deep.equal([id]);
                expect(await query({collection_name: names, sort: 'effective_mint'})).to.deep.equal([id]);
            });

            txit('rejects 51 collection names with a mint parameter', async () => {
                const c = await setup();
                await makeListing(c, [{original: 5}]);
                const names = [c, ...others(50)].join(',');

                await expectApiError(query({collection_name: names, min_effective_mint: '1'}), 400, CAP_MESSAGE);
                await expectApiError(query({collection_name: names, max_effective_mint: '9'}), 400, CAP_MESSAGE);
                await expectApiError(query({collection_name: names, sort: 'effective_mint'}), 400, CAP_MESSAGE);
                await expectApiError(count({collection_name: names, min_effective_mint: '1'}), 400, CAP_MESSAGE);
            });

            txit('counts 51 copies of one name as 51', async () => {
                const c = await setup();

                await expectApiError(
                    query({collection_name: Array(51).fill(c).join(','), min_effective_mint: '1'}), 400, CAP_MESSAGE
                );
            });

            txit('keeps 51 collection names working without a mint parameter', async () => {
                const c = await setup();
                const id = await makeListing(c, [{original: 5}]);

                expect(await query({collection_name: [c, ...others(50)].join(',')})).to.deep.equal([id]);
            });
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

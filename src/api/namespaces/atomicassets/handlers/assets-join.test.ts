import 'mocha';
import { expect } from 'chai';

import { getRawAssetsAction } from './assets';
import { AtomicAssetsContext } from '../index';
import { initListValidator } from '../../lists';

// Unit-style regression tests for the `needsTemplateJoin` gate in
// getRawAssetsAction. These stub-only tests run in the default
// `pnpm test`, so the gate against re-introducing the LEFT JOIN on the
// count path is enforced in every CI build. The parity coverage that
// proves the fast count equals the raw count lives in
// assets-count.integration.test.ts and needs a real Postgres, so it runs
// under `pnpm test:integration:ci`.

type CapturedQuery = { text: string; values?: any[] };

function stubContext(captures: CapturedQuery[]): AtomicAssetsContext {
    const db = {
        query: async (text: string, values?: any[]): Promise<any> => {
            captures.push({ text, values });
            // Return shapes that satisfy the callers we exercise here:
            //   - fast count:   COALESCE(SUM(...)) counter from asset_counts
            //   - raw count:    countQuery.rows[0].counter
            //   - addTemplateFilter / non-count flow: just needs `.rows`
            if (/SELECT\s+COUNT\(\*\)/i.test(text) || /COALESCE\(SUM\(/i.test(text)) {
                return { rows: [{ counter: '0' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
        fetchOne: async (text: string, values?: any[]): Promise<any> => {
            captures.push({ text, values });
            return null;
        },
    };

    return {
        pathParams: {},
        db,
        coreArgs: {
            atomicassets_account: 'aatest',
            connected_reader: '',
            limits: {},
            socket_features: { asset_update: false },
            // Most cases below exercise the fast count path, which is opt-in in
            // production. The setting-matrix test above overrides this per case
            // and is what pins the unset default to raw counting.
            enable_fast_asset_counts: true,
        },
    } as unknown as AtomicAssetsContext;
}

const hasTemplateJoin = (captures: CapturedQuery[]): boolean =>
    captures.some(c => /LEFT JOIN atomicassets_templates/i.test(c.text));

describe('getRawAssetsAction - needsTemplateJoin gate', () => {
    for (const enabled of [undefined, true, false]) {
        it(`fast count setting ${String(enabled)} selects the expected count source`, async () => {
            const captures: CapturedQuery[] = [];
            const ctx = stubContext(captures);
            ctx.coreArgs.enable_fast_asset_counts = enabled;

            await getRawAssetsAction({count: 'true'}, ctx);

            // Opt-in: only an explicit true takes the aggregate. Unset is the
            // production default and must count rows.
            expect(captures.some(c => /FROM atomicassets_asset_counts ac/.test(c.text))).to.equal(enabled === true);
            expect(captures.some(c => /SELECT COUNT\(\*\)/.test(c.text))).to.equal(enabled !== true);
        });
    }

    it('count + sort=name uses the aggregate table and skips the templates JOIN', async () => {
        // Unfiltered `/atomicassets/v1/assets/_count?sort=name` must read
        // atomicassets_asset_counts and must not pull in
        // atomicassets_templates. sort never consumes a template column
        // on the count path.
        const captures: CapturedQuery[] = [];
        const ctx = stubContext(captures);

        await getRawAssetsAction({ count: 'true', sort: 'name' }, ctx);

        expect(captures.length).to.be.greaterThan(0);
        expect(
            captures.some(c => /atomicassets_asset_counts/i.test(c.text)),
            'unfiltered count must use atomicassets_asset_counts',
        ).to.equal(true);
        expect(
            captures.some(c => /FROM atomicassets_assets/i.test(c.text)),
            'unfiltered count must not scan atomicassets_assets',
        ).to.equal(false);
        expect(
            hasTemplateJoin(captures),
            'count requests must NOT JOIN atomicassets_templates even when sort=name',
        ).to.equal(false);
    });

    it('count + hide_offers falls back to raw COUNT(*) without the templates JOIN', async () => {
        // hide_offers is a bool (so this stub file does not need list[name]
        // validation) and is not a fast-count key.
        const captures: CapturedQuery[] = [];
        const ctx = stubContext(captures);

        await getRawAssetsAction({ count: 'true', hide_offers: 'true', sort: 'name' }, ctx);

        expect(captures.some(c => /SELECT\s+COUNT\(\*\)/i.test(c.text))).to.equal(true);
        expect(
            hasTemplateJoin(captures),
            'raw count fallback must NOT JOIN atomicassets_templates even when sort=name',
        ).to.equal(false);
    });

    it('non-count sort=name keeps the templates JOIN', async () => {
        // Complementary check: when count is NOT set, sort=name needs the
        // JOIN because the ORDER BY clause reads `template.immutable_data`.
        // If the gate is dropped too aggressively, name-sort returns wrong
        // order or crashes on a missing column reference.
        const captures: CapturedQuery[] = [];
        const ctx = stubContext(captures);

        try {
            await getRawAssetsAction({ sort: 'name' }, ctx);
        } catch {
            // The non-count path runs pagination + format helpers that
            // expect richer row shapes than our stub provides; we only
            // care that the SQL was emitted with the JOIN, which happens
            // before the helpers run.
        }

        expect(captures.length).to.be.greaterThan(0);
        expect(
            hasTemplateJoin(captures),
            'non-count sort=name must JOIN atomicassets_templates for ORDER BY',
        ).to.equal(true);
    });

    it('count + is_transferable still triggers the JOIN', async () => {
        // Fast-count still needs the templates JOIN when the filter reads
        // template columns (is_transferable / is_burnable / match / search).
        const captures: CapturedQuery[] = [];
        const ctx = stubContext(captures);

        await getRawAssetsAction(
            { count: 'true', is_transferable: 'true' },
            ctx,
        );

        expect(captures.length).to.be.greaterThan(0);
        expect(
            captures.some(c => /atomicassets_asset_counts/i.test(c.text)),
            'is_transferable count must still use the aggregate table',
        ).to.equal(true);
        expect(
            hasTemplateJoin(captures),
            'count + is_transferable must JOIN atomicassets_templates for the filter',
        ).to.equal(true);
    });

    it('count + extraTables skips the aggregate table', async () => {
        const captures: CapturedQuery[] = [];
        const ctx = stubContext(captures);

        await getRawAssetsAction(
            { count: 'true' },
            ctx,
            {
                extraTables: 'LEFT JOIN atomicmarket_template_prices "price" ON (asset.contract = price.assets_contract)',
                extraSort: {},
            },
        );

        expect(
            captures.some(c => /atomicassets_asset_counts/i.test(c.text)),
            'extraTables must skip the aggregate fast path',
        ).to.equal(false);
        expect(captures.some(c => /SELECT\s+COUNT\(\*\)/i.test(c.text))).to.equal(true);
    });
});

describe('getRawAssetsAction - original mint link join', () => {
    const hasLinkJoin = (captures: CapturedQuery[]): boolean =>
        captures.some(c => /atomicassets_original_mints/i.test(c.text));

    async function run(params: Record<string, string>): Promise<CapturedQuery[]> {
        const captures: CapturedQuery[] = [];

        await getRawAssetsAction(params, stubContext(captures));

        return captures;
    }

    for (const params of [
        {},
        {template_mint: '3'},
        {min_template_mint: '2', max_template_mint: '4', sort: 'template_mint'},
        {hide_offers: 'true', sort: 'asset_id'},
    ]) {
        it(`${JSON.stringify(params)} keeps its SQL free of the link table`, async () => {
            expect(hasLinkJoin(await run(params))).to.equal(false);
        });
    }

    for (const params of [
        {original_mint: '3'},
        {min_original_mint: '2'},
        {max_original_mint: '4'},
        {sort: 'original_mint'},
    ]) {
        it(`${JSON.stringify(params)} joins the link table on its key`, async () => {
            const captures = await run(params);
            const text = captures.map(c => c.text).join('\n');

            expect(hasLinkJoin(captures)).to.equal(true);
            expect(text).to.match(/atomicassets_original_mints[^\n]*ON \(\s*\S*\.contract = asset\.contract AND \S*\.asset_id = asset\.asset_id\s*\)/);
        });
    }

    it('a count with an original mint filter skips the aggregate table', async () => {
        const captures = await run({count: 'true', min_original_mint: '2'});

        expect(captures.some(c => /atomicassets_asset_counts/i.test(c.text))).to.equal(false);
        expect(hasLinkJoin(captures)).to.equal(true);
    });

    it('sort=original_mint keeps only linked assets with a mint number', async () => {
        const text = (await run({sort: 'original_mint'})).map(c => c.text).join('\n');

        expect(text).to.contain('original_link.original_mint IS NOT NULL');
    });

    it('a filter without the sort adds no IS NOT NULL condition', async () => {
        const text = (await run({min_original_mint: '2'})).map(c => c.text).join('\n');

        expect(text).to.not.contain('IS NOT NULL');
    });

    it('a count with sort=original_mint skips the aggregate table and carries the condition', async () => {
        const captures = await run({count: 'true', sort: 'original_mint'});

        expect(captures.some(c => /atomicassets_asset_counts/i.test(c.text))).to.equal(false);
        expect(captures.some(c => /original_link\.original_mint IS NOT NULL/.test(c.text))).to.equal(true);
    });

    it('template_mint requests keep their SQL free of the condition', async () => {
        const text = (await run({sort: 'template_mint', min_template_mint: '2'})).map(c => c.text).join('\n');

        expect(text).to.not.contain('original_');
    });

    it('the original_mint sort emits both directions without NULLS LAST or a + 1 guard', async () => {
        for (const order of ['asc', 'desc']) {
            const text = (await run({sort: 'original_mint', order})).map(c => c.text).join('\n');

            expect(text).to.contain(`ORDER BY original_link.original_mint ${order} , asset.asset_id ASC`);
            expect(text).to.not.contain('NULLS LAST');
            expect(text).to.not.contain('original_mint + 1');
        }
    });

    it('a filter under the default sort carries the guarded ORDER BY', async () => {
        for (const params of [{original_mint: '3'}, {min_original_mint: '2'}, {max_original_mint: '4'}]) {
            const text = (await run(params)).map(c => c.text).join('\n');

            expect(text).to.contain('ORDER BY asset.asset_id + 1');
        }
    });

    it('a filter with a collection filter and the default sort keeps the guard', async () => {
        initListValidator({query: async () => ({rows: [], rowCount: 0})} as any);

        const text = (await run({min_original_mint: '2', collection_name: 'abc'})).map(c => c.text).join('\n');

        expect(text).to.contain('ORDER BY asset.asset_id + 1');
    });

    it('a request without an original mint filter keeps the plain asset_id ORDER BY', async () => {
        const text = (await run({hide_offers: 'true'})).map(c => c.text).join('\n');

        expect(text).to.contain('ORDER BY asset.asset_id');
        expect(text).to.not.contain('asset_id + 1');
    });

    for (const key of ['original_mint', 'min_original_mint', 'max_original_mint']) {
        it(`${key} above the safe integer range is refused as a 400`, async () => {
            let error: any = null;

            try {
                await run({[key]: String(Number.MAX_SAFE_INTEGER) + '0'});
            } catch (e) {
                error = e;
            }

            expect(error).to.not.equal(null);
            expect(error.code).to.equal(400);
            expect(error.message).to.contain(`Invalid value for parameter ${key}`);
        });
    }
});

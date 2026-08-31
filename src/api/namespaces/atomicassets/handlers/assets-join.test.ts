import 'mocha';
import { expect } from 'chai';

import { getRawAssetsAction } from './assets';
import { AtomicAssetsContext } from '../index';

// Unit-style regression tests for the `needsTemplateJoin` gate in
// getRawAssetsAction. The full assets.test.ts suite is integration
// (txit + real Postgres) and only runs under `pnpm test:e2e:ci`;
// these stub-only tests run in the default `pnpm test` so the gate
// against re-introducing the LEFT JOIN on the count path is enforced
// in every CI build.

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
        },
    } as unknown as AtomicAssetsContext;
}

const hasTemplateJoin = (captures: CapturedQuery[]): boolean =>
    captures.some(c => /LEFT JOIN atomicassets_templates/i.test(c.text));

describe('getRawAssetsAction - needsTemplateJoin gate', () => {
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

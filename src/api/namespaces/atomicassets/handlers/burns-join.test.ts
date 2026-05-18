import 'mocha';
import { expect } from 'chai';

import { getBurnsAction } from './burns';
import { AtomicAssetsContext } from '../index';
import { initListValidator } from '../../lists';

// Unit-style regression tests for `burnsQueryNeedsTemplateJoin` in burns.ts.
// Mirrors assets-join.test.ts in shape: stub the db.query so it captures
// emitted SQL, then assert whether `LEFT JOIN atomicassets_templates`
// appears for a given set of input params.
//
// These tests guard against two failure modes:
//   - silent filter drop: a param that buildAssetFilter / buildDataConditions
//     applies against `template.*` gets requested by the user, the gate
//     returns false, templateTable=undefined is passed through, and the
//     filter is silently ignored (wrong result set, no error)
//   - perf regression: a param that does NOT need the join causes the join
//     anyway, blocking the planner from using
//     atomicassets_assets_contract_burned_partial (1.6.1)
//
// Run as part of `pnpm test`. Integration coverage for the real query
// results lives under *.integration.test.ts and only runs in CI with a
// live Postgres.

type CapturedQuery = { text: string; values?: any[] };

function stubContext(captures: CapturedQuery[]): AtomicAssetsContext {
    const db = {
        query: async (text: string, values?: any[]): Promise<any> => {
            captures.push({ text, values });
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

describe('getBurnsAction — burnsQueryNeedsTemplateJoin gate', () => {
    // `list[name]` / `list[id]` filter types (used by owner, collection_name,
    // schema_name, asset_id, etc.) are validated by the `'list'` validation
    // type that's registered lazily by initListValidator() at server boot,
    // not at module load. Register it here with a stub DB so the asset-side
    // tests below can exercise list-typed params without hitting "Invalid
    // value for parameter X" from filterQueryArgs.
    before(() => {
        const stubDb = {
            fetchOne: async (): Promise<any> => ({ items: [] }),
        } as any;
        initListValidator(stubDb);
    });

    describe('skips the templates JOIN (perf path: index 1.6.1 usable)', () => {
        it('empty params', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({}, stubContext(captures));
            expect(captures.length).to.be.greaterThan(0);
            expect(hasTemplateJoin(captures), 'no params must not JOIN templates').to.equal(false);
        });

        it('pagination only', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ page: '2', limit: '50' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'pagination must not JOIN templates').to.equal(false);
        });

        it('match_owner (asset-only LIKE filter)', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ match_owner: 'alice' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'match_owner runs against asset.burned_by_account, no JOIN').to.equal(false);
        });

        it('collection_name (asset-side column)', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ collection_name: 'mycollection' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'collection_name lives on asset, no JOIN').to.equal(false);
        });

        it('schema_name (asset-side column)', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ schema_name: 'myschema' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'schema_name lives on asset, no JOIN').to.equal(false);
        });

        it('owner (asset-side column)', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ owner: 'alice' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'owner lives on asset, no JOIN').to.equal(false);
        });

        it('match_immutable_name (asset.immutable_data->>name)', async () => {
            // utils.ts:141-146 — runs against asset.immutable_data, not template.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ match_immutable_name: 'foo' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'match_immutable_name is asset-side, no JOIN').to.equal(false);
        });

        it('match_mutable_name (asset.mutable_data->>name)', async () => {
            // utils.ts:148-153 — runs against asset.mutable_data, not template.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ match_mutable_name: 'foo' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'match_mutable_name is asset-side, no JOIN').to.equal(false);
        });

        it('immutable_data.X (asset-side jsonb filter)', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'immutable_data.rarity': 'gold' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'immutable_data.* is asset-side, no JOIN').to.equal(false);
        });

        it('mutable_data.X (asset-side jsonb filter)', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'mutable_data.level': '5' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'mutable_data.* is asset-side, no JOIN').to.equal(false);
        });
    });

    describe('triggers the templates JOIN (correctness path: filter would be silently dropped)', () => {
        it('match (template.immutable_data->>name)', async () => {
            // utils.ts:161-166 — gated behind `if (options.templateTable)`.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ match: 'foo' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'match needs template join').to.equal(true);
        });

        it('search (trigram on template.immutable_data->>name)', async () => {
            // utils.ts:168-172 — gated behind `if (options.templateTable)`.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ search: 'foo' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'search needs template join').to.equal(true);
        });

        it('is_transferable=true', async () => {
            // utils.ts:259-265 — `if (options.templateTable && typeof args.is_transferable === 'boolean')`.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ is_transferable: 'true' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'is_transferable needs template join').to.equal(true);
        });

        it('is_burnable=false', async () => {
            // utils.ts:267-273 — `if (options.templateTable && typeof args.is_burnable === 'boolean')`.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ is_burnable: 'false' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'is_burnable needs template join').to.equal(true);
        });

        it('template_data.X (untyped)', async () => {
            // utils.ts:113, 157-159 — templateCondition merges template_data into template.immutable_data check.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'template_data.rarity': 'rare' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'template_data.* needs template join').to.equal(true);
        });

        it('template_data:text.X', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'template_data:text.rarity': 'rare' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'template_data:text.* needs template join').to.equal(true);
        });

        it('template_data:number.X', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'template_data:number.level': '5' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'template_data:number.* needs template join').to.equal(true);
        });

        it('template_data:bool.X', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'template_data:bool.shiny': 'true' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'template_data:bool.* needs template join').to.equal(true);
        });

        it('data.X (untyped) — preserves pre-1.6.1 semantics (filters template when joined, asset when not)', async () => {
            // utils.ts:113 vs :117-119 — `data.X` semantically switches table.
            // Gate triggers the join to preserve the historical result set.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'data.rarity': 'rare' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'data.* needs template join to preserve historical semantics').to.equal(true);
        });

        it('data:text.X', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'data:text.rarity': 'rare' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'data:text.* needs template join').to.equal(true);
        });

        it('data:number.X', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'data:number.level': '5' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'data:number.* needs template join').to.equal(true);
        });

        it('data:bool.X', async () => {
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'data:bool.shiny': 'true' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'data:bool.* needs template join').to.equal(true);
        });

        it('hypothetical future typed prefix data:json.X (broad-prefix gate must catch this)', async () => {
            // Future-proof: if buildDataConditions later adds a new typed
            // prefix (e.g., `data:json.X`), the broad `startsWith('data:')`
            // gate still routes through the join so behavior won't silently
            // bifurcate. Mirrors the same defensive choice in assets.ts:157.
            const captures: CapturedQuery[] = [];
            await getBurnsAction({ 'data:json.payload': '{}' }, stubContext(captures));
            expect(hasTemplateJoin(captures), 'unknown data: prefix must still trigger JOIN defensively').to.equal(true);
        });

        it('mixed: asset-side + template-side params still trigger JOIN', async () => {
            // Sanity: presence of a template-touching key is sufficient even
            // when asset-side keys are also present.
            const captures: CapturedQuery[] = [];
            await getBurnsAction(
                { owner: 'alice', collection_name: 'c', is_transferable: 'true' },
                stubContext(captures),
            );
            expect(hasTemplateJoin(captures), 'mixed-param query needs JOIN because of is_transferable').to.equal(true);
        });
    });
});

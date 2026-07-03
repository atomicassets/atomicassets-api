import 'mocha';
import { expect } from 'chai';

import { initAtomicMarketTest } from '../test';
import { RequestValues } from '../../utils';
import { getTestContext } from '../../../../utils/test';
import { ApiError } from '../../../error';
import {
    getRoyaltyAccountAction,
    getRoyaltyAttributeRulesAction,
    getRoyaltyConfigAction,
    getRoyaltyPayoutsAction,
    getRoyaltyTemplateRulesAction,
} from './royalties';

const { client, txit } = initAtomicMarketTest();

describe('AtomicMarket Royalties API', () => {

    describe('getRoyaltyConfigAction', () => {
        txit('returns the raw config mirror', async () => {
            const { collection_name } = await client.createRoyaltyConfig({
                founders: JSON.stringify([{ recipient: 'founder1', weight: 1 }]),
                attribute_mode: 1,
                split_founders: 5000,
                split_templates: 3000,
                split_attributes: 2000,
            });

            const result = await getRoyaltyConfigAction({}, getTestContext(client, { collection_name }));

            expect(result.collection_name).to.equal(collection_name);
            expect(result.attribute_mode).to.equal(1);
            expect(result.split_founders).to.equal('5000');
            expect(result.split_templates).to.equal('3000');
            expect(result.split_attributes).to.equal('2000');
            expect(result.founders).to.deep.equal([{ recipient: 'founder1', weight: 1 }]);
        });

        txit('throws a 416 when the collection has no config', async () => {
            let err;

            try {
                await getRoyaltyConfigAction({}, getTestContext(client, { collection_name: 'nonexistent' }));
            } catch (e) {
                err = e;
            }

            expect(err).to.be.instanceof(ApiError);
            expect((err as ApiError).code).to.equal(416);
        });
    });

    describe('getRoyaltyTemplateRulesAction', () => {
        txit('filters by template_id', async () => {
            const { collection_name } = await client.createCollection();

            const rule1 = await client.createRoyaltyTemplateRule({ collection_name });
            await client.createRoyaltyTemplateRule({ collection_name });

            const result = await getRoyaltyTemplateRulesAction(
                { template_id: `${rule1.template_id}` },
                getTestContext(client, { collection_name })
            );

            expect(result.map((r: any) => r.template_id)).to.deep.equal([rule1.template_id]);
        });

        txit('pages', async () => {
            const { collection_name } = await client.createCollection();

            const rule1 = await client.createRoyaltyTemplateRule({ collection_name, template_id: 1 });
            await client.createRoyaltyTemplateRule({ collection_name, template_id: 2 });

            const result = await getRoyaltyTemplateRulesAction(
                { page: '1', limit: '1' },
                getTestContext(client, { collection_name })
            );

            expect(result.map((r: any) => r.template_id)).to.deep.equal([rule1.template_id]);
        });
    });

    describe('getRoyaltyAttributeRulesAction', () => {
        txit('filters by source and field', async () => {
            const { collection_name } = await client.createCollection();

            const rule1 = await client.createRoyaltyAttributeRule({ collection_name, source: 1, field: 'rarity' });
            await client.createRoyaltyAttributeRule({ collection_name, source: 0, field: 'other' });

            const result = await getRoyaltyAttributeRulesAction(
                { source: '1', field: 'rarity' },
                getTestContext(client, { collection_name })
            );

            expect(result.map((r: any) => r.rule_id)).to.deep.equal([rule1.rule_id]);
        });

        txit('round-trips the raw variant tuple and hex lookup_hash', async () => {
            const { collection_name } = await client.createCollection();

            const rule = await client.createRoyaltyAttributeRule({
                collection_name,
                value: JSON.stringify(['uint64', '5']),
                lookup_hash: Buffer.from('ab'.repeat(32), 'hex'),
            });

            const result = await getRoyaltyAttributeRulesAction({}, getTestContext(client, { collection_name }));

            expect(result[0].rule_id).to.equal(rule.rule_id);
            expect(result[0].value).to.deep.equal(['uint64', '5']);
            expect(result[0].lookup_hash).to.equal('ab'.repeat(32));
        });
    });

    describe('getRoyaltyPayoutsAction', () => {
        async function getPayoutSequences(values: RequestValues): Promise<Array<string>> {
            const result = await getRoyaltyPayoutsAction(values, getTestContext(client));

            return result.map((p: any) => p.log_global_sequence);
        }

        txit('filters by recipient', async () => {
            const payout = await client.createRoyaltyPayout({ recipient: 'alice' });
            await client.createRoyaltyPayout({ recipient: 'bob' });

            expect(await getPayoutSequences({ recipient: 'alice' }))
                .to.deep.equal([payout.log_global_sequence]);
        });

        txit('filters by collection_name', async () => {
            const { collection_name } = await client.createCollection();
            const payout = await client.createRoyaltyPayout({ collection_name });
            await client.createRoyaltyPayout({});

            expect(await getPayoutSequences({ collection_name }))
                .to.deep.equal([payout.log_global_sequence]);
        });

        txit('filters by listing_type and listing_id', async () => {
            const payout = await client.createRoyaltyPayout({ listing_type: 2, listing_id: 555 });
            await client.createRoyaltyPayout({ listing_type: 1, listing_id: 555 });
            await client.createRoyaltyPayout({ listing_type: 2, listing_id: 556 });

            expect(await getPayoutSequences({ listing_type: 'auction', listing_id: '555' }))
                .to.deep.equal([payout.log_global_sequence]);
        });

        txit('filters by category', async () => {
            const payout = await client.createRoyaltyPayout({ category: 4 });
            await client.createRoyaltyPayout({ category: 1 });

            expect(await getPayoutSequences({ category: 'dust' }))
                .to.deep.equal([payout.log_global_sequence]);
        });

        txit('filters by asset_id', async () => {
            const payout = await client.createRoyaltyPayout({ asset_id: 123 });
            await client.createRoyaltyPayout({ asset_id: 456 });

            expect(await getPayoutSequences({ asset_id: '123' }))
                .to.deep.equal([payout.log_global_sequence]);
        });

        txit('filters by symbol', async () => {
            await client.createToken({ token_symbol: 'OTHER' });

            const payout = await client.createRoyaltyPayout({ token_symbol: 'TEST' });
            await client.createRoyaltyPayout({ token_symbol: 'OTHER' });

            expect(await getPayoutSequences({ symbol: 'TEST' }))
                .to.deep.equal([payout.log_global_sequence]);
        });

        txit('applies boundary filters (log_global_sequence range)', async () => {
            await client.createRoyaltyPayout({});

            const lower_bound = `${client.getId()}`;
            const payout = await client.createRoyaltyPayout({});
            const upper_bound = `${client.getId()}`;

            await client.createRoyaltyPayout({});

            expect(await getPayoutSequences({ lower_bound, upper_bound }))
                .to.deep.equal([payout.log_global_sequence]);
        });

        txit('sorts by created ascending and descending', async () => {
            const payout1 = await client.createRoyaltyPayout({});
            const payout2 = await client.createRoyaltyPayout({});

            expect(await getPayoutSequences({ sort: 'created', order: 'asc' }))
                .to.deep.equal([payout1.log_global_sequence, payout2.log_global_sequence]);

            expect(await getPayoutSequences({ sort: 'created', order: 'desc' }))
                .to.deep.equal([payout2.log_global_sequence, payout1.log_global_sequence]);
        });

        txit('sorts by amount ascending and descending', async () => {
            const payout1 = await client.createRoyaltyPayout({ amount: 100 });
            const payout2 = await client.createRoyaltyPayout({ amount: 200 });

            expect(await getPayoutSequences({ sort: 'amount', order: 'asc' }))
                .to.deep.equal([payout1.log_global_sequence, payout2.log_global_sequence]);

            expect(await getPayoutSequences({ sort: 'amount', order: 'desc' }))
                .to.deep.equal([payout2.log_global_sequence, payout1.log_global_sequence]);
        });

        txit('returns the matching count when count=true', async () => {
            await client.createRoyaltyPayout({ recipient: 'countme' });
            await client.createRoyaltyPayout({ recipient: 'countme' });
            await client.createRoyaltyPayout({ recipient: 'someoneelse' });

            const result = await getRoyaltyPayoutsAction(
                { recipient: 'countme', count: 'true' },
                getTestContext(client)
            );

            expect(result).to.equal('2');
        });

        txit('joins token precision/contract and formats category/listing_type as strings', async () => {
            await client.createToken({ token_symbol: 'ROYAL', token_precision: 4, token_contract: 'roytoken' });

            await client.createRoyaltyPayout({
                token_symbol: 'ROYAL',
                listing_type: 3,
                category: 3,
            });

            const [result] = await getRoyaltyPayoutsAction({ symbol: 'ROYAL' }, getTestContext(client));

            expect(result.listing_type).to.equal('buyoffer');
            expect(result.category).to.equal('attribute');
            expect(result.token_precision).to.equal(4);
            expect(result.token_contract).to.equal('roytoken');
        });
    });

    describe('getRoyaltyAccountAction', () => {
        txit('aggregates SUM(amount) and payout count per symbol, filterable by collection and symbol', async () => {
            const { collection_name } = await client.createCollection();
            const { collection_name: otherCollection } = await client.createCollection();

            await client.createToken({ token_symbol: 'OTHER' });

            await client.createRoyaltyPayout({ recipient: 'earner', collection_name, token_symbol: 'TEST', amount: 100 });
            await client.createRoyaltyPayout({ recipient: 'earner', collection_name, token_symbol: 'TEST', amount: 50 });
            await client.createRoyaltyPayout({ recipient: 'earner', collection_name, token_symbol: 'OTHER', amount: 10 });
            await client.createRoyaltyPayout({ recipient: 'earner', collection_name: otherCollection, token_symbol: 'TEST', amount: 999 });
            await client.createRoyaltyPayout({ recipient: 'someoneelse', collection_name, token_symbol: 'TEST', amount: 999 });

            const result = await getRoyaltyAccountAction(
                { collection_name, symbol: 'TEST' },
                getTestContext(client, { account: 'earner' })
            );

            expect(result).to.deep.equal([
                { token_symbol: 'TEST', token_precision: 8, token_contract: 'tctest', amount: '150', payout_count: '2' },
            ]);
        });
    });

    after(async () => {
        await client.end();
    });
});

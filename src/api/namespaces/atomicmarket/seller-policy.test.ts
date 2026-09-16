import { expect } from 'chai';
import express from 'express';
import supertest from 'supertest';
import sinon from 'sinon';

import { serverSellerPolicy } from './seller-policy';
import type { AtomicMarketNamespace } from './index';
import { mergeRequestData } from '../utils';

 describe('AtomicMarket server seller policy', () => {
    const sandbox = sinon.createSandbox();
    const previousUrl = process.env.SELLER_POLICY_URL;
    afterEach(() => {
        sandbox.restore();
        if (previousUrl === undefined) delete process.env.SELLER_POLICY_URL;
        else process.env.SELLER_POLICY_URL = previousUrl;
    });
    function app(chain: string) {
        const result = express().use(express.json());
        result.use(serverSellerPolicy({ connection: { chain: { name: chain } } } as AtomicMarketNamespace));
        result.use((req, res) => res.json(mergeRequestData(req)));
        return result;
    }
    it('preserves false selectors without requiring configuration', async () => {
        delete process.env.SELLER_POLICY_URL;
        const result = await supertest(app('false-chain')).get('/?hide_blocked_sellers=false');
        expect(result.status).to.equal(200);
        expect(result.body.hide_blocked_sellers).to.equal('false');
    });
    it('merges query and body exclusions before downstream handlers and cache', async () => {
        process.env.SELLER_POLICY_URL = 'https://policy.example';
        const fetcher = sandbox.stub(globalThis, 'fetch').resolves(Response.json({ data: { blocked_accounts: [{ chain: 'merge-chain', account: 'blocked' }], sellers: [] } }));
        const result = await supertest(app('merge-chain')).post('/?hide_blocked_sellers=true&seller_blacklist=query').send({ seller_blacklist: 'one,two' });
        expect(result.status).to.equal(200);
        expect(result.body.seller_blacklist).to.equal('one,two,blocked');
        expect(result.body).not.to.have.property('hide_blocked_sellers');
        expect(String(fetcher.firstCall.args[0])).to.include('/seller-policy?chains=');
    });
    it('refuses malformed policy instead of returning an empty exclusion set', async () => {
        process.env.SELLER_POLICY_URL = 'https://policy.example';
        sandbox.stub(globalThis, 'fetch').resolves(Response.json({}));
        const response = await supertest(app('invalid-chain')).get('/?hide_blocked_sellers=true');
        expect(response.status).to.equal(503);
        expect(response.body).to.deep.equal({ success: false, message: 'Seller policy unavailable' });
    });

    for (const [account, valid] of [['abcdefghijklj', true], ['abcdefghijklk', false]] as const) {
        it(`validates the restricted thirteenth character in ${account}`, async () => {
            process.env.SELLER_POLICY_URL = 'https://policy.example';
            const chain = `name-${account}`;
            sandbox.stub(globalThis, 'fetch').resolves(Response.json({ data: { blocked_accounts: [{ chain, account }], sellers: [] } }));
            const response = await supertest(app(chain)).get('/?hide_blocked_sellers=true');
            if (valid) {
                expect(response.status).to.equal(200);
                expect(response.body.seller_blacklist).to.equal(account);
            } else {
                expect(response.status).to.equal(503);
            }
        });
    }

    for (const state of [123, 'unknown', undefined]) it(`refuses malformed seller state ${state} with JSON`, async () => {
        process.env.SELLER_POLICY_URL = 'https://policy.example';
        const chain = `invalid-state-${state}`;
        sandbox.stub(globalThis, 'fetch').resolves(Response.json({ data: { blocked_accounts: [], sellers: [{ chain, account: 'blocked', state }] } }));
        const response = await supertest(app(chain)).get('/?hide_blocked_sellers=true');
        expect(response.status).to.equal(503);
        expect(response.body).to.deep.equal({ success: false, message: 'Seller policy unavailable' });
    });
});

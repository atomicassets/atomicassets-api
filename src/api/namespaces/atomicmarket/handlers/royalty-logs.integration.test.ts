import 'mocha';
import { expect } from 'chai';

import { initAtomicMarketTest } from '../test';
import { getTestContext } from '../../../../utils/test';
import { getSaleLogsAction } from './sales';
import { getAuctionLogsAction } from './auctions';
import { getBuyOfferLogsAction } from './buyoffers';
import { getTemplateBuyOfferLogsAction } from './template-buyoffers';

// The four logroy* actions carry no listing id in their own action data
// (collection_name, asset_id, payouts[] - see design.md); the filler resolves
// the settlement linkage and merges it into contract_traces.metadata so the
// existing per-listing /logs endpoints can find them by the usual
// metadata @> condition. These tests only cover the API-side action-list
// extension (getContractActionLogs is exercised directly against
// contract_traces, independent of the filler pipeline that populates it).
const { client, txit } = initAtomicMarketTest();

describe('AtomicMarket royalty log entries', () => {

    txit('/v1/sales/{id}/logs includes logroy* entries for a settled sale', async () => {
        const { sale_id } = await client.createSale();

        await client.createContractTrace({
            name: 'logroyfound',
            metadata: { collection_name: 'somecollection', asset_id: '123', sale_id },
        });

        const result = await getSaleLogsAction({}, getTestContext(client, { sale_id }));

        expect(result.map((log: any) => log.name)).to.include('logroyfound');
    });

    txit('/v1/auctions/{id}/logs includes logroy* entries for a settled auction', async () => {
        const { auction_id } = await client.createAuction();

        await client.createContractTrace({
            name: 'logroydust',
            metadata: { collection_name: 'somecollection', auction_id },
        });

        const result = await getAuctionLogsAction({}, getTestContext(client, { auction_id }));

        expect(result.map((log: any) => log.name)).to.include('logroydust');
    });

    txit('/v1/buyoffers/{id}/logs includes logroy* entries for a settled buyoffer', async () => {
        const { buyoffer_id } = await client.createBuyOffer();

        await client.createContractTrace({
            name: 'logroyattr',
            metadata: { collection_name: 'somecollection', rule_id: '1', buyoffer_id },
        });

        const result = await getBuyOfferLogsAction({}, getTestContext(client, { buyoffer_id }));

        expect(result.map((log: any) => log.name)).to.include('logroyattr');
    });

    txit('/v1/template_buyoffers/{id}/logs includes logroy* entries for a settled template buyoffer', async () => {
        const { buyoffer_id } = await client.createTemplateBuyOffer();

        await client.createContractTrace({
            name: 'logroytempl',
            metadata: { collection_name: 'somecollection', template_id: '1', buyoffer_id },
        });

        const result = await getTemplateBuyOfferLogsAction({}, getTestContext(client, { buyoffer_id }));

        expect(result.map((log: any) => log.name)).to.include('logroytempl');
    });

    after(async () => {
        await client.end();
    });
});

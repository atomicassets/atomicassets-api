import 'mocha';
import { expect } from 'chai';

import {
    createActionTrace,
    createBlock,
    createRecordingNotifier,
    createStubTransaction,
    createTx,
    processActionTrace,
    StubTransaction,
} from '../../test-helper';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ModuleLoader } from '../../../modules';
import { buyofferProcessor } from './buyoffers';
import { BuyofferState } from '../index';
import { AcceptBuyofferActionData } from '../types/actions';

const MARKET_CONTRACT = 'atomicmarket';
const ASSETS_CONTRACT = 'atomicassets';

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

function createMockCore(version: string): any {
    return {
        args: {
            atomicmarket_account: MARKET_CONTRACT,
            atomicassets_account: ASSETS_CONTRACT,
            delphioracle_account: 'delphioracle',
            store_logs: false,
        },
        config: {version},
        // The flip is behind every block createBlock() hands out, so these tests
        // exercise the asset count rather than the marker. legacy-bundles.test.ts
        // covers the marker itself.
        v2MarkerBlock: 1,
    };
}

function stubBuyoffer(assetCount: number, state: BuyofferState = BuyofferState.PENDING): StubTransaction {
    return createStubTransaction((sql: string) => {
        if (sql.includes('FROM atomicmarket_buyoffers_assets')) {
            return [{count: String(assetCount)}];
        }

        if (sql.includes('FROM atomicmarket_buyoffers WHERE')) {
            return [{state: state.valueOf()}];
        }

        return [];
    });
}

async function accept(core: any, stub: StubTransaction, notifier: any, buyofferId: string): Promise<void> {
    const processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
    const destroy = buyofferProcessor(core, processor, notifier);

    try {
        const data: AcceptBuyofferActionData = {
            buyoffer_id: buyofferId,
            expected_asset_ids: ['1001'],
            expected_price: '10.0000 WAX',
            taker_marketplace: 'taker1111111',
        };

        await processActionTrace(
            processor, stub.db, createBlock(), createTx(),
            createActionTrace(MARKET_CONTRACT, 'acceptbuyo', data)
        );
    } finally {
        destroy();
    }
}

describe('buyofferProcessor acceptbuyo on a legacy bundle', () => {
    it('records the buyoffer as accepted when it holds a single asset', async () => {
        const stub = stubBuyoffer(1);
        const recording = createRecordingNotifier();

        await accept(createMockCore('2.0.0'), stub, recording.notifier, '700101');

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].table).to.equal('atomicmarket_buyoffers');
        expect(stub.updates[0].values.state).to.equal(BuyofferState.ACCEPTED.valueOf());
        expect(stub.updates[0].values.taker_marketplace).to.equal('taker1111111');
        expect(recording.traces.map(entry => entry.channel)).to.deep.equal(['buyoffers']);
    });

    it('records a bundle on a v2 contract as declined, with an empty memo and no taker marketplace', async () => {
        const stub = stubBuyoffer(2);
        const recording = createRecordingNotifier();

        await accept(createMockCore('2.0.0'), stub, recording.notifier, '700102');

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].values.state).to.equal(BuyofferState.DECLINED.valueOf());
        expect(stub.updates[0].values.decline_memo).to.equal('');
        expect(stub.updates[0].values).to.not.have.property('taker_marketplace');
        // declinebuyo announces its trace the same way, and the socket api names
        // no event for either action.
        expect(recording.traces.map(entry => entry.channel)).to.deep.equal(['buyoffers']);
    });

    it('leaves an already accepted bundle alone, so a replay cannot rewrite a settled purchase', async () => {
        const stub = stubBuyoffer(2, BuyofferState.ACCEPTED);
        const recording = createRecordingNotifier();

        await accept(createMockCore('2.0.0'), stub, recording.notifier, '700104');

        expect(stub.updates).to.be.empty;
        expect(recording.traces).to.be.empty;
    });

    it('records a bundle on a v1 contract as accepted, because that contract still settles it', async () => {
        const stub = stubBuyoffer(2);
        const recording = createRecordingNotifier();

        await accept(createMockCore('1.2.2'), stub, recording.notifier, '700103');

        expect(stub.updates[0].values.state).to.equal(BuyofferState.ACCEPTED.valueOf());
        // The version rules the asset count out before it is read.
        expect(stub.queries.filter(entry => entry.sql.includes('atomicmarket_buyoffers_assets'))).to.be.empty;
    });
});

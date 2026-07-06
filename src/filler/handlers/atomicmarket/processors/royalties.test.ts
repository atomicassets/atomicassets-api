import 'mocha';
import { expect } from 'chai';

import { resolveSettlement } from './royalties';
import { RoyaltyListingType } from '../index';
import { createActionTrace, createTx } from '../../test-helper';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';

const MARKET_CONTRACT = 'atomicmarket';

// Estimation object shape the receiver leaves on a trace nobody asked to
// deserialize (src/filler/receiver.ts prepareActionTraces) - typeof 'object' but
// never carries any of the settlement id fields.
function estimationObject(): {binary: Uint8Array, json: null, block_num: null} {
    return {binary: new Uint8Array([1, 2, 3]), json: null, block_num: null};
}

function buildTx(traces: Array<EosioActionTrace<any>>): EosioTransaction<any> {
    return createTx({traces});
}

describe('resolveSettlement', () => {
    it('resolves a logroy trace whose direct parent is purchasesale', () => {
        const settlement = createActionTrace(MARKET_CONTRACT, 'purchasesale', {sale_id: '500001'}, {
            action_ordinal: 1, creator_action_ordinal: 0
        });
        const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', {}, {
            action_ordinal: 2, creator_action_ordinal: 1
        });
        const tx = buildTx([settlement, logTrace]);

        const result = resolveSettlement(tx, logTrace);

        expect(result).to.deep.equal({listingType: RoyaltyListingType.SALE, listingId: '500001'});
    });

    it('resolves through a nested creator chain (logroy -> intermediate inline -> settlement action)', () => {
        const settlement = createActionTrace(MARKET_CONTRACT, 'purchasesale', {sale_id: '500002'}, {
            action_ordinal: 1, creator_action_ordinal: 0
        });
        // Intermediate inline action on a different account (e.g. a token transfer
        // triggered by the settlement) sitting between the settlement and the log.
        const intermediate = createActionTrace('eosio.token', 'transfer', {from: 'a', to: 'b'}, {
            action_ordinal: 2, creator_action_ordinal: 1
        });
        const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', {}, {
            action_ordinal: 3, creator_action_ordinal: 2
        });
        const tx = buildTx([settlement, intermediate, logTrace]);

        const result = resolveSettlement(tx, logTrace);

        expect(result).to.deep.equal({listingType: RoyaltyListingType.SALE, listingId: '500002'});
    });

    const settlementCases: Array<{action: string, idField: string, listingType: RoyaltyListingType}> = [
        {action: 'auctclaimsel', idField: 'auction_id', listingType: RoyaltyListingType.AUCTION},
        {action: 'acceptbuyo', idField: 'buyoffer_id', listingType: RoyaltyListingType.BUYOFFER},
        {action: 'fulfilltbuyo', idField: 'buyoffer_id', listingType: RoyaltyListingType.TEMPLATE_BUYOFFER},
    ];

    for (const {action, idField, listingType} of settlementCases) {
        it(`maps ${action} to ${idField} / ${RoyaltyListingType[listingType]}`, () => {
            const settlement = createActionTrace(MARKET_CONTRACT, action, {[idField]: '900001'}, {
                action_ordinal: 1, creator_action_ordinal: 0
            });
            const logTrace = createActionTrace(MARKET_CONTRACT, 'logroydust', {}, {
                action_ordinal: 2, creator_action_ordinal: 1
            });
            const tx = buildTx([settlement, logTrace]);

            const result = resolveSettlement(tx, logTrace);

            expect(result).to.deep.equal({listingType, listingId: '900001'});
        });
    }

    it('returns null when no market-contract settlement ancestor exists', () => {
        const unrelated = createActionTrace('eosio.token', 'transfer', {from: 'a', to: 'b'}, {
            action_ordinal: 1, creator_action_ordinal: 0
        });
        const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', {}, {
            action_ordinal: 2, creator_action_ordinal: 1
        });
        const tx = buildTx([unrelated, logTrace]);

        expect(resolveSettlement(tx, logTrace)).to.be.null;
    });

    it('returns null (does not throw) when an ancestor\'s act.data is still a hex string (undecoded)', () => {
        // A settlement-named trace whose data no listener asked to have
        // deserialized is left as a raw hex string by the receiver.
        const settlement = createActionTrace(MARKET_CONTRACT, 'purchasesale', '0011223344556677' as any, {
            action_ordinal: 1, creator_action_ordinal: 0
        });
        const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', {}, {
            action_ordinal: 2, creator_action_ordinal: 1
        });
        const tx = buildTx([settlement, logTrace]);

        expect(() => resolveSettlement(tx, logTrace)).to.not.throw();
        expect(resolveSettlement(tx, logTrace)).to.be.null;
    });

    it('returns null (does not misclassify) when an ancestor\'s act.data is an unprocessed estimation object', () => {
        // Nobody asked to deserialize this trace at all - receiver leaves it as
        // the raw {binary, json, block_num} shape, which is `typeof === 'object'`
        // but has none of the settlement id fields.
        const settlement = createActionTrace(MARKET_CONTRACT, 'purchasesale', estimationObject() as any, {
            action_ordinal: 1, creator_action_ordinal: 0
        });
        const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', {}, {
            action_ordinal: 2, creator_action_ordinal: 1
        });
        const tx = buildTx([settlement, logTrace]);

        expect(resolveSettlement(tx, logTrace)).to.be.null;
    });

    it('terminates on a root trace (creator_action_ordinal 0)', () => {
        const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', {}, {
            action_ordinal: 1, creator_action_ordinal: 0
        });
        const tx = buildTx([logTrace]);

        expect(resolveSettlement(tx, logTrace)).to.be.null;
    });

    it('terminates on a cyclic ordinal chain instead of hanging (depth guard)', () => {
        // ordinal 2 <-> ordinal 3 point at each other - a corrupt/impossible chain
        // that must not spin the walk forever.
        const a = createActionTrace(MARKET_CONTRACT, 'someaction', {}, {
            action_ordinal: 2, creator_action_ordinal: 3
        });
        const b = createActionTrace(MARKET_CONTRACT, 'otheraction', {}, {
            action_ordinal: 3, creator_action_ordinal: 2
        });
        const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', {}, {
            action_ordinal: 1, creator_action_ordinal: 2
        });
        const tx = buildTx([a, b, logTrace]);

        expect(resolveSettlement(tx, logTrace)).to.be.null;
    });
});

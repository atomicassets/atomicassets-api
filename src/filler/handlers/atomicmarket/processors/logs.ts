import { AtomicMarketUpdatePriority, RoyaltyListingType } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import AtomicMarketHandler from '../index';
import {
    AcceptBuyofferActionData,
    AuctionClaimBuyerActionData,
    AuctionClaimSellerActionData,
    CancelAuctionActionData, CancelBuyofferActionData, CancelSaleActionData, DeclineBuyofferActionData,
    LogAuctionStartActionData,
    LogNewAuctionActionData, LogNewBuyofferActionData, LogNewSaleActionData, LogSaleStartActionData, PurchaseSaleActionData,
    LogRoyaltyAttributeActionData, LogRoyaltyDustActionData, LogRoyaltyFoundActionData, LogRoyaltyTemplateActionData,
    MigrateBalanceActionData, SetDefaultMarketCreatorActionData
} from '../types/actions';
import { resolveSettlement } from './royalties';

// The resolved settlement linkage merged into a royalty log's metadata, keyed
// the way each listing type's own log actions already key it (sale_id /
// auction_id / buyoffer_id) so the per-listing /logs endpoints stay uniform.
function resolvedSettlementMetadata(tx: EosioTransaction, trace: EosioActionTrace<any>): Record<string, string> {
    const settlement = resolveSettlement(tx, trace);

    if (!settlement) {
        return {};
    }

    switch (settlement.listingType) {
        case RoyaltyListingType.SALE:
            return {sale_id: settlement.listingId};
        case RoyaltyListingType.AUCTION:
            return {auction_id: settlement.listingId};
        case RoyaltyListingType.BUYOFFER:
        case RoyaltyListingType.TEMPLATE_BUYOFFER:
            return {buyoffer_id: settlement.listingId};
        default:
            return {};
    }
}

export function logProcessor(core: AtomicMarketHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicmarket_account;

    /* AUCTIONS */
    destructors.push(processor.onActionTrace(
        contract, 'lognewauct',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewAuctionActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                auction_id: trace.act.data.auction_id,
                starting_bid: trace.act.data.starting_bid,
                maker_marketplace: trace.act.data.maker_marketplace,
                collection_fee: trace.act.data.collection_fee
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logauctstart',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogAuctionStartActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'cancelauct',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CancelAuctionActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'auctclaimbuy',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<AuctionClaimBuyerActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'auctclaimsel',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<AuctionClaimSellerActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    /* SALES */
    destructors.push(processor.onActionTrace(
        contract, 'lognewsale',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewSaleActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                sale_id: trace.act.data.sale_id,
                maker_marketplace: trace.act.data.maker_marketplace,
                collection_fee: trace.act.data.collection_fee
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logsalestart',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogSaleStartActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'cancelsale',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CancelSaleActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'purchasesale',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<PurchaseSaleActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                sale_id: trace.act.data.sale_id,
                taker_marketplace: trace.act.data.taker_marketplace,
                intended_delphi_median: trace.act.data.intended_delphi_median
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    /* BUYOFFERS */
    destructors.push(processor.onActionTrace(
        contract, 'lognewbuyo',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewBuyofferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                buyoffer_id: trace.act.data.buyoffer_id,
                maker_marketplace: trace.act.data.maker_marketplace,
                collection_fee: trace.act.data.collection_fee
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'cancelbuyo',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CancelBuyofferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                buyoffer_id: trace.act.data.buyoffer_id
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'acceptbuyo',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<AcceptBuyofferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                buyoffer_id: trace.act.data.buyoffer_id,
                taker_marketplace: trace.act.data.taker_marketplace
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'declinebuyo',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<DeclineBuyofferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                buyoffer_id: trace.act.data.buyoffer_id
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    /* TEMPLATE BUYOFFERS */
    destructors.push(processor.onActionTrace(
        contract, 'lognewtbuyo',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewBuyofferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                buyoffer_id: trace.act.data.buyoffer_id,
                maker_marketplace: trace.act.data.maker_marketplace,
                collection_fee: trace.act.data.collection_fee
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'canceltbuyo',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CancelBuyofferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                buyoffer_id: trace.act.data.buyoffer_id
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'fulfilltbuyo',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<AcceptBuyofferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                buyoffer_id: trace.act.data.buyoffer_id,
                taker_marketplace: trace.act.data.taker_marketplace
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    /* ROYALTIES - metadata is the action data plus the resolved settlement
       linkage (sale_id/auction_id/buyoffer_id), so the per-listing /logs
       endpoints can surface these the same way as every other settlement log. */
    destructors.push(processor.onActionTrace(
        contract, 'logroyfound',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogRoyaltyFoundActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                ...trace.act.data,
                ...resolvedSettlementMetadata(tx, trace)
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logroytempl',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogRoyaltyTemplateActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                ...trace.act.data,
                ...resolvedSettlementMetadata(tx, trace)
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logroyattr',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogRoyaltyAttributeActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                ...trace.act.data,
                ...resolvedSettlementMetadata(tx, trace)
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logroydust',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogRoyaltyDustActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                ...trace.act.data,
                ...resolvedSettlementMetadata(tx, trace)
            });
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setdefmktcr',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<SetDefaultMarketCreatorActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'migratebal',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<MigrateBalanceActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicMarketUpdatePriority.LOGS.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

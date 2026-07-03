import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { encodeDatabaseJson } from '../../../utils';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { preventInt64Overflow } from '../../../../utils/binary';
import logger from '../../../../utils/winston';
import AtomicMarketHandler, { AtomicMarketUpdatePriority, RoyaltyListingType, RoyaltyPayoutCategory } from '../index';
import { RoyaltyAttrTableRow, RoyaltyConfTableRow, RoyaltyTempTableRow } from '../types/tables';
import {
    LogRoyaltyAttributeActionData,
    LogRoyaltyDustActionData,
    LogRoyaltyFoundActionData,
    LogRoyaltyTemplateActionData,
    RoyaltyPayoutActionData
} from '../types/actions';

// Maps a settlement action name to its listing type + id field. A function
// rather than a module-level object literal: index.ts and this file import each
// other (index.ts wires royaltyProcessor; this file reads AtomicMarketUpdatePriority
// / RoyaltyListingType from index.ts), and a top-level object literal evaluated at
// import time can capture `undefined` for RoyaltyListingType depending on which
// side of the cycle finishes initializing first. Deferring the enum lookups into a
// function body (evaluated only when resolveSettlement actually runs, after the
// whole module graph has loaded) sidesteps the ordering hazard entirely.
function settlementActionInfo(actionName: string): {listingType: RoyaltyListingType, idField: string} | undefined {
    switch (actionName) {
        case 'purchasesale':
            return {listingType: RoyaltyListingType.SALE, idField: 'sale_id'};
        case 'auctclaimsel':
            return {listingType: RoyaltyListingType.AUCTION, idField: 'auction_id'};
        case 'acceptbuyo':
            return {listingType: RoyaltyListingType.BUYOFFER, idField: 'buyoffer_id'};
        case 'fulfilltbuyo':
            return {listingType: RoyaltyListingType.TEMPLATE_BUYOFFER, idField: 'buyoffer_id'};
        default:
            return undefined;
    }
}

// Hard ceiling on how many creator_action_ordinal hops resolveSettlement will
// follow before giving up. Real inline-action chains are a handful of hops deep
// at most - this only exists so a corrupt/cyclic ordinal chain can never spin the
// walk forever.
const MAX_ANCESTOR_DEPTH = 32;

export type ResolvedSettlement = {
    listingType: RoyaltyListingType,
    listingId: string
};

/**
 * Walk a logroy* trace's creator_action_ordinal chain up to the settlement action
 * (purchasesale / auctclaimsel / acceptbuyo / fulfilltbuyo) that triggered it, and
 * return the listing it settled. Pure and DB-free so it is unit-testable without a
 * transaction.
 *
 * The market contract to match against is the log trace's own account: logroy*
 * actions are self-authorized inline actions sent by the market contract, so any
 * settlement ancestor that matters is on the same account.
 *
 * An ancestor trace only counts as a match when its act.data is the actually
 * decoded object AND carries the expected id field. `typeof data === 'object'` on
 * its own is not enough: the receiver leaves traces whose only listeners requested
 * raw (non-deserialized) processing as hex strings, but ALSO leaves traces nobody
 * asked to deserialize as the raw `{binary, json, block_num}` estimation object -
 * which is also `typeof === 'object'` and would otherwise be misread as a decoded,
 * but oddly-shaped, settlement payload. Checking for the id field itself rules out
 * both non-decoded shapes.
 */
export function resolveSettlement(tx: EosioTransaction<any>, trace: EosioActionTrace<any>): ResolvedSettlement | null {
    const contract = trace.act.account;

    const byOrdinal = new Map<number, EosioActionTrace<any>>();
    for (const candidate of tx.traces) {
        byOrdinal.set(candidate.action_ordinal, candidate);
    }

    let current: EosioActionTrace<any> = trace;
    let depth = 0;

    while (depth < MAX_ANCESTOR_DEPTH) {
        if (!current.creator_action_ordinal) {
            // Root action (creator_action_ordinal 0) - nothing above it.
            return null;
        }

        const parent = byOrdinal.get(current.creator_action_ordinal);

        if (!parent) {
            return null;
        }

        if (parent.act.account === contract) {
            const settlement = settlementActionInfo(parent.act.name);

            if (settlement) {
                const data: any = parent.act.data;

                if (data && typeof data === 'object' && data[settlement.idField] !== undefined) {
                    return {listingType: settlement.listingType, listingId: String(data[settlement.idField])};
                }

                // Id field missing/undecoded - the trace didn't resolve as usable
                // here, but the ancestry can still continue above it.
            }
        }

        current = parent;
        depth += 1;
    }

    return null;
}

async function insertRoyaltyPayouts(
    core: AtomicMarketHandler, db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<any>,
    category: RoyaltyPayoutCategory, collectionName: string,
    assetId: string | null, templateId: string | number | null, ruleId: string | null,
    payouts: RoyaltyPayoutActionData[]
): Promise<void> {
    if (payouts.length === 0) {
        return;
    }

    const contract = core.args.atomicmarket_account;
    const settlement = resolveSettlement(tx, trace);

    if (!settlement) {
        logger.warn(
            'AtomicMarket: could not resolve settlement listing for royalty payout. ' +
            'global_sequence=' + trace.global_sequence + ', collection=' + collectionName
        );
    }

    const listingType = settlement ? settlement.listingType : RoyaltyListingType.UNRESOLVED;
    const listingId = settlement ? settlement.listingId : null;

    const rows = payouts.map((payout, index) => {
        const [amount, tokenSymbol] = payout.amount.split(' ');

        return {
            market_contract: contract,
            log_global_sequence: trace.global_sequence,
            payout_index: index,
            listing_type: listingType.valueOf(),
            listing_id: listingId,
            category: category.valueOf(),
            collection_name: collectionName,
            asset_id: assetId,
            template_id: templateId,
            rule_id: ruleId,
            recipient: payout.recipient,
            amount: preventInt64Overflow(amount.replace('.', '')),
            token_symbol: tokenSymbol,
            txid: Buffer.from(tx.id, 'hex'),
            created_at_block: block.block_num,
            created_at_time: eosioTimestampToDate(block.timestamp).getTime()
        };
    });

    await db.insert(
        'atomicmarket_royalty_payouts', rows,
        ['market_contract', 'log_global_sequence', 'payout_index'],
        true, true, 'update'
    );
}

export function royaltyProcessor(core: AtomicMarketHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicmarket_account;

    /* CONFIG MIRROR - raw, row-for-row, deletes included. No off-chain attribute
       matching or weight renormalization: the settled truth arrives via the
       payout log below, so reimplementing the matching engine here would only
       risk silently diverging from it. */

    destructors.push(processor.onContractRow(
        contract, 'royaltyconf',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<RoyaltyConfTableRow>): Promise<void> => {
            if (!delta.present) {
                await db.delete('atomicmarket_royalties_config', {
                    str: 'market_contract = $1 AND collection_name = $2',
                    values: [contract, delta.value.collection]
                });

                return;
            }

            await db.replace('atomicmarket_royalties_config', {
                market_contract: contract,
                collection_name: delta.value.collection,
                founders: encodeDatabaseJson(delta.value.founders),
                attribute_mode: delta.value.attribute_mode,
                split_founders: delta.value.split_founders,
                split_templates: delta.value.split_templates,
                split_attributes: delta.value.split_attributes,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                created_at_block: block.block_num,
                created_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, ['market_contract', 'collection_name'], ['created_at_block', 'created_at_time']);
        }, AtomicMarketUpdatePriority.TABLE_ROYALTIES.valueOf()
    ));

    destructors.push(processor.onContractRow(
        contract, 'royaltytemp',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<RoyaltyTempTableRow>): Promise<void> => {
            if (!delta.present) {
                await db.delete('atomicmarket_royalties_templates', {
                    str: 'market_contract = $1 AND collection_name = $2 AND template_id = $3',
                    values: [contract, delta.scope, delta.value.template_id]
                });

                return;
            }

            await db.replace('atomicmarket_royalties_templates', {
                market_contract: contract,
                collection_name: delta.scope,
                template_id: delta.value.template_id,
                recipients: encodeDatabaseJson(delta.value.recipients),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                created_at_block: block.block_num,
                created_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, ['market_contract', 'collection_name', 'template_id'], ['created_at_block', 'created_at_time']);
        }, AtomicMarketUpdatePriority.TABLE_ROYALTIES.valueOf()
    ));

    destructors.push(processor.onContractRow(
        contract, 'royaltyattr',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<RoyaltyAttrTableRow>): Promise<void> => {
            if (!delta.present) {
                await db.delete('atomicmarket_royalties_attributes', {
                    str: 'market_contract = $1 AND collection_name = $2 AND rule_id = $3',
                    values: [contract, delta.scope, delta.value.index]
                });

                return;
            }

            await db.replace('atomicmarket_royalties_attributes', {
                market_contract: contract,
                collection_name: delta.scope,
                rule_id: delta.value.index,
                source: delta.value.source,
                field: delta.value.field,
                value: encodeDatabaseJson(delta.value.value),
                weight: delta.value.weight,
                recipients: encodeDatabaseJson(delta.value.recipients),
                lookup_hash: Buffer.from(delta.value.lookup_hash, 'hex'),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                created_at_block: block.block_num,
                created_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, ['market_contract', 'collection_name', 'rule_id'], ['created_at_block', 'created_at_time']);
        }, AtomicMarketUpdatePriority.TABLE_ROYALTIES.valueOf()
    ));

    /* PAYOUT LEDGER - one row per (log action, payout vector entry). Each is
       inserted with its settled listing linkage resolved from the same
       transaction via resolveSettlement (unresolved keeps the row, never drops
       it - see resolveSettlement doc comment). */

    destructors.push(processor.onActionTrace(
        contract, 'logroyfound',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogRoyaltyFoundActionData>): Promise<void> => {
            await insertRoyaltyPayouts(
                core, db, block, tx, trace, RoyaltyPayoutCategory.FOUNDERS,
                trace.act.data.collection_name, trace.act.data.asset_id, null, null,
                trace.act.data.payouts
            );
        }, AtomicMarketUpdatePriority.ACTION_LOG_ROYALTIES.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logroytempl',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogRoyaltyTemplateActionData>): Promise<void> => {
            await insertRoyaltyPayouts(
                core, db, block, tx, trace, RoyaltyPayoutCategory.TEMPLATE,
                trace.act.data.collection_name, trace.act.data.asset_id, trace.act.data.template_id, null,
                trace.act.data.payouts
            );
        }, AtomicMarketUpdatePriority.ACTION_LOG_ROYALTIES.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logroyattr',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogRoyaltyAttributeActionData>): Promise<void> => {
            await insertRoyaltyPayouts(
                core, db, block, tx, trace, RoyaltyPayoutCategory.ATTRIBUTE,
                trace.act.data.collection_name, trace.act.data.asset_id, null, trace.act.data.rule_id,
                trace.act.data.payouts
            );
        }, AtomicMarketUpdatePriority.ACTION_LOG_ROYALTIES.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logroydust',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogRoyaltyDustActionData>): Promise<void> => {
            // At most one dust row per settlement - always payout_index 0, no
            // asset/template/rule, recipient is the collection author (the
            // author-fallback + rounding-dust catch-all).
            await insertRoyaltyPayouts(
                core, db, block, tx, trace, RoyaltyPayoutCategory.DUST,
                trace.act.data.collection_name, null, null, null,
                [{recipient: trace.act.data.collection_author, amount: trace.act.data.amount}]
            );
        }, AtomicMarketUpdatePriority.ACTION_LOG_ROYALTIES.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

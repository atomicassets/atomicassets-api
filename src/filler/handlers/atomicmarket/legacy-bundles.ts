/**
 * Legacy bundle rules for the AtomicMarket v2 contract.
 *
 * A sale, auction or buyoffer created before the v2 upgrade may hold more than
 * one asset. v2 refuses to create such a listing but keeps the same actions
 * working on the ones already on chain, and it turns each of them into a
 * cancel: `purchasesale` declines the AtomicAssets offer, erases the sale and
 * charges the buyer nothing; `auctionbid`, `auctclaimbuy` and `auctclaimsel`
 * dissolve an auction neither side has claimed, refunding the standing bid and
 * returning the assets to the seller; `acceptbuyo` refunds the buyer and erases
 * the row, exactly like `declinebuyo`. Recording any of those as a trade puts a
 * sale that never happened in the database, so the processors ask here first.
 *
 * Two facts gate the rules, and both come from the in-memory state the handler
 * already keeps, so no extra database read is needed. The version comes from
 * `AtomicMarketHandler.config`, seeded in `init()` and rewritten by
 * `processors/config.ts` on a config delta. The marker comes from
 * `AtomicMarketHandler.v2MarkerBlock`, read from `atomicmarket_config` at
 * startup and written by that same processor at the block a v2 delta arrives.
 * The marker is what makes a replay safe, because the version on its own is a
 * head-time fact that says nothing about the block being recorded.
 *
 * TABLE_CONFIG priority puts the config processor ahead of the ACTION_UPDATE_*
 * priorities these rules sit on, which orders the two inside a head-mode commit
 * batch. It does not order them across blocks: the queue drains per commit
 * batch, not per block, so a batch that spans the flip can apply the config
 * delta ahead of action jobs from earlier blocks in the same batch, and a
 * catchup batch covers many blocks at once. The marker carries those cases,
 * because an action from a block before the flip stays below it whatever order
 * the batch ran in.
 *
 * Each helper checks version and marker before it queries, so a chain still on
 * v1, and any block before the flip, pay nothing for these rules.
 */
// Type-only, so this module carries no value import from the filler database
// layer and the api side can import the version predicate from it.
import type { ContractDBTransaction } from '../../database';
import { parseContractMajorVersion } from '../atomicassets/v2-guard';

/** The AtomicMarket major version that stopped honoring bundle listings. */
export const BUNDLE_REMOVAL_MAJOR_VERSION = 2;

/**
 * What a processor knows about the contract when it records an action: the
 * contract version the reader has seen, the last block the old rules still
 * cover, and the block being processed.
 */
export interface LegacyBundleContext {
    version: string | undefined | null;
    /**
     * `atomicmarket_config.v2_marker_block`, the last block still recorded under
     * the old rules. Null while the flip is unproven.
     */
    markerBlock: number | null | undefined;
    blockNum: number;
}

/**
 * Whether a market contract on this version dissolves a bundle listing instead
 * of settling it. The current version is the whole question for a caller asking
 * what an action would do now, such as the api deriving a listing's state.
 */
export function versionDissolvesBundles(version: string | undefined | null): boolean {
    const major = parseContractMajorVersion(version);

    return major !== null && major >= BUNDLE_REMOVAL_MAJOR_VERSION;
}

/**
 * Whether the block being recorded falls under the bundle rules.
 *
 * The version alone cannot answer this. `deleteDB` clears `atomicmarket_config`
 * and `init()` re-seeds it from a head-time RPC read, so a resync of a chain
 * already on v2 reads version 2.x while it replays pre-upgrade history, and
 * gating on the version alone would rewrite every real pre-upgrade settlement
 * as a cancel. The marker is the block the flip was observed at, or the reader
 * position the 2.0.9 migration recorded for a deployment whose flip is already
 * past. A null marker means unproven and leaves the old recording in place.
 *
 * The boundary is strictly after the marker, not at it. The marker is a block
 * number, but `setversion` sits at some position inside its block and the
 * config delta is applied ahead of that block's action jobs, so an action that
 * executed earlier in the flip block ran under v1 code and settled for real.
 * Admitting the flip block would record those as cancels and destroy a real
 * settlement. Excluding it costs the opposite: a bundle touched later in the
 * flip block keeps the old recording for that one block, which is the defect
 * this fixes everywhere else. That is the cheaper of the two, and it is the
 * same conservative direction as an unproven marker leaving the old recording
 * in place. The 2.0.9 backfill takes the same reading: it stores a block the
 * reader has already processed, and the rules start with the next one.
 */
export function marketDissolvesBundles(context: LegacyBundleContext): boolean {
    if (!versionDissolvesBundles(context.version)) {
        return false;
    }

    if (context.markerBlock === null || typeof context.markerBlock === 'undefined') {
        return false;
    }

    return context.blockNum > context.markerBlock;
}

/**
 * Whether a `purchasesale` on this sale cancels it instead of selling it.
 *
 * A sale carries its assets through the AtomicAssets offer it was started
 * with, so the count comes from `atomicassets_offers_assets`. A sale that has
 * no offer needs no count: the bundle branch returns before the offer check
 * that every other path has to pass, so on a v2 contract an executed
 * `purchasesale` against such a sale can only have taken it.
 */
export async function saleDissolvesAsLegacyBundle(
    db: ContractDBTransaction, assetsContract: string, offerId: string | null | undefined,
    context: LegacyBundleContext
): Promise<boolean> {
    if (!marketDissolvesBundles(context)) {
        return false;
    }

    if (offerId === null || typeof offerId === 'undefined') {
        return true;
    }

    const query = await db.query(
        'SELECT COUNT(*) FROM atomicassets_offers_assets WHERE contract = $1 AND offer_id = $2',
        [assetsContract, offerId]
    );

    return parseInt(query.rows[0].count, 10) > 1;
}

/**
 * Whether a bid or a claim on this auction dissolves it instead of settling it.
 *
 * A partially claimed auction is excluded: one side was already served, so the
 * contract wraps it up through the normal claim path with the collection fee
 * going to the author and no royalty logs.
 */
export async function auctionDissolvesAsLegacyBundle(
    db: ContractDBTransaction, marketContract: string, auctionId: string,
    context: LegacyBundleContext
): Promise<boolean> {
    if (!marketDissolvesBundles(context)) {
        return false;
    }

    const query = await db.query(
        'SELECT auction.claimed_by_buyer, auction.claimed_by_seller, (' +
            'SELECT COUNT(*) FROM atomicmarket_auctions_assets asset ' +
            'WHERE asset.market_contract = auction.market_contract AND asset.auction_id = auction.auction_id' +
        ') asset_count ' +
        'FROM atomicmarket_auctions auction WHERE auction.market_contract = $1 AND auction.auction_id = $2',
        [marketContract, auctionId]
    );

    if (query.rowCount === 0) {
        return false;
    }

    const row = query.rows[0];

    if (row.claimed_by_buyer || row.claimed_by_seller) {
        return false;
    }

    return parseInt(row.asset_count, 10) > 1;
}

/**
 * Whether an `acceptbuyo` on this buyoffer refunds the buyer instead of
 * settling the trade.
 */
export async function buyofferDissolvesAsLegacyBundle(
    db: ContractDBTransaction, marketContract: string, buyofferId: string,
    context: LegacyBundleContext
): Promise<boolean> {
    if (!marketDissolvesBundles(context)) {
        return false;
    }

    const query = await db.query(
        'SELECT COUNT(*) FROM atomicmarket_buyoffers_assets WHERE market_contract = $1 AND buyoffer_id = $2',
        [marketContract, buyofferId]
    );

    return parseInt(query.rows[0].count, 10) > 1;
}

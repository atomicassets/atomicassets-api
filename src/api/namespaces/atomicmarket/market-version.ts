import { DB } from '../../server';
import { versionDissolvesBundles } from '../../../filler/handlers/atomicmarket/legacy-bundles';

/**
 * Whether the market contract dissolves a legacy bundle listing instead of
 * settling it, which decides the state an ended bundle auction derives.
 *
 * The version lives in `atomicmarket_config`, where the filler writes it when
 * the chain flips. Reading it once at namespace init tied it to the process
 * lifetime instead: the flip lands on a running fleet that nobody restarts, and
 * every auction response would keep reporting an ended bundle as sold until
 * someone did.
 *
 * A short-lived cache rather than a per-request read. The auctions list is a
 * hot path, and an unconditional round trip per request is a cost this change
 * has not measured, so it does not take it. One primary-key lookup per contract
 * per TTL is nil by inspection, and it needs no new notification wiring: the
 * AtomicMarket config processor publishes nothing today, so a notification-
 * driven refresh would mean adding a channel to the filler and a subscriber to
 * the api for a value that changes once in a chain's life.
 *
 * The cache is not a latch. `setversion` can name any string, so a contract
 * rollback moves the version back, and a value that only ever moved forward
 * would hold the wrong rules until a restart, which is the defect this fixes.
 */
export const MARKET_VERSION_CACHE_TTL_MS = 30000;

interface CachedMarketVersion {
    dissolvesBundles: boolean;
    readAt: number;
}

const cache = new Map<string, CachedMarketVersion>();

/** Drops every cached version. For tests that flip the stored value. */
export function clearMarketVersionCache(): void {
    cache.clear();
}

export async function marketDissolvesBundles(db: DB, marketContract: string): Promise<boolean> {
    const cached = cache.get(marketContract);

    if (cached && Date.now() - cached.readAt < MARKET_VERSION_CACHE_TTL_MS) {
        return cached.dissolvesBundles;
    }

    const query = await db.query(
        'SELECT version FROM atomicmarket_config WHERE market_contract = $1',
        [marketContract]
    );

    // A missing row is a reader that has not initialized the contract yet.
    // Treat it as pre-v2, which keeps the state every client already sees.
    const dissolvesBundles = query.rowCount > 0 && versionDissolvesBundles(query.rows[0].version);

    cache.set(marketContract, {dissolvesBundles, readAt: Date.now()});

    return dissolvesBundles;
}

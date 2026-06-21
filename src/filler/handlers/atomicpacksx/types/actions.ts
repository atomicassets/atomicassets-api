/**
 * atomicpacksx action data shapes - WAX mainnet ABI.
 *
 * In 1.6.0, pack metadata + claim lifecycle are driven from contract row
 * deltas (see `types/tables.ts`). Action listeners remain for:
 *
 *   - `logresult` - provides `template_ids` (which template each minted
 *     NFT comes from), keyed by `pack_asset_id`. Emitted inline by
 *     `receiverand` (RNG callback). Resolution event - UPSERTs the claim
 *     row to RESOLVED + INSERT claim_assets.
 *   - `claimunboxed` - user's terminal pickup action. Used to flip claim
 *     state to PICKED_UP.
 *   - `lognewroll` + `addpackroll` - pack roll metadata (rolls.ts still
 *     uses these action listeners; rolls aren't worth the scope-decoding
 *     complexity of `packrolls` table deltas - pack_id scope is uint64,
 *     not name-encoded).
 *   - `lognewpack` - log-only listener (logs.ts) for raw trace stream.
 *
 * The pack-open event (`receive_asset_transfer` notify with memo="unbox")
 * is captured via the `unboxpacks` row delta INSERT, NOT via an action
 * listener. See `processors/claims.ts`.
 */

/** lognewpack - log-only consumer in logs.ts (no domain mutations). */
export type LogNewPackActionData = {
    pack_id: string,
    collection_name: string,
    unlock_time: number,
};

/** Announces a roll exists for a pack. Outcomes come separately via
 *  `addpackroll`. */
export type LogNewRollActionData = {
    pack_id: string,
    roll_id: string,
};

/** Provides the outcomes + total_odds for an existing roll. Fires after
 *  the corresponding `lognewroll`. */
export type AddPackRollActionData = {
    authorized_account: string,
    pack_id: string,
    outcomes: unknown,           // ROLL_OUTCOME[] - array of { template_id, odds }
    total_odds: string,
};

/**
 * Server-signed reveal of a pack's NFT outputs. Provides `template_ids`
 * (which template each minted NFT will be from), keyed by `pack_asset_id`.
 * The actually-minted asset_ids come later via atomicassets `logmint`
 * notify (future work; the schema's `asset_id` column stays NULL).
 */
export type LogResultActionData = {
    pack_asset_id: string,
    pack_id: string,
    template_ids: string[],
};

/**
 * User claims a pack's resolved NFTs (the contract mints them and erases
 * the per-roll unboxassets rows). Auth is the original unboxer or the
 * contract self. The pack_asset_id is the claim identifier (1:1).
 */
export type ClaimUnboxedActionData = {
    pack_asset_id: string,
    origin_roll_ids: string[],
};

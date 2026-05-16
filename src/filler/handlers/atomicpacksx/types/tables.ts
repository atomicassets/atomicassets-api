/**
 * atomicpacksx contract table row shapes — WAX mainnet ABI.
 *
 * Sourced from the on-chain contract at
 * `atomichub/contracts/atomicpacks-contract/include/atomicpacks-interface.hpp`
 * and `src/atomicpacks.cpp`. SHiP delivers these row deltas via
 * `processor.onContractRow(contract, table, ...)`.
 *
 * Why we drive off table deltas instead of action listeners:
 *   - The chain writes the same data to its own state regardless of which
 *     action mutated it (announcepack, completepack, setpackdata,
 *     setpacktime all write to `packs`). Listening to the row delta
 *     captures all five with one handler.
 *   - The pack-open event has NO single action — it's the
 *     `receive_asset_transfer` notification (memo="unbox") triggering an
 *     `unboxpacks` row insert. Action-level handlers can't reliably hear
 *     notifications across all chain variants; the row delta always fires.
 */

export type ConfigTableRow = {
    contract: string,
    version: string,
};

/** atomicpacksx::packs (scope: contract self) */
export type PacksTableRow = {
    pack_id: string,
    collection_name: string,
    unlock_time: number,
    pack_template_id: string | number,  // -1 if not yet completepack'd
    roll_counter: string | number,
    display_data: string,
};

/** atomicpacksx::packrolls (scope: pack_id) */
export type PackRollsTableRow = {
    roll_id: string,
    outcomes: Array<{ template_id: string | number, odds: string | number }>,
    total_odds: string | number,
};

/** atomicpacksx::unboxpacks (scope: contract self).
 *  Inserted when a user transfers a pack with memo="unbox"; erased when
 *  claimunboxed completes for the last roll. */
export type UnboxPacksTableRow = {
    pack_asset_id: string,
    pack_id: string,
    unboxer: string,
};

/** atomicpacksx::unboxassets (scope: pack_asset_id).
 *  Inserted by receiverand callback (one row per resolved roll); erased
 *  per-row by claimunboxed as the user picks up each roll's outcome. */
export type UnboxAssetsTableRow = {
    origin_roll_id: string,
    template_id: string | number,  // -1 = no mint for this roll
};

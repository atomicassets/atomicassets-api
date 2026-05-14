/**
 * atomicpacksx action data shapes.
 *
 * Action names mirror those emitted by the upstream atomicpacksx contract
 * on WAX mainnet. Field names follow the contract's struct definitions; if
 * a chain runs a forked/older variant with different field names, override
 * action names via the handler arg or extend the type unions here.
 */

export type LogNewPackActionData = {
    pack_id: string,
    collection_name: string,
    unlock_time: number,
    pack_template_id: string,
    display_data: string,
};

export type SetPackDataActionData = {
    pack_id: string,
    display_data: string,
};

export type SetUnlockTimeActionData = {
    pack_id: string,
    unlock_time: number,
};

export type LogNewRollActionData = {
    pack_id: string,
    roll_id: string,
    total_odds: string,
    outcomes: unknown,           // array of { template_id, odds } objects (jsonb-stored as-is)
    display_data?: string,
};

export type SetRollOutcomesActionData = {
    pack_id: string,
    roll_id: string,
    total_odds: string,
    outcomes: unknown,
};

/**
 * User claims a pack. The contract burns the pack NFT and emits this action;
 * the actual reveal happens later via `setresultrnft` / `claimunboxed` /
 * `logresult`.
 */
export type ClaimPackActionData = {
    claimer?: string,
    opener?: string,
    pack_asset_id: string,
    origin_roll_ids?: string[],
};

export type LogClaimActionData = {
    claim_id: string,
    pack_id: string,
    opener: string,
    pack_asset_id: string,
};

/**
 * Server-signed reveal of a claim's NFT outputs.
 */
export type LogResultActionData = {
    claim_id: string,
    asset_ids: string[],
};

/**
 * Optional cancel/expire action — produces a state=2 (cancelled) transition.
 */
export type CancelClaimActionData = {
    claim_id: string,
};

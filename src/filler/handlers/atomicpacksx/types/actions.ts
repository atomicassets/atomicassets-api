/**
 * atomicpacksx action data shapes — WAX mainnet ABI.
 *
 * Field names mirror the actions emitted by the official atomicpacksx
 * contract on WAX mainnet (verified via `get_abi`). Other chains may run a
 * forked variant with different field names; override action names via
 * handler args or extend the type unions if needed.
 *
 * Notable WAX semantics:
 *   - There is no `claim_id` chain field. Each pack opening burns ONE
 *     specific NFT (`pack_asset_id`), so `pack_asset_id` IS the claim
 *     identifier. The schema's `claim_id bigint` column is populated from
 *     `pack_asset_id` 1:1.
 *   - `lognewpack` only carries the bare minimum (pack_id, collection_name,
 *     unlock_time). `pack_template_id` is set later by `completepack`;
 *     `display_data` is set later by `setpackdata`.
 *   - Rolls are split across two actions: `lognewroll` announces the roll
 *     (pack_id, roll_id only) and `addpackroll` provides the outcomes
 *     (`outcomes`, `total_odds`).
 *   - `logresult` provides `template_ids` (which template each minted NFT
 *     will be from), NOT the actual minted asset_ids. The asset_ids
 *     themselves come later via atomicassets `logmint` notify (not handled
 *     here in 1.5.1; future work).
 */

/** Pre-creation announcement of a pack — reserves a pack_id slot. */
export type AnnouncePackActionData = {
    authorized_account: string,
    collection_name: string,
    unlock_time: number,
    display_data: string,
};

/** Bare-bones pack creation. pack_template_id + display_data are filled
 *  in later by `completepack` and `setpackdata` respectively. */
export type LogNewPackActionData = {
    pack_id: string,
    collection_name: string,
    unlock_time: number,
};

/** Sets the pack's template_id post-creation (pack must already exist via
 *  `lognewpack`). On WAX, packs are created blank then completed. */
export type CompletePackActionData = {
    authorized_account: string,
    pack_id: string,
    pack_template_id: string,
};

/** Updates display_data only. Tolerates any extra fields the contract
 *  emits (the upstream contract always emits `authorized_account`). */
export type SetPackDataActionData = {
    pack_id: string,
    display_data: string,
    [key: string]: unknown,
};

/** Updates unlock_time only. WAX uses `setpacktime` (not `setunlocktime`)
 *  with the field renamed `new_unlock_time`. */
export type SetPackTimeActionData = {
    authorized_account: string,
    pack_id: string,
    new_unlock_time: number,
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
    outcomes: unknown,           // ROLL_OUTCOME[] — array of { template_id, odds }
    total_odds: string,
};

/**
 * User claims a pack (the contract burns the pack NFT). The actual reveal
 * happens later via `logresult`. WAX uses `claimunboxed` (not `logclaim`);
 * the unique claim identifier on WAX is `pack_asset_id` since each pack
 * opening burns exactly one specific NFT.
 *
 * The opener account is on `trace.act.authorization[0].actor` (not in
 * action data) since the user signs the action themselves.
 */
export type ClaimUnboxedActionData = {
    pack_asset_id: string,
    origin_roll_ids: string[],
};

/**
 * Server-signed reveal of a pack's NFT outputs. Provides `template_ids`
 * (which template each minted NFT will be from), keyed by `pack_asset_id`.
 * The actually-minted asset_ids come from a separate atomicassets
 * `logmint` notify chain (not handled in 1.5.1).
 */
export type LogResultActionData = {
    pack_asset_id: string,
    pack_id: string,
    template_ids: string[],
};

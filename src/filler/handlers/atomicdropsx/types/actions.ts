/**
 * atomicdropsx action data shapes - WAX mainnet ABI.
 *
 * Action names follow the official atomicdropsx contract on WAX mainnet
 * (verified via `get_abi`). Notable WAX semantics:
 *   - User claims emit `claimdrop` / `claimdropwl` / `claimdropkey`.
 *     Field is `claim_amount` (NOT `amount` as the upstream PR #26
 *     assumed).
 *   - `claimdropwl` is the canonical whitelist claim (NOT `claimwlnft` /
 *     `claimwhitelis` which the upstream listened for - those don't exist
 *     on WAX).
 *   - `claimdropkey` is a separate key-auth claim variant.
 *   - `triggerdrop` is admin-mediated (e.g., card-payment service triggers
 *     on behalf of a user). Field is `recipient` (the claimer) and
 *     `amount` (count). No `intended_delphi_median`.
 *   - `setdroptimes` is PLURAL on WAX (NOT `setdroptime`).
 *   - `erasedrop` exists but carries an extra `authorized_account` field
 *     that the upstream type didn't include (harmless - extras are ignored).
 *   - There is no `logclaim` action on WAX. (The upstream defined one for
 *     other chain variants; we keep the type defined for future use but
 *     no listener fires.)
 */

export type LogNewDropActionData = {
    drop_id: string,
    collection_name: string,
    assets_to_mint: Array<{
        template_id: string | number,
        bank_account?: string,
        use_pool?: boolean,
        tokens_to_back?: string[],
    }>,
    listing_price: string,
    settlement_symbol?: string,
    price_recipient: string,
    auth_required: boolean,
    account_limit?: number,
    account_limit_cooldown?: number,
    max_claimable?: number,
    start_time?: number,
    end_time?: number,
    display_data?: string,
};

export type SetDropDataActionData = {
    drop_id: string,
    display_data: string,
    [key: string]: unknown,  // tolerate WAX's extra authorized_account field
};

export type SetDropPriceActionData = {
    drop_id: string,
    listing_price: string,
    [key: string]: unknown,
};

export type SetDropLimitActionData = {
    drop_id: string,
    account_limit: number,
    account_limit_cooldown: number,
    max_claimable?: number,  // WAX's setdroplimit may not include this - setdropmax does
    [key: string]: unknown,
};

/**
 * `setdroptimes` (PLURAL) on WAX. Both fields are required by the WAX
 * contract - there's no equivalent of "set only start" or "set only end".
 */
export type SetDropTimesActionData = {
    authorized_account: string,
    drop_id: string,
    start_time: number,
    end_time: number,
};

export type EraseDropActionData = {
    drop_id: string,
    [key: string]: unknown,  // tolerate WAX's authorized_account
};

/**
 * Standard user claim. Field `claim_amount` on WAX (NOT `amount`).
 */
export type ClaimDropActionData = {
    claimer: string,
    drop_id: string,
    claim_amount: number,
    intended_delphi_median?: string,
    referrer?: string,
    country?: string,
};

/** Whitelist claim variant - `claimdropwl` on WAX. */
export type ClaimDropWlActionData = ClaimDropActionData & {
    whitelist_proof?: unknown,
};

/** Key-auth whitelist claim - `claimdropkey` on WAX. */
export type ClaimDropKeyActionData = ClaimDropActionData & {
    auth_key?: string,
};

/**
 * Admin-mediated claim. Different field naming from the user-side claims:
 *   - `recipient` is the user receiving the claim (vs `claimer` on user actions)
 *   - `amount` is the count (vs `claim_amount` on user actions)
 * Common: drop_id.
 */
export type TriggerDropActionData = {
    authorized_account: string,
    drop_id: string,
    recipient: string,
    amount: number,
    trigger_provider: string,
    trigger_identifier: string,
};

/**
 * Author-side log of a claim. Does NOT exist on WAX - kept for chain
 * variants that emit it. The upstream listener was already gated on
 * `claim_id` being present, so the no-op fallback is safe.
 */
export type LogClaimActionData = {
    claim_id?: string,
    claimer: string,
    drop_id: string,
    amount: number,
    total_price?: string,
};

/**
 * atomicdropsx action data shapes.
 *
 * Action names follow the upstream atomicdropsx contract on WAX mainnet.
 * Naming covers both the modern action names and a small set of historical
 * variants (claimwlnft / claimdroppos) to cope with chains running older
 * deployments. Variant listeners no-op when their action never fires.
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
};

export type SetDropPriceActionData = {
    drop_id: string,
    listing_price: string,
};

export type SetDropLimitActionData = {
    drop_id: string,
    account_limit: number,
    account_limit_cooldown: number,
    max_claimable: number,
};

export type SetDropTimeActionData = {
    drop_id: string,
    start_time?: number,
    end_time?: number,
};

export type EraseDropActionData = {
    drop_id: string,
};

export type ClaimDropActionData = {
    claimer: string,
    drop_id: string,
    amount: number,
    intended_delphi_median?: string,
    referrer?: string,
    country?: string,
};

/** Whitelist claim variant — emits when the user is on a drop whitelist. */
export type ClaimWhitelistActionData = ClaimDropActionData & {
    whitelist_proof?: unknown,
};

/**
 * Drop-author-side log of a claim. Some contract variants emit a separate
 * `logclaim` after the user action; we listen for both to be safe.
 */
export type LogClaimActionData = {
    claim_id?: string,
    claimer: string,
    drop_id: string,
    amount: number,
    total_price?: string,
};

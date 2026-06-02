export type AttributeMap = Array<{key: string, value: [string, any]} | {first: string, second: [string, any]}>;
export type Format = {name: string, type: string};

export type LogTransferActionData = {
    collection_name: string,
    'from': string,
    to: string,
    asset_ids: string[],
    memo: string
};

export type LogMoveActionData = {
    collection_name: string,
    owner: string,
    'from': string,
    to: string,
    asset_ids: string[],
    memo: string
};

export type LogMintAssetActionData = {
    asset_id: string;
    authorized_minter: string,
    collection_name: string,
    schema_name: string,
    template_id: number,
    new_asset_owner: string,
    immutable_data: AttributeMap,
    mutable_data: AttributeMap,
    backed_tokens: string[],
    immutable_template_data: AttributeMap
};

export type LogBurnAssetActionData = {
    asset_owner: string,
    asset_id: string,
    collection_name: string,
    schema_name: string,
    template_id: number,
    backed_tokens: string[],
    asset_ram_payer: string,
    old_immutable_data: AttributeMap,
    old_mutable_data: AttributeMap
};

export type LogBackAssetActionData = {
    asset_owner: string,
    asset_id: string,
    backed_token: string
};

export type LogSetDataActionData = {
    asset_owner: string,
    asset_id: string,
    old_data: AttributeMap,
    new_data: AttributeMap
};

export type AddColAuthActionData = {
    collection_name: string,
    account_to_add: string
};

export type AddNotifyAccActionData = {
    collection_name: string,
    account_to_add: string
};

export type CreateColActionData = {
    author: string,
    collection_name: string,
    allow_notify: boolean,
    authorized_accounts: string[],
    notify_accounts: string[],
    market_fee: number,
    data: AttributeMap
};

export type ForbidNotifyActionData = {
    collection_name: string
};

export type RemColAuthActionData = {
    collection_name: string,
    account_to_remove: string
};

export type RemNotifyAccActionData = {
    collection_name: string,
    account_to_remove: string
};

export type SetMarketFeeActionData = {
    collection_name: string,
    market_fee: number
};

export type SetColDataActionData = {
    collection_name: string,
    data: AttributeMap
};

export type LogNewTemplateActionData = {
    template_id: number,
    authorized_creator: string,
    schema_name: string,
    collection_name: string,
    transferable: boolean,
    burnable: boolean,
    max_supply: number,
    immuntable_data: AttributeMap
};

export type LockTemplateActionData = {
    authorized_editor: string,
    collection_name: string,
    template_id: number
};

export type CreateSchemaActionData = {
    authorized_creator: string,
    collection_name: string,
    schema_name: string,
    schema_format: Format[]
};

export type ExtendSchemaActionData = {
    authorized_editor: string,
    collection_name: string,
    schema_name: string,
    schema_format_extension: Format[]
};

export type AcceptOfferActionData = {
    offer_id: string
};

export type DeclineOfferActionData = {
    offer_id: string
};

export type CancelOfferActionData = {
    offer_id: string
};

export type LogNewOfferActionData = {
    offer_id: string,
    sender: string,
    recipient: string,
    sender_asset_ids: string[],
    recipient_asset_ids: string[],
    memo: string
};

export type CreateAuthorSwapActionData = {
    collection_name: string,
    new_author: string,
    owner: boolean,
};

export type AcceptAuthorSwapActionData = {
    collection_name: string,
};

export type RejectAuthorSwapActionData = {
    collection_name: string,
};

export type DeleteTemplateActionData = {
    authorized_editor: string,
    collection_name: string,
    template_id: number,
};

export type ReduceTemplateMaxSupplyActionData = {
    authorized_editor: string,
    collection_name: string,
    template_id: number,
    new_max_supply: number
};

export type LogSetTemplateDataActionData = {
    authorized_editor: string,
    collection_name: string,
    template_id: number,
    old_data: AttributeMap,
    new_data: AttributeMap
};

export type LogSetSchemaTypeActionData = {
    authorized_editor: string,
    collection_name: string,
    schema_name: number,
    schema_format_type: any
};

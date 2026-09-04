-- Carry the template's mutable data and its deletion marks into the nested
-- template object of atomicassets_assets_master.
--
-- The object listed immutable_data alone, so every asset response reported an
-- empty template.mutable_data and a merged data without any key the template
-- holds mutably. formatAsset already layers template.mutable_data underneath
-- the asset's own data and openapi already documents the three fields, so the
-- view was the only place the values were lost.
--
-- The replacement changes expressions inside one existing json column and adds
-- no column, so CREATE OR REPLACE keeps the view's signature and every
-- dependent view (atomicmarket_assets_master selects asset.*) stays valid with
-- no DROP ... CASCADE. Nothing is rewritten on disk: a view holds no rows, so
-- this is a catalog update whose cost does not scale with the table.
--
-- The timeouts repeat 2.0.6's and 2.0.7's treatment and cover the rest of the
-- version transaction. The replacement takes ACCESS EXCLUSIVE on
-- atomicassets_assets_master, which every asset read and every market listing
-- read passes through, and the lock queue is FIFO, so a pending request parks
-- those reads behind it. lock_timeout is 5s, the in-repo value for locking DDL:
-- the cost of waiting is paid by API readers, not by this migration, so failing
-- after 5s and letting the filler replay the version caps that cost at 5s per
-- attempt where the runner's 60s session default would stall the path for a
-- minute per filler boot. A version that can never take the lock crash-loops
-- the filler, which is the loud failure this trades for. statement_timeout is
-- lifted because the cap the migration path inherits was chosen for runtime
-- queries; a statement waiting behind a long-running reader should fail on the
-- lock timeout, not on a cap meant for something else.

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE VIEW atomicassets_assets_master AS
    SELECT DISTINCT ON (asset.contract, asset.asset_id)
        asset.contract, asset.asset_id, asset.owner,

        CASE WHEN "template".template_id IS NULL THEN true ELSE "template".transferable END AS is_transferable,
        CASE WHEN "template".template_id IS NULL THEN true ELSE "template".burnable END AS is_burnable,

        asset.collection_name,
        json_build_object(
            'collection_name', collection.collection_name,
            'name', collection.data->>'name',
            'img', collection.data->>'img',
            'images', collection.data->>'images',
            'author', collection.author,
            'allow_notify', collection.allow_notify,
            'authorized_accounts', collection.authorized_accounts,
            'notify_accounts', collection.notify_accounts,
            'market_fee', collection.market_fee,
            'created_at_block', collection.created_at_block::text,
            'created_at_time', collection.created_at_time::text
        ) collection,

        asset.schema_name,
        json_build_object(
            'schema_name', "schema".schema_name,
            'format', "schema".format,
            'types', "schema".types,
            'created_at_block', "schema".created_at_block::text,
            'created_at_time', "schema".created_at_time::text
        ) "schema",

        asset.template_id,
        CASE WHEN "template".template_id IS NULL THEN null ELSE
        json_build_object(
            'template_id', "template".template_id::text,
            'max_supply', "template".max_supply::text,
            'is_transferable', "template".transferable,
            'is_burnable', "template".burnable,
            'issued_supply', "template".issued_supply::text,
            'immutable_data', "template".immutable_data,
            'mutable_data', "template".mutable_data,
            'created_at_time', "template".created_at_time::text,
            'created_at_block', "template".created_at_block::text,
            'deleted_at_time', "template".deleted_at_time::text,
            'deleted_at_block', "template".deleted_at_block::text
        ) END AS "template",

        asset.mutable_data,
        asset.immutable_data,

        COALESCE(asset.template_mint, 0)::bigint template_mint,

        ARRAY(
            SELECT DISTINCT ON (inner_backed.contract, inner_backed.asset_id, inner_backed.token_symbol)
                json_build_object(
                    'token_contract', inner_symbol.token_contract,
                    'token_symbol', inner_symbol.token_symbol,
                    'token_precision', inner_symbol.token_precision,
                    'amount', inner_backed.amount
                )
            FROM atomicassets_assets_backed_tokens inner_backed, atomicassets_tokens inner_symbol
            WHERE
                inner_backed.contract = inner_symbol.contract AND inner_backed.token_symbol = inner_symbol.token_symbol AND
                inner_backed.contract = asset.contract AND inner_backed.asset_id = asset.asset_id
        ) backed_tokens,

        asset.burned_by_account, asset.burned_at_block, asset.burned_at_time,
        asset.updated_at_block, asset.updated_at_time,
        asset.transferred_at_block, asset.transferred_at_time,
        asset.minted_at_block, asset.minted_at_time
    FROM
        atomicassets_assets asset
        LEFT JOIN atomicassets_templates "template" ON (
            "template".contract = asset.contract AND "template".template_id = asset.template_id
        )
        JOIN atomicassets_collections collection ON (collection.contract = asset.contract AND collection.collection_name = asset.collection_name)
        JOIN atomicassets_schemas "schema" ON ("schema".contract = asset.contract AND "schema".collection_name = asset.collection_name AND "schema".schema_name = asset.schema_name)

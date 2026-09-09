import {OfferState} from '../../../filler/handlers/atomicassets';
import QueryBuilder from '../../builder';
import {filterQueryArgs, FiltersDefinition, FilterValues} from '../validation';

export function hasAssetFilter(values: FilterValues, blacklist: string[] = []): boolean {
    return Object.keys(values)
        .filter(key => !blacklist.includes(key))
        .some(key => assetFilters[key]);
}

export function hasDataFilters(values: FilterValues): boolean {
    const keys = Object.keys(values);

    for (const key of keys) {
        if (['match', 'match_immutable_name', 'match_mutable_name', 'search'].includes(key)) {
            return true;
        }

        if (key.startsWith('data.') || key.startsWith('data:')) {
            return true;
        }

        if (key.startsWith('template_data.') || key.startsWith('template_data:')) {
            return true;
        }

        if (key.startsWith('immutable_data.') || key.startsWith('immutable_data:')) {
            return true;
        }

        if (key.startsWith('mutable_data.') || key.startsWith('mutable_data:')) {
            return true;
        }
    }

    return false;
}

export function buildDataConditions(values: FilterValues, query: QueryBuilder, options: { assetTable?: string, templateTable?: string }): void {
    const keys = Object.keys(values);

    function buildConditionObject(name: string): { [key: string]: string | number | boolean } {
        const searchObject: { [key: string]: string | number } = {};

        for (const key of keys) {
            if (key.startsWith(name + ':text.')) {
                searchObject[key.substr((name + ':text.').length)] = String(values[key]);
            } else if (key.startsWith(name + ':number.')) {
                searchObject[key.substr((name + ':number.').length)] = parseFloat(values[key]);
            } else if (key.startsWith(name + ':bool.')) {
                searchObject[key.substr((name + ':bool.').length)] = (values[key] === 'true' || values[key] === '1') ? 1 : 0;
            } else if (key.startsWith(name + '.')) {
                searchObject[key.substr((name + '.').length)] = values[key];
            }
        }

        return searchObject;
    }

    const templateCondition = {...buildConditionObject('data'), ...buildConditionObject('template_data')};
    const mutableCondition = buildConditionObject('mutable_data');
    const immutableCondition = buildConditionObject('immutable_data');

    if (!options.templateTable) {
        Object.assign(immutableCondition, buildConditionObject('data'), immutableCondition);
    }

    if (options.assetTable) {
        const assetDataCondition = {
            ...mutableCondition,
            ...immutableCondition,
        };

        if (Object.keys(assetDataCondition).length > 0) {
            // use combined index
            query.addCondition(`(${options.assetTable}.mutable_data || ${options.assetTable}.immutable_data) @> ${query.addVariable(JSON.stringify(mutableCondition))}::jsonb`);
            query.addCondition(`(${options.assetTable}.mutable_data || ${options.assetTable}.immutable_data) != '{}'`);
        }

        if (Object.keys(mutableCondition).length > 0) {
            query.addCondition(options.assetTable + '.mutable_data @> ' + query.addVariable(JSON.stringify(mutableCondition)) + '::jsonb');
        }

        if (Object.keys(immutableCondition).length > 0) {
            query.addCondition(options.assetTable + '.immutable_data @> ' + query.addVariable(JSON.stringify(immutableCondition)) + '::jsonb');
        }

        if (typeof values.match_immutable_name === 'string' && values.match_immutable_name.length > 0) {
            query.addCondition(
                options.assetTable + '.immutable_data->>\'name\' ILIKE ' +
                query.addVariable('%' + query.escapeLikeVariable(values.match_immutable_name) + '%')
            );
        }

        if (typeof values.match_mutable_name === 'string' && values.match_mutable_name.length > 0) {
            query.addCondition(
                options.assetTable + '.mutable_data->>\'name\' ILIKE ' +
                query.addVariable('%' + query.escapeLikeVariable(values.match_mutable_name) + '%')
            );
        }
    }

    if (options.templateTable) {
        // A template carries its data across two columns and a collection
        // decides which one holds a given attribute, so every template-level
        // condition below is satisfied by either column. Each requested pair
        // gets its own disjunction rather than one containment test over the
        // whole object: that keeps a filter naming one immutable key and one
        // mutable key working, and it leaves each arm of the OR indexable by
        // the jsonb_ops GIN index on its own column. Postgres builds a BitmapOr
        // only when every arm is indexable, so an unindexed arm costs a
        // sequential scan for the whole condition, not just for itself.
        //
        // The key and the value only ever reach the query inside a bind
        // parameter, as one JSON object per pair. Neither is concatenated into
        // the SQL text.
        for (const [key, value] of Object.entries(templateCondition)) {
            const pair = query.addVariable(JSON.stringify({[key]: value}));

            query.addCondition(
                `${options.templateTable}.immutable_data @> ${pair}::jsonb` +
                ` OR ${options.templateTable}.mutable_data @> ${pair}::jsonb`
            );
        }

        // The name comparisons take the other index type: ILIKE and the <%
        // word-similarity operator are served by the trigram GIST index on each
        // column's extracted name, which a jsonb_ops GIN index cannot serve.
        if (typeof values.match === 'string' && values.match.length > 0) {
            const match = query.addVariable('%' + query.escapeLikeVariable(values.match) + '%');

            query.addCondition(
                `${options.templateTable}.immutable_data->>'name' ILIKE ${match}` +
                ` OR ${options.templateTable}.mutable_data->>'name' ILIKE ${match}`
            );
        }

        if (typeof values.search === 'string' && values.search.length > 0) {
            const search = query.addVariable(values.search);

            query.addCondition(
                `${search} <% (${options.templateTable}.immutable_data->>'name')` +
                ` OR ${search} <% (${options.templateTable}.mutable_data->>'name')`
            );
        }
    }
}

const assetFilters: FiltersDefinition = {
    asset_id: {type: 'list[id]'},
    owner: {type: 'list[name]'},
    burned: {type: 'bool'},
    template_id: {type: 'list[id]'},
    collection_name: {type: 'list[name]'},
    schema_name: {type: 'list[name]'},
    is_transferable: {type: 'bool'},
    is_burnable: {type: 'bool'},
    minter: {type: 'list[name]'},
    initial_receiver: {type: 'list[name]'},
    burner: {type: 'list[name]'},
};

export async function buildAssetFilter(
    values: FilterValues, query: QueryBuilder,
    options: { assetTable?: string, templateTable?: string, allowDataFilter?: boolean } = {}
): Promise<void> {
    options = {allowDataFilter: true, ...options};

    const args = await filterQueryArgs(values, assetFilters);

    if (options.allowDataFilter !== false) {
        buildDataConditions(values, query, {assetTable: options.assetTable, templateTable: options.templateTable});
    }

    if (args.asset_id.length) {
        query.equalMany(options.assetTable + '.asset_id', args.asset_id);
    }

    if (args.owner.length) {
        query.equalMany(options.assetTable + '.owner', args.owner);
    }

    if (args.template_id.length) {
        if ((args.template_id.length === 1) && (args.template_id[0] === 'null')) {
            query.isNull(options.assetTable + '.template_id');
        } else {
            query.equalMany(options.assetTable + '.template_id', args.template_id);
        }
    }

    if (args.collection_name.length) {
        query.equalMany(options.assetTable + '.collection_name', args.collection_name);
    }

    if (args.schema_name.length) {
        query.equalMany(options.assetTable + '.schema_name', args.schema_name);

        if (!args.collection_name.length) {
            // makes collection/schema index faster to use
            query.addCondition(`${options.assetTable}.collection_name IN (SELECT collection_name FROM atomicassets_schemas WHERE schema_name = ANY(${query.addVariable(args.schema_name)}))`);
        }
    }

    if (args.minter.length) {
        query.addCondition(`EXISTS (
            SELECT * FROM atomicassets_mints mint_table 
            WHERE ${options.assetTable}.contract = mint_table.contract AND ${options.assetTable}.asset_id = mint_table.asset_id
                AND mint_table.minter = ANY(${query.addVariable(args.minter)})
        )`);
    }

    if (args.initial_receiver.length) {
        query.addCondition(`EXISTS (
            SELECT * FROM atomicassets_mints mint_table 
            WHERE ${options.assetTable}.contract = mint_table.contract AND ${options.assetTable}.asset_id = mint_table.asset_id
                AND mint_table.receiver = ANY(${query.addVariable(args.initial_receiver)})
        )`);
    }

    if (args.burner.length) {
        query.equalMany(options.assetTable + '.burned_by_account', args.burner);
    }

    if (typeof args.burned === 'boolean') {
        if (args.burned) {
            query.isNull(options.assetTable + '.owner');
        } else {
            query.notNull(options.assetTable + '.owner');
        }
    }

    if (options.templateTable && typeof args.is_transferable === 'boolean') {
        if (args.is_transferable) {
            query.addCondition(options.templateTable + '.transferable IS DISTINCT FROM FALSE');
        } else {
            query.addCondition(options.templateTable + '.transferable = FALSE');
        }
    }

    if (options.templateTable && typeof args.is_burnable === 'boolean') {
        if (args.is_burnable) {
            query.addCondition(options.templateTable + '.burnable IS DISTINCT FROM FALSE');
        } else {
            query.addCondition(options.templateTable + '.burnable = FALSE');
        }
    }
}

export async function buildGreylistFilter(values: FilterValues, query: QueryBuilder, columns: { collectionName?: string, account?: string[] }): Promise<void> {
    const args = await filterQueryArgs(values, {
        collection_blacklist: {type: 'list[name]'},
        collection_whitelist: {type: 'list[name]'},
        account_blacklist: {type: 'list[name]'},
    });

    const collectionBlacklist: string[] = args.collection_blacklist;
    const collectionWhitelist: string[] = args.collection_whitelist;

    if (columns.collectionName) {
        if (collectionWhitelist.length > 0 && collectionBlacklist.length > 0) {
            query.equalMany(columns.collectionName, collectionWhitelist.filter(row => !collectionBlacklist.includes(row)));
        } else {
            if (collectionWhitelist.length > 0) {
                query.equalMany(columns.collectionName, collectionWhitelist);
            }

            if (collectionBlacklist.length > 0) {
                query.notMany(columns.collectionName, collectionBlacklist);
            }
        }
    }

    if (columns.account?.length && args.account_blacklist.length) {
        query.addCondition(
            'AND NOT EXISTS (SELECT * FROM UNNEST(' + query.addVariable(args.account_blacklist) + '::text[]) ' +
            'WHERE ' + columns.account.map(column => ('"unnest" = ' + column)).join(' OR ') + ') '
        );
    }
}

export async function buildHideOffersFilter(values: FilterValues, query: QueryBuilder, assetTable: string): Promise<void> {
    const args = await filterQueryArgs(values, {
        hide_offers: {type: 'bool', default: false}
    });

    if (args.hide_offers) {
        query.addCondition(
            'NOT EXISTS (' +
            'SELECT * FROM atomicassets_offers offer, atomicassets_offers_assets offer_asset ' +
            'WHERE offer_asset.contract = ' + assetTable + '.contract AND offer_asset.asset_id = ' + assetTable + '.asset_id AND ' +
            'offer.contract = offer_asset.contract AND offer.offer_id = offer_asset.offer_id AND ' +
            'offer.state = ' + OfferState.PENDING + ' ' +
            ')'
        );
    }
}

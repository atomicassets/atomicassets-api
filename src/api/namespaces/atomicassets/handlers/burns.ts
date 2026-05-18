import { buildBoundaryFilter, RequestValues } from '../../utils';
import { AtomicAssetsContext } from '../index';
import QueryBuilder from '../../../builder';
import { buildAssetFilter, buildGreylistFilter, buildHideOffersFilter } from '../utils';
import { formatCollection } from '../format';
import { filterQueryArgs } from '../../validation';

/**
 * Detects whether any of the user-supplied params on /v1/burns reference
 * atomicassets_templates columns (data/template_data jsonb filters, the
 * `match`/`search` name filters, etc). When false, the handler can skip
 * the LEFT JOIN to atomicassets_templates entirely, which is the unblocker
 * for the planner to use the `atomicassets_assets_contract_burned_partial`
 * index added in migration 1.6.1.
 *
 * Without this gate, the LEFT JOIN forces a Parallel Seq Scan on the
 * ~80 GB atomicassets_assets table even when no template-side condition
 * is requested (the planner won't prove the join is no-op'able with a
 * partial-index alternative).
 */
function burnsQueryNeedsTemplateJoin(params: RequestValues): boolean {
    for (const key of Object.keys(params)) {
        if (
            key === 'match' ||
            key === 'search' ||
            key.startsWith('data:text.') ||
            key.startsWith('data:number.') ||
            key.startsWith('data:bool.') ||
            key.startsWith('data.') ||
            key.startsWith('template_data.')
        ) {
            return true;
        }
    }
    return false;
}

export async function getBurnsAction(params: RequestValues, ctx: AtomicAssetsContext): Promise<any> {
    const maxLimit = ctx.coreArgs.limits?.burns || 5000;
    const args = await filterQueryArgs(params, {
        page: {type: 'int', min: 1, default: 1},
        limit: {type: 'int', min: 1, max: maxLimit, default: Math.min(maxLimit, 100)},

        match_owner: {type: 'name'},
    });

    const needsTemplateJoin = burnsQueryNeedsTemplateJoin(params);

    const query = new QueryBuilder(
        needsTemplateJoin
            ? 'SELECT burned_by_account account, COUNT(*) as assets FROM atomicassets_assets asset ' +
              'LEFT JOIN atomicassets_templates template ON (asset.contract = template.contract AND asset.template_id = template.template_id)'
            : 'SELECT burned_by_account account, COUNT(*) as assets FROM atomicassets_assets asset'
    );

    query.equal('asset.contract', ctx.coreArgs.atomicassets_account).notNull('asset.burned_by_account');

    if (args.match_owner) {
        query.addCondition('POSITION(' + query.addVariable(args.match_owner.toLowerCase()) + ' IN asset.burned_by_account) > 0');
    }

    await buildAssetFilter(params, query, {
        assetTable: 'asset',
        templateTable: needsTemplateJoin ? 'template' : undefined,
        allowDataFilter: true,
    });
    await buildGreylistFilter(params, query, {collectionName: 'asset.collection_name'});

    await buildHideOffersFilter(params, query, 'asset');
    await buildBoundaryFilter(params, query, 'burned_by_account', 'string', null);

    query.group(['asset.burned_by_account']);

    query.append('ORDER BY assets DESC, account ASC');
    query.paginate(args.page, args.limit);

    const result = await ctx.db.query(query.buildString(), query.buildValues());

    return result.rows;
}

export async function getBurnsAccountAction(params: RequestValues, ctx: AtomicAssetsContext): Promise<any> {
    // collection query
    const collectionQuery = new QueryBuilder(
        'SELECT collection_name, COUNT(*) as assets ' +
        'FROM atomicassets_assets asset'
    );
    collectionQuery.equal('contract', ctx.coreArgs.atomicassets_account);
    collectionQuery.equal('burned_by_account', ctx.pathParams.account);

    await buildGreylistFilter(params, collectionQuery, {collectionName: 'asset.collection_name'});
    await buildHideOffersFilter(params, collectionQuery, 'asset');

    collectionQuery.group(['contract', 'collection_name']);
    collectionQuery.append('ORDER BY assets DESC');

    const collectionResult = await ctx.db.query(collectionQuery.buildString(), collectionQuery.buildValues());

    // template query
    const templateQuery = new QueryBuilder(
        'SELECT collection_name, template_id, COUNT(*) as assets ' +
        'FROM atomicassets_assets asset'
    );
    templateQuery.equal('contract', ctx.coreArgs.atomicassets_account);
    templateQuery.equal('burned_by_account', ctx.pathParams.account);

    await buildGreylistFilter(params, templateQuery, {collectionName: 'asset.collection_name'});
    await buildHideOffersFilter(params, templateQuery, 'asset');

    templateQuery.group(['contract', 'collection_name', 'template_id']);
    templateQuery.append('ORDER BY assets DESC');

    const templateResult = await ctx.db.query(templateQuery.buildString(), templateQuery.buildValues());

    const collections = await ctx.db.query(
        'SELECT * FROM atomicassets_collections_master WHERE contract = $1 AND collection_name = ANY ($2)',
        [ctx.coreArgs.atomicassets_account, collectionResult.rows.map(row => row.collection_name)]
    );

    const lookupCollections = collections.rows.reduce(
        (prev, current) => Object.assign(prev, {[current.collection_name]: formatCollection(current)}), {}
    );

    return {
        collections: collectionResult.rows.map(row => ({
            collection: lookupCollections[row.collection_name],
            assets: row.assets
        })),
        templates: templateResult.rows,
        assets: collectionResult.rows.reduce((prev, current) => prev + parseInt(current.assets, 10), 0)
    };
}

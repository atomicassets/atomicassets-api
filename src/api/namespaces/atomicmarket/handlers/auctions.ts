import {buildBoundaryFilter, RequestValues} from '../../utils';
import {AtomicMarketContext} from '../index';
import QueryBuilder from '../../../builder';
import {buildAuctionFilter} from '../utils';
import {buildGreylistFilter} from '../../atomicassets/utils';
import {fillAuctions} from '../filler';
import {formatAuction} from '../format';
import { marketDissolvesBundles } from '../market-version';
import {ApiError} from '../../../error';
import {applyActionGreylistFilters, getContractActionLogs} from '../../../utils';
import {filterQueryArgs} from '../../validation';

export async function getAuctionsAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    const maxLimit = ctx.coreArgs.limits?.auctions || 100;
    const args = await filterQueryArgs(params, {
        page: {type: 'int', min: 1, default: 1},
        limit: {type: 'int', min: 1, max: maxLimit, default: Math.min(maxLimit, 100)},
        sort: {
            type: 'string',
            allowedValues: [
                'created', 'updated', 'ending', 'auction_id', 'price',
                'template_mint', 'name',
            ],
            default: 'created'
        },
        order: {type: 'string', allowedValues: ['asc', 'desc'], default: 'desc'},

        count: {type: 'bool'}
    });

    const query = new QueryBuilder(`
        SELECT listing.auction_id
        FROM atomicmarket_auctions listing
            JOIN atomicmarket_tokens "token" ON (listing.market_contract = "token".market_contract AND listing.token_symbol = "token".token_symbol)
    `);

    if (args.sort === 'name') {
        query.appendToBase(`
            LEFT OUTER JOIN atomicmarket_auctions_assets auction_asset ON auction_asset.auction_id = listing.auction_id AND auction_asset.market_contract = listing.market_contract AND auction_asset.index = 1
            LEFT OUTER JOIN atomicassets_assets asset ON asset.asset_id = auction_asset.asset_id AND asset.contract = auction_asset.assets_contract
            LEFT OUTER JOIN atomicassets_templates template ON template.contract = asset.contract AND template.template_id = asset.template_id
        `);
    }

    query.equal('listing.market_contract', ctx.coreArgs.atomicmarket_account);
    // filter out auctions where an asset is missing
    query.addCondition(
        'NOT EXISTS (' +
        'SELECT * FROM atomicmarket_auctions_assets auction_asset ' +
        'WHERE auction_asset.market_contract = listing.market_contract AND auction_asset.auction_id = listing.auction_id AND ' +
        'NOT EXISTS (SELECT * FROM atomicassets_assets asset WHERE asset.contract = auction_asset.assets_contract AND asset.asset_id = auction_asset.asset_id)' +
        ')'
    );

    const dissolvesBundles = await marketDissolvesBundles(ctx.db, ctx.coreArgs.atomicmarket_account);

    await buildAuctionFilter(params, query, dissolvesBundles);
    await buildGreylistFilter(params, query, {collectionName: 'listing.collection_name'});
    await buildBoundaryFilter(
        params, query, 'listing.auction_id', 'int',
        args.sort === 'updated' ? 'listing.updated_at_time' : 'listing.created_at_time'
    );

    if (args.count) {
        const countQuery = await ctx.db.query(
            'SELECT COUNT(*) counter FROM (' + query.buildString() + ') x',
            query.buildValues()
        );

        return countQuery.rows[0].counter;
    }

    const sortMapping: { [key: string]: { column: string, nullable: boolean } } = {
        auction_id: {column: 'listing.auction_id', nullable: false},
        ending: {column: 'listing.end_time', nullable: false},
        created: {column: 'listing.created_at_time', nullable: false},
        updated: {column: 'listing.updated_at_time', nullable: false},
        price: {column: 'listing.price', nullable: true},
        template_mint: {column: 'LOWER(listing.template_mint)', nullable: true},
        name: {column: '(COALESCE(template.mutable_data, \'{}\') || COALESCE(asset.mutable_data, \'{}\') || COALESCE(asset.immutable_data, \'{}\') || COALESCE(template.immutable_data, \'{}\'))->>\'name\'', nullable: true},
    };

    query.append('ORDER BY ' + sortMapping[args.sort].column + ' ' + args.order + ' ' + (sortMapping[args.sort].nullable ? 'NULLS LAST' : '') + ', listing.auction_id ASC');
    query.paginate(args.page, args.limit);

    const auctionResult = await ctx.db.query(query.buildString(), query.buildValues());

    const auctionLookup: { [key: string]: any } = {};
    const result = await ctx.db.query(
        'SELECT * FROM atomicmarket_auctions_master WHERE market_contract = $1 AND auction_id = ANY ($2)',
        [ctx.coreArgs.atomicmarket_account, auctionResult.rows.map(row => row.auction_id)]
    );

    result.rows.reduce((prev, current) => {
        prev[String(current.auction_id)] = current;

        return prev;
    }, auctionLookup);

    return await fillAuctions(
        ctx.db, ctx.coreArgs.atomicassets_account,
        auctionResult.rows.map((row) => formatAuction(auctionLookup[String(row.auction_id)], dissolvesBundles))
    );
}

export async function getAuctionsCountAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    return getAuctionsAction({...params, count: 'true'}, ctx);
}

export async function getAuctionAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    const args = await filterQueryArgs(ctx.pathParams, {
        auction_id: {type: 'id'},
    });

    const query = await ctx.db.query(
        'SELECT * FROM atomicmarket_auctions_master WHERE market_contract = $1 AND auction_id = $2',
        [ctx.coreArgs.atomicmarket_account, args.auction_id]
    );

    if (query.rowCount === 0) {
        throw new ApiError('Auction not found', 416);
    }
    const dissolvesBundles = await marketDissolvesBundles(ctx.db, ctx.coreArgs.atomicmarket_account);
    const auctions = await fillAuctions(
        ctx.db, ctx.coreArgs.atomicassets_account,
        query.rows.map(row => formatAuction(row, dissolvesBundles))
    );

    return auctions[0];
}

export async function getAuctionLogsAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    const maxLimit = ctx.coreArgs.limits?.logs || 100;
    const args = await filterQueryArgs({...ctx.pathParams, ...params}, {
        auction_id: {type: 'id'},
        page: {type: 'int', min: 1, default: 1},
        limit: {type: 'int', min: 1, max: maxLimit, default: Math.min(maxLimit, 100)},
        order: {type: 'string', allowedValues: ['asc', 'desc'], default: 'asc'},
        action_whitelist: {type: 'string[]', min: 1},
        action_blacklist: {type: 'string[]', min: 1},
    });

    return await getContractActionLogs(
        ctx.db, ctx.coreArgs.atomicmarket_account,
        applyActionGreylistFilters(
            ['lognewauct', 'logauctstart', 'cancelauct', 'auctclaimbuy', 'auctclaimsel', 'logroyfound', 'logroytempl', 'logroyattr', 'logroydust'],
            args
        ),
        {auction_id: args.auction_id},
        (args.page - 1) * args.limit, args.limit, args.order
    );
}

import { buildBoundaryFilter, RequestValues } from '../../utils';
import { AtomicAssetsContext } from '../index';
import QueryBuilder from '../../../builder';
import { buildAssetFilter, hasAssetFilter } from '../utils';
import { FilteredValues, filterQueryArgs } from '../../validation';
import { ApiError } from '../../../error';

export async function getRawMovesAction(params: RequestValues, ctx: AtomicAssetsContext): Promise<any> {
    const maxLimit = ctx.coreArgs.limits?.moves || 100;
    const args = await filterQueryArgs(params, {
        page: {type: 'int', min: 1, default: 1},
        limit: {type: 'int', min: 1, max: maxLimit, default: Math.min(maxLimit, 100)},
        sort: {type: 'string', allowedValues: ['created'], default: 'created'},
        order: {type: 'string', allowedValues: ['asc', 'desc'], default: 'desc'},

        asset_id: {type: 'list[id]'},

        collection_blacklist: {type: 'list[name]'},
        collection_whitelist: {type: 'list[name]'},

        account: {type: 'list[name]'},
        sender: {type: 'list[name]'},
        recipient: {type: 'list[name]'},
        memo: {type: 'string', min: 1},
        match_memo: {type: 'string', min: 1},

        hide_contracts: {type: 'bool'},

        count: {type: 'bool'}
    });

    if (args.account.length && (args.sender.length || args.recipient.length)) {
        throw new ApiError('Can not use account and sender or recipient filters at the same time', 400);
    }

    const unionArgsList = getUnionArgsList(args);
    const query = unionArgsList.length
        ? await buildUnionQuery(unionArgsList, args, params, ctx)
        : await buildMoveQuery(args, params, ctx);

    if (args.count) {
        const countQuery = await ctx.db.query(
            'SELECT COUNT(*) counter FROM (' + query.buildString() + ') x',
            query.buildValues()
        );

        return countQuery.rows[0].counter;
    }

    const sortColumnMapping: { [key: string]: string } = {
        created: 'move_id'
    };

    query.append('ORDER BY ' + sortColumnMapping[args.sort] + ' ' + args.order);
    query.paginate(args.page, args.limit);

    return await ctx.db.query(query.buildString(), query.buildValues());
}

async function buildUnionQuery(unionArgsList: any[], args: Record<string, any>, params: RequestValues, ctx: AtomicAssetsContext): Promise<QueryBuilder> {
    const query = new QueryBuilder('');

    const unions = [];
    for (const unionArgs of unionArgsList) {
        const union = await buildMoveQuery(unionArgs, params, ctx, query.buildValues());
        union.append('ORDER BY move_id ' + args.order);
        union.append(`LIMIT ${union.addVariable(args.page * args.limit)}`);

        unions.push(`(\n${union.buildString()}\n)`);
        query.setVars(union.buildValues());
    }

    return new QueryBuilder(unions.join(' UNION '), query.buildValues());
}

function getUnionArgsList<T extends FilteredValues<T>>(args: Record<string, any>): T[] {
    if (args.count || (args.sort !== 'created') || ((args.sender.length > 0) && (args.recipient.length > 0))) {
        return []; // unable to use unions
    }

    if (args.sender.length > 1) {
        return args.sender.map((sender: string) => ({...args, sender: [sender]}));
    }

    if (args.recipient.length > 1) {
        return args.recipient.map((recipient: string) => ({...args, recipient: [recipient]}));
    }

    const result = [];
    for (const account of args.account) {
        result.push({...args, account: [], sender: [account]} as any as T);
        result.push({...args, account: [], recipient: [account]} as any as T);
    }
    return result;
}

async function buildMoveQuery(args: Record<string, any>, params: RequestValues, ctx: AtomicAssetsContext, queryValues: any[] = []): Promise<QueryBuilder> {
    const query = new QueryBuilder('SELECT DISTINCT move.* FROM atomicassets_moves_master move', queryValues);
    query.equal('contract', ctx.coreArgs.atomicassets_account);

    if (args.account.length) {
        const varName = query.addVariable(args.account);
        query.addCondition(`(sender_name = ANY (${varName}) OR recipient_name = ANY (${varName}))`);
    }

    if (args.sender.length) {
        query.equalMany('sender_name', args.sender);
    }

    if (args.recipient.length) {
        query.equalMany('recipient_name', args.recipient);
    }

    if (args.memo) {
        query.equal('memo', args.memo);
    }

    if (args.match_memo) {
        query.addCondition(
            'memo ILIKE ' + query.addVariable('%' + query.escapeLikeVariable(args.match_memo) + '%')
        );
    }

    if (hasAssetFilter(params, ['asset_id'])) {
        const assetQuery = new QueryBuilder('SELECT move_asset.move_id move_join_id FROM atomicassets_moves_assets move_asset, atomicassets_assets asset', query.buildValues());

        assetQuery.equal('asset.contract', ctx.coreArgs.atomicassets_account);

        assetQuery.join('asset', 'move_asset', ['contract', 'asset_id']);

        await buildAssetFilter(params, assetQuery, {assetTable: '"asset"', allowDataFilter: false});

        query.appendToBase(` JOIN (${assetQuery.buildString()}) assets ON move.move_id = assets.move_join_id`);

        query.setVars(assetQuery.buildValues());
    }

    if (args.asset_id.length) {
        query.addCondition(
            'EXISTS(' +
            'SELECT * FROM atomicassets_moves_assets asset ' +
            'WHERE move.contract = asset.contract AND move.move_id = asset.move_id AND ' +
            'asset_id = ANY (' + query.addVariable(args.asset_id) + ')' +
            ') '
        );
    }

    /*
        the collection_whitelist and collection_blacklist filters have + 0 on the move.move_id
        to prevent postgres from rewriting the query in very inefficient way.
        we want the outer query to lead using the recipient or sender index, and only validate those results
        against the lists
    */

    if (args.collection_blacklist.length) {
        query.addCondition(
            'NOT EXISTS(' +
            'SELECT * FROM atomicassets_moves_assets move_asset, atomicassets_assets asset ' +
            'WHERE move_asset.contract = move.contract AND move_asset.move_id = move.move_id + 0 AND ' +
            'move_asset.contract = asset.contract AND move_asset.asset_id = asset.asset_id AND ' +
            'asset.collection_name = ANY (' + query.addVariable(args.collection_blacklist) + ')' +
            ') '
        );
    }

    if (args.collection_whitelist.length) {
        query.addCondition(
            'NOT EXISTS(' +
            'SELECT * FROM atomicassets_moves_assets move_asset, atomicassets_assets asset ' +
            'WHERE move_asset.contract = move.contract AND move_asset.move_id = move.move_id + 0 AND ' +
            'move_asset.contract = asset.contract AND move_asset.asset_id = asset.asset_id AND ' +
            'NOT (asset.collection_name = ANY (' + query.addVariable(args.collection_whitelist) + '))' +
            ')'
        );
    }

    if (args.hide_contracts) {
        query.addCondition(
            'NOT EXISTS(SELECT * FROM contract_codes ' +
            'WHERE (account = move.recipient_name OR account = move.sender_name) AND NOT (account = ANY(' +
            query.addVariable([...args.account, ...args.sender, ...args.recipient]) +
            ')))'
        );
    }

    await buildBoundaryFilter(params, query, 'move_id', 'int', 'created_at_time');

    return query;
}


export async function getMovesCountAction(params: RequestValues, ctx: AtomicAssetsContext): Promise<any> {
    return getRawMovesAction({...params, count: 'true'}, ctx);
}

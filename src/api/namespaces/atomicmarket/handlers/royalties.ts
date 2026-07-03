import { buildBoundaryFilter, RequestValues } from '../../utils';
import { AtomicMarketContext } from '../index';
import QueryBuilder from '../../../builder';
import { ApiError } from '../../../error';
import { filterQueryArgs } from '../../validation';

// AtomicMarket v2 royalty read layer. royaltyconf/royaltytemp/royaltyattr are
// mirrored raw (row-for-row, see design.md) - these handlers do not
// reimplement attribute matching, they only expose the mirrored rows and the
// settled payout ledger fed by the logroy* actions.

const LISTING_TYPE_BY_NAME: { [key: string]: number } = {
    unresolved: 0,
    sale: 1,
    auction: 2,
    buyoffer: 3,
    template_buyoffer: 4,
};

const LISTING_TYPE_BY_ID: { [key: number]: string } = Object.fromEntries(
    Object.entries(LISTING_TYPE_BY_NAME).map(([name, id]) => [id, name])
);

const PAYOUT_CATEGORY_BY_NAME: { [key: string]: number } = {
    founders: 1,
    template: 2,
    attribute: 3,
    dust: 4,
};

const PAYOUT_CATEGORY_BY_ID: { [key: number]: string } = Object.fromEntries(
    Object.entries(PAYOUT_CATEGORY_BY_NAME).map(([name, id]) => [id, name])
);

function formatPayout(row: any): any {
    return {
        market_contract: row.market_contract,
        log_global_sequence: row.log_global_sequence,
        payout_index: row.payout_index,
        listing_type: LISTING_TYPE_BY_ID[row.listing_type] ?? null,
        listing_id: row.listing_id,
        category: PAYOUT_CATEGORY_BY_ID[row.category] ?? null,
        collection_name: row.collection_name,
        asset_id: row.asset_id,
        template_id: row.template_id,
        rule_id: row.rule_id,
        recipient: row.recipient,
        amount: row.amount,
        token_symbol: row.token_symbol,
        token_precision: row.token_precision,
        token_contract: row.token_contract,
        txid: row.txid,
        created_at_block: row.created_at_block,
        created_at_time: row.created_at_time,
    };
}

export async function getRoyaltyConfigAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    const query = await ctx.db.query(
        'SELECT * FROM atomicmarket_royalties_config WHERE market_contract = $1 AND collection_name = $2',
        [ctx.coreArgs.atomicmarket_account, ctx.pathParams.collection_name]
    );

    if (query.rowCount === 0) {
        throw new ApiError('Royalty config not found', 416);
    }

    return query.rows[0];
}

export async function getRoyaltyTemplateRulesAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    const maxLimit = ctx.coreArgs.limits?.royalties || 100;
    const args = await filterQueryArgs(params, {
        template_id: { type: 'list[id]' },

        page: { type: 'int', min: 1, default: 1 },
        limit: { type: 'int', min: 1, max: maxLimit, default: Math.min(maxLimit, 100) },
    });

    const query = new QueryBuilder('SELECT * FROM atomicmarket_royalties_templates');

    query.equal('market_contract', ctx.coreArgs.atomicmarket_account);
    query.equal('collection_name', ctx.pathParams.collection_name);

    if (args.template_id.length) {
        query.equalMany('template_id', args.template_id);
    }

    query.append('ORDER BY template_id ASC');
    query.paginate(args.page, args.limit);

    const result = await ctx.db.query(query.buildString(), query.buildValues());

    return result.rows;
}

export async function getRoyaltyAttributeRulesAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    const maxLimit = ctx.coreArgs.limits?.royalties || 100;
    const args = await filterQueryArgs(params, {
        source: { type: 'int', min: 0 },
        field: { type: 'string', min: 1 },

        page: { type: 'int', min: 1, default: 1 },
        limit: { type: 'int', min: 1, max: maxLimit, default: Math.min(maxLimit, 100) },
    });

    const query = new QueryBuilder(`
        SELECT market_contract, collection_name, rule_id, source, field, value, weight, recipients,
            encode(lookup_hash::bytea, 'hex') lookup_hash,
            updated_at_block, updated_at_time, created_at_block, created_at_time
        FROM atomicmarket_royalties_attributes
    `);

    query.equal('market_contract', ctx.coreArgs.atomicmarket_account);
    query.equal('collection_name', ctx.pathParams.collection_name);

    if (typeof args.source === 'number') {
        query.equal('source', args.source);
    }

    if (args.field) {
        query.equal('field', args.field);
    }

    query.append('ORDER BY rule_id ASC');
    query.paginate(args.page, args.limit);

    const result = await ctx.db.query(query.buildString(), query.buildValues());

    return result.rows;
}

export async function getRoyaltyPayoutsAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    const maxLimit = ctx.coreArgs.limits?.royalties || 100;
    const args = await filterQueryArgs(params, {
        recipient: { type: 'list[name]' },
        collection_name: { type: 'list[name]' },
        asset_id: { type: 'list[id]' },
        symbol: { type: 'string', min: 1 },

        listing_type: { type: 'string', allowedValues: Object.keys(LISTING_TYPE_BY_NAME) },
        listing_id: { type: 'id' },
        category: { type: 'list[string]', allowedValues: Object.keys(PAYOUT_CATEGORY_BY_NAME) },

        page: { type: 'int', min: 1, default: 1 },
        limit: { type: 'int', min: 1, max: maxLimit, default: Math.min(maxLimit, 100) },
        sort: { type: 'string', allowedValues: ['created', 'amount'], default: 'created' },
        order: { type: 'string', allowedValues: ['asc', 'desc'], default: 'desc' },

        count: { type: 'bool' },
    });

    const query = new QueryBuilder(`
        SELECT
            payout.market_contract, payout.log_global_sequence, payout.payout_index,
            payout.listing_type, payout.listing_id,
            payout.category, payout.collection_name,
            payout.asset_id, payout.template_id, payout.rule_id,
            payout.recipient, payout.amount,
            payout.token_symbol, token.token_precision, token.token_contract,
            encode(payout.txid::bytea, 'hex') txid,
            payout.created_at_block, payout.created_at_time
        FROM atomicmarket_royalty_payouts payout
            JOIN atomicmarket_tokens token ON (token.market_contract = payout.market_contract AND token.token_symbol = payout.token_symbol)
    `);

    query.equal('payout.market_contract', ctx.coreArgs.atomicmarket_account);

    if (args.recipient.length) {
        query.equalMany('payout.recipient', args.recipient);
    }

    if (args.collection_name.length) {
        query.equalMany('payout.collection_name', args.collection_name);
    }

    if (args.asset_id.length) {
        query.equalMany('payout.asset_id', args.asset_id);
    }

    if (args.symbol) {
        query.equalMany('payout.token_symbol', args.symbol.split(','));
    }

    if (args.listing_type) {
        query.equal('payout.listing_type', LISTING_TYPE_BY_NAME[args.listing_type]);
    }

    if (args.listing_id) {
        query.equal('payout.listing_id', args.listing_id);
    }

    if (args.category.length) {
        query.equalMany('payout.category', args.category.map((category: string) => PAYOUT_CATEGORY_BY_NAME[category]));
    }

    await buildBoundaryFilter(params, query, 'payout.log_global_sequence', 'int', 'payout.created_at_time');

    if (args.count) {
        const countQuery = await ctx.db.query(
            'SELECT COUNT(*) counter FROM (' + query.buildString() + ') x',
            query.buildValues()
        );

        return countQuery.rows[0].counter;
    }

    const sortColumnMapping: { [key: string]: string } = {
        created: 'payout.created_at_time',
        amount: 'payout.amount',
    };

    query.append(
        'ORDER BY ' + sortColumnMapping[args.sort] + ' ' + args.order + ', ' +
        'payout.log_global_sequence ' + args.order + ', payout.payout_index ' + args.order
    );
    query.paginate(args.page, args.limit);

    const result = await ctx.db.query(query.buildString(), query.buildValues());

    return result.rows.map(formatPayout);
}

export async function getRoyaltyPayoutsCountAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    return getRoyaltyPayoutsAction({ ...params, count: 'true' }, ctx);
}

export async function getRoyaltyAccountAction(params: RequestValues, ctx: AtomicMarketContext): Promise<any> {
    const args = await filterQueryArgs(params, {
        collection_name: { type: 'list[name]' },
        symbol: { type: 'string', min: 1 },
        before: { type: 'int', min: 1 },
        after: { type: 'int', min: 1 },
    });

    const query = new QueryBuilder(`
        SELECT payout.token_symbol, token.token_precision, token.token_contract,
            SUM(payout.amount) amount, COUNT(*) payout_count
        FROM atomicmarket_royalty_payouts payout
            JOIN atomicmarket_tokens token ON (token.market_contract = payout.market_contract AND token.token_symbol = payout.token_symbol)
    `);

    query.equal('payout.market_contract', ctx.coreArgs.atomicmarket_account);
    query.equal('payout.recipient', ctx.pathParams.account);

    if (args.collection_name.length) {
        query.equalMany('payout.collection_name', args.collection_name);
    }

    if (args.symbol) {
        query.equalMany('payout.token_symbol', args.symbol.split(','));
    }

    // Only before/after apply to an aggregate - parse them directly instead of
    // going through buildBoundaryFilter, which would accept (and silently
    // ignore) lower_bound/upper_bound/ids without a primary column.
    if (args.before) {
        query.addCondition('payout.created_at_time < ' + query.addVariable(args.before) + '::BIGINT');
    }

    if (args.after) {
        query.addCondition('payout.created_at_time > ' + query.addVariable(args.after) + '::BIGINT');
    }

    query.group(['payout.token_symbol', 'token.token_precision', 'token.token_contract']);
    query.append('ORDER BY payout.token_symbol ASC');

    const result = await ctx.db.query(query.buildString(), query.buildValues());

    return result.rows.map(row => ({
        token_symbol: row.token_symbol,
        token_precision: row.token_precision,
        token_contract: row.token_contract,
        amount: row.amount,
        payout_count: row.payout_count,
    }));
}

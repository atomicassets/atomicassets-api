import express from 'express';

import { AtomicMarketNamespace } from '../index';
import { HTTPServer } from '../../../server';
import { getOpenAPI3Responses, getPrimaryBoundaryParams, paginationParameters } from '../../../docs';
import {
    getRoyaltyAccountAction,
    getRoyaltyAttributeRulesAction,
    getRoyaltyConfigAction,
    getRoyaltyPayoutsAction,
    getRoyaltyPayoutsCountAction,
    getRoyaltyTemplateRulesAction,
} from '../handlers/royalties';

export function royaltiesEndpoints(core: AtomicMarketNamespace, server: HTTPServer, router: express.Router): any {
    const {caching, returnAsJSON} = server.web;

    // Fixed segments first - ':collection_name' below is a single path
    // segment wildcard and would otherwise swallow '/payouts' and '/accounts'.
    router.all('/v1/royalties/payouts', caching(), returnAsJSON(getRoyaltyPayoutsAction, core));
    router.all('/v1/royalties/payouts/_count', caching(), returnAsJSON(getRoyaltyPayoutsCountAction, core));
    router.all('/v1/royalties/accounts/:account', caching(), returnAsJSON(getRoyaltyAccountAction, core));

    router.all('/v1/royalties/:collection_name', caching(), returnAsJSON(getRoyaltyConfigAction, core));
    router.all('/v1/royalties/:collection_name/templates', caching(), returnAsJSON(getRoyaltyTemplateRulesAction, core));
    router.all('/v1/royalties/:collection_name/attributes', caching(), returnAsJSON(getRoyaltyAttributeRulesAction, core));

    return {
        tag: {
            name: 'royalties',
            description: 'Royalties'
        },
        paths: {
            '/v1/royalties/{collection_name}': {
                get: {
                    tags: ['royalties'],
                    summary: 'Get the raw royalty config mirror for a collection',
                    parameters: [
                        {
                            in: 'path',
                            name: 'collection_name',
                            description: 'Collection name',
                            required: true,
                            schema: {type: 'string'}
                        }
                    ],
                    responses: getOpenAPI3Responses([200, 416, 500], {'$ref': '#/components/schemas/RoyaltyConfig'})
                }
            },
            '/v1/royalties/{collection_name}/templates': {
                get: {
                    tags: ['royalties'],
                    summary: 'Get the per-template royalty overrides for a collection',
                    parameters: [
                        {
                            in: 'path',
                            name: 'collection_name',
                            description: 'Collection name',
                            required: true,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'template_id',
                            in: 'query',
                            description: 'Filter by template id(s) - separate multiple with ","',
                            required: false,
                            schema: {type: 'string'}
                        },
                        ...paginationParameters
                    ],
                    responses: getOpenAPI3Responses([200, 500], {
                        type: 'array',
                        items: {'$ref': '#/components/schemas/RoyaltyTemplateRule'}
                    })
                }
            },
            '/v1/royalties/{collection_name}/attributes': {
                get: {
                    tags: ['royalties'],
                    summary: 'Get the attribute-matched royalty rules for a collection',
                    parameters: [
                        {
                            in: 'path',
                            name: 'collection_name',
                            description: 'Collection name',
                            required: true,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'source',
                            in: 'query',
                            description: 'Filter by attribute source',
                            required: false,
                            schema: {type: 'integer'}
                        },
                        {
                            name: 'field',
                            in: 'query',
                            description: 'Filter by attribute field name',
                            required: false,
                            schema: {type: 'string'}
                        },
                        ...paginationParameters
                    ],
                    responses: getOpenAPI3Responses([200, 500], {
                        type: 'array',
                        items: {'$ref': '#/components/schemas/RoyaltyAttributeRule'}
                    })
                }
            },
            '/v1/royalties/payouts': {
                get: {
                    tags: ['royalties'],
                    summary: 'Get settled royalty payouts',
                    parameters: [
                        {
                            name: 'recipient',
                            in: 'query',
                            description: 'Filter by recipient account(s) - separate multiple with ","',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'collection_name',
                            in: 'query',
                            description: 'Filter by collection(s) - separate multiple with ","',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'listing_type',
                            in: 'query',
                            description: 'Filter by the resolved listing type',
                            required: false,
                            schema: {type: 'string', enum: ['unresolved', 'sale', 'auction', 'buyoffer', 'template_buyoffer']}
                        },
                        {
                            name: 'listing_id',
                            in: 'query',
                            description: 'Filter by the resolved listing id (use together with listing_type)',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'category',
                            in: 'query',
                            description: 'Filter by payout category - separate multiple with ","',
                            required: false,
                            schema: {type: 'string', enum: ['founders', 'template', 'attribute', 'dust']}
                        },
                        {
                            name: 'asset_id',
                            in: 'query',
                            description: 'Filter by asset id(s) - separate multiple with ","',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'symbol',
                            in: 'query',
                            description: 'Filter by token symbol(s) - separate multiple with ","',
                            required: false,
                            schema: {type: 'string'}
                        },
                        ...getPrimaryBoundaryParams('log_global_sequence'),
                        {
                            name: 'before',
                            in: 'query',
                            description: 'Only show results before this timestamp in milliseconds (value excluded)',
                            required: false,
                            schema: {type: 'integer'}
                        },
                        {
                            name: 'after',
                            in: 'query',
                            description: 'Only show results after this timestamp in milliseconds (value excluded)',
                            required: false,
                            schema: {type: 'integer'}
                        },
                        ...paginationParameters,
                        {
                            name: 'sort',
                            in: 'query',
                            description: 'Column to sort',
                            required: false,
                            schema: {type: 'string', enum: ['created', 'amount'], default: 'created'}
                        }
                    ],
                    responses: getOpenAPI3Responses([200, 500], {
                        type: 'array',
                        items: {'$ref': '#/components/schemas/RoyaltyPayout'}
                    })
                }
            },
            '/v1/royalties/accounts/{account}': {
                get: {
                    tags: ['royalties'],
                    summary: 'Get royalty earnings aggregated per token symbol for an account',
                    parameters: [
                        {
                            in: 'path',
                            name: 'account',
                            description: 'Recipient account',
                            required: true,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'collection_name',
                            in: 'query',
                            description: 'Filter by collection(s) - separate multiple with ","',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'symbol',
                            in: 'query',
                            description: 'Filter by token symbol(s) - separate multiple with ","',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'before',
                            in: 'query',
                            description: 'Only show results before this timestamp in milliseconds (value excluded)',
                            required: false,
                            schema: {type: 'integer'}
                        },
                        {
                            name: 'after',
                            in: 'query',
                            description: 'Only show results after this timestamp in milliseconds (value excluded)',
                            required: false,
                            schema: {type: 'integer'}
                        }
                    ],
                    responses: getOpenAPI3Responses([200, 500], {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                token_symbol: {type: 'string'},
                                token_precision: {type: 'integer'},
                                token_contract: {type: 'string'},
                                amount: {type: 'string'},
                                payout_count: {type: 'string'}
                            }
                        }
                    })
                }
            }
        }
    };
}

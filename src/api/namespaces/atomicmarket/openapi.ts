import { atomicassetsComponents, generateOfferSchema, generateTransferSchema } from '../atomicassets/openapi';

export const atomicmarketComponents = {
    ListingAsset: {
        type: 'object',
        properties: {
            ...atomicassetsComponents.Asset.properties,
            sales: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        market_contract: {type: 'string'},
                        sale_id: {type: 'string'}
                    }
                }
            },
            auctions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        market_contract: {type: 'string'},
                        auction_id: {type: 'string'}
                    }
                }
            },
            template_buyoffers: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        market_contract: {type: 'string'},
                        buyoffer_id: {type: 'string'},
                        token_symbol: {type: 'string'},
                    }
                }
            },
            prices: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        average: {type: 'string'},
                        market_contract: {type: 'string'},
                        max: {type: 'string'},
                        median: {type: 'string'},
                        min: {type: 'string'},
                        sales: {type: 'string'},
                        suggested_average: {type: 'string'},
                        suggested_median: {type: 'string'},
                        token: {
                            type: 'object',
                            properties: {
                                token_contract: {type: 'string'},
                                token_precision: {type: 'integer'},
                                token_symbol: {type: 'string'}
                            }
                        }
                    }
                }
            }
        }
    },
    ListingOffer: generateOfferSchema('ListingAsset'),
    ListingTransfer: generateTransferSchema('ListingAsset'),
    Sale: {
        type: 'object',
        properties: {
            market_contract: {type: 'string'},
            assets_contract: {type: 'string'},
            sale_id: {type: 'string'},

            seller: {type: 'string'},
            buyer: {type: 'string'},

            offer_id: {type: 'string'},

            price: {
                type: 'object',
                properties: {
                    amount: {type: 'string'},
                    token_precision: {type: 'integer'},
                    token_contract: {type: 'string'},
                    token_symbol: {type: 'string'}
                }
            },

            listing_price: {type: 'number'},
            listing_symbol: {type: 'string'},

            assets: {
                type: 'array',
                items: {'$ref': '#/components/schemas/Asset'}
            },

            maker_marketplace: {type: 'string', nullable: true},
            taker_marketplace: {type: 'string', nullable: true},

            collection: atomicassetsComponents.Asset.properties.collection,

            current_collection_fee: {
                type: 'number',
                description: 'The collection\'s market_fee as of the last indexed block. collection.market_fee is ' +
                    'the listing-time snapshot; AtomicMarket v2 reads the fee live at settlement, so this field can ' +
                    'differ from the snapshot for a listing that is still open.'
            },

            state: {type: 'integer'},

            updated_at_block: {type: 'string'},
            updated_at_time: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    },
    Auction: {
        type: 'object',
        properties: {
            market_contract: {type: 'string'},
            assets_contract: {type: 'string'},
            auction_id: {type: 'string'},

            seller: {type: 'string'},
            buyer: {type: 'string', nullable: true},

            price: {
                type: 'object',
                properties: {
                    amount: {type: 'string'},
                    token_precision: {type: 'integer'},
                    token_contract: {type: 'string'},
                    token_symbol: {type: 'string'}
                }
            },

            assets: {
                type: 'array',
                items: {'$ref': '#/components/schemas/Asset'}
            },

            bids: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        number: {type: 'integer'},
                        account: {type: 'string'},
                        amount: {type: 'string'},
                        created_at_block: {type: 'string'},
                        created_at_time: {type: 'string'},
                        txid: {type: 'string'}
                    }
                }
            },

            maker_marketplace: {type: 'string', nullable: true},
            taker_marketplace: {type: 'string', nullable: true},

            collection: atomicassetsComponents.Asset.properties.collection,

            current_collection_fee: {
                type: 'number',
                description: 'The collection\'s market_fee as of the last indexed block. collection.market_fee is ' +
                    'the listing-time snapshot; AtomicMarket v2 reads the fee live at settlement, so this field can ' +
                    'differ from the snapshot for a listing that is still open.'
            },

            state: {type: 'integer'},

            end_time: {type: 'string'},

            updated_at_block: {type: 'string'},
            updated_at_time: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    },
    Buyoffer: {
        type: 'object',
        properties: {
            market_contract: {type: 'string'},
            assets_contract: {type: 'string'},
            buyoffer_id: {type: 'string'},

            seller: {type: 'string'},
            buyer: {type: 'string'},

            price: {
                type: 'object',
                properties: {
                    amount: {type: 'string'},
                    token_precision: {type: 'integer'},
                    token_contract: {type: 'string'},
                    token_symbol: {type: 'string'}
                }
            },

            assets: {
                type: 'array',
                items: {'$ref': '#/components/schemas/Asset'}
            },

            maker_marketplace: {type: 'string', nullable: true},
            taker_marketplace: {type: 'string', nullable: true},

            collection: atomicassetsComponents.Asset.properties.collection,

            current_collection_fee: {
                type: 'number',
                description: 'The collection\'s market_fee as of the last indexed block. collection.market_fee is ' +
                    'the listing-time snapshot; AtomicMarket v2 reads the fee live at settlement, so this field can ' +
                    'differ from the snapshot for a listing that is still open.'
            },

            state: {type: 'integer'},

            memo: {type: 'string'},
            decline_memo: {type: 'string'},

            updated_at_block: {type: 'string'},
            updated_at_time: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    },
    TemplateBuyoffer: {
        type: 'object',
        properties: {
            market_contract: {type: 'string'},
            assets_contract: {type: 'string'},
            buyoffer_id: {type: 'string'},

            seller: {type: 'string'},
            buyer: {type: 'string'},

            price: {
                type: 'object',
                properties: {
                    amount: {type: 'string'},
                    token_precision: {type: 'integer'},
                    token_contract: {type: 'string'},
                    token_symbol: {type: 'string'}
                }
            },

            assets: {
                type: 'array',
                items: {'$ref': '#/components/schemas/Asset'}
            },

            maker_marketplace: {type: 'string', nullable: true},
            taker_marketplace: {type: 'string', nullable: true},

            collection: atomicassetsComponents.Asset.properties.collection,

            template: atomicassetsComponents.Asset.properties.template,

            current_collection_fee: {
                type: 'number',
                description: 'The collection\'s market_fee as of the last indexed block. collection.market_fee is ' +
                    'the listing-time snapshot; AtomicMarket v2 reads the fee live at settlement, so this field can ' +
                    'differ from the snapshot for a listing that is still open.'
            },

            state: {type: 'integer'},

            updated_at_block: {type: 'string'},
            updated_at_time: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    },
    Marketplace: {
        type: 'object',
        properties: {
            marketplace_name: {type: 'string'},
            creator: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    },
    RoyaltyConfig: {
        type: 'object',
        description: 'Raw row-for-row mirror of the on-chain royaltyconf table. No off-chain resolution is applied.',
        properties: {
            market_contract: {type: 'string'},
            collection_name: {type: 'string'},
            founders: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        recipient: {type: 'string'},
                        weight: {type: 'integer'}
                    }
                }
            },
            attribute_mode: {type: 'integer', description: '0 = merged, 1 = granular'},
            split_founders: {type: 'string'},
            split_templates: {type: 'string'},
            split_attributes: {type: 'string'},
            updated_at_block: {type: 'string'},
            updated_at_time: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    },
    RoyaltyTemplateRule: {
        type: 'object',
        description: 'Raw row-for-row mirror of the on-chain royaltytemp table.',
        properties: {
            market_contract: {type: 'string'},
            collection_name: {type: 'string'},
            template_id: {type: 'string'},
            recipients: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        recipient: {type: 'string'},
                        weight: {type: 'integer'}
                    }
                }
            },
            updated_at_block: {type: 'string'},
            updated_at_time: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    },
    RoyaltyAttributeRule: {
        type: 'object',
        description: 'Raw row-for-row mirror of the on-chain royaltyattr table.',
        properties: {
            market_contract: {type: 'string'},
            collection_name: {type: 'string'},
            rule_id: {type: 'string'},
            source: {type: 'integer'},
            field: {type: 'string'},
            value: {
                type: 'array',
                description: 'Raw deserialized ["type", value] variant tuple - integer payloads are preserved as strings.',
                items: {}
            },
            weight: {type: 'integer'},
            recipients: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        recipient: {type: 'string'},
                        weight: {type: 'integer'}
                    }
                }
            },
            lookup_hash: {type: 'string', description: 'Hex-encoded sha256 lookup hash'},
            updated_at_block: {type: 'string'},
            updated_at_time: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    },
    RoyaltyPayout: {
        type: 'object',
        description: 'One settled royalty payout entry, keyed by the log trace global_sequence and its position in the payouts vector.',
        properties: {
            market_contract: {type: 'string'},
            log_global_sequence: {type: 'string'},
            payout_index: {type: 'integer'},
            listing_type: {type: 'string', enum: ['unresolved', 'sale', 'auction', 'buyoffer', 'template_buyoffer']},
            listing_id: {type: 'string', nullable: true},
            category: {type: 'string', enum: ['founders', 'template', 'attribute', 'dust']},
            collection_name: {type: 'string'},
            asset_id: {type: 'string', nullable: true},
            template_id: {type: 'string', nullable: true},
            rule_id: {type: 'string', nullable: true},
            recipient: {type: 'string'},
            amount: {type: 'string'},
            token_symbol: {type: 'string'},
            token_precision: {type: 'integer'},
            token_contract: {type: 'string'},
            txid: {type: 'string'},
            created_at_block: {type: 'string'},
            created_at_time: {type: 'string'}
        }
    }
};

export const listingFilterParameters = [
    {
        name: 'max_assets',
        in: 'query',
        description: 'Max assets per listing',
        required: false,
        schema: {type: 'integer'}
    },
    {
        name: 'min_assets',
        in: 'query',
        description: 'Min assets per listing',
        required: false,
        schema: {type: 'integer'}
    },
    {
        name: 'show_seller_contracts',
        in: 'query',
        description: 'If false no seller contracts are shown except if they are in the contract whitelist',
        required: false,
        schema: {type: 'boolean'}
    },
    {
        name: 'contract_whitelist',
        in: 'query',
        description: 'Show these accounts even if they are contracts',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'seller_blacklist',
        in: 'query',
        description: 'Dont show listings from these sellers (Split multiple with ",")',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'buyer_blacklist',
        in: 'query',
        description: 'Dont show listings from these buyers (Split multiple with ",")',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'asset_id',
        in: 'query',
        description: 'Asset id in the offer',
        required: false,
        schema: {type: 'int'}
    },
    {
        name: 'marketplace',
        in: 'query',
        description: 'Filter by all sales where a certain marketplace is either taker or maker marketplace - separate multiple with ","',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'maker_marketplace',
        in: 'query',
        description: 'Maker marketplace - separate multiple with ","',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'taker_marketplace',
        in: 'query',
        description: 'Taker marketplace - separate multiple with ","',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'symbol',
        in: 'query',
        description: 'Filter by symbol',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'account',
        in: 'query',
        description: 'Filter accounts that are either seller or buyer',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'seller',
        in: 'query',
        description: 'Filter by seller - separate multiple with ","',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'buyer',
        in: 'query',
        description: 'Filter by buyer - separate multiple with ","',
        required: false,
        schema: {type: 'string'}
    },
    {
        name: 'min_price',
        in: 'query',
        description: 'Lower price limit',
        required: false,
        schema: {type: 'number'}
    },
    {
        name: 'max_price',
        in: 'query',
        description: 'Upper price limit',
        required: false,
        schema: {type: 'number'}
    },
    {
        name: 'min_template_mint',
        in: 'query',
        description: 'Min template mint',
        required: false,
        schema: {type: 'number'}
    },
    {
        name: 'max_template_mint',
        in: 'query',
        description: 'Max template mint',
        required: false,
        schema: {type: 'number'}
    }
];

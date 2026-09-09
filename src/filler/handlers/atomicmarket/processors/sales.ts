import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import AtomicMarketHandler, { AtomicMarketUpdatePriority, SaleState } from '../index';
import {
    CancelSaleActionData,
    LogNewSaleActionData, LogSaleStartActionData, PurchaseSaleActionData
} from '../types/actions';
import { preventInt64Overflow } from '../../../../utils/binary';
import { normalizeMarketplace } from '../../../../utils/marketplace';
import ApiNotificationSender from '../../../notifier';
import logger from '../../../../utils/winston';
import { saleDissolvesAsLegacyBundle } from '../legacy-bundles';

export function saleProcessor(core: AtomicMarketHandler, processor: DataProcessor, notifier: ApiNotificationSender): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicmarket_account;

    destructors.push(processor.onActionTrace(
        contract, 'lognewsale',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewSaleActionData>): Promise<void> => {
            await db.insert('atomicmarket_sales', {
                market_contract: core.args.atomicmarket_account,
                sale_id: trace.act.data.sale_id,
                seller: trace.act.data.seller,
                buyer: null,
                listing_price: preventInt64Overflow(trace.act.data.listing_price.split(' ')[0].replace('.', '')),
                final_price: null,
                listing_symbol: trace.act.data.listing_price.split(' ')[1],
                settlement_symbol: trace.act.data.settlement_symbol.split(',')[1],
                assets_contract: core.args.atomicassets_account,
                offer_id: null,
                maker_marketplace: normalizeMarketplace(trace.act.data.maker_marketplace),
                taker_marketplace: null,
                collection_name: trace.act.data.collection_name,
                collection_fee: trace.act.data.collection_fee,
                state: SaleState.WAITING.valueOf(),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                created_at_block: block.block_num,
                created_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, ['market_contract', 'sale_id'], true, true, 'update');

            notifier.sendActionTrace('sales', block, tx, trace);
        }, AtomicMarketUpdatePriority.ACTION_CREATE_SALE.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logsalestart',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogSaleStartActionData>): Promise<void> => {
            await db.update('atomicmarket_sales', {
                state: SaleState.LISTED.valueOf(),
                offer_id: trace.act.data.offer_id,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, {
                str: 'market_contract = $1 AND sale_id = $2',
                values: [core.args.atomicmarket_account, trace.act.data.sale_id]
            }, ['market_contract', 'sale_id']);

            notifier.sendActionTrace('sales', block, tx, trace);
        }, AtomicMarketUpdatePriority.ACTION_UPDATE_SALE.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'cancelsale',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CancelSaleActionData>): Promise<void> => {
            await db.update('atomicmarket_sales', {
                state: SaleState.CANCELED.valueOf(),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, {
                str: 'market_contract = $1 AND sale_id = $2',
                values: [core.args.atomicmarket_account, trace.act.data.sale_id]
            }, ['market_contract', 'sale_id']);

            notifier.sendActionTrace('sales', block, tx, trace);
        }, AtomicMarketUpdatePriority.ACTION_UPDATE_SALE.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'purchasesale',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<PurchaseSaleActionData>): Promise<void> => {
            // Replay guard: a SOLD sale row already has the correct final_price/buyer
            // from initial processing. Recomputing during SHIP replay would overwrite
            // final_price using delphioracle_pairs precisions that may be stale (e.g.,
            // after a backup restore). Mirrors PR #2507 in nft-data-api which fixed
            // the 2026-04-09 WAX 10,000x current_usd incident. The early-out also
            // skips the JOIN below during catchup, when most rows are already SOLD.
            const existing = await db.query(
                'SELECT state, listing_price, offer_id, assets_contract FROM atomicmarket_sales WHERE market_contract = $1 AND sale_id = $2',
                [core.args.atomicmarket_account, trace.act.data.sale_id]
            );

            if (existing.rowCount === 0) {
                logger.warn('AtomicMarket: Sale was purchased but was not found (possible fork replay). sale_id=' + trace.act.data.sale_id);
                return;
            }

            if (existing.rows[0].state === SaleState.SOLD.valueOf()) {
                return;
            }

            const dissolved = await saleDissolvesAsLegacyBundle(
                db, existing.rows[0].assets_contract, existing.rows[0].offer_id,
                {version: core.config?.version, markerBlock: core.v2MarkerBlock, blockNum: block.block_num}
            );

            if (dissolved) {
                // v2 cannot sell a bundle: purchasesale declines the offer, erases the
                // sale and charges the buyer nothing. Record the cancel, and leave buyer
                // and final_price unset because no trade settled.
                await db.update('atomicmarket_sales', {
                    state: SaleState.CANCELED.valueOf(),
                    updated_at_block: block.block_num,
                    updated_at_time: eosioTimestampToDate(block.timestamp).getTime()
                }, {
                    str: 'market_contract = $1 AND sale_id = $2',
                    values: [core.args.atomicmarket_account, trace.act.data.sale_id]
                }, ['market_contract', 'sale_id']);

                // The socket api turns a purchasesale trace into the purchased_sale event,
                // so this path sends nothing, the way cancelsale's trace reaches no event.
                return;
            }

            let finalPrice;

            if (parseInt(trace.act.data.intended_delphi_median, 10) === 0) {
                finalPrice = existing.rows[0].listing_price;
            } else {
                const query = await db.query(
                    'SELECT pair.invert_delphi_pair, delphi.base_precision, delphi.quote_precision, delphi.median_precision, sale.listing_price ' +
                    'FROM atomicmarket_symbol_pairs pair, atomicmarket_sales sale, delphioracle_pairs delphi ' +
                    'WHERE sale.market_contract = pair.market_contract AND sale.listing_symbol = pair.listing_symbol AND sale.settlement_symbol = pair.settlement_symbol AND ' +
                    'pair.delphi_contract = delphi.contract AND pair.delphi_pair_name = delphi.delphi_pair_name AND ' +
                    'sale.market_contract = $1 AND sale.sale_id = $2',
                    [core.args.atomicmarket_account, trace.act.data.sale_id]
                );

                if (query.rowCount === 0) {
                    logger.warn('AtomicMarket: Sale was purchased but could not find delphi pair (possible fork replay). sale_id=' + trace.act.data.sale_id);
                    return;
                }

                const row = query.rows[0];

                if (row.invert_delphi_pair) {
                    finalPrice = Math.floor(parseInt(row.listing_price, 10) * parseInt(trace.act.data.intended_delphi_median, 10) *
                        Math.pow(10, row.quote_precision - row.base_precision - row.median_precision));
                } else {
                    finalPrice = Math.floor((parseInt(row.listing_price, 10) / parseInt(trace.act.data.intended_delphi_median, 10)) *
                        Math.pow(10, row.median_precision + row.base_precision - row.quote_precision));
                }
            }

            await db.update('atomicmarket_sales', {
                buyer: trace.act.data.buyer,
                final_price: preventInt64Overflow(finalPrice),
                state: SaleState.SOLD.valueOf(),
                taker_marketplace: normalizeMarketplace(trace.act.data.taker_marketplace),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, {
                str: 'market_contract = $1 AND sale_id = $2',
                values: [core.args.atomicmarket_account, trace.act.data.sale_id]
            }, ['market_contract', 'sale_id']);

            notifier.sendActionTrace('sales', block, tx, trace);
        }, AtomicMarketUpdatePriority.ACTION_UPDATE_SALE.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

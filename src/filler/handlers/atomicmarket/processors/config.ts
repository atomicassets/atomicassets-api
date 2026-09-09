import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioContractRow } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { ConfigTableRow } from '../types/tables';
import AtomicMarketHandler, { AtomicMarketUpdatePriority } from '../index';
import logger from '../../../../utils/winston';
import { versionDissolvesBundles } from '../legacy-bundles';

export function configProcessor(core: AtomicMarketHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicmarket_account;

    destructors.push(processor.onContractRow(
        contract, 'config',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<ConfigTableRow>): Promise<void> => {
            if (!delta.present) {
                throw Error('AtomicMarket: Config should not be deleted');
            }

            if (
                core.config.version !== delta.value.version ||
                core.config.maker_market_fee !== delta.value.maker_market_fee ||
                core.config.taker_market_fee !== delta.value.taker_market_fee ||
                core.config.maximum_auction_duration !== delta.value.maximum_auction_duration ||
                core.config.minimum_bid_increase !== delta.value.minimum_bid_increase ||
                core.config.minimum_auction_duration !== delta.value.minimum_auction_duration ||
                core.config.auction_reset_duration !== delta.value.auction_reset_duration
            ) {
                await db.update('atomicmarket_config', {
                    version: delta.value.version,
                    maker_market_fee: delta.value.maker_market_fee,
                    taker_market_fee: delta.value.taker_market_fee,
                    minimum_auction_duration: delta.value.minimum_auction_duration,
                    maximum_auction_duration: delta.value.maximum_auction_duration,
                    minimum_bid_increase: delta.value.minimum_bid_increase,
                    auction_reset_duration: delta.value.auction_reset_duration
                }, {
                    str: 'market_contract = $1',
                    values: [core.args.atomicmarket_account]
                }, ['market_contract']);
            }

            if (core.config.supported_tokens.length !== delta.value.supported_tokens.length) {
                const tokens = core.config.supported_tokens.map(row => row.token_symbol.split(',')[1]);

                for (const token of delta.value.supported_tokens) {
                    const index = tokens.indexOf(token.token_symbol.split(',')[1]);

                    if (index === -1) {
                        await db.insert('atomicmarket_tokens', {
                            market_contract: core.args.atomicmarket_account,
                            token_contract: token.token_contract,
                            token_symbol: token.token_symbol.split(',')[1],
                            token_precision: token.token_symbol.split(',')[0]
                        }, ['market_contract', 'token_symbol']);
                    } else {
                        tokens.splice(index, 1);
                    }
                }

                if (tokens.length > 0) {
                    logger.warn('AtomicMarket: ' + tokens.length + ' supported token(s) removed from config: ' + tokens.join(', '));
                }
            }

            if (core.config.supported_symbol_pairs.length !== delta.value.supported_symbol_pairs.length) {
                const pairs = core.config.supported_symbol_pairs.map(
                    row => row.listing_symbol.split(',')[1] + ':' + row.settlement_symbol.split(',')[1]
                );

                for (const pair of delta.value.supported_symbol_pairs) {
                    const index = pairs.indexOf(pair.listing_symbol.split(',')[1] + ':' + pair.settlement_symbol.split(',')[1]);

                    if (index === -1) {
                        await db.insert('atomicmarket_symbol_pairs', {
                            market_contract: core.args.atomicmarket_account,
                            listing_symbol: pair.listing_symbol.split(',')[1],
                            settlement_symbol: pair.settlement_symbol.split(',')[1],
                            delphi_contract: delta.value.delphioracle_account,
                            delphi_pair_name: pair.delphi_pair_name,
                            invert_delphi_pair: pair.invert_delphi_pair
                        }, ['market_contract', 'listing_symbol', 'settlement_symbol']);
                    } else {
                        pairs.splice(index, 1);
                    }
                }

                if (pairs.length > 0) {
                    logger.warn('AtomicMarket: ' + pairs.length + ' symbol pair(s) removed from config: ' + pairs.join(', '));
                }
            }

            // v2 legacy bundle marker (legacy-bundles.ts): a live config delta
            // reporting v2 or above is proof this reader was subscribed for the
            // flip, so it is the last block the old rules cover and the new ones
            // start with the next.
            //
            // The write goes through db.update, the same reversible path the
            // version write above uses, rather than a raw query. A fork that
            // orphans the first v2 delta has to take the marker with it: left
            // behind, it would point at a block that is no longer history, and
            // every action between it and the canonical flip would be recorded
            // against a boundary that never happened. rollbackReversibleBlocks
            // restores the previous value from the log db.update writes.
            //
            // Whether the marker is already set is read from the row, not from
            // the in-memory value, because a rollback does not reach into memory.
            // Reading it back is also what re-syncs core.v2MarkerBlock after a
            // fork. Config deltas are rare, so the extra read costs nothing.
            if (versionDissolvesBundles(delta.value.version)) {
                const markerQuery = await db.query(
                    'SELECT v2_marker_block FROM atomicmarket_config WHERE market_contract = $1',
                    [core.args.atomicmarket_account]
                );
                const storedMarker = markerQuery.rows[0]?.v2_marker_block;

                if (storedMarker === null || typeof storedMarker === 'undefined') {
                    await db.update('atomicmarket_config', {
                        v2_marker_block: block.block_num
                    }, {
                        str: 'market_contract = $1',
                        values: [core.args.atomicmarket_account]
                    }, ['market_contract']);

                    core.v2MarkerBlock = block.block_num;
                } else {
                    core.v2MarkerBlock = Number(storedMarker);
                }
            }

            core.config = delta.value;
        }, AtomicMarketUpdatePriority.TABLE_CONFIG.valueOf()
    ));

    // A fork rollback restores atomicmarket_config from the reversible log and
    // stops there, so the handler's own copy of that row would keep the orphaned
    // branch's version and marker. Nothing later is guaranteed to correct them:
    // the canonical branch need not carry a config delta at all, and the marker
    // read-back above only runs when one arrives. Re-read the row here so the
    // in-memory copy follows the rollback the way it follows a delta.
    destructors.push(processor.onFork(
        async (db: ContractDBTransaction): Promise<void> => {
            const query = await db.query(
                'SELECT version, maker_market_fee, taker_market_fee, minimum_auction_duration, ' +
                'maximum_auction_duration, minimum_bid_increase, auction_reset_duration, v2_marker_block ' +
                'FROM atomicmarket_config WHERE market_contract = $1',
                [core.args.atomicmarket_account]
            );

            if (query.rowCount === 0) {
                return;
            }

            const row = query.rows[0];

            core.config = {
                ...core.config,
                version: row.version,
                maker_market_fee: row.maker_market_fee,
                taker_market_fee: row.taker_market_fee,
                minimum_auction_duration: row.minimum_auction_duration,
                maximum_auction_duration: row.maximum_auction_duration,
                minimum_bid_increase: row.minimum_bid_increase,
                auction_reset_duration: row.auction_reset_duration
            };

            core.v2MarkerBlock = row.v2_marker_block === null || typeof row.v2_marker_block === 'undefined'
                ? null
                : Number(row.v2_marker_block);
        }, AtomicMarketUpdatePriority.TABLE_CONFIG.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

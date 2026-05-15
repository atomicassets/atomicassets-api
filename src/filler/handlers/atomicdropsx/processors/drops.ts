import AtomicDropsHandler, { AtomicDropsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { preventInt64Overflow } from '../../../../utils/binary';
import {
    LogNewDropActionData,
    SetDropDataActionData,
    SetDropPriceActionData,
    SetDropLimitActionData,
    SetDropTimesActionData,
    EraseDropActionData,
} from '../types/actions';

function parseListingPrice(listing_price: string): { amount: string, symbol: string } {
    // "5.00000000 WAX" → { amount: "500000000", symbol: "WAX" }
    if (!listing_price || typeof listing_price !== 'string') return { amount: '0', symbol: '' };
    const [valueStr, symbol] = listing_price.split(' ');
    if (!valueStr || !symbol) return { amount: '0', symbol: symbol ?? '' };
    return { amount: preventInt64Overflow(valueStr.replace('.', '')), symbol };
}

export function dropsProcessor(core: AtomicDropsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicdropsx_account;

    destructors.push(processor.onActionTrace(
        contract, 'lognewdrop',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<LogNewDropActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            const price = parseListingPrice(trace.act.data.listing_price);
            await db.insert('atomicdropsx_drops', {
                contract,
                drop_id: trace.act.data.drop_id,
                assets_contract: core.args.atomicassets_account,
                collection_name: trace.act.data.collection_name,
                assets_to_mint: JSON.stringify(trace.act.data.assets_to_mint ?? []),
                listing_price: price.amount,
                listing_symbol: price.symbol,
                settlement_symbol: trace.act.data.settlement_symbol ?? null,
                price_recipient: trace.act.data.price_recipient,
                auth_required: trace.act.data.auth_required ?? false,
                account_limit: trace.act.data.account_limit ?? 0,
                account_limit_cooldown: trace.act.data.account_limit_cooldown ?? 0,
                max_claimable: trace.act.data.max_claimable ?? 0,
                start_time: trace.act.data.start_time ?? null,
                end_time: trace.act.data.end_time ?? null,
                display_data: trace.act.data.display_data ?? null,
                is_deleted: false,
                created_at_block: block.block_num,
                created_at_time: ts,
                updated_at_block: block.block_num,
                updated_at_time: ts,
            }, ['contract', 'drop_id'], true, true, 'update');
        }, AtomicDropsUpdatePriority.ACTION_CREATE_DROP.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setdropdata',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<SetDropDataActionData>): Promise<void> => {
            await db.update('atomicdropsx_drops', {
                display_data: trace.act.data.display_data,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND drop_id = $2',
                values: [contract, trace.act.data.drop_id],
            }, ['contract', 'drop_id']);
        }, AtomicDropsUpdatePriority.ACTION_UPDATE_DROP.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setdropprice',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<SetDropPriceActionData>): Promise<void> => {
            const price = parseListingPrice(trace.act.data.listing_price);
            await db.update('atomicdropsx_drops', {
                listing_price: price.amount,
                listing_symbol: price.symbol,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND drop_id = $2',
                values: [contract, trace.act.data.drop_id],
            }, ['contract', 'drop_id']);
        }, AtomicDropsUpdatePriority.ACTION_UPDATE_DROP.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setdroplimit',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<SetDropLimitActionData>): Promise<void> => {
            await db.update('atomicdropsx_drops', {
                account_limit: trace.act.data.account_limit,
                account_limit_cooldown: trace.act.data.account_limit_cooldown,
                max_claimable: trace.act.data.max_claimable,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND drop_id = $2',
                values: [contract, trace.act.data.drop_id],
            }, ['contract', 'drop_id']);
        }, AtomicDropsUpdatePriority.ACTION_UPDATE_DROP.valueOf(),
    ));

    /**
     * `setdroptimes` (PLURAL) on WAX. Both `start_time` and `end_time` are
     * required by the contract (no partial updates), so the processor
     * sets both unconditionally — the upstream's "preserve unspecified"
     * branching doesn't apply to WAX.
     */
    destructors.push(processor.onActionTrace(
        contract, 'setdroptimes',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<SetDropTimesActionData>): Promise<void> => {
            await db.update('atomicdropsx_drops', {
                start_time: trace.act.data.start_time,
                end_time: trace.act.data.end_time,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND drop_id = $2',
                values: [contract, trace.act.data.drop_id],
            }, ['contract', 'drop_id']);
        }, AtomicDropsUpdatePriority.ACTION_UPDATE_DROP.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'erasedrop',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<EraseDropActionData>): Promise<void> => {
            await db.update('atomicdropsx_drops', {
                is_deleted: true,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND drop_id = $2',
                values: [contract, trace.act.data.drop_id],
            }, ['contract', 'drop_id']);
        }, AtomicDropsUpdatePriority.ACTION_UPDATE_DROP.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

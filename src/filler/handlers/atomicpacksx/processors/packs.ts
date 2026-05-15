import AtomicPacksHandler, { AtomicPacksUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import {
    AnnouncePackActionData,
    CompletePackActionData,
    LogNewPackActionData,
    SetPackDataActionData,
    SetPackTimeActionData,
} from '../types/actions';

export function packsProcessor(core: AtomicPacksHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicpacksx_account;

    /**
     * `lognewpack` on WAX only emits 3 fields. `pack_template_id` and
     * `display_data` are filled in later by `completepack` and
     * `setpackdata` respectively, so we insert with NULLs and let the
     * subsequent action's UPDATE backfill them.
     *
     * If `announcepack` fired earlier in the same tx, the pack row may
     * already exist with display_data populated — the `update` strategy on
     * conflict preserves the non-NULL display_data unless this insert
     * provides one (it doesn't, so it stays).
     */
    destructors.push(processor.onActionTrace(
        contract, 'lognewpack',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<LogNewPackActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.insert('atomicpacksx_packs', {
                contract,
                pack_id: trace.act.data.pack_id,
                assets_contract: core.args.atomicassets_account,
                collection_name: trace.act.data.collection_name,
                pack_template_id: null,  // populated by completepack
                unlock_time: trace.act.data.unlock_time,
                display_data: null,      // populated by setpackdata or announcepack
                created_at_block: block.block_num,
                created_at_time: ts,
                updated_at_block: block.block_num,
                updated_at_time: ts,
            }, ['contract', 'pack_id'], true, true, 'update');
        }, AtomicPacksUpdatePriority.ACTION_CREATE_PACK.valueOf(),
    ));

    /**
     * `announcepack` (WAX) — pre-create reservation. Fires before
     * `lognewpack` in the same tx and provides display_data + collection
     * + unlock_time, but NO pack_id (the contract assigns one in
     * `lognewpack`). Without a pack_id we can't write a row yet, so this
     * listener is a no-op for now: the values it carries are already
     * provided by `lognewpack` (collection_name, unlock_time) and
     * `setpackdata` (display_data) within the same tx, so nothing is
     * lost. Kept as an explicit no-op listener to document the action's
     * existence and silence "unhandled action" log noise.
     */
    destructors.push(processor.onActionTrace(
        contract, 'announcepack',
        async (_db: ContractDBTransaction, _block: ShipBlock, _tx: EosioTransaction, _trace: EosioActionTrace<AnnouncePackActionData>): Promise<void> => {
            // Intentional no-op — see comment above.
        }, AtomicPacksUpdatePriority.ACTION_CREATE_PACK.valueOf(),
    ));

    /**
     * `completepack` (WAX) — sets `pack_template_id` after `lognewpack`
     * has reserved the pack_id row. Required to know which template the
     * pack opens onto.
     */
    destructors.push(processor.onActionTrace(
        contract, 'completepack',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<CompletePackActionData>): Promise<void> => {
            await db.update('atomicpacksx_packs', {
                pack_template_id: trace.act.data.pack_template_id,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND pack_id = $2',
                values: [contract, trace.act.data.pack_id],
            }, ['contract', 'pack_id']);
        }, AtomicPacksUpdatePriority.ACTION_UPDATE_PACK.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setpackdata',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<SetPackDataActionData>): Promise<void> => {
            await db.update('atomicpacksx_packs', {
                display_data: trace.act.data.display_data,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND pack_id = $2',
                values: [contract, trace.act.data.pack_id],
            }, ['contract', 'pack_id']);
        }, AtomicPacksUpdatePriority.ACTION_UPDATE_PACK.valueOf(),
    ));

    /**
     * `setpacktime` (WAX) — replaces the upstream `setunlocktime` action.
     * Field name is `new_unlock_time` (not `unlock_time`).
     */
    destructors.push(processor.onActionTrace(
        contract, 'setpacktime',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<SetPackTimeActionData>): Promise<void> => {
            await db.update('atomicpacksx_packs', {
                unlock_time: trace.act.data.new_unlock_time,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND pack_id = $2',
                values: [contract, trace.act.data.pack_id],
            }, ['contract', 'pack_id']);
        }, AtomicPacksUpdatePriority.ACTION_UPDATE_PACK.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

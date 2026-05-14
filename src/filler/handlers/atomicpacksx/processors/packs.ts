import AtomicPacksHandler, { AtomicPacksUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import {
    LogNewPackActionData,
    SetPackDataActionData,
    SetUnlockTimeActionData,
} from '../types/actions';

export function packsProcessor(core: AtomicPacksHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicpacksx_account;

    destructors.push(processor.onActionTrace(
        contract, 'lognewpack',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<LogNewPackActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.insert('atomicpacksx_packs', {
                contract,
                pack_id: trace.act.data.pack_id,
                assets_contract: core.args.atomicassets_account,
                collection_name: trace.act.data.collection_name,
                pack_template_id: trace.act.data.pack_template_id,
                unlock_time: trace.act.data.unlock_time,
                display_data: trace.act.data.display_data,
                created_at_block: block.block_num,
                created_at_time: ts,
                updated_at_block: block.block_num,
                updated_at_time: ts,
            }, ['contract', 'pack_id'], true, true, 'update');
        }, AtomicPacksUpdatePriority.ACTION_CREATE_PACK.valueOf(),
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

    destructors.push(processor.onActionTrace(
        contract, 'setunlocktime',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<SetUnlockTimeActionData>): Promise<void> => {
            await db.update('atomicpacksx_packs', {
                unlock_time: trace.act.data.unlock_time,
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

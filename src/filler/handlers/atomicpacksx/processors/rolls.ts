import AtomicPacksHandler, { AtomicPacksUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { LogNewRollActionData, SetRollOutcomesActionData } from '../types/actions';

export function rollsProcessor(core: AtomicPacksHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicpacksx_account;

    destructors.push(processor.onActionTrace(
        contract, 'lognewroll',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<LogNewRollActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.insert('atomicpacksx_pack_rolls', {
                contract,
                pack_id: trace.act.data.pack_id,
                roll_index: trace.act.data.roll_id,
                total_odds: trace.act.data.total_odds,
                outcomes: JSON.stringify(trace.act.data.outcomes ?? []),
                display_data: trace.act.data.display_data ?? null,
                created_at_block: block.block_num,
                created_at_time: ts,
                updated_at_block: block.block_num,
                updated_at_time: ts,
            }, ['contract', 'pack_id', 'roll_index'], true, true, 'update');
        }, AtomicPacksUpdatePriority.ACTION_CREATE_ROLL.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setrolloutcomes',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<SetRollOutcomesActionData>): Promise<void> => {
            await db.update('atomicpacksx_pack_rolls', {
                total_odds: trace.act.data.total_odds,
                outcomes: JSON.stringify(trace.act.data.outcomes ?? []),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND pack_id = $2 AND roll_index = $3',
                values: [contract, trace.act.data.pack_id, trace.act.data.roll_id],
            }, ['contract', 'pack_id', 'roll_index']);
        }, AtomicPacksUpdatePriority.ACTION_UPDATE_ROLL.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

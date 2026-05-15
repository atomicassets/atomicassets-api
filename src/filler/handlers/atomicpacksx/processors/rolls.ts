import AtomicPacksHandler, { AtomicPacksUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { AddPackRollActionData, LogNewRollActionData } from '../types/actions';

/**
 * On WAX, pack rolls are created in two steps within the same transaction:
 *   1. `lognewroll(pack_id, roll_id)` — announces a roll exists. Outcomes
 *      are NOT in this action's data.
 *   2. `addpackroll(authorized_account, pack_id, outcomes, total_odds)` —
 *      provides the actual outcomes + total_odds.
 *
 * The processor inserts a placeholder row from `lognewroll` (with empty
 * outcomes) and then UPDATEs it from `addpackroll`. Reading the schema
 * column `roll_index` for the WAX `roll_id` field — the column was named
 * before the WAX ABI was confirmed; the values it holds are the same.
 */
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
                total_odds: '0',          // populated by addpackroll
                outcomes: '[]',           // populated by addpackroll
                display_data: null,
                created_at_block: block.block_num,
                created_at_time: ts,
                updated_at_block: block.block_num,
                updated_at_time: ts,
            }, ['contract', 'pack_id', 'roll_index'], true, true, 'update');
        }, AtomicPacksUpdatePriority.ACTION_CREATE_ROLL.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'addpackroll',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<AddPackRollActionData>): Promise<void> => {
            // Find the most recent roll for this pack (lognewroll fired
            // before this action and gave the row a roll_index). On WAX,
            // `addpackroll` does NOT carry the roll_id — it always targets
            // the latest unfilled roll. We update the highest roll_index
            // for this pack that still has placeholder outcomes (`'[]'`).
            //
            // This relies on the contract enforcing strict
            // lognewroll → addpackroll ordering within a tx, which the
            // upstream contract does. If a future variant interleaves
            // multiple rolls per tx, this needs revisiting.
            await db.query(
                `UPDATE atomicpacksx_pack_rolls
                    SET total_odds = $1,
                        outcomes = $2,
                        updated_at_block = $3,
                        updated_at_time = $4
                  WHERE contract = $5
                    AND pack_id = $6
                    AND roll_index = (
                        SELECT roll_index
                          FROM atomicpacksx_pack_rolls
                         WHERE contract = $5 AND pack_id = $6 AND outcomes = '[]'
                         ORDER BY roll_index DESC
                         LIMIT 1
                    )`,
                [
                    trace.act.data.total_odds,
                    JSON.stringify(trace.act.data.outcomes ?? []),
                    block.block_num,
                    eosioTimestampToDate(block.timestamp).getTime(),
                    contract,
                    trace.act.data.pack_id,
                ],
            );
        }, AtomicPacksUpdatePriority.ACTION_UPDATE_ROLL.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

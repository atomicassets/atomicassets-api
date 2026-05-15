import AtomicPacksHandler, { AtomicPacksUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import {
    AddPackRollActionData,
    ClaimUnboxedActionData,
    LogNewPackActionData,
    LogNewRollActionData,
    LogResultActionData,
} from '../types/actions';

/**
 * Writes every captured atomicpacksx action to the shared trace log so
 * downstream consumers (notification-service, audit tooling) can read the
 * raw stream by action name without joining against the domain tables.
 *
 * Mirrors the gating pattern in atomicmarket: only registered when
 * args.store_logs is true. WAX action names (claimunboxed, addpackroll,
 * etc.) — there is no logclaim or cancelclaim on WAX.
 */
export function logProcessor(core: AtomicPacksHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicpacksx_account;

    destructors.push(processor.onActionTrace(
        contract, 'lognewpack',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewPackActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                pack_id: trace.act.data.pack_id,
                collection_name: trace.act.data.collection_name,
            });
        }, AtomicPacksUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'lognewroll',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewRollActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                pack_id: trace.act.data.pack_id,
                roll_id: trace.act.data.roll_id,
            });
        }, AtomicPacksUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'addpackroll',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<AddPackRollActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                pack_id: trace.act.data.pack_id,
                total_odds: trace.act.data.total_odds,
            });
        }, AtomicPacksUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimunboxed',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimUnboxedActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                pack_asset_id: trace.act.data.pack_asset_id,
                opener: trace.act.authorization?.[0]?.actor ?? '',
            });
        }, AtomicPacksUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logresult',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogResultActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                pack_asset_id: trace.act.data.pack_asset_id,
                pack_id: trace.act.data.pack_id,
                template_count: Array.isArray(trace.act.data.template_ids) ? trace.act.data.template_ids.length : 0,
            });
        }, AtomicPacksUpdatePriority.LOGS.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

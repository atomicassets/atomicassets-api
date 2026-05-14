import AtomicDropsHandler, { AtomicDropsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import {
    LogNewDropActionData,
    ClaimDropActionData,
    ClaimWhitelistActionData,
    EraseDropActionData,
    LogClaimActionData,
} from '../types/actions';

export function logProcessor(core: AtomicDropsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicdropsx_account;

    destructors.push(processor.onActionTrace(
        contract, 'lognewdrop',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewDropActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                collection_name: trace.act.data.collection_name,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimdrop',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimDropActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: trace.act.data.amount,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimwlnft',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimWhitelistActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: trace.act.data.amount,
                whitelist: true,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimwhitelis',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimWhitelistActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: trace.act.data.amount,
                whitelist: true,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logclaim',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogClaimActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                claim_id: trace.act.data.claim_id,
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'erasedrop',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<EraseDropActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                drop_id: trace.act.data.drop_id,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

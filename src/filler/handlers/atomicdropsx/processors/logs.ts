import AtomicDropsHandler, { AtomicDropsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import {
    ClaimDropActionData,
    ClaimDropKeyActionData,
    ClaimDropWlActionData,
    EraseDropActionData,
    LogClaimActionData,
    LogNewDropActionData,
    TriggerDropActionData,
} from '../types/actions';

/**
 * Trace log for every captured atomicdropsx action - WAX action set.
 *
 * Field is `claim_amount` on user actions (claimdrop / claimdropwl /
 * claimdropkey) and `amount` on the admin-mediated `triggerdrop`.
 * `claimwlnft` and `claimwhitelis` (the upstream's whitelist names) do
 * not exist on WAX - replaced by `claimdropwl`/`claimdropkey`.
 * `logclaim` does not exist on WAX but is kept for non-WAX variants.
 */
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
                amount: trace.act.data.claim_amount,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimdropwl',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimDropWlActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: trace.act.data.claim_amount,
                whitelist: true,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimdropkey',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimDropKeyActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: trace.act.data.claim_amount,
                whitelist: true,
                key_auth: true,
            });
        }, AtomicDropsUpdatePriority.LOGS.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'triggerdrop',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<TriggerDropActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                recipient: trace.act.data.recipient,
                amount: trace.act.data.amount,
                trigger_provider: trace.act.data.trigger_provider,
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

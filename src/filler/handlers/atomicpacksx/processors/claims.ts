import AtomicPacksHandler, { AtomicPacksUpdatePriority, ClaimState } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import {
    CancelClaimActionData,
    LogClaimActionData,
    LogResultActionData,
} from '../types/actions';

export function claimsProcessor(core: AtomicPacksHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicpacksx_account;

    // logclaim emits when a user opens a pack. The pack NFT is burned by
    // the contract; the result NFTs are minted later via logresult.
    destructors.push(processor.onActionTrace(
        contract, 'logclaim',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogClaimActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.insert('atomicpacksx_claims', {
                contract,
                claim_id: trace.act.data.claim_id,
                pack_id: trace.act.data.pack_id,
                opener: trace.act.data.opener,
                pack_asset_id: trace.act.data.pack_asset_id,
                state: ClaimState.CLAIMED.valueOf(),
                txid: Buffer.from(tx.id, 'hex'),
                claimed_at_block: block.block_num,
                claimed_at_time: ts,
                resolved_at_block: null,
                resolved_at_time: null,
            }, ['contract', 'claim_id'], true, true, 'update');

            // Increment pack use_count so consumers can see pop_count without
            // a COUNT() on claims.
            await db.query(
                'UPDATE atomicpacksx_packs SET use_count = use_count + 1, ' +
                'updated_at_block = $1, updated_at_time = $2 ' +
                'WHERE contract = $3 AND pack_id = $4',
                [block.block_num, ts, contract, trace.act.data.pack_id],
            );
        }, AtomicPacksUpdatePriority.ACTION_CREATE_CLAIM.valueOf(),
    ));

    // logresult emits when the server reveals the NFTs for a claim.
    destructors.push(processor.onActionTrace(
        contract, 'logresult',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<LogResultActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.update('atomicpacksx_claims', {
                state: ClaimState.RESOLVED.valueOf(),
                resolved_at_block: block.block_num,
                resolved_at_time: ts,
            }, {
                str: 'contract = $1 AND claim_id = $2',
                values: [contract, trace.act.data.claim_id],
            }, ['contract', 'claim_id']);

            if (Array.isArray(trace.act.data.asset_ids) && trace.act.data.asset_ids.length > 0) {
                await db.insert('atomicpacksx_claim_assets', trace.act.data.asset_ids.map((assetId, index) => ({
                    contract,
                    claim_id: trace.act.data.claim_id,
                    index,
                    asset_id: assetId,
                })), ['contract', 'claim_id', 'index'], true, true, 'update');
            }
        }, AtomicPacksUpdatePriority.ACTION_UPDATE_CLAIM.valueOf(),
    ));

    // Optional cancel — for chains where the contract publishes a cancel
    // action. Some atomicpacksx variants don't emit one; the listener is
    // harmless when the action never fires.
    destructors.push(processor.onActionTrace(
        contract, 'cancelclaim',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<CancelClaimActionData>): Promise<void> => {
            await db.update('atomicpacksx_claims', {
                state: ClaimState.CANCELLED.valueOf(),
                resolved_at_block: block.block_num,
                resolved_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND claim_id = $2',
                values: [contract, trace.act.data.claim_id],
            }, ['contract', 'claim_id']);
        }, AtomicPacksUpdatePriority.ACTION_UPDATE_CLAIM.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

import AtomicPacksHandler, { AtomicPacksUpdatePriority, ClaimState } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import {
    EosioActionTrace,
    EosioContractRow,
    EosioTransaction,
} from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { ClaimUnboxedActionData, LogResultActionData } from '../types/actions';
import { UnboxPacksTableRow } from '../types/tables';

/**
 * Pack-claim lifecycle on WAX mainnet (verified against
 * `atomichub/contracts/atomicpacks-contract/src/unboxing.cpp`):
 *
 *   1. User transfers a pack NFT to atomicpacksx with memo="unbox".
 *      Contract's `receive_asset_transfer` notify inserts an `unboxpacks`
 *      row keyed by `pack_asset_id` (with unboxer + pack_id), then calls
 *      orng::requestrand. **This row delta is the pack-open event.**
 *      → state: CLAIMED (= "opened, awaiting RNG resolution")
 *
 *   2. RNG oracle callback `receiverand` runs (could be the same block
 *      or many blocks later). Contract burns the pack NFT, inserts one
 *      `unboxassets` row per roll with the resolved template_id, and
 *      emits an inline `logresult(pack_asset_id, pack_id, template_ids)`
 *      action. **logresult is the resolution event.**
 *      → state: RESOLVED, claim_assets populated
 *
 *   3. User (or the contract self) calls `claimunboxed` (sometimes days
 *      later). Contract erases unboxassets rows + mints the NFTs to the
 *      unboxer. When ALL rolls are picked, unboxpacks row is erased.
 *      → state: PICKED_UP
 *
 * In 1.5.x the handlers had this inverted — they treated `claimunboxed`
 * as the open event, which broke every pack on WAX (claimunboxed fires
 * later or never; logresult always fires first and FK-violated against
 * the missing parent claim). 1.6.0 drives off the contract's actual row
 * deltas, which makes the state machine match the chain.
 *
 * **Defensive UPSERT in logresult:** if our filler started indexing
 * AFTER the unboxpacks row was inserted (so we missed the open event)
 * but BEFORE logresult fires, we INSERT a fallback claim row with
 * opener='' rather than FK-violating. This preserves resolution data
 * for historical packs the filler missed.
 */
export function claimsProcessor(core: AtomicPacksHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicpacksx_account;

    // 1. Pack open: unboxpacks row INSERT → claim row in CLAIMED state.
    //    Row UPDATE is structurally impossible on this table (rows are
    //    only ever inserted at unbox time and erased at claim completion);
    //    if one ever appears we reuse the upsert path defensively.
    //    Row DELETE (when claimunboxed completes for the last roll) is a
    //    no-op here — the action listener below handles state transition
    //    to PICKED_UP and gives us the better timestamp.
    destructors.push(processor.onContractRow(
        contract, 'unboxpacks',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<UnboxPacksTableRow>): Promise<void> => {
            if (!delta.present) return;

            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.insert('atomicpacksx_claims', {
                contract,
                claim_id: delta.value.pack_asset_id,   // 1:1 mapping
                pack_id: delta.value.pack_id,
                opener: delta.value.unboxer,
                pack_asset_id: delta.value.pack_asset_id,
                state: ClaimState.CLAIMED.valueOf(),
                txid: null,                            // not available in row delta
                claimed_at_block: block.block_num,
                claimed_at_time: ts,
                resolved_at_block: null,
                resolved_at_time: null,
            }, ['contract', 'claim_id'], true, true, 'update',
            // Preserve immutable fields + resolution timestamps if we
            // somehow re-process an unboxpacks delta after logresult.
            ['contract', 'claim_id', 'opener', 'pack_asset_id',
                'claimed_at_block', 'claimed_at_time',
                'resolved_at_block', 'resolved_at_time']);
        }, AtomicPacksUpdatePriority.TABLE_UNBOXPACKS.valueOf(),
    ));

    // 2. Resolution: logresult action → state=RESOLVED + claim_assets[].
    //    Defensive UPSERT for orphan resolutions (unboxpacks row was
    //    inserted before our filler started indexing).
    destructors.push(processor.onActionTrace(
        contract, 'logresult',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<LogResultActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();

            // Try UPDATE first (the common case — claim was created by
            // the unboxpacks delta in this or an earlier block).
            const updateResult = await db.update('atomicpacksx_claims', {
                state: ClaimState.RESOLVED.valueOf(),
                pack_id: trace.act.data.pack_id,
                resolved_at_block: block.block_num,
                resolved_at_time: ts,
            }, {
                str: 'contract = $1 AND pack_asset_id = $2',
                values: [contract, trace.act.data.pack_asset_id],
            }, ['contract', 'pack_asset_id']);

            // Orphan resolution fallback: insert a placeholder claim row
            // so the FK to claim_assets holds. opener='' marks it as
            // unbacked-by-open-event for downstream cleanup if needed.
            if (updateResult.rowCount === 0) {
                await db.insert('atomicpacksx_claims', {
                    contract,
                    claim_id: trace.act.data.pack_asset_id,
                    pack_id: trace.act.data.pack_id,
                    opener: '',
                    pack_asset_id: trace.act.data.pack_asset_id,
                    state: ClaimState.RESOLVED.valueOf(),
                    txid: null,
                    claimed_at_block: block.block_num,
                    claimed_at_time: ts,
                    resolved_at_block: block.block_num,
                    resolved_at_time: ts,
                }, ['contract', 'claim_id'], true, true, 'nothing');
            }

            if (Array.isArray(trace.act.data.template_ids) && trace.act.data.template_ids.length > 0) {
                await db.insert('atomicpacksx_claim_assets', trace.act.data.template_ids.map((templateId, index) => ({
                    contract,
                    claim_id: trace.act.data.pack_asset_id,
                    index: index + 1,    // 1-based to match other handlers
                    asset_id: null,      // future logmint chain backfill
                    template_id: templateId,
                })), ['contract', 'claim_id', 'index'], true, true, 'update');
            }
        }, AtomicPacksUpdatePriority.ACTION_RESOLVE_CLAIM.valueOf(),
    ));

    // 3. Pickup: claimunboxed action → state=PICKED_UP.
    //    Only transitions forward (state >= RESOLVED) so a pickup that
    //    arrives before our resolution event doesn't clobber a CLAIMED
    //    row that's still waiting for logresult.
    destructors.push(processor.onActionTrace(
        contract, 'claimunboxed',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<ClaimUnboxedActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.update('atomicpacksx_claims', {
                state: ClaimState.PICKED_UP.valueOf(),
                resolved_at_block: block.block_num,
                resolved_at_time: ts,
            }, {
                str: 'contract = $1 AND pack_asset_id = $2 AND state >= $3',
                values: [contract, trace.act.data.pack_asset_id, ClaimState.RESOLVED.valueOf()],
            }, ['contract', 'pack_asset_id']);
        }, AtomicPacksUpdatePriority.ACTION_PICKUP_CLAIM.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

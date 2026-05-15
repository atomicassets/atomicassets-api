import AtomicPacksHandler, { AtomicPacksUpdatePriority, ClaimState } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import {
    ClaimUnboxedActionData,
    LogResultActionData,
} from '../types/actions';

/**
 * Pack-claim lifecycle on WAX mainnet:
 *
 *   1. User calls `claimunboxed(pack_asset_id, origin_roll_ids)`. The
 *      contract burns the pack NFT and transitions to a CLAIMED state.
 *      WAX has NO `claim_id` chain field — `pack_asset_id` IS the unique
 *      claim identifier (each pack opening burns exactly one specific
 *      NFT). The opener account comes from the action's authorization,
 *      not action data.
 *
 *   2. Server later fires `logresult(pack_asset_id, pack_id, template_ids)`
 *      revealing which templates the user got. We populate `pack_id` here
 *      (we didn't know it from claimunboxed alone since the pack was
 *      identified by asset, not pack_id).
 *
 * The schema's `claim_id bigint` column is populated from `pack_asset_id`
 * (1:1 mapping). Template IDs land in the new `template_id` column on
 * `atomicpacksx_claim_assets` (added in 1.5.1 migration). Actual minted
 * asset_ids come from a separate atomicassets `logmint` notify chain
 * (not handled in 1.5.1; future work will fill the existing `asset_id`
 * column then).
 *
 * No `cancelclaim` listener — the action does not exist on WAX.
 */
export function claimsProcessor(core: AtomicPacksHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicpacksx_account;

    destructors.push(processor.onActionTrace(
        contract, 'claimunboxed',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimUnboxedActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            const opener = trace.act.authorization?.[0]?.actor ?? '';
            await db.insert('atomicpacksx_claims', {
                contract,
                claim_id: trace.act.data.pack_asset_id,   // 1:1 mapping
                pack_id: null,                            // populated by logresult
                opener,
                pack_asset_id: trace.act.data.pack_asset_id,
                state: ClaimState.CLAIMED.valueOf(),
                txid: Buffer.from(tx.id, 'hex'),
                claimed_at_block: block.block_num,
                claimed_at_time: ts,
                resolved_at_block: null,
                resolved_at_time: null,
            }, ['contract', 'claim_id'], true, true, 'update');
        }, AtomicPacksUpdatePriority.ACTION_CREATE_CLAIM.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logresult',
        async (db: ContractDBTransaction, block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<LogResultActionData>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.update('atomicpacksx_claims', {
                state: ClaimState.RESOLVED.valueOf(),
                pack_id: trace.act.data.pack_id,         // first known here
                resolved_at_block: block.block_num,
                resolved_at_time: ts,
            }, {
                str: 'contract = $1 AND pack_asset_id = $2',
                values: [contract, trace.act.data.pack_asset_id],
            }, ['contract', 'pack_asset_id']);

            if (Array.isArray(trace.act.data.template_ids) && trace.act.data.template_ids.length > 0) {
                // Template IDs land in `template_id` (new in 1.5.1).
                // `asset_id` stays NULL until atomicassets `logmint` notify
                // backfills the actual minted asset_ids per opening.
                // 1-based index matches the rest of the schema
                // (atomicassets_transfers_assets, atomicmarket_*_assets).
                //
                // claim_id is pack_asset_id (1:1 mapping established at
                // claimunboxed time).
                await db.insert('atomicpacksx_claim_assets', trace.act.data.template_ids.map((templateId, index) => ({
                    contract,
                    claim_id: trace.act.data.pack_asset_id,
                    index: index + 1,
                    asset_id: null,
                    template_id: templateId,
                })), ['contract', 'claim_id', 'index'], true, true, 'update');
            }
        }, AtomicPacksUpdatePriority.ACTION_UPDATE_CLAIM.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

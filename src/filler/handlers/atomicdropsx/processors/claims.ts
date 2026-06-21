import AtomicDropsHandler, { AtomicDropsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { preventInt64Overflow } from '../../../../utils/binary';
import {
    ClaimDropActionData,
    ClaimDropKeyActionData,
    ClaimDropWlActionData,
    LogClaimActionData,
    TriggerDropActionData,
} from '../types/actions';

/**
 * Drop claim processor.
 *
 * WAX has THREE user-facing claim actions plus one admin-mediated path:
 *   - `claimdrop` - standard public claim (paid).
 *   - `claimdropwl` - whitelist claim (canonical name on WAX; the
 *     upstream's `claimwlnft`/`claimwhitelis` listeners targeted actions
 *     that don't exist on WAX).
 *   - `claimdropkey` - key-auth whitelist claim variant.
 *   - `triggerdrop` - admin-triggered (e.g., card-payment service claims
 *     on behalf of a user). Different field naming: `recipient` instead
 *     of `claimer`, `amount` instead of `claim_amount`.
 *
 * `logclaim` listener is preserved for non-WAX chain variants that emit
 * it; the no-op fallback (skipping rows without `claim_id`) is safe.
 *
 * claim_id is synthesized from global_sequence (or txid + drop_id
 * fallback) so it's stable across replays and unique per claim.
 */
export function claimsProcessor(core: AtomicDropsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicdropsx_account;

    async function recordClaim(
        db: ContractDBTransaction,
        block: ShipBlock,
        tx: EosioTransaction,
        trace: EosioActionTrace<unknown>,
        params: {
            drop_id: string,
            claimer: string,
            amount: number,
            isWhitelist: boolean,
        },
    ): Promise<void> {
        const ts = eosioTimestampToDate(block.timestamp).getTime();
        const claimId = trace.global_sequence ?? `${tx.id.slice(0, 16)}_${params.drop_id}`;

        // Drop's stored listing_price drives total_price.
        const dropQuery = await db.query(
            'SELECT listing_price, listing_symbol FROM atomicdropsx_drops WHERE contract = $1 AND drop_id = $2',
            [contract, params.drop_id],
        );
        const drop = dropQuery.rows[0] as { listing_price: string, listing_symbol: string } | undefined;
        const totalPrice = drop ? String(BigInt(drop.listing_price ?? '0') * BigInt(params.amount)) : null;

        await db.insert('atomicdropsx_claims', {
            contract,
            claim_id: claimId,
            drop_id: params.drop_id,
            claimer: params.claimer,
            amount: params.amount,
            total_price: totalPrice ? preventInt64Overflow(totalPrice) : null,
            price_symbol: drop?.listing_symbol ?? null,
            is_whitelist: params.isWhitelist,
            txid: Buffer.from(tx.id, 'hex'),
            claimed_at_block: block.block_num,
            claimed_at_time: ts,
        }, ['contract', 'claim_id'], true, true, 'update');

        // current_claimed for the parent drop is computed in
        // atomicdropsx_drops_master as SUM(amount) over the canonical claim
        // rows, so no in-handler counter maintenance is needed.
    }

    destructors.push(processor.onActionTrace(
        contract, 'claimdrop',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimDropActionData>): Promise<void> => {
            await recordClaim(db, block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: Number(trace.act.data.claim_amount ?? 0),
                isWhitelist: false,
            });
        }, AtomicDropsUpdatePriority.ACTION_CLAIM.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimdropwl',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimDropWlActionData>): Promise<void> => {
            await recordClaim(db, block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: Number(trace.act.data.claim_amount ?? 0),
                isWhitelist: true,
            });
        }, AtomicDropsUpdatePriority.ACTION_CLAIM.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimdropkey',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimDropKeyActionData>): Promise<void> => {
            await recordClaim(db, block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: Number(trace.act.data.claim_amount ?? 0),
                isWhitelist: true,  // key-auth claims count as whitelist
            });
        }, AtomicDropsUpdatePriority.ACTION_CLAIM.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'triggerdrop',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<TriggerDropActionData>): Promise<void> => {
            await recordClaim(db, block, tx, trace, {
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.recipient,         // recipient ≡ claimer
                amount: Number(trace.act.data.amount ?? 0), // `amount` not `claim_amount`
                // Admin-triggered claims are NOT whitelist claims by design;
                // they're a payment-mediation path. Set false so the
                // is_whitelist column reflects user-action semantics.
                isWhitelist: false,
            });
        }, AtomicDropsUpdatePriority.ACTION_CLAIM.valueOf(),
    ));

    /**
     * `logclaim` - does NOT exist on WAX, but kept for non-WAX chain
     * variants that emit it. The early-return on missing claim_id makes
     * it safe to leave registered everywhere.
     */
    destructors.push(processor.onActionTrace(
        contract, 'logclaim',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogClaimActionData>): Promise<void> => {
            if (!trace.act.data.claim_id) return;
            const ts = eosioTimestampToDate(block.timestamp).getTime();
            await db.insert('atomicdropsx_claims', {
                contract,
                claim_id: trace.act.data.claim_id,
                drop_id: trace.act.data.drop_id,
                claimer: trace.act.data.claimer,
                amount: trace.act.data.amount,
                total_price: trace.act.data.total_price ? preventInt64Overflow(trace.act.data.total_price) : null,
                price_symbol: null,
                is_whitelist: false,
                txid: Buffer.from(tx.id, 'hex'),
                claimed_at_block: block.block_num,
                claimed_at_time: ts,
            }, ['contract', 'claim_id'], true, true, 'nothing');
        }, AtomicDropsUpdatePriority.ACTION_CLAIM.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

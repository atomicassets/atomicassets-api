import AtomicDropsHandler, { AtomicDropsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { preventInt64Overflow } from '../../../../utils/binary';
import {
    ClaimDropActionData,
    ClaimWhitelistActionData,
    LogClaimActionData,
} from '../types/actions';

/**
 * Drop claim processor.
 *
 * Listens for both the modern `claimdrop` / `claimwlnft` actions and the
 * back-author-side `logclaim` log. We synthesize a deterministic claim_id
 * from the transaction id + global sequence so it's stable across replays
 * and joins cleanly to atomicassets transfers in the same tx.
 */
export function claimsProcessor(core: AtomicDropsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicdropsx_account;

    async function recordClaim(
        db: ContractDBTransaction,
        block: ShipBlock,
        tx: EosioTransaction,
        trace: EosioActionTrace<ClaimDropActionData>,
        isWhitelist: boolean,
    ): Promise<void> {
        const ts = eosioTimestampToDate(block.timestamp).getTime();
        const claimId = trace.global_sequence ?? `${tx.id.slice(0, 16)}_${trace.act.data.drop_id}`;

        // Drop's stored listing_price drives total_price; claim action carries
        // amount and (optionally) a per-unit override via intended_delphi_median
        // for tokens priced via delphi.
        const dropQuery = await db.query(
            'SELECT listing_price, listing_symbol FROM atomicdropsx_drops WHERE contract = $1 AND drop_id = $2',
            [contract, trace.act.data.drop_id],
        );
        const drop = dropQuery.rows[0] as { listing_price: string, listing_symbol: string } | undefined;
        const amount = Number(trace.act.data.amount ?? 0);
        const totalPrice = drop ? String(BigInt(drop.listing_price ?? '0') * BigInt(amount)) : null;

        await db.insert('atomicdropsx_claims', {
            contract,
            claim_id: claimId,
            drop_id: trace.act.data.drop_id,
            claimer: trace.act.data.claimer,
            amount: amount,
            total_price: totalPrice ? preventInt64Overflow(totalPrice) : null,
            price_symbol: drop?.listing_symbol ?? null,
            is_whitelist: isWhitelist,
            txid: Buffer.from(tx.id, 'hex'),
            claimed_at_block: block.block_num,
            claimed_at_time: ts,
        }, ['contract', 'claim_id'], true, true, 'update');

        // Maintain current_claimed counter on the drop so consumers can
        // read recent activity without a COUNT() on the claims table.
        await db.query(
            'UPDATE atomicdropsx_drops SET current_claimed = current_claimed + $1, ' +
            'updated_at_block = $2, updated_at_time = $3 ' +
            'WHERE contract = $4 AND drop_id = $5',
            [amount, block.block_num, ts, contract, trace.act.data.drop_id],
        );
    }

    destructors.push(processor.onActionTrace(
        contract, 'claimdrop',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimDropActionData>): Promise<void> => {
            await recordClaim(db, block, tx, trace, false);
        }, AtomicDropsUpdatePriority.ACTION_CLAIM.valueOf(),
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claimwlnft',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimWhitelistActionData>): Promise<void> => {
            await recordClaim(db, block, tx, trace, true);
        }, AtomicDropsUpdatePriority.ACTION_CLAIM.valueOf(),
    ));

    // Historical variant — some chains emit claimwhitelis (truncated name).
    destructors.push(processor.onActionTrace(
        contract, 'claimwhitelis',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimWhitelistActionData>): Promise<void> => {
            await recordClaim(db, block, tx, trace, true);
        }, AtomicDropsUpdatePriority.ACTION_CLAIM.valueOf(),
    ));

    // Some atomicdropsx variants emit a separate logclaim alongside the user
    // action; ignore if we already recorded the same claim by ON CONFLICT.
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

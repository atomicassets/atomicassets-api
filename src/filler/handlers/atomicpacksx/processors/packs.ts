import AtomicPacksHandler, { AtomicPacksUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ShipBlock } from '../../../../types/ship';
import { EosioContractRow } from '../../../../types/eosio';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { PacksTableRow } from '../types/tables';

/**
 * `packs` row delta is the canonical source of pack metadata. It captures
 * announcepack, completepack, setpacktime, setpackdata in a single handler.
 * Whichever of those actions ran, the contract's resulting state is
 * what we mirror.
 *
 * `pack_template_id = -1` on chain means "announced but not yet completed";
 * we store NULL in the DB column to match the existing nullable schema.
 *
 * Row deletes are exceedingly rare for `packs` (the contract has no public
 * erasePack path); when they do happen we delete the local row and let the
 * deferred FKs cascade-fail loudly if a child claim still references it.
 */
export function packsProcessor(core: AtomicPacksHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicpacksx_account;

    destructors.push(processor.onContractRow(
        contract, 'packs',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<PacksTableRow>): Promise<void> => {
            const ts = eosioTimestampToDate(block.timestamp).getTime();

            if (!delta.present) {
                await db.delete('atomicpacksx_packs', {
                    str: 'contract = $1 AND pack_id = $2',
                    values: [contract, delta.value.pack_id],
                });
                return;
            }

            const packTemplateId = Number(delta.value.pack_template_id) === -1
                ? null
                : delta.value.pack_template_id;

            await db.insert('atomicpacksx_packs', {
                contract,
                pack_id: delta.value.pack_id,
                assets_contract: core.args.atomicassets_account,
                collection_name: delta.value.collection_name,
                pack_template_id: packTemplateId,
                unlock_time: delta.value.unlock_time,
                display_data: delta.value.display_data || null,
                created_at_block: block.block_num,
                created_at_time: ts,
                updated_at_block: block.block_num,
                updated_at_time: ts,
            }, ['contract', 'pack_id'], true, true, 'update',
            // Preserve original creation timestamps on conflict updates;
            // collection_name/assets_contract are immutable post-creation
            // so blacklisting them is defensive (catches accidental drift).
            ['contract', 'pack_id', 'assets_contract', 'collection_name',
                'created_at_block', 'created_at_time']);
        }, AtomicPacksUpdatePriority.TABLE_PACKS.valueOf(),
    ));

    return (): any => destructors.map(fn => fn());
}

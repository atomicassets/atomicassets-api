import AtomicAssetsHandler, { AtomicAssetsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioContractRow } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { deserialize, CachedObjectSchema } from '@atomichub/atomicassets';
import type { AuthorSwapsTableRow, CollectionsTableRow } from '@atomichub/atomicassets';
import { encodeDatabaseJson } from '../../../utils';

export function collectionProcessor(core: AtomicAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicassets_account;

    destructors.push(processor.onContractRow(
        contract, 'collections',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<CollectionsTableRow>): Promise<void> => {
            if (!delta.present) {
                throw new Error('AtomicAssets: A collection was deleted. Should not be possible by contract');
            }

            const deserializedData = deserialize(delta.value.serialized_data, CachedObjectSchema(core.config.collection_format));

            await db.replace('atomicassets_collections', {
                contract: contract,
                collection_name: delta.value.collection_name,
                author: delta.value.author,
                allow_notify: delta.value.allow_notify,
                authorized_accounts: delta.value.authorized_accounts,
                notify_accounts: delta.value.notify_accounts,
                market_fee: delta.value.market_fee,
                data: encodeDatabaseJson(deserializedData),
                created_at_block: block.block_num,
                created_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, ['contract', 'collection_name'], ['created_at_block', 'created_at_time']);
        }, AtomicAssetsUpdatePriority.TABLE_COLLECTIONS.valueOf()
    ));

    // v2: collection author swaps. The contract's `authorswaps` table holds a
    // pending author change until it is accepted/rejected (row removed).
    destructors.push(processor.onContractRow(
        contract, 'authorswaps',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<AuthorSwapsTableRow>): Promise<void> => {
            await db.update('atomicassets_collections', {
                new_author_name: delta.present ? delta.value.new_author : null,
                new_author_date: delta.present ? delta.value.acceptance_date * 1000 : null,
            }, {
                str: 'contract = $1 AND collection_name = $2',
                values: [contract, delta.value.collection_name]
            }, ['contract', 'collection_name']);
        }, AtomicAssetsUpdatePriority.TABLE_COLLECTIONS.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

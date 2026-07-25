import AtomicAssetsHandler, { AtomicAssetsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioContractRow } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { SchemasTableRow, SchemaTypesTableRow } from '@atomichub/atomicassets';

export function schemaProcessor(core: AtomicAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicassets_account;

    destructors.push(processor.onContractRow(
        contract, 'schemas',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<SchemasTableRow>): Promise<void> => {
            if (!delta.present) {
                throw new Error('AtomicAssets: A schema was deleted. Should not be possible by contract');
            }

            await db.replace('atomicassets_schemas', {
                contract: contract,
                collection_name: delta.scope,
                schema_name: delta.value.schema_name,
                format: delta.value.format.map(row => JSON.stringify(row)),
                created_at_block: block.block_num,
                created_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, ['contract', 'collection_name', 'schema_name'], ['created_at_block', 'created_at_time']);
        }, AtomicAssetsUpdatePriority.TABLE_SCHEMAS.valueOf()
    ));

    // v2: per-field media types live in the contract's `schematypes` table.
    destructors.push(processor.onContractRow(
        contract, 'schematypes',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<SchemaTypesTableRow>): Promise<void> => {
            if (!delta.present) {
                throw new Error('AtomicAssets: A schema type was deleted. Should not be possible by contract');
            }

            await db.update('atomicassets_schemas', {
                types: delta.value.format_type.map(row => JSON.stringify(row)),
            }, {
                str: 'contract = $1 AND collection_name = $2 AND schema_name = $3',
                values: [contract, delta.scope, delta.value.schema_name]
            }, ['contract', 'collection_name', 'schema_name']);
        }, AtomicAssetsUpdatePriority.TABLE_SCHEMAS.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

import AtomicAssetsHandler, { AtomicAssetsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioContractRow } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { MutableTemplatesTableRow, TemplatesTableRow } from '../types/tables';
import { deserialize, CachedObjectSchema } from '@atomichub/atomicassets';
import { encodeDatabaseJson } from '../../../utils';

export function templateProcessor(core: AtomicAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicassets_account;

    destructors.push(processor.onContractRow(
        contract, 'templates',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<TemplatesTableRow>): Promise<void> => {
            // v2: templates can now be deleted (deltemplate). A non-present delta
            // marks the row deleted instead of throwing.
            const templateQuery = await db.query(
                'SELECT contract, collection_name, schema_name FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [contract, delta.value.template_id]
            );

            if (templateQuery.rowCount > 0) {
                await db.update('atomicassets_templates', {
                    transferable: delta.value.transferable,
                    burnable: delta.value.burnable,
                    max_supply: delta.value.max_supply,
                    issued_supply: delta.value.issued_supply,
                    deleted_at_block: !delta.present ? block.block_num : null,
                    deleted_at_time: !delta.present ? eosioTimestampToDate(block.timestamp).getTime() : null,
                }, {
                    str: 'contract = $1 AND template_id = $2',
                    values: [contract, delta.value.template_id]
                }, ['contract', 'template_id']);
            } else {
                // A delete (deltemplate) delta for a template we never indexed has
                // nothing to mark deleted - skip rather than insert a deleted
                // placeholder row.
                if (!delta.present) {
                    return;
                }

                const schemaQuery = await db.query(
                    'SELECT format FROM atomicassets_schemas WHERE contract = $1 AND collection_name = $2 AND schema_name = $3',
                    [contract, delta.scope, delta.value.schema_name]
                );

                if (schemaQuery.rowCount === 0) {
                    throw new Error('AtomicAssets: Schema of template not found. Should not be possible by contract');
                }

                const immutableData = deserialize(delta.value.immutable_serialized_data, CachedObjectSchema(schemaQuery.rows[0].format));

                await db.insert('atomicassets_templates', {
                    contract: contract,
                    template_id: delta.value.template_id,
                    collection_name: delta.scope,
                    schema_name: delta.value.schema_name,
                    transferable: delta.value.transferable,
                    burnable: delta.value.burnable,
                    max_supply: delta.value.max_supply,
                    issued_supply: delta.value.issued_supply,
                    immutable_data: encodeDatabaseJson(immutableData),
                    created_at_block: block.block_num,
                    created_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                    deleted_at_block: !delta.present ? block.block_num : null,
                    deleted_at_time: !delta.present ? eosioTimestampToDate(block.timestamp).getTime() : null,
                }, ['contract', 'template_id'], true, true, 'update');
            }
        }, AtomicAssetsUpdatePriority.TABLE_TEMPLATES.valueOf()
    ));

    // v2: mutable template data lives in the contract's `templates2` table
    // (template_mutables; see include/atomicassets.hpp:405 + atomicassets.abi).
    // NOTE: the on-chain table is `templates2`, NOT `tmplmutables` (the upstream
    // OIG branch subscribed to a non-existent name, which silently dropped the
    // whole feature). A non-present delta = the row was cleared (settempldata to
    // empty) or the template was deleted (deltemplate erases the templates2 row)
    // -> NULL the mutable_data instead of re-writing stale data.
    destructors.push(processor.onContractRow(
        contract, 'templates2',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<MutableTemplatesTableRow>): Promise<void> => {
            if (!delta.present) {
                await db.update('atomicassets_templates', {
                    mutable_data: null,
                }, {
                    str: 'contract = $1 AND template_id = $2',
                    values: [contract, delta.value.template_id]
                }, ['contract', 'template_id']);

                return;
            }

            const schemaQuery = await db.query(
                'SELECT format FROM atomicassets_schemas WHERE contract = $1 AND collection_name = $2 AND schema_name = $3',
                [contract, delta.scope, delta.value.schema_name]
            );

            if (schemaQuery.rowCount === 0) {
                throw new Error('AtomicAssets: Schema of template not found. Should not be possible by contract');
            }

            const mutableData = deserialize(delta.value.mutable_serialized_data, CachedObjectSchema(schemaQuery.rows[0].format));

            await db.update('atomicassets_templates', {
                mutable_data: encodeDatabaseJson(mutableData),
            }, {
                str: 'contract = $1 AND template_id = $2',
                values: [contract, delta.value.template_id]
            }, ['contract', 'template_id']);
        }, AtomicAssetsUpdatePriority.TABLE_TEMPLATES.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

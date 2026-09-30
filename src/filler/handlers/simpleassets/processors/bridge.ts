import { convertAttributeMapToObject } from '@atomichub/atomicassets';
import { ClientBase } from 'pg';

import SimpleAssetsHandler, { SimpleAssetsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { LogMintAssetActionData } from '../../atomicassets/types/actions';
import logger from '../../../../utils/winston';

export const ORIGINAL_MINTS_TABLE = 'atomicassets_original_mints';

/**
 * Whether the atomicassets handler's link table exists. It belongs to that
 * handler, so a database set up without it has none.
 */
export async function originalMintsTableExists(client: ClientBase): Promise<boolean> {
    const query = await client.query('SELECT to_regclass($1) IS NOT NULL AS "exists"', ['public.' + ORIGINAL_MINTS_TABLE]);

    return query.rows[0].exists;
}

const MAX_BIGINT = BigInt('9223372036854775807');

/**
 * The SimpleAssets asset id a bridge mint carries in its immutable data, or
 * null when it carries none that fits the bigint column.
 */
function readSassetsId(immutableData: Record<string, any>): string | null {
    const value = immutableData?.sassets_id;

    if (value === undefined || value === null) {
        return null;
    }

    const id = String(value);

    if (!/^[0-9]{1,19}$/.test(id) || BigInt(id) > MAX_BIGINT) {
        return null;
    }

    return id;
}

export function bridgeProcessor(core: SimpleAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.simpleassets_account;
    const atomicassetsContract = core.args.atomicassets_account;
    const bridgeAccount = core.args.bridge_account;

    if (!bridgeAccount) {
        return (): any => destructors.map(fn => fn());
    }

    destructors.push(processor.onActionTrace(
        atomicassetsContract, 'logmint',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogMintAssetActionData>): Promise<void> => {
            if (trace.act.data.authorized_minter !== bridgeAccount) {
                return;
            }

            const immutableData = convertAttributeMapToObject(trace.act.data.immutable_data ?? []);
            const originalAssetId = readSassetsId(immutableData);

            if (originalAssetId === null) {
                if (immutableData.sassets_id !== undefined) {
                    logger.warn('SimpleAssets: bridge mint carries a sassets_id that is not an asset id', {
                        asset_id: trace.act.data.asset_id, sassets_id: immutableData.sassets_id
                    });
                }

                return;
            }

            const mintQuery = await db.query(
                'SELECT mint_number FROM simpleassets_assets WHERE contract = $1 AND asset_id = $2',
                [contract, originalAssetId]
            );
            const originalMint = mintQuery.rowCount > 0 ? mintQuery.rows[0].mint_number : null;

            if (originalMint === null) {
                // The create always precedes the bridge mint, so this is a gap in the imported data.
                logger.warn('SimpleAssets: bridged asset has no mint number, linking it with none', {
                    asset_id: trace.act.data.asset_id, original_asset_id: originalAssetId,
                    stored: mintQuery.rowCount > 0
                });
            }

            // A pair never changes after the mint, so a replay keeps the first row.
            await db.insert(ORIGINAL_MINTS_TABLE, {
                contract: atomicassetsContract,
                asset_id: trace.act.data.asset_id,
                original_contract: contract,
                original_asset_id: originalAssetId,
                original_mint: originalMint,
                block_num: block.block_num
            }, ['contract', 'asset_id'], true, true, 'nothing');
        }, SimpleAssetsUpdatePriority.ACTION_LINK_BRIDGE_MINT.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

import SimpleAssetsHandler, { SimpleAssetsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { eosioTimestampToDate } from '../../../../utils/eosio';
import { arrayChunk } from '../../../../utils';
import {
    BurnLogActionData,
    ChangeAuthorActionData,
    ClaimActionData,
    CreateLogActionData,
    TransferActionData,
    UpdateActionData
} from '../types/actions';
import { parseJsonObject } from '../../../../utils/binary';
import { encodeDatabaseJson } from '../../../utils';
import logger from '../../../../utils/winston';

type PendingCreate = {
    assetId: string,
    author: string,
    category: string,
    owner: string,
    mutableData: Record<string, any>,
    immutableData: Record<string, any>,
    mintGroup: string | null,
    blockNum: number,
    blockTime: number,
};

/**
 * The card group an asset's ordinal counts in: a JSON array of the create's
 * category, then each configured mutable data field as a string, a missing
 * field as the empty string. A JSON array keeps values that contain the
 * separator apart. Readers match stored groups on this exact form.
 */
export function cardGroupKey(category: string, mutableData: Record<string, any>, fields: string[]): string {
    return JSON.stringify([category, ...fields.map(field => String((mutableData ?? {})[field] ?? ''))]);
}

function compareCreates(a: PendingCreate, b: PendingCreate): number {
    if (a.blockNum !== b.blockNum) {
        return a.blockNum - b.blockNum;
    }

    // Asset ids exceed Number.MAX_SAFE_INTEGER.
    const left = BigInt(a.assetId);
    const right = BigInt(b.assetId);

    return left < right ? -1 : (left > right ? 1 : 0);
}

export function assetProcessor(core: SimpleAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.simpleassets_account;

    const numberedAuthors = core.args.numbered_authors ?? [];
    const groupFields = core.args.numbered_group_fields ?? [];

    // Creates wait for the end of the mint priority so one block's creates in a
    // group get consecutive ordinals in asset id order. The queue runs every
    // create in the commit batch before any action that changes an asset.
    let pendingCreates: PendingCreate[] = [];

    async function readBaselineBlock(db: ContractDBTransaction): Promise<number | null> {
        const query = await db.query(
            'SELECT bootstrap_baseline_block FROM simpleassets_config WHERE contract = $1',
            [contract]
        );

        if (query.rowCount === 0 || query.rows[0].bootstrap_baseline_block === null) {
            return null;
        }

        return Number(query.rows[0].bootstrap_baseline_block);
    }

    async function assignMintNumbers(db: ContractDBTransaction, creates: PendingCreate[]): Promise<Map<string, number>> {
        const mints = new Map<string, number>();
        const numbered = creates.filter(create => create.mintGroup !== null);

        if (numbered.length === 0) {
            return mints;
        }

        // Without a baseline the imported totals are unknown, so no ordinal can be right.
        const baselineBlock = await readBaselineBlock(db);

        if (baselineBlock === null) {
            return mints;
        }

        const groups = new Map<string, PendingCreate[]>();

        for (const create of numbered.filter(row => row.blockNum > baselineBlock)) {
            const key = JSON.stringify([create.author, create.mintGroup]);

            const group = groups.get(key);

            if (group) {
                group.push(create);
            } else {
                groups.set(key, [create]);
            }
        }

        for (const groupCreates of groups.values()) {
            groupCreates.sort(compareCreates);

            const {author, mintGroup} = groupCreates[0];
            const condition = {
                str: 'contract = $1 AND author = $2 AND mint_group = $3',
                values: [contract, author, mintGroup]
            };
            const totalQuery = await db.query(
                'SELECT total_ever FROM simpleassets_card_totals WHERE ' + condition.str, condition.values
            );
            const base = totalQuery.rowCount > 0 ? Number(totalQuery.rows[0].total_ever) : 0;

            groupCreates.forEach((create, index) => mints.set(create.assetId, base + index + 1));

            if (totalQuery.rowCount > 0) {
                await db.update('simpleassets_card_totals', {
                    total_ever: base + groupCreates.length
                }, condition, ['contract', 'author', 'mint_group']);
            } else {
                // The import seeds every known group, so a gap there must be visible.
                logger.warn('SimpleAssets: no card totals row for group, numbering from 1', {
                    contract, author, mint_group: mintGroup
                });

                await db.insert('simpleassets_card_totals', {
                    contract, author, mint_group: mintGroup, total_ever: groupCreates.length
                }, ['contract', 'author', 'mint_group']);
            }
        }

        return mints;
    }

    async function flushCreates(db: ContractDBTransaction): Promise<void> {
        const creates = [...new Map(pendingCreates.map(create => [create.assetId, create])).values()];
        pendingCreates = [];

        if (creates.length === 0) {
            return;
        }

        // A stored asset was numbered and counted when it was first written, so
        // skipping it is what makes a replayed create leave total_ever alone.
        const existingQuery = await db.query(
            'SELECT asset_id FROM simpleassets_assets WHERE contract = $1 AND asset_id = ANY($2::bigint[])',
            [contract, creates.map(create => create.assetId)]
        );
        const existing = new Set(existingQuery.rows.map(row => String(row.asset_id)));
        const newCreates = creates.filter(create => !existing.has(create.assetId));

        if (newCreates.length === 0) {
            return;
        }

        const mints = await assignMintNumbers(db, newCreates);
        const rows = newCreates.map(create => ({
            contract: contract,
            asset_id: create.assetId,
            author: create.author,
            category: create.category,
            owner: create.owner,
            mint_number: mints.get(create.assetId) ?? null,
            mint_group: create.mintGroup,
            mutable_data: encodeDatabaseJson(create.mutableData),
            immutable_data: encodeDatabaseJson(create.immutableData),
            burned_by_account: null,
            burned_at_block: null,
            burned_at_time: null,
            transferred_at_block: create.blockNum,
            transferred_at_time: create.blockTime,
            updated_at_block: create.blockNum,
            updated_at_time: create.blockTime,
            minted_at_block: create.blockNum,
            minted_at_time: create.blockTime
        }));

        for (const chunk of arrayChunk(rows, 50)) {
            await db.insert('simpleassets_assets', chunk, ['contract', 'asset_id'], true, true, 'nothing');
        }
    }

    destructors.push(processor.onActionTrace(
        contract, 'createlog',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CreateLogActionData>): Promise<void> => {
            const mutableData = parseJsonObject(trace.act.data.mdata);

            pendingCreates.push({
                assetId: String(trace.act.data.assetid),
                author: trace.act.data.author,
                category: trace.act.data.category,
                owner: trace.act.data.owner,
                mutableData,
                immutableData: parseJsonObject(trace.act.data.idata),
                mintGroup: numberedAuthors.includes(trace.act.data.author)
                    ? cardGroupKey(trace.act.data.category, mutableData, groupFields)
                    : null,
                blockNum: block.block_num,
                blockTime: eosioTimestampToDate(block.timestamp).getTime()
            });
        }, SimpleAssetsUpdatePriority.ACTION_MINT_ASSET.valueOf()
    ));

    destructors.push(processor.onPriorityComplete(SimpleAssetsUpdatePriority.ACTION_MINT_ASSET.valueOf(),
        async (db: ContractDBTransaction) => flushCreates(db), SimpleAssetsUpdatePriority.ACTION_MINT_ASSET.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'burnlog',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<BurnLogActionData>): Promise<void> => {
            await db.update('simpleassets_assets', {
                owner: null,
                burned_by_account: trace.act.data.owner,
                burned_at_block: block.block_num,
                burned_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND asset_id = ANY($2) AND updated_at_block <= $3',
                values: [contract, trace.act.data.assetids, block.block_num]
            }, ['contract', 'asset_id']);
        }, SimpleAssetsUpdatePriority.ACTION_UPDATE_ASSET.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'update',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<UpdateActionData>): Promise<void> => {
            await db.update('simpleassets_assets', {
                mutable_data: encodeDatabaseJson(parseJsonObject(trace.act.data.mdata)),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND asset_id = $2 AND updated_at_block <= $3',
                values: [contract, trace.act.data.assetid, block.block_num]
            }, ['contract', 'asset_id']);
        }, SimpleAssetsUpdatePriority.ACTION_UPDATE_ASSET.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'changeauthor',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ChangeAuthorActionData>): Promise<void> => {
            await db.update('simpleassets_assets', {
                author: trace.act.data.newauthor,
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND asset_id = ANY($2) AND updated_at_block <= $3',
                values: [contract, trace.act.data.assetids, block.block_num]
            }, ['contract', 'asset_id']);
        }, SimpleAssetsUpdatePriority.ACTION_UPDATE_ASSET.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'transfer',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<TransferActionData>): Promise<void> => {
            await db.update('simpleassets_assets', {
                owner: trace.act.data.to,
                transferred_at_block: block.block_num,
                transferred_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND asset_id = ANY ($2) AND owner = $3 AND updated_at_block <= $4',
                values: [contract, trace.act.data.assetids, trace.act.data.from, block.block_num]
            }, ['contract', 'asset_id']);

            if (core.args.store_transfers) {
                await db.insert('simpleassets_transfers', {
                    contract: contract,
                    transfer_id: trace.global_sequence,
                    sender: trace.act.data.from,
                    recipient: trace.act.data.to,
                    memo: String(trace.act.data.memo).substr(0, 256),
                    txid: Buffer.from(tx.id, 'hex'),
                    created_at_block: block.block_num,
                    created_at_time: eosioTimestampToDate(block.timestamp).getTime()
                }, ['contract', 'transfer_id'], true, true, 'update');

                await db.insert('simpleassets_transfers_assets', trace.act.data.assetids.map((assetID, index) => ({
                    transfer_id: trace.global_sequence,
                    contract: contract,
                    index: index + 1,
                    asset_id: assetID
                })), ['contract', 'transfer_id', 'asset_id'], true, true, 'update');
            }
        }, SimpleAssetsUpdatePriority.ACTION_UPDATE_ASSET.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'claim',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimActionData>): Promise<void> => {
            // Read before the update below, which overwrites the owner the record needs.
            // One transfer row records one sender, so a claim of several offerers takes the lowest id.
            const fromQuery = core.args.store_transfers ? await db.query(
                'SELECT owner FROM simpleassets_assets WHERE contract = $1 AND asset_id = ANY($2) ORDER BY asset_id',
                [contract, trace.act.data.assetids]
            ) : null;

            await db.update('simpleassets_assets', {
                owner: trace.act.data.claimer,
                transferred_at_block: block.block_num,
                transferred_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
            }, {
                str: 'contract = $1 AND asset_id = ANY ($2) AND updated_at_block <= $3',
                values: [contract, trace.act.data.assetids, block.block_num]
            }, ['contract', 'asset_id']);

            if (core.args.store_transfers) {
                // A replay reads the claimer as the owner, so the first write keeps the sender.
                await db.insert('simpleassets_transfers', {
                    contract: contract,
                    transfer_id: trace.global_sequence,
                    sender: fromQuery.rowCount > 0 ? fromQuery.rows[0].owner : '.',
                    recipient: trace.act.data.claimer,
                    memo: '',
                    txid: Buffer.from(tx.id, 'hex'),
                    created_at_block: block.block_num,
                    created_at_time: eosioTimestampToDate(block.timestamp).getTime()
                }, ['contract', 'transfer_id'], true, true, 'nothing');

                await db.insert('simpleassets_transfers_assets', trace.act.data.assetids.map((assetID, index) => ({
                    transfer_id: trace.global_sequence,
                    contract: contract,
                    index: index + 1,
                    asset_id: assetID
                })), ['contract', 'transfer_id', 'asset_id'], true, true, 'update');
            }
        }, SimpleAssetsUpdatePriority.ACTION_UPDATE_ASSET.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

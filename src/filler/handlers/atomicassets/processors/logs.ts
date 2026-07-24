import AtomicAssetsHandler, { AtomicAssetsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { AuthorSwapsTableRow } from '../types/tables';
import logger from '../../../../utils/winston';
import {
    AcceptAuthorSwapActionData,
    AcceptOfferActionData,
    AddColAuthActionData,
    CancelOfferActionData,
    CreateAuthorSwapActionData,
    CreateColActionData, CreateSchemaActionData,
    DeclineOfferActionData,
    DeleteTemplateActionData,
    ExtendSchemaActionData,
    ForbidNotifyActionData, LockTemplateActionData,
    LogBackAssetActionData,
    LogBurnAssetActionData,
    LogMintAssetActionData,
    LogNewOfferActionData,
    LogNewTemplateActionData,
    LogSetDataActionData,
    LogSetSchemaTypeActionData,
    LogSetTemplateDataActionData,
    ReduceTemplateMaxSupplyActionData,
    RejectAuthorSwapActionData,
    RemColAuthActionData,
    RemNotifyAccActionData,
    SetColDataActionData,
    SetMarketFeeActionData
} from '../types/actions';

/**
 * Per-commit-batch bookkeeping for the author-swap log handlers.
 *
 * The queue in DataProcessor.executeHeadQueue runs strictly by ascending
 * priority, so every log handler (LOGS = 0) runs before any table delta of
 * the same commit batch (TABLE_COLLECTIONS = 20). Two consequences drive the
 * shape below:
 *
 * - A read of atomicassets_collections inside a log handler sees the state
 *   BEFORE any of this batch's deltas: `author` is still the pre-swap author
 *   and `new_author_name` still holds the pending swap - exactly the values
 *   accept/reject metadata needs. The ledger maps only cover swaps created or
 *   resolved earlier in the SAME batch (possible for owner-permission swaps,
 *   whose acceptance_date is immediate), where the database cannot know yet.
 *
 * - createauswap's acceptance_date is computed by the contract (it is not an
 *   action argument), so it only exists in the block's authorswaps delta,
 *   which runs after the log handler. The log entry is therefore deferred and
 *   completed by the authorswaps capture listener. SHIP deltas carry the row
 *   value on removals too, so even a swap created and resolved within one
 *   block enriches from its removal delta; only entries whose delta never
 *   surfaces at all are flushed at commit without acceptance_date.
 *
 * Keyed by transaction: one ContractDBTransaction spans exactly one commit
 * batch, and the commit listener drops the entry, so no state can leak into
 * the next batch or survive an abort.
 */
type AuswapBatchState = {
    pendingNewAuthor: Map<string, string>,
    authorOverride: Map<string, string>,
    deferredCreates: Array<{
        block: ShipBlock,
        tx: EosioTransaction,
        trace: EosioActionTrace<CreateAuthorSwapActionData>
    }>
};

export function logProcessor(core: AtomicAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicassets_account;

    const auswapState = new WeakMap<ContractDBTransaction, AuswapBatchState>();

    const getAuswapState = (db: ContractDBTransaction): AuswapBatchState => {
        let state = auswapState.get(db);

        if (!state) {
            state = {pendingNewAuthor: new Map(), authorOverride: new Map(), deferredCreates: []};
            auswapState.set(db, state);
        }

        return state;
    };

    const fetchCollectionRow = async (
        db: ContractDBTransaction, collectionName: string
    ): Promise<{author: string, new_author_name: string | null} | null> => {
        try {
            const query = await db.query(
                'SELECT author, new_author_name FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2',
                [contract, collectionName]
            );

            return query.rows[0] ?? null;
        } catch (error) {
            // A log handler must never throw over missing enrichment data. If
            // the transaction itself is broken this read is not what surfaces
            // it - the commit will fail and the batch replays.
            logger.warn('AtomicAssets: could not read collection ' + collectionName + ' for auswap log metadata', error);

            return null;
        }
    };

    const buildSwapResolutionMetadata = async (
        db: ContractDBTransaction, trace: EosioActionTrace<AcceptAuthorSwapActionData | RejectAuthorSwapActionData>
    ): Promise<{metadata: {[key: string]: any}, newAuthor: string | null}> => {
        const collectionName = trace.act.data.collection_name;
        const state = getAuswapState(db);
        const row = await fetchCollectionRow(db, collectionName);

        const newAuthor = state.pendingNewAuthor.get(collectionName) ?? row?.new_author_name ?? null;
        const priorAuthor = state.authorOverride.get(collectionName) ?? row?.author ?? null;
        const actor = trace.act.authorization?.[0]?.actor ?? null;

        const metadata: {[key: string]: any} = {collection_name: collectionName};

        if (newAuthor) {
            metadata.new_author = newAuthor;
        }

        if (priorAuthor) {
            metadata.prior_author = priorAuthor;
        }

        if (actor) {
            metadata.actor = actor;
        }

        state.pendingNewAuthor.delete(collectionName);

        return {metadata, newAuthor};
    };

    /* OFFERS */
    destructors.push(processor.onActionTrace(
        contract, 'lognewoffer',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewOfferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                offer_id: trace.act.data.offer_id
            });
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'acceptoffer',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<AcceptOfferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'declineoffer',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<DeclineOfferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'canceloffer',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CancelOfferActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    /* ASSETS */
    destructors.push(processor.onActionTrace(
        contract, 'logmint',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogMintAssetActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                asset_id: trace.act.data.asset_id,
                new_asset_owner: trace.act.data.new_asset_owner,
                authorized_minter: trace.act.data.authorized_minter
            });
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logburnasset',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogBurnAssetActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                asset_id: trace.act.data.asset_id,
                asset_owner: trace.act.data.asset_owner,
                backed_tokens: trace.act.data.backed_tokens
            });
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logbackasset',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogBackAssetActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                asset_id: trace.act.data.asset_id,
                backed_token: trace.act.data.backed_token
            });
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logsetdata',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogSetDataActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                asset_id: trace.act.data.asset_id,
                old_data: trace.act.data.old_data,
                new_data: trace.act.data.new_data
            });
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    /* COLLECTIONS */
    destructors.push(processor.onActionTrace(
        contract, 'createcol',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CreateColActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'addcolauth',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<AddColAuthActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'forbidnotify',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ForbidNotifyActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'remcolauth',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<RemColAuthActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'remnotifyacc',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<RemNotifyAccActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setmarketfee',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<SetMarketFeeActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setcoldata',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<SetColDataActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'createauswap',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CreateAuthorSwapActionData>): Promise<void> => {
            const state = getAuswapState(db);

            state.pendingNewAuthor.set(trace.act.data.collection_name, trace.act.data.new_author);
            state.deferredCreates.push({block, tx, trace});
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'acceptauswap',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<AcceptAuthorSwapActionData>): Promise<void> => {
            const {metadata, newAuthor} = await buildSwapResolutionMetadata(db, trace);

            await db.logTrace(block, tx, trace, metadata);

            if (newAuthor) {
                getAuswapState(db).authorOverride.set(trace.act.data.collection_name, newAuthor);
            }
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'rejectauswap',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<RejectAuthorSwapActionData>): Promise<void> => {
            const {metadata} = await buildSwapResolutionMetadata(db, trace);

            await db.logTrace(block, tx, trace, metadata);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    // Completes deferred createauswap log entries with the acceptance_date
    // (seconds since epoch, as stored on chain) that only the table row
    // carries. Runs in addition to the collections processor's authorswaps
    // listener and never writes table data itself. Removal deltas carry the
    // row value just like creations, so both presence states use the same
    // matching rule: a delta at block B belongs to the latest still-deferred
    // createauswap at or before B for the same collection and proposed
    // author - for a removal that is the swap born and erased in this batch.
    destructors.push(processor.onContractRow(
        contract, 'authorswaps',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<AuthorSwapsTableRow>): Promise<void> => {
            const state = auswapState.get(db);

            if (!state) {
                return;
            }

            for (let i = state.deferredCreates.length - 1; i >= 0; i--) {
                const entry = state.deferredCreates[i];

                if (
                    entry.trace.act.data.collection_name !== delta.value.collection_name ||
                    entry.trace.act.data.new_author !== delta.value.new_author ||
                    entry.block.block_num > block.block_num
                ) {
                    continue;
                }

                state.deferredCreates.splice(i, 1);

                await db.logTrace(entry.block, entry.tx, entry.trace, {
                    collection_name: entry.trace.act.data.collection_name,
                    new_author: entry.trace.act.data.new_author,
                    owner: entry.trace.act.data.owner,
                    acceptance_date: delta.value.acceptance_date
                });

                return;
            }
        }, AtomicAssetsUpdatePriority.TABLE_COLLECTIONS.valueOf()
    ));

    destructors.push(processor.onCommit(
        async (db: ContractDBTransaction): Promise<void> => {
            const state = auswapState.get(db);

            if (!state) {
                return;
            }

            for (const entry of state.deferredCreates) {
                await db.logTrace(entry.block, entry.tx, entry.trace, {
                    collection_name: entry.trace.act.data.collection_name,
                    new_author: entry.trace.act.data.new_author,
                    owner: entry.trace.act.data.owner
                });
            }

            auswapState.delete(db);
        }
    ));

    /* TEMPLATES */
    destructors.push(processor.onActionTrace(
        contract, 'lognewtempl',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewTemplateActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                collection_name: trace.act.data.collection_name,
                template_id: trace.act.data.template_id,
                authorized_creator: trace.act.data.authorized_creator,
                max_supply: trace.act.data.max_supply
            });
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'locktemplate',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LockTemplateActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'deltemplate',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<DeleteTemplateActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'redtemplmax',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ReduceTemplateMaxSupplyActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'logsetdatatl',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogSetTemplateDataActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    /* SCHEMAS */
    destructors.push(processor.onActionTrace(
        contract, 'createschema',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CreateSchemaActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'extendschema',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ExtendSchemaActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        contract, 'setschematyp',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogSetSchemaTypeActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, trace.act.data);
        }, AtomicAssetsUpdatePriority.LOGS.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

import AtomicAssetsHandler, { AtomicAssetsUpdatePriority } from '../index';
import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { EosioContractRow } from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import { ConfigTableRow, TokenConfigsTableRow } from '../types/tables';

export function configProcessor(core: AtomicAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicassets_account;

    destructors.push(processor.onContractRow(
        contract, 'config',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<ConfigTableRow>): Promise<void> => {
            if (!delta.present) {
                throw new Error('AtomicAssets: config row was deleted. Should not be possible by contract');
            }

            if (core.config.supported_tokens.length !== delta.value.supported_tokens.length) {
                const tokens = core.config.supported_tokens.map((row: {sym: string, contract: string}) => row.sym);

                for (const token of delta.value.supported_tokens) {
                    const index = tokens.indexOf(token.sym);

                    if (index === -1) {
                        // ON CONFLICT DO NOTHING — the in-memory `tokens` list
                        // and the on-DB row set can diverge across restarts
                        // (e.g., when init re-loads supported_tokens from the
                        // DB and a config delta is replayed in catch-up mode).
                        // The init path at handlers/atomicassets/index.ts:175
                        // already uses ON CONFLICT DO NOTHING explicitly; mirror
                        // it here so the delta-time replay is equally idempotent.
                        // 2026-05-10 jungle4 stall (block 52023599) was the
                        // reproducer: 23505 → TRANSIENT_PG_CODES retry →
                        // double-release → consumer queue paused. The token
                        // row's content is fixed by the chain (precision is
                        // immutable per symbol), so DO NOTHING is correct.
                        await db.insert('atomicassets_tokens', {
                            contract: contract,
                            token_symbol: token.sym.split(',')[1],
                            token_contract: token.contract,
                            token_precision: token.sym.split(',')[0]
                        }, ['contract', 'token_symbol'], true, true, 'nothing');
                    }
                }
            }

            if (core.config.collection_format.length !== delta.value.collection_format.length) {
                await db.update('atomicassets_config', {
                    collection_format: delta.value.collection_format.map((element: any) => JSON.stringify(element))
                }, {
                    str: 'contract = $1',
                    values: [contract]
                }, ['contract']);
            }

            core.config = delta.value;
        }, AtomicAssetsUpdatePriority.TABLE_CONFIG.valueOf()
    ));

    destructors.push(processor.onContractRow(
        contract, 'tokenconfigs',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<TokenConfigsTableRow>): Promise<void> => {
            if (!delta.present) {
                throw new Error('AtomicAssets: tokenconfigs row was deleted. Should not be possible by contract');
            }

            if (core.tokenconfigs.version !== delta.value.version) {
                await db.update('atomicassets_config', {
                    version: delta.value.version
                }, {
                    str: 'contract = $1',
                    values: [contract]
                }, ['contract']);
            }

            core.tokenconfigs = delta.value;
        }, AtomicAssetsUpdatePriority.TABLE_CONFIG.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}

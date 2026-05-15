import * as fs from 'fs';
import { PoolClient } from 'pg';

import { ContractHandler } from '../interfaces';
import logger from '../../../utils/winston';
import Filler from '../../filler';
import DataProcessor from '../../processor';
import { ATOMICASSETS_BASE_PRIORITY } from '../atomicassets';
import { packsProcessor } from './processors/packs';
import { rollsProcessor } from './processors/rolls';
import { claimsProcessor } from './processors/claims';
import { logProcessor } from './processors/logs';

export const ATOMICPACKS_BASE_PRIORITY = ATOMICASSETS_BASE_PRIORITY + 1000;

export type AtomicPacksArgs = {
    atomicpacksx_account: string,
    atomicassets_account: string,
    store_logs: boolean,
};

export enum AtomicPacksUpdatePriority {
    TABLE_CONFIG = ATOMICPACKS_BASE_PRIORITY + 10,
    ACTION_CREATE_PACK = ATOMICPACKS_BASE_PRIORITY + 20,
    ACTION_UPDATE_PACK = ATOMICPACKS_BASE_PRIORITY + 30,
    ACTION_CREATE_ROLL = ATOMICPACKS_BASE_PRIORITY + 20,
    ACTION_UPDATE_ROLL = ATOMICPACKS_BASE_PRIORITY + 30,
    ACTION_CREATE_CLAIM = ATOMICPACKS_BASE_PRIORITY + 40,
    ACTION_UPDATE_CLAIM = ATOMICPACKS_BASE_PRIORITY + 50,
    LOGS = ATOMICPACKS_BASE_PRIORITY,
}

export enum ClaimState {
    CLAIMED = 0,
    RESOLVED = 1,
    CANCELLED = 2,
}

export default class AtomicPacksHandler extends ContractHandler {
    static handlerName = 'atomicpacksx';

    declare readonly args: AtomicPacksArgs;

    static async setup(client: PoolClient): Promise<boolean> {
        const existsQuery = await client.query(
            'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2)',
            ['public', 'atomicpacksx_config'],
        );

        const views = ['atomicpacksx_packs_master', 'atomicpacksx_claims_master'];

        if (!existsQuery.rows[0].exists) {
            logger.info('Could not find AtomicPacks tables. Create them now...');

            await client.query(fs.readFileSync('./definitions/tables/atomicpacksx_tables.sql', {
                encoding: 'utf8',
            }));

            for (const view of views) {
                await client.query(fs.readFileSync('./definitions/views/' + view + '.sql', { encoding: 'utf8' }));
            }

            logger.info('AtomicPacks tables successfully created');
            return true;
        }

        return false;
    }

    static async upgrade(client: PoolClient, version: string): Promise<void> {
        if (version === '1.5.1') {
            // Re-run the view DDL — the column list changed (template_id
            // added to result_assets json_agg). CREATE OR REPLACE works
            // because no column types changed in the SELECT signature.
            await client.query(
                fs.readFileSync('./definitions/views/atomicpacksx_claims_master.sql', { encoding: 'utf8' }),
            );
            logger.info('AtomicPacks 1.5.1 master view refreshed');
        }
    }

    constructor(filler: Filler, args: { [key: string]: any }) {
        super(filler, args);

        if (typeof args.atomicpacksx_account !== 'string') {
            throw new Error('AtomicPacks: Argument missing in atomicpacksx handler: atomicpacksx_account');
        }
        if (typeof args.atomicassets_account !== 'string') {
            // Default to the canonical contract name so chain configs that
            // don't explicitly set this keep working.
            args.atomicassets_account = 'atomicassets';
        }
    }

    async init(client: PoolClient): Promise<void> {
        const configQuery = await client.query(
            'SELECT * FROM atomicpacksx_config WHERE contract = $1',
            [this.args.atomicpacksx_account],
        );

        if (configQuery.rows.length === 0) {
            // Pack contract has no version table to seed from on-chain;
            // record the contract account so downstream introspection works.
            await client.query(
                'INSERT INTO atomicpacksx_config (contract, version) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [this.args.atomicpacksx_account, '1.0.0'],
            );
        }
    }

    async deleteDB(client: PoolClient): Promise<void> {
        const tables = [
            'atomicpacksx_claim_assets',
            'atomicpacksx_claims',
            'atomicpacksx_pack_rolls',
            'atomicpacksx_packs',
            'atomicpacksx_config',
        ];

        for (const table of tables) {
            await client.query(
                'DELETE FROM ' + client.escapeIdentifier(table) + ' WHERE contract = $1',
                [this.args.atomicpacksx_account],
            );
        }
    }

    async register(processor: DataProcessor): Promise<() => any> {
        const destructors: Array<() => any> = [];

        destructors.push(packsProcessor(this, processor));
        destructors.push(rollsProcessor(this, processor));
        destructors.push(claimsProcessor(this, processor));

        if (this.args.store_logs) {
            destructors.push(logProcessor(this, processor));
        }

        return (): any => destructors.map(fn => fn());
    }
}

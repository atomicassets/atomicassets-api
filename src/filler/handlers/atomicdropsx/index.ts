import * as fs from 'fs';
import { PoolClient } from 'pg';

import { ContractHandler } from '../interfaces';
import logger from '../../../utils/winston';
import Filler from '../../filler';
import DataProcessor from '../../processor';
import { ATOMICASSETS_BASE_PRIORITY } from '../atomicassets';
import { dropsProcessor } from './processors/drops';
import { claimsProcessor } from './processors/claims';
import { logProcessor } from './processors/logs';

const ATOMICDROPS_BASE_PRIORITY = ATOMICASSETS_BASE_PRIORITY + 2000;

export type AtomicDropsArgs = {
    atomicdropsx_account: string,
    atomicassets_account: string,
    store_logs: boolean,
};

export enum AtomicDropsUpdatePriority {
    TABLE_CONFIG = ATOMICDROPS_BASE_PRIORITY + 10,
    ACTION_CREATE_DROP = ATOMICDROPS_BASE_PRIORITY + 20,
    ACTION_UPDATE_DROP = ATOMICDROPS_BASE_PRIORITY + 30,
    ACTION_CLAIM = ATOMICDROPS_BASE_PRIORITY + 40,
    LOGS = ATOMICDROPS_BASE_PRIORITY,
}

export default class AtomicDropsHandler extends ContractHandler {
    static handlerName = 'atomicdropsx';

    declare readonly args: AtomicDropsArgs;

    static async setup(client: PoolClient): Promise<boolean> {
        const existsQuery = await client.query(
            'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2)',
            ['public', 'atomicdropsx_config'],
        );

        const views = ['atomicdropsx_drops_master', 'atomicdropsx_claims_master'];

        if (!existsQuery.rows[0].exists) {
            logger.info('Could not find AtomicDrops tables. Create them now...');

            await client.query(fs.readFileSync('./definitions/tables/atomicdropsx_tables.sql', {
                encoding: 'utf8',
            }));

            for (const view of views) {
                await client.query(fs.readFileSync('./definitions/views/' + view + '.sql', { encoding: 'utf8' }));
            }

            logger.info('AtomicDrops tables successfully created');
            return true;
        }

        return false;
    }

    static async upgrade(_client: PoolClient, _version: string): Promise<void> {
        return;
    }

    constructor(filler: Filler, args: { [key: string]: any }) {
        super(filler, args);

        if (typeof args.atomicdropsx_account !== 'string') {
            throw new Error('AtomicDrops: Argument missing in atomicdropsx handler: atomicdropsx_account');
        }
        if (typeof args.atomicassets_account !== 'string') {
            args.atomicassets_account = 'atomicassets';
        }
    }

    async init(client: PoolClient): Promise<void> {
        const configQuery = await client.query(
            'SELECT * FROM atomicdropsx_config WHERE contract = $1',
            [this.args.atomicdropsx_account],
        );

        if (configQuery.rows.length === 0) {
            await client.query(
                'INSERT INTO atomicdropsx_config (contract, version) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [this.args.atomicdropsx_account, '1.0.0'],
            );
        }
    }

    async deleteDB(client: PoolClient): Promise<void> {
        const tables = [
            'atomicdropsx_claims',
            'atomicdropsx_drops',
            'atomicdropsx_config',
        ];

        for (const table of tables) {
            await client.query(
                'DELETE FROM ' + client.escapeIdentifier(table) + ' WHERE contract = $1',
                [this.args.atomicdropsx_account],
            );
        }
    }

    async register(processor: DataProcessor): Promise<() => any> {
        const destructors: Array<() => any> = [];

        destructors.push(dropsProcessor(this, processor));
        destructors.push(claimsProcessor(this, processor));

        if (this.args.store_logs) {
            destructors.push(logProcessor(this, processor));
        }

        return (): any => destructors.map(fn => fn());
    }
}

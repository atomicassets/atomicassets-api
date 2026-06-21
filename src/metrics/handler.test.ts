import * as os from 'os';

import {connectionConfig, getTestPostgresConfig} from '../utils/test';
import {MetricsCollectorHandler} from './handler';
import {Registry} from 'prom-client';
import ConnectionManager from '../connections/manager';
import {expect} from 'chai';

let hasFullConfig = false;
try {
    require('../../config/connections.config.json');
    hasFullConfig = true;
} catch { /* CI mode - no full config */ }

(hasFullConfig ? describe : describe.skip)('FillerMetricCollector', () => {
    let connections: ConnectionManager;

    before(async () => {
        connections = new ConnectionManager({
            ...connectionConfig,
            postgres: getTestPostgresConfig(),
        });
        await connections.connect();
    });

    it('returns the metrics', async () => {
        const handler = new MetricsCollectorHandler(connections, 'filler', os.hostname());

        const metrics = [
            'eos_contract_api_sql_live',
            'eos_contract_api_pool_clients_count',
            'eos_contract_api_waiting_pool_clients_count',
            'eos_contract_api_idle_pool_clients_count',
            'eos_contract_api_readers_blocks_behind_count',
            'eos_contract_api_readers_time_behind_chain_sec',
            'eos_contract_api_redis_live',
            'eos_contract_api_sales_filters_updates_pending_count',
        ];
        const res = await handler.getMetrics(new Registry());

        expect(metrics.every(s => res.includes(s))).to.be.true;
    });

    it('emits one backlog series per priority lane', async function () {
        // The collector deliberately emits no backlog series on databases without
        // the atomicmarket tables - skip there instead of asserting lanes.
        const present = await connections.database.query<{ present: boolean }>(
            'SELECT to_regclass(\'atomicmarket_sales_filters_updates\') IS NOT NULL AS present'
        );
        if (!present.rows[0]?.present) {
            this.skip();
        }

        const handler = new MetricsCollectorHandler(connections, 'filler', os.hostname());

        const res = await handler.getMetrics(new Registry());

        // Both lanes are always emitted (reset to 0 before set) so an emptied
        // lane drops to 0 instead of disappearing / holding its last value.
        expect(res).to.include('prio="0"');
        expect(res).to.include('prio="1"');
    });

    it('skips the metrics using the collect from option', async () => {
        const handler = new MetricsCollectorHandler(connections, 'filler', os.hostname(), {
            readers: false,
            redis_connection: false,
            psql_pool: false,
            sales_filters_backlog: false
        });

        const metrics = [
            'eos_contract_api_pool_clients_count',
            'eos_contract_api_waiting_pool_clients_count',
            'eos_contract_api_idle_pool_clients_count',
            'eos_contract_api_readers_blocks_behind_count',
            'eos_contract_api_readers_time_behind_chain_sec',
            'eos_contract_api_redis_live',
            'eos_contract_api_sales_filters_updates_pending_count',
        ];
        const res = await handler.getMetrics(new Registry());

        expect(metrics.every(s => !res.includes(s))).to.be.true;
        expect(res.includes('eos_contract_api_sql_live')).to.be.true;
    });

    after(async () => {
        await connections.disconnect();
    });
});

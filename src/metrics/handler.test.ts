import 'mocha';
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
        // the atomicmarket tables — skip there instead of asserting lanes.
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

// The template-prices queue gauges (1.7.26): the prio/kind composition series and
// the due-count series an alert reads. Driven off a stubbed ConnectionManager rather
// than a live database: the behavior under test is the collector's own contract - the
// to_regclass guard, the per-lane/per-kind reset, the bigint-string conversion and the
// swallowed error - none of which needs a server, and all of which must hold on every
// chain including those without the atomicmarket tables (where the suite above skips
// entirely).
const TEMPLATE_PRICES_GAUGE = 'eos_contract_api_template_prices_updates_pending_count';
const TEMPLATE_PRICES_DUE_GAUGE = 'eos_contract_api_template_prices_updates_due_count';

type StubRows = Array<Record<string, unknown>>;

function stubConnections(query: (sql: string) => Promise<{ rows: StubRows }>): ConnectionManager {
    return {
        database: { query },
    } as unknown as ConnectionManager;
}

function sampleValue(metrics: string, labels: Record<string, string>, gauge = TEMPLATE_PRICES_GAUGE): number | undefined {
    const line = metrics.split('\n').find(l =>
        l.startsWith(`${gauge}{`)
        && Object.entries(labels).every(([key, value]) => l.includes(`${key}="${value}"`)));

    return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

// Both collector statements name the queue table, so the stub tells them apart by the
// due predicate the alert-facing one carries.
function isDueQuery(sql: string): boolean {
    return sql.includes('refresh_at <=');
}

describe('MetricsCollectorHandler - template-prices queue depth', () => {
    // Everything except the template-prices backlog is switched off so the stub only
    // has to answer this collector's own queries.
    const onlyTemplatePrices = {
        psql_connection: false,
        psql_pool: false,
        redis_connection: false,
        readers: false,
        sales_filters_backlog: false,
    };

    it('reports one series per priority lane and kind, resetting the empty ones to 0', async () => {
        const handler = new MetricsCollectorHandler(
            stubConnections(async (sql: string) => {
                if (sql.includes('to_regclass')) {
                    return { rows: [{ present: true }] };
                }
                if (isDueQuery(sql)) {
                    return { rows: [{ due: '3' }] };
                }
                return { rows: [
                    { prio: 0, kind: 0, pending: '3' },
                    { prio: 1, kind: 1, pending: '17' },
                ] };
            }),
            'filler', 'testhost', onlyTemplatePrices,
        );

        const res = await handler.getMetrics(new Registry());

        expect(sampleValue(res, { prio: '0', kind: '0' }), 'real-time live backlog').to.equal(3);
        expect(sampleValue(res, { prio: '1', kind: '1' }), 'armed aging rows').to.equal(17);
        // GROUP BY emits no row for an empty lane/kind, so without the reset these
        // would be missing (or hold their previous value on a long-lived registry).
        expect(sampleValue(res, { prio: '0', kind: '1' })).to.equal(0);
        expect(sampleValue(res, { prio: '1', kind: '0' })).to.equal(0);
    });

    it('reports the due count separately from the total, and gates it on the reader block time', async () => {
        // 20 rows in the queue, 3 of them claimable: an alert on the total would read 20
        // and fire on a queue that is fully drained of due work, so the due series is its
        // own number and carries the claim's own predicate.
        const statements: string[] = [];
        const handler = new MetricsCollectorHandler(
            stubConnections(async (sql: string) => {
                statements.push(sql);
                if (sql.includes('to_regclass')) {
                    return { rows: [{ present: true }] };
                }
                if (isDueQuery(sql)) {
                    return { rows: [{ due: '3' }] };
                }
                return { rows: [
                    { prio: 0, kind: 0, pending: '3' },
                    { prio: 1, kind: 1, pending: '17' },
                ] };
            }),
            'filler', 'testhost', onlyTemplatePrices,
        );

        const res = await handler.getMetrics(new Registry());

        expect(sampleValue(res, { process: 'filler' }, TEMPLATE_PRICES_DUE_GAUGE), 'claimable backlog').to.equal(3);

        const dueStatement = statements.find(isDueQuery);
        expect(dueStatement, 'the due series has its own statement').to.not.equal(undefined);
        expect(dueStatement).to.match(/refresh_at\s*<=\s*\(SELECT MAX\(block_time\) FROM contract_readers\)/);
        expect(dueStatement).to.not.match(/now\(\)|CURRENT_TIMESTAMP|clock_timestamp/i);
    });

    it('clamps a count past MAX_SAFE_INTEGER instead of silently losing precision', async () => {
        const handler = new MetricsCollectorHandler(
            stubConnections(async (sql: string) => {
                if (sql.includes('to_regclass')) {
                    return { rows: [{ present: true }] };
                }
                return isDueQuery(sql)
                    ? { rows: [{ due: '99999999999999999999' }] }
                    : { rows: [{ prio: 0, kind: 0, pending: '99999999999999999999' }] };
            }),
            'filler', 'testhost', onlyTemplatePrices,
        );

        const res = await handler.getMetrics(new Registry());

        expect(sampleValue(res, { prio: '0', kind: '0' })).to.equal(Number.MAX_SAFE_INTEGER);
        expect(sampleValue(res, { process: 'filler' }, TEMPLATE_PRICES_DUE_GAUGE)).to.equal(Number.MAX_SAFE_INTEGER);
    });

    it('emits no series when the queue table is absent (to_regclass guard)', async () => {
        // Chains without the atomicmarket handler, and atomicmarket chains whose schema
        // is older than 1.7.26, have no queue table. Referencing it in the count
        // statement would error at parse time, so the collector must stop at the guard.
        let counted = false;
        const handler = new MetricsCollectorHandler(
            stubConnections(async (sql: string) => {
                if (sql.includes('to_regclass')) {
                    return { rows: [{ present: false }] };
                }
                counted = true;
                return { rows: [] };
            }),
            'filler', 'testhost', onlyTemplatePrices,
        );

        const res = await handler.getMetrics(new Registry());

        expect(counted, 'neither count statement may run without the table').to.equal(false);
        expect(res).to.not.include(`${TEMPLATE_PRICES_GAUGE}{`);
        expect(res).to.not.include(`${TEMPLATE_PRICES_DUE_GAUGE}{`);
    });

    it('swallows a backlog query failure so the rest of the scrape still serves', async () => {
        const handler = new MetricsCollectorHandler(
            stubConnections(async (sql: string) => {
                if (sql.includes('atomicmarket_template_prices_updates')) {
                    throw new Error('relation is being dropped');
                }
                return { rows: [{ present: true }] };
            }),
            'filler', 'testhost', { ...onlyTemplatePrices, psql_connection: undefined },
        );

        const res = await handler.getMetrics(new Registry());

        expect(res).to.include('eos_contract_api_sql_live');
        expect(res).to.not.include(`${TEMPLATE_PRICES_GAUGE}{`);
        expect(res).to.not.include(`${TEMPLATE_PRICES_DUE_GAUGE}{`);
    });

    it('is switched off by the collect-from option', async () => {
        const handler = new MetricsCollectorHandler(
            stubConnections(async () => ({ rows: [{ present: true }] })),
            'filler', 'testhost', { ...onlyTemplatePrices, template_prices_backlog: false },
        );

        const res = await handler.getMetrics(new Registry());

        expect(res).to.not.include(TEMPLATE_PRICES_GAUGE);
        expect(res).to.not.include(TEMPLATE_PRICES_DUE_GAUGE);
    });
});

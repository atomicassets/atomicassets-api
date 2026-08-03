import {Gauge, Registry} from 'prom-client';
import ConnectionManager from '../connections/manager';
import logger from '../utils/winston';

interface IMetrics {
    psql_connection?: Gauge<any>,
    redis_connection?: Gauge<any>,
    psql_pool_clients_total_count?: Gauge<any>,
    psql_pool_clients_idle_count?: Gauge<any>,
    psql_pool_clients_waiting_count?: Gauge<any>,
    readers_blocks_behind_count?: Gauge<any>,
    readers_time_behind_chain_sec?: Gauge<any>,
    sales_filters_updates_pending_count?: Gauge<any>,
    template_prices_updates_pending_count?: Gauge<any>,
    template_prices_updates_due_count?: Gauge<any>,
}

export interface ICollectOptions {
    psql_connection?: boolean;
    redis_connection?: boolean;
    psql_pool?: boolean;
    readers?: boolean;
    sales_filters_backlog?: boolean;
    template_prices_backlog?: boolean;
}

export class MetricsCollectorHandler {
    private metrics: IMetrics;

    constructor(
        private readonly connections: ConnectionManager,
        private readonly process: 'filler' | 'api',
        private readonly hostname: string,
        private readonly collectFrom: ICollectOptions = {}
    ) {}

    async getMetrics(registry: Registry): Promise<string> {
        this.registerMetrics(registry);

        await Promise.all([
            this.collectPSQlState(),
            this.collectPoolClientsCount(),
            this.collectRedisState(),
            this.collectReadersState(),
            this.collectSalesFiltersBacklog(),
            this.collectTemplatePricesBacklog()
        ]);

        return registry.metrics();
    }

    private registerMetrics(registry: Registry): void {
        this.metrics = {};

        if (this.collectFrom.psql_connection !== false) {
            this.metrics.psql_connection = new Gauge({
                name: 'eos_contract_api_sql_live',
                registers: [registry],
                labelNames: ['process', 'hostname'],
                help: 'Indicates if the sql connection is alive, 1 = Alive, 0 = Dead'
            });
        }

        if (this.collectFrom.psql_pool !== false) {
            this.metrics.psql_pool_clients_total_count = new Gauge({
                name: 'eos_contract_api_pool_clients_count',
                registers: [registry],
                labelNames: ['process', 'hostname'],
                help: 'Indicates how many client connections has spawn'
            });
            this.metrics.psql_pool_clients_waiting_count = new Gauge({
                name: 'eos_contract_api_waiting_pool_clients_count',
                registers: [registry],
                labelNames: ['process', 'hostname'],
                help: 'Indicates how many sql client connections are waiting'
            });
            this.metrics.psql_pool_clients_idle_count = new Gauge({
                name: 'eos_contract_api_idle_pool_clients_count',
                registers: [registry],
                labelNames: ['process', 'hostname'],
                help: 'Indicates how many sql client connections are idle'
            });
        }

        if (this.collectFrom.readers !== false) {
            this.metrics.readers_blocks_behind_count = new Gauge({
                name: 'eos_contract_api_readers_blocks_behind_count',
                registers: [registry],
                labelNames: ['process', 'hostname', 'filler_name'],
                help: 'Indicates how many blocks is the filler behind the chain'
            });
            this.metrics.readers_time_behind_chain_sec = new Gauge({
                name: 'eos_contract_api_readers_time_behind_chain_sec',
                registers: [registry],
                labelNames: ['process', 'hostname', 'filler_name'],
                help: 'Indicates how much time in seconds, is the filler behind the chain'
            });
        }

        if (this.collectFrom.sales_filters_backlog !== false) {
            // Authoritative sales-filter drain-health signal: a sustained upward trend means the
            // drain is falling behind chain churn. The reader catch-up watchdog cannot see this
            // (it resets on any block advance). No series is emitted on chains without the table.
            // prio label (1.7.13 two-lane queue): '0' = real-time trigger events (must stay
            // near zero), '1' = bulk price-refresh rows (bounded sawtooth). Sum the label
            // for the pre-1.7.13 total.
            this.metrics.sales_filters_updates_pending_count = new Gauge({
                name: 'eos_contract_api_sales_filters_updates_pending_count',
                registers: [registry],
                labelNames: ['process', 'hostname', 'prio'],
                help: 'Pending rows in atomicmarket_sales_filters_updates (the sales-filter drain queue) per priority lane'
            });
        }

        if (this.collectFrom.template_prices_backlog !== false) {
            // Drain-health signals for the 2.0.6 queue-driven template-price recompute,
            // the sales-filter gauge's counterpart. Neither series is emitted on chains
            // without the table (pre-2.0.6 or non-atomicmarket).
            //
            // The composition series. Both labels are load-bearing. prio: '0' = real-time
            // trigger enqueues (must stay near zero), '1' = the cutover seed and every
            // aging row. kind: '0' = live, '1' = aging, an armed future boundary. A
            // healthy queue holds one aging row per active template indefinitely by
            // design, so kind '1' is a population count rather than backlog, and a
            // threshold on the unlabeled total would fire on a perfectly drained queue.
            this.metrics.template_prices_updates_pending_count = new Gauge({
                name: 'eos_contract_api_template_prices_updates_pending_count',
                registers: [registry],
                labelNames: ['process', 'hostname', 'prio', 'kind'],
                help: 'Pending rows in atomicmarket_template_prices_updates (the template-prices drain queue) per priority lane and row kind'
            });
            // The alert-facing series: rows the next claim would actually take, which is
            // the only number that means "the drain is behind". Due-ness is measured
            // against the reader's block time, the same expression the claim and the
            // filler's work probe use, so a lagging filler does not report armed aging
            // rows as backlog.
            this.metrics.template_prices_updates_due_count = new Gauge({
                name: 'eos_contract_api_template_prices_updates_due_count',
                registers: [registry],
                labelNames: ['process', 'hostname'],
                help: 'Rows in atomicmarket_template_prices_updates due at the reader block time (the claimable backlog)'
            });
        }

        if (this.collectFrom.redis_connection !== false) {
            this.metrics.redis_connection = new Gauge({
                name: 'eos_contract_api_redis_live',
                registers: [registry],
                labelNames: ['process', 'hostname'],
                help: 'Indicates if the redis connection is alive, 1 = Alive, 0 = Dead'
            });
        }

    }

    private async collectPSQlState(): Promise<void> {
        if (this.collectFrom.psql_connection === false) return Promise.resolve();

        try {
            await this.connections.database.query('SELECT 1;');

            this.metrics.psql_connection.labels(this.process, this.hostname).set(1);
        } catch (e) {
            this.metrics.psql_connection.labels(this.process, this.hostname).set(0);
        }
    }

    private async collectPoolClientsCount(): Promise<void> {
        if (this.collectFrom.psql_pool === false) return Promise.resolve();

        return new Promise((res) => {
            this.metrics.psql_pool_clients_total_count
                .labels(this.process, this.hostname).set(this.connections.database.pool.totalCount);
            this.metrics.psql_pool_clients_waiting_count
                .labels(this.process, this.hostname).set(this.connections.database.pool.waitingCount);
            this.metrics.psql_pool_clients_idle_count
                .labels(this.process, this.hostname).set(this.connections.database.pool.idleCount);

            res();
        });
    }

    private async collectRedisState(): Promise<void> {
        if (this.collectFrom.redis_connection === false) return Promise.resolve();

        try {
            const res = await this.connections.redis.ioRedis.ping();

            this.metrics.redis_connection.labels(this.process, this.hostname).set(res === 'PONG' ? 1 : 0);
        } catch (e) {
            this.metrics.redis_connection.labels(this.process, this.hostname).set(0);
        }
    }

    private async collectReadersState(): Promise<void> {
        if (this.collectFrom.readers === false) return Promise.resolve();

        try {
            const info = await this.connections.chain.rpc.get_info();

            const res = await this.connections.database.query<{ name: string, block_num: string, block_time: string }>(
                'SELECT name, block_num, block_time FROM contract_readers'
            );

            res.rows.forEach(reader => {
                this.metrics.readers_blocks_behind_count.labels(this.process, this.hostname, reader.name).set(info.head_block_num - parseInt(reader.block_num));
                this.metrics.readers_time_behind_chain_sec.labels(this.process, this.hostname, reader.name).set(
                    (Date.now() - parseInt(reader.block_time)) / 1000
                );
            });
        } catch (e) {
            logger.debug('Error reading the readers state', e);
        }
    }

    private async collectSalesFiltersBacklog(): Promise<void> {
        if (this.collectFrom.sales_filters_backlog === false) return Promise.resolve();

        try {
            // Self-guard on table existence: only atomicmarket-enabled chains have it.
            // Referencing a missing table in the same statement errors at parse time, so
            // probe with to_regclass first and skip (emit no series) when absent.
            const present = await this.connections.database.query<{ present: boolean }>(
                'SELECT to_regclass(\'atomicmarket_sales_filters_updates\') IS NOT NULL AS present'
            );
            if (!present.rows[0]?.present) return;

            // The queue is kept small by the drain (by design), so an exact count is cheap.
            // Catalog-probe the prio column first: metrics must keep working during the
            // pre-1.7.13 window (old schema, e.g. metrics scraped while migrations pend).
            const hasPrio = await this.connections.database.query<{ present: boolean }>(
                'SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = \'atomicmarket_sales_filters_updates\'::regclass AND attname = \'prio\' AND NOT attisdropped) AS present'
            );
            const res = hasPrio.rows[0]?.present
                ? await this.connections.database.query<{ prio: number, pending: string }>(
                    'SELECT prio, count(*)::bigint AS pending FROM atomicmarket_sales_filters_updates GROUP BY prio'
                )
                : await this.connections.database.query<{ prio: number, pending: string }>(
                    'SELECT 0 AS prio, count(*)::bigint AS pending FROM atomicmarket_sales_filters_updates'
                );
            // Reset both lane series before setting so an emptied lane drops to 0 instead of
            // holding its last value (GROUP BY emits no row for an empty lane).
            for (const lane of ['0', '1']) {
                this.metrics.sales_filters_updates_pending_count
                    .labels(this.process, this.hostname, lane).set(0);
            }
            for (const row of res.rows) {
                // count(*)::bigint comes back as a string; clamp to MAX_SAFE_INTEGER so a
                // pathological backlog can't silently lose precision in the Number() conversion.
                const pending = Number(row.pending);
                this.metrics.sales_filters_updates_pending_count
                    .labels(this.process, this.hostname, String(row.prio))
                    .set(Number.isSafeInteger(pending) ? pending : Number.MAX_SAFE_INTEGER);
            }
        } catch (e) {
            logger.debug('Error reading the sales-filter backlog', e);
        }
    }

    private async collectTemplatePricesBacklog(): Promise<void> {
        if (this.collectFrom.template_prices_backlog === false) return Promise.resolve();

        try {
            // Same self-guard as the sales-filter backlog above: only atomicmarket
            // chains running 2.0.6 or later have the table, and referencing a missing
            // one errors at parse time, so probe with to_regclass and emit nothing when
            // it is absent.
            const present = await this.connections.database.query<{ present: boolean }>(
                'SELECT to_regclass(\'atomicmarket_template_prices_updates\') IS NOT NULL AS present'
            );
            if (!present.rows[0]?.present) return;

            // Dedup bounds the queue at two rows per active template, so an exact count
            // is cheap.
            const res = await this.connections.database.query<{ prio: number, kind: number, pending: string }>(
                'SELECT prio, kind, count(*)::bigint AS pending FROM atomicmarket_template_prices_updates GROUP BY prio, kind'
            );
            // Reset every lane/kind series before setting so an emptied one drops to 0
            // instead of holding its last value (GROUP BY emits no row for an empty one).
            for (const prio of ['0', '1']) {
                for (const kind of ['0', '1']) {
                    this.metrics.template_prices_updates_pending_count
                        .labels(this.process, this.hostname, prio, kind).set(0);
                }
            }
            for (const row of res.rows) {
                // count(*)::bigint comes back as a string; clamp to MAX_SAFE_INTEGER so a
                // pathological backlog can't silently lose precision in the conversion.
                const pending = Number(row.pending);
                this.metrics.template_prices_updates_pending_count
                    .labels(this.process, this.hostname, String(row.prio), String(row.kind))
                    .set(Number.isSafeInteger(pending) ? pending : Number.MAX_SAFE_INTEGER);
            }

            // The claimable backlog, gated on the reader's block time exactly as the
            // claim in update_atomicmarket_template_prices() is. With no reader rows the
            // MAX is NULL, the comparison is NULL for every row and the count is 0, which
            // is also what the claim would take.
            const dueRes = await this.connections.database.query<{ due: string }>(
                `SELECT count(*)::bigint AS due
                 FROM atomicmarket_template_prices_updates
                 WHERE refresh_at <= (SELECT MAX(block_time) FROM contract_readers)`
            );
            const due = Number(dueRes.rows[0]?.due ?? 0);
            this.metrics.template_prices_updates_due_count
                .labels(this.process, this.hostname)
                .set(Number.isSafeInteger(due) ? due : Number.MAX_SAFE_INTEGER);
        } catch (e) {
            logger.debug('Error reading the template-prices backlog', e);
        }
    }
}

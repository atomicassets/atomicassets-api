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
}

export interface ICollectOptions {
    psql_connection?: boolean;
    redis_connection?: boolean;
    psql_pool?: boolean;
    readers?: boolean;
    sales_filters_backlog?: boolean;
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
            this.collectSalesFiltersBacklog()
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
            this.metrics.sales_filters_updates_pending_count = new Gauge({
                name: 'eos_contract_api_sales_filters_updates_pending_count',
                registers: [registry],
                labelNames: ['process', 'hostname'],
                help: 'Pending rows in atomicmarket_sales_filters_updates (the sales-filter drain queue). '
                    + 'A sustained upward trend means the drain is falling behind chain churn — the reader '
                    + 'catch-up watchdog cannot see this (it resets on any block advance), so this is the '
                    + 'authoritative drain-health signal. No series is emitted on chains without the table.'
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
            const res = await this.connections.database.query<{ pending: string }>(
                'SELECT count(*)::bigint AS pending FROM atomicmarket_sales_filters_updates'
            );
            this.metrics.sales_filters_updates_pending_count
                .labels(this.process, this.hostname).set(Number(res.rows[0].pending));
        } catch (e) {
            logger.debug('Error reading the sales-filter backlog', e);
        }
    }
}

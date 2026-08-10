import StateHistoryBlockReader from './ship';
import ChainApi from './chain';
import RedisConnection from './redis';
import PostgresConnection from './postgres';
import { IConnectionsConfig } from '../types/config';
import { IBlockReaderOptions } from '../types/ship';

export default class ConnectionManager {
    readonly chain: ChainApi;
    readonly redis: RedisConnection;
    readonly database: PostgresConnection;

    constructor(private readonly config: IConnectionsConfig) {
        this.chain = new ChainApi(
            process.env.CHAIN_HTTP || config.chain.http,
            process.env.CHAIN_NAME || config.chain.name,
            process.env.CHAIN_ID || config.chain.chain_id
        );

        // Build TLS config from environment variable or config file
        const redisTls = process.env.REDIS_TLS === 'true'
            ? {
                // verify-ca: validate CA chain but skip hostname check
                // (iovalkey cluster mode connects to node IPs from CLUSTER SLOTS, not hostnames)
                rejectUnauthorized: process.env.REDIS_TLS_MODE === 'verify-ca'
                    ? true
                    : process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
                ...(process.env.REDIS_TLS_MODE === 'verify-ca'
                    ? { checkServerIdentity: (): undefined => undefined }
                    : {}),
            }
            : config.redis.tls;

        // Optional separate endpoint for the SUBSCRIBE connection. Set
        // REDIS_SUB_HOST to point the notification subscriber at a different
        // instance from the one serving the rate limiter, the response cache
        // and alive()'s ping; leave it unset and both share one endpoint.
        // Each field falls back to its primary counterpart, so pointing the
        // subscriber elsewhere needs only the host when the rest matches.
        const subscriber = process.env.REDIS_SUB_HOST
            ? {
                host: process.env.REDIS_SUB_HOST,
                port: parseInt(process.env.REDIS_SUB_PORT, 10)
                    || parseInt(process.env.REDIS_PORT, 10)
                    || config.redis.port,
                username: process.env.REDIS_SUB_USERNAME
                    || process.env.REDIS_USERNAME
                    || config.redis.username,
                password: process.env.REDIS_SUB_PASSWORD
                    || process.env.REDIS_PASSWORD
                    || config.redis.password,
                tls: redisTls,
                connectionType: process.env.REDIS_SUB_CONNECTION_TYPE
                    || process.env.REDIS_CONNECTION_TYPE
                    || 'standalone',
            }
            : undefined;

        this.redis = new RedisConnection({
            host: process.env.REDIS_HOST || config.redis.host,
            port: parseInt(process.env.REDIS_PORT, 10) || config.redis.port,
            username: process.env.REDIS_USERNAME || config.redis.username,
            password: process.env.REDIS_PASSWORD || config.redis.password,
            tls: redisTls,
            connectionType: process.env.REDIS_CONNECTION_TYPE || 'standalone',
            subscriber,
        });

        this.database = new PostgresConnection(
            process.env.POSTGRES_HOST || config.postgres.host,
            parseInt(process.env.POSTGRES_PORT, 10) || config.postgres.port,
            process.env.POSTGRES_USER || config.postgres.user,
            process.env.POSTGRES_PASSWORD || config.postgres.password,
            process.env.POSTGRES_DATABASE || config.postgres.database
        );
    }

    async connect(): Promise<void> {
        await this.database.connect();
        await this.redis.connect();
    }

    async disconnect(): Promise<void> {
        await this.database.end();
        await this.redis.disconnect();
    }

    async alive(): Promise<boolean> {
        try {
            await this.redis.ioRedis.ping();
            await this.database.pool.query('SELECT 1');

            return true;
        } catch {
            return false;
        }
    }

    createShipBlockReader(options?: IBlockReaderOptions): StateHistoryBlockReader {
        const reader = new StateHistoryBlockReader(process.env.CHAIN_SHIP || this.config.chain.ship);

        if (options) {
            reader.setOptions(options);
        }

        return reader;
    }
}

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
            ? { rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' }
            : config.redis.tls;

        this.redis = new RedisConnection({
            host: process.env.REDIS_HOST || config.redis.host,
            port: parseInt(process.env.REDIS_PORT, 10) || config.redis.port,
            username: process.env.REDIS_USERNAME || config.redis.username,
            password: process.env.REDIS_PASSWORD || config.redis.password,
            tls: redisTls,
            connectionType: process.env.REDIS_CONNECTION_TYPE || 'standalone',
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

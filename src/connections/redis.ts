import { Redis, RedisOptions } from '@atomichub/backend-common/redis';

export interface RedisConnectionOptions {
    host: string;
    port: number;
    username?: string;
    password?: string;
    tls?: {
        rejectUnauthorized?: boolean;
    };
}

export default class RedisConnection {
    readonly ioRedis: Redis;
    readonly ioRedisSub: Redis;

    constructor(options: RedisConnectionOptions) {
        const { host, port, username, password, tls } = options;

        const ioRedisOptions: RedisOptions = { host, port, username, password, tls };
        this.ioRedis = new Redis(ioRedisOptions);
        this.ioRedisSub = new Redis(ioRedisOptions);
    }

    async connect(): Promise<void> {
        // iovalkey connects lazily on first command, no explicit connect needed
    }

    async disconnect(): Promise<void> {
        await this.ioRedis.disconnect();
        await this.ioRedisSub.disconnect();
    }

}

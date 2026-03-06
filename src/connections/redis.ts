import { Redis, Cluster, RedisOptions, ClusterOptions, RedisClientInstance } from '@atomichub/backend-common/redis';

export interface RedisConnectionOptions {
    host: string;
    port: number;
    username?: string;
    password?: string;
    tls?: {
        rejectUnauthorized?: boolean;
        checkServerIdentity?: (hostname: string, cert: object) => Error | undefined;
    };
    connectionType?: string;
}

export default class RedisConnection {
    readonly ioRedis: RedisClientInstance;
    readonly ioRedisSub: RedisClientInstance;

    constructor(options: RedisConnectionOptions) {
        const { host, port, username, password, tls, connectionType } = options;

        if (connectionType === 'cluster') {
            const clusterOptions: ClusterOptions = {
                redisOptions: { username, password, tls },
            };
            this.ioRedis = new Cluster([{ host, port }], clusterOptions);
            this.ioRedisSub = new Cluster([{ host, port }], clusterOptions);
        } else {
            const ioRedisOptions: RedisOptions = { host, port, username, password, tls };
            this.ioRedis = new Redis(ioRedisOptions);
            this.ioRedisSub = new Redis(ioRedisOptions);
        }
    }

    async connect(): Promise<void> {
        // iovalkey connects lazily on first command, no explicit connect needed
    }

    async disconnect(): Promise<void> {
        await this.ioRedis.disconnect();
        await this.ioRedisSub.disconnect();
    }

}

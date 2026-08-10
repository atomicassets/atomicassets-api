import type { PeerCertificate } from 'tls';

import { Redis, Cluster } from 'iovalkey';
import type { RedisOptions, ClusterOptions } from 'iovalkey';

export type RedisClientInstance = Redis | Cluster;

export interface RedisConnectionOptions {
    host: string;
    port: number;
    username?: string;
    password?: string;
    tls?: {
        rejectUnauthorized?: boolean;
        checkServerIdentity?: (hostname: string, cert: PeerCertificate) => Error | undefined;
    };
    connectionType?: string;

    /**
     * Endpoint for the SUBSCRIBE connection, when it should not be the same
     * instance as everything else. Omit it and the subscriber shares the
     * primary's options, which is the behaviour without this field.
     *
     * This exists because the two connections have different requirements. The
     * primary carries the rate limiter, the response cache and the liveness
     * probe's ping, so it must be local and writable. The subscriber only ever
     * SUBSCRIBEs, so it can point at a remote or read-only instance, and losing
     * it costs live events rather than the API.
     */
    subscriber?: Omit<RedisConnectionOptions, 'subscriber'>;
}

export default class RedisConnection {
    readonly ioRedis: RedisClientInstance;
    readonly ioRedisSub: RedisClientInstance;

    constructor(options: RedisConnectionOptions) {
        this.ioRedis = RedisConnection.createClient(options);
        this.ioRedisSub = RedisConnection.createClient(options.subscriber ?? options);
    }

    private static createClient(options: Omit<RedisConnectionOptions, 'subscriber'>): RedisClientInstance {
        const { host, port, username, password, tls, connectionType } = options;

        if (connectionType === 'cluster') {
            const clusterOptions: ClusterOptions = {
                redisOptions: { username, password, tls },
            };

            return new Cluster([{ host, port }], clusterOptions);
        }

        const ioRedisOptions: RedisOptions = { host, port, username, password, tls };

        return new Redis(ioRedisOptions);
    }

    async connect(): Promise<void> {
        // iovalkey connects lazily on first command, no explicit connect needed
    }

    async disconnect(): Promise<void> {
        await this.ioRedis.disconnect();
        await this.ioRedisSub.disconnect();
    }

}

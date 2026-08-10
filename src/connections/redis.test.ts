import 'mocha';
import { expect } from 'chai';
import type { Redis } from 'iovalkey';

import RedisConnection from './redis';
import type { RedisConnectionOptions } from './redis';

/**
 * The subscriber endpoint is what keeps a remote notification source away from
 * the rate limiter, the response cache and alive()'s ping, all of which run on
 * the primary connection. The property worth pinning is that configuring one
 * moves ONLY the subscriber, and that omitting it changes nothing.
 *
 * iovalkey resolves options synchronously but starts connecting on construction,
 * so each client gets an error sink and is disconnected again.
 */
describe('RedisConnection subscriber endpoint', () => {
    const created: RedisConnection[] = [];

    function build(options: RedisConnectionOptions): RedisConnection {
        const connection = new RedisConnection(options);

        connection.ioRedis.on('error', () => undefined);
        connection.ioRedisSub.on('error', () => undefined);
        created.push(connection);

        return connection;
    }

    const primary: RedisConnectionOptions = {
        host: 'primary.invalid',
        port: 6379,
        username: 'default',
        password: 'primary-secret',
    };

    afterEach(async () => {
        await Promise.all(created.splice(0).map(c => c.disconnect().catch(() => undefined)));
    });

    it('shares one endpoint when no subscriber is configured', () => {
        const { ioRedis, ioRedisSub } = build(primary);

        expect((ioRedis as Redis).options.host).to.equal('primary.invalid');
        expect((ioRedisSub as Redis).options.host).to.equal('primary.invalid');
        expect((ioRedisSub as Redis).options.port).to.equal(6379);
    });

    it('moves only the subscriber when one is configured', () => {
        const { ioRedis, ioRedisSub } = build({
            ...primary,
            subscriber: { host: 'events.invalid', port: 6380 },
        });

        expect((ioRedis as Redis).options.host).to.equal('primary.invalid');
        expect((ioRedis as Redis).options.port).to.equal(6379);
        expect((ioRedisSub as Redis).options.host).to.equal('events.invalid');
        expect((ioRedisSub as Redis).options.port).to.equal(6380);
    });

    it('keeps the primary credentials off the subscriber when it carries its own', () => {
        const { ioRedis, ioRedisSub } = build({
            ...primary,
            subscriber: {
                host: 'events.invalid',
                port: 6380,
                username: 'subscriber',
                password: 'subscriber-secret',
            },
        });

        expect((ioRedis as Redis).options.password).to.equal('primary-secret');
        expect((ioRedisSub as Redis).options.username).to.equal('subscriber');
        expect((ioRedisSub as Redis).options.password).to.equal('subscriber-secret');
    });
});

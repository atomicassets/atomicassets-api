import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import type express from 'express';

import { expressRedisCache } from './cache';
import logger from './winston';


type RedisLike = {
    get: sinon.SinonStub;
    set: sinon.SinonStub;
    expire: sinon.SinonStub;
};

const makeRedis = (): RedisLike => ({
    get: sinon.stub().resolves(null), // no cached entry -> middleware will attempt SET
    set: sinon.stub().resolves('OK'),
    expire: sinon.stub().resolves(1),
});

const makeReq = (): express.Request => ({
    ip: '127.0.0.1',
    baseUrl: '/atomicassets/v1',
    path: '/accounts/test-account',
    query: {},
    body: {},
} as unknown as express.Request);

type FakeResponse = express.Response & {
    statusCode: number;
    sentPayload?: Buffer | string;
};

const makeRes = (): FakeResponse => {
    const res: Partial<FakeResponse> = {
        statusCode: 200,
    };
    res.send = (data: Buffer | string): express.Response => {
        res.sentPayload = data;
        return res as express.Response;
    };
    res.getHeader = (name: string): string | undefined => {
        if (name === 'content-type') return 'application/json';
        return undefined;
    };
    return res as FakeResponse;
};

/**
 * Run one middleware cycle: attach to req/res, invoke next(), then invoke
 * res.send to trigger the cache write path.
 */
const runMiddleware = async (
    middleware: express.RequestHandler,
    req: express.Request,
    res: FakeResponse,
    payload: Buffer | string,
): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        middleware(req, res, ((err?: unknown) => (err ? reject(err) : resolve())) as express.NextFunction);
        // The middleware calls redis.get().then(...) which resolves on a microtask.
        // Wait for the cache-miss branch to install the res.send wrapper.
        setImmediate(() => {
            try {
                res.send(payload);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
    // Let any SET/expire promise chains settle before assertions.
    await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('expressRedisCache', () => {
    let warnSpy: sinon.SinonSpy;

    beforeEach(() => {
        warnSpy = sinon.spy(logger, 'warn');
    });

    afterEach(() => {
        warnSpy.restore();
        sinon.restore();
    });

    it('caches a small response via redis.set', async () => {
        const redis = makeRedis();
        const handler = expressRedisCache(redis as never, 'test-prefix', 60);
        const middleware = handler();

        const req = makeReq();
        const res = makeRes();
        const payload = 'small payload';

        await runMiddleware(middleware, req, res, payload);

        expect(redis.set.calledOnce, 'redis.set should be called for small payload').to.equal(true);
        expect(warnSpy.called, 'no warn log expected for small payload').to.equal(false);
    });

    it('skips caching when payload exceeds default maxValueBytes and logs a warn', async () => {
        const redis = makeRedis();
        const handler = expressRedisCache(redis as never, 'test-prefix', 60);
        const middleware = handler();

        const req = makeReq();
        const res = makeRes();
        // Default cap is 2 MB — build a 3 MB string.
        const payload = 'x'.repeat(3 * 1024 * 1024);

        await runMiddleware(middleware, req, res, payload);

        expect(redis.set.called, 'redis.set should NOT be called for oversized payload').to.equal(false);
        expect(warnSpy.calledOnce, 'warn log should fire when skipping cache').to.equal(true);
        const firstArg = warnSpy.firstCall.args[0] as string;
        expect(firstArg).to.match(/Skipping cache SET/);
        expect(firstArg).to.match(/exceeds maxValueBytes/);
    });

    it('respects a per-route maxValueBytes override', async () => {
        const redis = makeRedis();
        const handler = expressRedisCache(redis as never, 'test-prefix', 60);
        const middleware = handler({ maxValueBytes: 100 });

        const req = makeReq();
        const res = makeRes();
        // 500 bytes exceeds the 100-byte per-route cap, even though it's well
        // under the default 2 MB cap.
        const payload = 'x'.repeat(500);

        await runMiddleware(middleware, req, res, payload);

        expect(redis.set.called, 'redis.set should NOT be called above per-route cap').to.equal(false);
        expect(warnSpy.calledOnce).to.equal(true);
    });

    it('does not cache non-200 responses', async () => {
        const redis = makeRedis();
        const handler = expressRedisCache(redis as never, 'test-prefix', 60);
        const middleware = handler();

        const req = makeReq();
        const res = makeRes();
        res.statusCode = 500;

        await runMiddleware(middleware, req, res, 'error payload');

        expect(redis.set.called, 'redis.set should NOT be called for non-200').to.equal(false);
        expect(warnSpy.called, 'no warn for non-200 — short-circuit happens before size check').to.equal(false);
    });

    it('still writes the response body to the client when cache is skipped due to size', async () => {
        const redis = makeRedis();
        const handler = expressRedisCache(redis as never, 'test-prefix', 60);
        const middleware = handler();

        const req = makeReq();
        const res = makeRes();
        const payload = 'x'.repeat(3 * 1024 * 1024);

        await runMiddleware(middleware, req, res, payload);

        expect(res.sentPayload).to.equal(payload);
    });
});

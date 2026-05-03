import express from 'express';
import * as crypto from 'crypto';

import type { RedisClientInstance } from '../connections/redis';

import logger from './winston';
import { mergeRequestData } from '../api/namespaces/utils';


export type ExpressRedisCacheOptions = {
    expire?: number,
    factor?: number,
    ignoreQueryString?: boolean,
    urlHandler?: express.RequestHandler,
    maxValueBytes?: number,
};

export type ExpressRedisCacheHandler = (options?: ExpressRedisCacheOptions) => express.RequestHandler;

// Valkey is single-threaded; a SET on a 20+ MB value blocks every other client for 40-60 ms.
// Skip caching responses larger than this; serves them uncached instead of poisoning the shard.
const DEFAULT_MAX_CACHE_VALUE_BYTES = 2_000_000;

export function expressRedisCache(
    redis: RedisClientInstance, prefix: string, expire: number, whitelistedIPs?: string[]
): ExpressRedisCacheHandler {
    return (options: ExpressRedisCacheOptions = {}) => {
        return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
            const factor = options.factor ? options.factor : 1;
            const cacheLife = options.expire ? (options.expire * factor) : (expire * factor);

            if (cacheLife === 0) {
                return next();
            }

            if (whitelistedIPs && whitelistedIPs.indexOf(req.ip) >= 0) {
                return next();
            }

            let key: string;
            if (options.urlHandler) {
                key = prefix + ':' + String(options.urlHandler(req, res, next));
            } else if (options.ignoreQueryString) {
                key = prefix + ':' + req.baseUrl + req.path;
            } else {
                const hash = crypto.createHash('sha256');

                if (req.body) {
                    hash.update(JSON.stringify(req.body));
                }

                if (req.query) {
                    hash.update(JSON.stringify(req.query));
                }

                key = prefix + ':' + req.baseUrl + req.path + ':' + hash.digest().toString('hex');
            }

            redis.get(key).then(reply => {
                let expire = 0;
                if (reply) {
                    const split = reply.split('::');

                    if (split[3]) {
                        expire = parseInt(split[3], 10) || 0;
                    }
                }

                if (expire < Date.now()) {
                    const sendFn = res.send.bind(res);
                    const maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_CACHE_VALUE_BYTES;

                    res.send = (data: Buffer | string): express.Response => {
                        const result = sendFn(data);

                        if (res.statusCode !== 200) {
                            return result;
                        }

                        const rawBytes = typeof data === 'string'
                            ? Buffer.byteLength(data, 'utf8')
                            : data.length;

                        if (rawBytes > maxValueBytes) {
                            logger.warn(
                                `Skipping cache SET for ${key}: ${rawBytes} bytes exceeds maxValueBytes ${maxValueBytes}`,
                                mergeRequestData(req),
                            );
                            return result;
                        }

                        let content;
                        if (typeof data === 'string') {
                            content = Buffer.from(data, 'utf8').toString('base64');
                        } else {
                            content = data.toString('base64');
                        }

                        expire = Date.now() + Math.round(cacheLife) * 1000;
                        redis.set(key, res.getHeader('content-type') + '::' + res.statusCode + '::' + content + '::' + expire).then(async () => {
                            await redis.expire(key, Math.round(cacheLife));

                            logger.debug('Cache request ' + key + ' for ' + cacheLife + ' seconds', mergeRequestData(req));
                        });

                        return result;
                    };

                    next();
                } else {
                    const split = reply.split('::');

                    if (split[0]) {
                        res.contentType(split[0]);
                    }

                    if (split[1]) {
                        res.status(parseInt(split[1], 10));
                    }

                    const buffer = Buffer.from(split[2], 'base64');

                    res.send(buffer);
                }
            });
        };
    };
}

import {Namespace} from 'socket.io';
import express from 'express';

import {DB, HTTPServer} from './server';
import {NotificationData} from '../filler/notifier';
import {ApiError} from './error';
import logger from '../utils/winston';

// Serialize a metadata-condition object into the two `::jsonb` parameter
// variants needed to match contract_traces rows. validateId returns numeric
// IDs as strings to preserve precision for uint64 values that overflow JS
// Number.MAX_SAFE_INTEGER, but the filler stores trace metadata with the
// JSON type the ship deserializer produced: uint64 values below 2^32
// (sale_id, offer_id, ...) land as JSON numbers while larger ones
// (asset_id is always >= 2^40) land as JSON strings. JSONB containment
// (`@>`) is type-strict, so a single serialization can only ever match one
// of the two populations. Return both: [0] emits integer-literal string
// values as JSON number tokens directly from the source string (preserving
// full uint64 precision), [1] is the plain JSON.stringify string form. The
// variants are identical when the condition has no numeric values.
export function buildJsonbConditionVariants(condition: { [key: string]: any }): [string, string] {
    const numberParts: string[] = [];
    const stringParts: string[] = [];
    for (const [key, value] of Object.entries(condition)) {
        const keyJson = JSON.stringify(key);
        const valueJson = JSON.stringify(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value)) {
            numberParts.push(`${keyJson}:${value}`);
        } else {
            numberParts.push(`${keyJson}:${valueJson}`);
        }
        stringParts.push(`${keyJson}:${valueJson}`);
    }
    return [`{${numberParts.join(',')}}`, `{${stringParts.join(',')}}`];
}

export async function getContractActionLogs(
    db: DB, contract: string, actions: string[], condition: { [key: string]: any },
    offset: number = 0, limit: number = 100, order: 'asc' | 'desc' = 'asc'
): Promise<Array<{ log_id: number, name: string, data: any, txid: string, created_at_block: string, created_at_time: string }>> {
    const queryStr = 'SELECT global_sequence log_id, name, metadata "data", encode(txid::bytea, \'hex\') txid, created_at_block, created_at_time ' +
        'FROM contract_traces ' +
        'WHERE account = $1 AND name = ANY($2) AND (metadata @> $3::jsonb OR metadata @> $4::jsonb) ' +
        'ORDER BY global_sequence ' + (order === 'asc' ? 'ASC' : 'DESC') + ' LIMIT $5 OFFSET $6 ';

    const [numberCondition, stringCondition] = buildJsonbConditionVariants(condition);
    const query = await db.query(queryStr, [contract, actions, numberCondition, stringCondition, limit, offset]);
    const emptyCondition = Object.keys(condition).reduce((prev, curr) => ({...prev, [curr]: undefined}), {});

    return query.rows.map(row => ({
        ...row, data: JSON.parse(JSON.stringify({...row.data, ...emptyCondition}))
    }));
}

export function applyActionGreylistFilters(
    actions: string[],
    args: { action_whitelist: string[], action_blacklist: string[] },
): string[] {
    return actions
        .filter(action => !args.action_whitelist.length || args.action_whitelist.includes(action))
        .filter(action => !args.action_blacklist.includes(action));
}

export function createSocketApiNamespace(server: HTTPServer, path: string): Namespace {
    return server.socket.io.of(path);
}

export function extractNotificationIdentifiers(notifications: NotificationData[], key: string): string[] {
    const result = [];

    for (const notification of notifications) {
        let identifier: any = null;

        if (notification.type === 'delta') {
            // @ts-ignore
            identifier = notification.data.delta.value[key];
        }

        if (notification.type === 'trace' && notification.data.trace) {
            // @ts-ignore
            identifier = notification.data.trace.act.data[key];
        }

        if (identifier && result.indexOf(identifier) === -1) {
            result.push(identifier);
        }
    }

    return result;
}

export function respondApiError(res: express.Response, error: Error): express.Response {
    if ((error as ApiError).showMessage) {
        return res.status((error as ApiError).code).json({success: false, message: error.message});
    }

    const errorMessage = error.message ? String(error.message) : '';
    if (errorMessage.includes('canceling statement due to statement timeout') || errorMessage.includes('Query read timeout')) {
        return res.status(408).json({
            success: false,
            message: 'Max database query time exceeded. Please try to add more filters to your query.'
        });
    } else {
        logger.warn('Error occured while processing request', error);
    }

    return res.status(500).json({success: false, message: 'Internal Server Error'});
}

// Express's 'trust proxy' setting. `true` historically meant "trust one hop"
// here (NOT Express's own `true`, which trusts everything and lets clients
// spoof X-Forwarded-For). Hop counts, named subnets and CIDR lists pass
// through verbatim so deployments behind multiple proxy layers (e.g.
// Cloudflare → ingress) can resolve the real client IP - with a CIDR list
// Express skips all trusted trailing X-Forwarded-For hops, so req.ip (and
// therefore rate-limit buckets) is the actual client, not the closest proxy.
export type TrustProxyConfig = boolean | number | string | string[];

export function resolveTrustProxy(value: TrustProxyConfig): boolean | number | string | string[] {
    return value === true ? 1 : value;
}

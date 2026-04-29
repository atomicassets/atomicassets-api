import {Namespace} from 'socket.io';
import express from 'express';

import {DB, HTTPServer} from './server';
import {NotificationData} from '../filler/notifier';
import {ApiError} from './error';
import logger from '../utils/winston';

// Serialize a metadata-condition object for use as a `::jsonb` parameter.
// validateId returns numeric IDs as strings to preserve precision for
// uint64 values that overflow JS Number.MAX_SAFE_INTEGER, but on-chain
// metadata stores those same IDs as JSON numbers. JSONB containment (`@>`)
// is type-strict, so a naive JSON.stringify of `{sale_id: "172238298"}`
// matches zero rows against `{"sale_id":172238298}` in the heap. Emit
// values that look like integer literals as JSON number tokens directly
// from the source string, preserving full precision; other values flow
// through JSON.stringify unchanged.
export function buildJsonbCondition(condition: { [key: string]: any }): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(condition)) {
        const keyJson = JSON.stringify(key);
        if (typeof value === 'string' && /^-?\d+$/.test(value)) {
            parts.push(`${keyJson}:${value}`);
        } else {
            parts.push(`${keyJson}:${JSON.stringify(value)}`);
        }
    }
    return `{${parts.join(',')}}`;
}

export async function getContractActionLogs(
    db: DB, contract: string, actions: string[], condition: { [key: string]: any },
    offset: number = 0, limit: number = 100, order: 'asc' | 'desc' = 'asc'
): Promise<Array<{ log_id: number, name: string, data: any, txid: string, created_at_block: string, created_at_time: string }>> {
    const queryStr = 'SELECT global_sequence log_id, name, metadata "data", encode(txid::bytea, \'hex\') txid, created_at_block, created_at_time ' +
        'FROM contract_traces ' +
        'WHERE account = $1 AND name = ANY($2) AND metadata @> $3::jsonb ' +
        'ORDER BY global_sequence ' + (order === 'asc' ? 'ASC' : 'DESC') + ' LIMIT $4 OFFSET $5 ';

    const query = await db.query(queryStr, [contract, actions, buildJsonbCondition(condition), limit, offset]);
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

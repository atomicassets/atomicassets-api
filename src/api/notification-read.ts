import type { DB } from './server';
import type { NotificationData } from '../filler/notification-format';
import logger from '../utils/winston';

// The query surface alone. A socket handler holds the pg pool, which serves
// query() but not the rest of DB.
type NotifiedRowsDb = Pick<DB, 'query'>;

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 100;
const WARN_INTERVAL_MS = 60000;

// One entry per channel, and a channel set is fixed and small, so the map is
// bounded. A replica that lags for minutes exhausts the budget on every batch,
// and an unthrottled line per batch buries every other log the server writes.
const warnState = new Map<string, {lastWarnAt: number, suppressed: number}>();

function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

type NotifiedRowsQuery<T> = {
    sql: string,
    params: any[],
    ids: any[],
    expectedBlockById: Map<string, number>,
    keyOf: (row: T) => any,
    blockOf: (row: T) => any,
    channel: string,
    attempts?: number,
    delayMs?: number,
    sleep?: (ms: number) => Promise<void>,
    clock?: () => number
};

/**
 * Collect, per identifier, the highest block a notification reports for it.
 *
 * `identifier` is the key to read from the action data or the delta row, or a
 * function that returns the identifier for one notification. Fork
 * notifications carry no identifier and are left out.
 */
export function extractNotificationBlocks(
    notifications: NotificationData[],
    identifier: string | ((notification: NotificationData) => any)
): Map<string, number> {
    const blocks = new Map<string, number>();

    for (const notification of notifications) {
        if (notification.type === 'fork') {
            continue;
        }

        let id: any = null;

        if (typeof identifier === 'function') {
            id = identifier(notification);
        } else if (notification.type === 'delta' && notification.data.delta) {
            id = (<any>notification.data.delta).value[identifier];
        } else if (notification.type === 'trace' && notification.data.trace) {
            id = (<any>notification.data.trace.act.data)[identifier];
        }

        if (id === null || id === undefined) {
            continue;
        }

        const blockNum = Number(notification.data.block?.block_num);

        if (!Number.isFinite(blockNum)) {
            continue;
        }

        const key = String(id);
        const known = blocks.get(key);

        if (known === undefined || blockNum > known) {
            blocks.set(key, blockNum);
        }
    }

    return blocks;
}

// The filler publishes a notification once its write is committed on the
// primary, but the API reads through an asynchronous replica, so the row a
// notification names can still hold its pre-action state or be missing. Each
// notification carries the block its write belongs to, and a row has caught up
// once its block column reaches that number, so a lagging read is worth
// repeating. The repeat is bounded: after `attempts` queries the rows the
// replica holds are returned and the shortfall is logged, at most one line per
// channel per minute. A height does not identify a branch, so a fork that
// rewrites a row at the same height reads as fresh here, and the replica's
// replay of the rollback closes that window.
export async function readNotifiedRows<T = any>(db: NotifiedRowsDb, query: NotifiedRowsQuery<T>): Promise<T[]> {
    const {sql, params, ids, expectedBlockById, keyOf, blockOf, channel} = query;
    const attempts = query.attempts ?? DEFAULT_ATTEMPTS;
    const delayMs = query.delayMs ?? DEFAULT_DELAY_MS;
    const sleep = query.sleep ?? defaultSleep;
    const clock = query.clock ?? Date.now;

    const wanted = [...new Set(ids.map(id => String(id)))];

    let rows: T[] = [];
    let behind: string[] = [];

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const result = await db.query<T>(sql, params);

        rows = result.rows;

        const rowById = new Map<string, T>();

        for (const row of rows) {
            rowById.set(String(keyOf(row)), row);
        }

        behind = wanted.filter(id => {
            const expected = expectedBlockById.get(id);

            if (expected === undefined) {
                return false;
            }

            const row = rowById.get(id);

            if (row === undefined) {
                return true;
            }

            // A row whose block column reads as no number counts as behind,
            // which the negated comparison gives and `<` does not.
            return !(Number(blockOf(row)) >= expected);
        });

        if (behind.length === 0) {
            return rows;
        }

        if (attempt < attempts) {
            await sleep(delayMs);
        }
    }

    if (behind.length > 0) {
        const now = clock();
        const state = warnState.get(channel);

        if (state === undefined || now - state.lastWarnAt >= WARN_INTERVAL_MS) {
            logger.warn('Notified rows are behind the notified block', {
                channel,
                ids: behind,
                expected_block: Math.max(...behind.map(id => expectedBlockById.get(id))),
                attempts,
                suppressed_batches: state === undefined ? 0 : state.suppressed
            });

            warnState.set(channel, {lastWarnAt: now, suppressed: 0});
        } else {
            state.suppressed += 1;
        }
    }

    return rows;
}

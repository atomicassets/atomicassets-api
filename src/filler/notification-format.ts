import { ShipBlock } from '../types/ship';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../types/eosio';

// Version 2 of the filler-to-server notification wire format. The legacy form is
// a JSON array of NotificationData, which embeds a full copy of the transaction
// in every notification that belongs to it, so a transaction with many matching
// traces is serialized once per trace. The envelope below carries each
// transaction once per message and refers to it by key.
export const NOTIFICATION_FORMAT_VERSION = 2;

// Notifications per published message. The filler splits a batch into chunks of
// this size so every message decodes on its own with no state carried between
// messages.
export const NOTIFICATION_CHUNK_SIZE = 50;

export type NotificationData = {
    channel: string,
    type: 'trace' | 'delta' | 'fork',
    data: {block: ShipBlock, tx?: EosioTransaction, trace?: EosioActionTrace, delta?: EosioContractRow}
};

export type NotificationEnvelopeEntry = {
    channel: string | null,
    type: 'trace' | 'delta' | 'fork',
    block: ShipBlock,
    tx_id?: string,
    trace?: EosioActionTrace,
    delta?: EosioContractRow
};

export type NotificationEnvelope = {
    v: number,
    txs: {[reference: string]: EosioTransaction},
    n: NotificationEnvelopeEntry[]
};

function isRecord(value: unknown): value is {[key: string]: unknown} {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotificationType(type: unknown): type is 'trace' | 'delta' | 'fork' {
    return type === 'trace' || type === 'delta' || type === 'fork';
}

// Shared between the compact and the legacy decode path: a referenced value
// that is null, an empty object or otherwise missing its id and traces is not
// a transaction, and a socket route that dereferences tx.id throws.
function isWellFormedTransaction(tx: unknown): tx is {[key: string]: unknown, id: string, traces: unknown[]} {
    return isRecord(tx) && typeof tx.id === 'string' && Array.isArray(tx.traces);
}

/**
 * Build the compact envelope for one chunk of notifications.
 *
 * Transactions are keyed by object reference, not by id: extractShipTraces
 * pushes the same transaction object for every trace of a transaction, so the
 * reference is what tells one transaction from another. Two distinct objects
 * that carry the same id both get an entry, the later one under an `id#n`
 * suffix, so neither overwrites the other.
 */
export function encodeNotifications(chunk: NotificationData[]): {envelope: NotificationEnvelope, transactions: number} {
    const references = new Map<EosioTransaction, string>();
    const txs: {[reference: string]: EosioTransaction} = {};
    const entries: NotificationEnvelopeEntry[] = [];

    for (const notification of chunk) {
        const entry: NotificationEnvelopeEntry = {
            channel: notification.channel ?? null,
            type: notification.type,
            block: notification.data.block
        };

        const tx = notification.data.tx;

        if (tx) {
            let reference = references.get(tx);

            if (reference === undefined) {
                reference = tx.id;

                for (let suffix = 1; Object.prototype.hasOwnProperty.call(txs, reference); suffix += 1) {
                    reference = tx.id + '#' + suffix;
                }

                references.set(tx, reference);
                txs[reference] = tx;
            }

            entry.tx_id = reference;
        }

        if (notification.data.trace !== undefined) {
            entry.trace = notification.data.trace;
        }

        if (notification.data.delta !== undefined) {
            entry.delta = notification.data.delta;
        }

        entries.push(entry);
    }

    return {
        envelope: {v: NOTIFICATION_FORMAT_VERSION, txs, n: entries},
        transactions: Object.keys(txs).length
    };
}

/**
 * Decode one published message into the notification array the API dispatches.
 *
 * The message is untrusted input. Anything that does not satisfy the accept rule
 * throws, and the caller skips the whole message rather than dispatching a
 * notification with a missing transaction.
 */
export function decodeNotificationMessage(message: string): NotificationData[] {
    const parsed: unknown = JSON.parse(message);

    // The top level type discriminates the two forms: an array is a message from
    // a filler that still publishes the legacy form. Each entry is validated
    // against the same per-type rules the compact path applies, adapted to the
    // legacy nested-data shape, and the whole message is rejected on the first
    // bad row: a null or malformed row would otherwise reach a listener, which
    // reads `channel` and `data` off every row outside any try.
    if (Array.isArray(parsed)) {
        if (parsed.length > NOTIFICATION_CHUNK_SIZE) {
            throw new Error('Notification message carries more than ' + NOTIFICATION_CHUNK_SIZE + ' entries');
        }

        return parsed.map(decodeLegacyEntry);
    }

    if (!isRecord(parsed)) {
        throw new Error('Notification message is neither an array nor an object');
    }

    if (parsed.v !== NOTIFICATION_FORMAT_VERSION) {
        // JSON.stringify(undefined) returns the value undefined rather than a
        // string, so a message with no v would otherwise throw a TypeError from
        // .slice() and report the wrong failure. String() first keeps the
        // diagnostic on the unsupported version even when v is absent.
        throw new Error('Unsupported notification format version ' + String(JSON.stringify(parsed.v)).slice(0, 64));
    }

    const entries = parsed.n;

    if (!Array.isArray(entries)) {
        throw new Error('Notification envelope carries no entry array');
    }

    const txs = parsed.txs === undefined ? {} : parsed.txs;

    if (!isRecord(txs)) {
        throw new Error('Notification envelope carries a transaction map that is not an object');
    }

    if (entries.length > NOTIFICATION_CHUNK_SIZE) {
        throw new Error('Notification message carries more than ' + NOTIFICATION_CHUNK_SIZE + ' entries');
    }

    // Each entry is checked against the shape its own type requires: a trace
    // entry needs a transaction reference, an object trace and a string
    // channel; a delta entry needs an object delta and a string channel; a
    // fork entry needs no transaction reference and a channel that is null or
    // absent. An entry of any other type is rejected outright.
    const referencedTxIds = new Set<string>();
    const decoded = entries.map(entry => decodeEntry(entry, txs, referencedTxIds));

    // txs carries only the transactions the entries reference. A key nothing
    // references cannot have come from the encoder, so its presence means the
    // message was tampered with or built by hand.
    for (const reference of Object.keys(txs)) {
        if (!referencedTxIds.has(reference)) {
            throw new Error('Notification envelope carries a transaction no entry references');
        }
    }

    return decoded;
}

function decodeEntry(entry: unknown, txs: {[key: string]: unknown}, referencedTxIds: Set<string>): NotificationData {
    if (!isRecord(entry)) {
        throw new Error('Notification entry is not an object');
    }

    if (!isNotificationType(entry.type)) {
        throw new Error('Notification entry carries an unsupported type');
    }

    if (!isRecord(entry.block)) {
        throw new Error('Notification entry carries no block');
    }

    // The encoder always resolves a tx_id and a trace for a trace entry, and
    // always carries a string channel for a trace or a delta entry. An entry
    // that claims one of those types but does not carry the payload the type
    // implies cannot be one the encoder produced, and a consumer that trusts
    // the type dereferences the missing field.
    if (entry.type === 'trace') {
        if (typeof entry.tx_id !== 'string') {
            throw new Error('Notification entry has type trace but carries no tx_id');
        }

        if (!isRecord(entry.trace)) {
            throw new Error('Notification entry has type trace but carries no trace');
        }

        if (typeof entry.channel !== 'string') {
            throw new Error('Notification entry has type trace but carries no channel');
        }
    }

    if (entry.type === 'delta') {
        if (!isRecord(entry.delta)) {
            throw new Error('Notification entry has type delta but carries no delta');
        }

        if (typeof entry.channel !== 'string') {
            throw new Error('Notification entry has type delta but carries no channel');
        }
    }

    // A fork is not scoped to one channel and never carries a transaction: it
    // is the only rollback signal a socket client gets, so every listener
    // receives it.
    if (entry.type === 'fork') {
        if (entry.channel !== null && entry.channel !== undefined) {
            throw new Error('Notification entry has type fork but carries a channel');
        }

        if (entry.tx_id !== undefined) {
            throw new Error('Notification entry has type fork but carries a tx_id');
        }
    }

    // Legacy key order: block, then tx, then trace or delta. A serialization of
    // the decoded array is byte for byte what the legacy array form carried, so
    // a consumer cannot tell the two wire forms apart.
    const data: NotificationData['data'] = {block: entry.block as unknown as ShipBlock};

    if (entry.tx_id !== undefined) {
        if (typeof entry.tx_id !== 'string' || !Object.prototype.hasOwnProperty.call(txs, entry.tx_id)) {
            throw new Error('Notification entry references a transaction the message does not carry');
        }

        const tx = txs[entry.tx_id];

        if (!isWellFormedTransaction(tx)) {
            throw new Error('Notification entry references a transaction that is not well formed');
        }

        referencedTxIds.add(entry.tx_id);

        // One parsed transaction object is shared by every notification that
        // references it, the same sharing the filler does on the publish side.
        // The object is read only by contract: a consumer that mutates it
        // mutates every other notification of the same transaction.
        data.tx = tx as unknown as EosioTransaction;
    }

    if (entry.trace !== undefined) {
        data.trace = entry.trace as EosioActionTrace;
    }

    if (entry.delta !== undefined) {
        data.delta = entry.delta as EosioContractRow;
    }

    return {
        channel: entry.type === 'fork' ? null : (entry.channel as string),
        type: entry.type,
        data
    };
}

/**
 * Validate one entry of a legacy notification array before it reaches a
 * listener. The legacy wire form carries no envelope-level checks of its own,
 * so each row is checked against the same per-type rules decodeEntry applies
 * to the compact form, adapted to the legacy nested data shape: a trace row
 * needs a string channel, an object data.trace and a well-formed data.tx; a
 * delta row needs a string channel and an object data.delta; a fork row needs
 * no channel and no data.tx. A bad row throws, so the caller rejects the
 * whole message rather than dispatching a notification with a missing field.
 */
function decodeLegacyEntry(entry: unknown): NotificationData {
    if (!isRecord(entry)) {
        throw new Error('Legacy notification array carries an entry that is not an object');
    }

    if (!isNotificationType(entry.type)) {
        throw new Error('Legacy notification entry carries an unsupported type');
    }

    if (!isRecord(entry.data) || !isRecord(entry.data.block)) {
        throw new Error('Legacy notification entry carries no block');
    }

    if (entry.type === 'trace') {
        if (typeof entry.channel !== 'string') {
            throw new Error('Legacy notification entry has type trace but carries no channel');
        }

        if (!isRecord(entry.data.trace)) {
            throw new Error('Legacy notification entry has type trace but carries no trace');
        }

        if (!isWellFormedTransaction(entry.data.tx)) {
            throw new Error('Legacy notification entry has type trace but carries no well formed transaction');
        }
    }

    if (entry.type === 'delta') {
        if (typeof entry.channel !== 'string') {
            throw new Error('Legacy notification entry has type delta but carries no channel');
        }

        if (!isRecord(entry.data.delta)) {
            throw new Error('Legacy notification entry has type delta but carries no delta');
        }
    }

    // A fork is not scoped to one channel and never carries a transaction: it
    // is the only rollback signal a socket client gets, so every listener
    // receives it.
    if (entry.type === 'fork') {
        if (entry.channel !== null && entry.channel !== undefined) {
            throw new Error('Legacy notification entry has type fork but carries a channel');
        }

        if (entry.data.tx !== undefined) {
            throw new Error('Legacy notification entry has type fork but carries a tx');
        }
    }

    return {
        channel: entry.type === 'fork' ? null : (entry.channel as string),
        type: entry.type,
        data: entry.data as NotificationData['data']
    };
}

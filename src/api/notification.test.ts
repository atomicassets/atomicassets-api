import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';

import ApiNotificationReceiver from './notification';
import {encodeNotifications, NotificationData} from '../filler/notification-format';
import {EosioTransaction} from '../types/eosio';
import logger from '../utils/winston';

const CHANNEL = 'eosio-contract-api:test:test-reader:api';

type Harness = {
    receiver: ApiNotificationReceiver;
    emit: (message: string, channel?: string) => Promise<void>;
};

function createHarness(): Harness {
    let handler: (channel: string, message: string) => Promise<void>;

    const ioRedisSub = {
        setMaxListeners: (): void => undefined,
        getMaxListeners: (): number => 10,
        subscribe: (_channel: string, callback: () => void): void => callback(),
        on: (event: string, listener: (channel: string, message: string) => Promise<void>): void => {
            if (event === 'message') {
                handler = listener;
            }
        }
    };

    const connection = {chain: {name: 'test'}, redis: {ioRedisSub}} as any;
    const receiver = new ApiNotificationReceiver(connection, 'test-reader');

    return {receiver, emit: (message, channel = CHANNEL): Promise<void> => handler(channel, message)};
}

function makeBlock(blockNum = 1000): any {
    return {
        block_id: blockNum.toString(16).padStart(64, '0'),
        block_num: blockNum,
        timestamp: '2026-01-01T00:00:00.000',
        producer: 'producer1'
    };
}

function makeTransaction(id: string, cpuUsage = 100): EosioTransaction {
    return {id, cpu_usage_us: cpuUsage, net_usage_words: 10, traces: []};
}

function makeTrace(ordinal: number): any {
    return {
        action_ordinal: ordinal,
        creator_action_ordinal: 0,
        global_sequence: String(ordinal),
        account_ram_deltas: [],
        act: {
            account: 'atomicassets',
            name: 'logmint',
            authorization: [{actor: 'atomicassets', permission: 'active'}],
            data: {asset_id: String(1099511627776 + ordinal)}
        }
    };
}

function traceNotification(channel: string, tx: EosioTransaction, ordinal: number): NotificationData {
    return {channel, type: 'trace', data: {block: makeBlock(), tx, trace: makeTrace(ordinal)}};
}

function deltaNotification(channel: string): NotificationData {
    return {
        channel,
        type: 'delta',
        data: {
            block: makeBlock(),
            delta: {
                code: 'atomicassets',
                scope: 'atomicassets',
                table: 'config',
                primary_key: '1',
                payer: 'atomicassets',
                present: true,
                value: {asset_counter: '5'}
            }
        }
    };
}

function forkNotification(): NotificationData {
    return {channel: null, type: 'fork', data: {block: makeBlock(900)}} as any;
}

function compact(notifications: NotificationData[]): string {
    return JSON.stringify(encodeNotifications(notifications).envelope);
}

describe('ApiNotificationReceiver', () => {
    afterEach(() => {
        sinon.restore();
    });

    describe('dispatch', () => {
        it('passes a legacy array through to the listener unchanged', async () => {
            const {receiver, emit} = createHarness();
            const notifications = [traceNotification('assets', makeTransaction('a'.repeat(64)), 1)];
            const received: NotificationData[][] = [];

            receiver.onData('assets', async rows => received.push(rows));

            await emit(JSON.stringify(notifications));

            expect(received).to.have.length(1);
            expect(received[0]).to.deep.equal(notifications);
        });

        it('decodes the legacy and the compact form of one batch to equal serializations', async () => {
            const tx = makeTransaction('b'.repeat(64));
            const notifications = [
                traceNotification('assets', tx, 1),
                traceNotification('assets', tx, 2),
                deltaNotification('assets'),
                forkNotification()
            ];

            const legacy = createHarness();
            const legacyReceived: NotificationData[][] = [];
            legacy.receiver.onData('assets', async rows => legacyReceived.push(rows));
            await legacy.emit(JSON.stringify(notifications));

            const envelope = createHarness();
            const envelopeReceived: NotificationData[][] = [];
            envelope.receiver.onData('assets', async rows => envelopeReceived.push(rows));
            await envelope.emit(compact(notifications));

            expect(JSON.stringify(envelopeReceived[0])).to.equal(JSON.stringify(legacyReceived[0]));
        });

        it('hands one rehydrated transaction object to every notification that references it', async () => {
            const {receiver, emit} = createHarness();
            const tx = makeTransaction('c'.repeat(64));
            const received: NotificationData[] = [];

            receiver.onData('assets', async rows => {
                received.push(...rows);
            });

            await emit(compact([traceNotification('assets', tx, 1), traceNotification('assets', tx, 2)]));

            expect(received).to.have.length(2);
            expect(received[0].data.tx).to.equal(received[1].data.tx);
            expect(received[0].data.tx).to.deep.equal(tx);
        });

        it('gives a listener only the rows of its own channel', async () => {
            const {receiver, emit} = createHarness();
            const tx = makeTransaction('d'.repeat(64));
            const received: NotificationData[] = [];

            receiver.onData('assets', async rows => {
                received.push(...rows);
            });

            await emit(compact([traceNotification('assets', tx, 1), traceNotification('transfers', tx, 2)]));

            expect(received).to.have.length(1);
            expect(received[0].channel).to.equal('assets');
        });

        it('delivers a fork row to every listener', async () => {
            const {receiver, emit} = createHarness();
            const assets: NotificationData[] = [];
            const transfers: NotificationData[] = [];

            receiver.onData('assets', async rows => {
                assets.push(...rows);
            });
            receiver.onData('transfers', async rows => {
                transfers.push(...rows);
            });

            await emit(compact([forkNotification()]));

            expect(assets.map(row => row.type)).to.deep.equal(['fork']);
            expect(transfers.map(row => row.type)).to.deep.equal(['fork']);
        });

        it('delivers a legacy fork row with no channel key to every listener as channel null', async () => {
            const {receiver, emit} = createHarness();
            const assets: NotificationData[] = [];
            const transfers: NotificationData[] = [];

            receiver.onData('assets', async rows => {
                assets.push(...rows);
            });
            receiver.onData('transfers', async rows => {
                transfers.push(...rows);
            });

            await emit(JSON.stringify([{type: 'fork', data: {block: makeBlock(900)}}]));

            expect(assets.map(row => row.channel)).to.deep.equal([null]);
            expect(transfers.map(row => row.channel)).to.deep.equal([null]);
        });

        it('does not call a listener whose channel matches nothing', async () => {
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();

            receiver.onData('sales', listener);

            await emit(compact([traceNotification('assets', makeTransaction('e'.repeat(64)), 1)]));

            expect(listener.called).to.equal(false);
        });

        it('ignores a message published on another channel', async () => {
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();

            receiver.onData('assets', listener);

            await emit(
                compact([traceNotification('assets', makeTransaction('f'.repeat(64)), 1)]),
                'eosio-contract-api:test:other-reader:api'
            );

            expect(listener.called).to.equal(false);
        });

        it('removes the listener the onData disposer was returned for', async () => {
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const dispose = receiver.onData('assets', listener);

            dispose();

            await emit(compact([traceNotification('assets', makeTransaction('1'.repeat(64)), 1)]));

            expect(listener.called).to.equal(false);
        });
    });

    describe('malformed messages', () => {
        it('logs a warning and calls no listener for invalid JSON', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();

            receiver.onData('assets', listener);

            await emit('{"v":2,"n":[');

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips an envelope with an unsupported version', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();

            receiver.onData('assets', listener);

            await emit(JSON.stringify({v: 3, txs: {}, n: [{channel: 'assets', type: 'trace', block: makeBlock()}]}));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('skips the whole message when a tx_id resolves to no txs entry', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('2'.repeat(64));
            const envelope = encodeNotifications([
                traceNotification('assets', tx, 1),
                traceNotification('assets', tx, 2)
            ]).envelope;

            envelope.txs = {};

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact envelope with 51 entries', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('4'.repeat(64));
            const notifications: NotificationData[] = [];

            for (let i = 0; i < 51; i += 1) {
                notifications.push(traceNotification('assets', tx, i));
            }

            receiver.onData('assets', listener);

            await emit(compact(notifications));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a legacy array with 51 entries', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('5'.repeat(64));
            const notifications: NotificationData[] = [];

            for (let i = 0; i < 51; i += 1) {
                notifications.push(traceNotification('assets', tx, i));
            }

            receiver.onData('assets', listener);

            await emit(JSON.stringify(notifications));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact trace entry with no tx_id', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('6'.repeat(64));
            const envelope = encodeNotifications([traceNotification('assets', tx, 1)]).envelope;

            delete envelope.n[0].tx_id;

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact entry with an unsupported type', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const envelope = encodeNotifications([forkNotification()]).envelope;

            envelope.n[0].type = 'reorg' as any;

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact delta entry with no delta', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const envelope = encodeNotifications([deltaNotification('assets')]).envelope;

            delete envelope.n[0].delta;

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact trace entry with a non-string channel', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('7'.repeat(64));
            const envelope = encodeNotifications([traceNotification('assets', tx, 1)]).envelope;

            envelope.n[0].channel = 5 as any;

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact fork entry with a string channel', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const envelope = encodeNotifications([forkNotification()]).envelope;

            envelope.n[0].channel = 'assets';

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact envelope whose referenced transaction is null', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('8'.repeat(64));
            const envelope = encodeNotifications([traceNotification('assets', tx, 1)]).envelope;

            (envelope.txs as any)[envelope.n[0].tx_id as string] = null;

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact envelope whose referenced transaction carries no string id', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('9'.repeat(64));
            const envelope = encodeNotifications([traceNotification('assets', tx, 1)]).envelope;

            (envelope.txs as any)[envelope.n[0].tx_id as string] = {cpu_usage_us: 100, net_usage_words: 10, traces: []};

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact entry whose block is not an object', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('e'.repeat(64));
            const envelope = encodeNotifications([traceNotification('assets', tx, 1)]).envelope;

            (envelope.n[0] as any).block = null;

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a legacy row whose block is not an object', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const row = traceNotification('assets', makeTransaction('f'.repeat(64)), 1);

            (row.data as any).block = 'not a block';

            receiver.onData('assets', listener);

            await emit(JSON.stringify([row]));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a compact envelope with a transaction no entry references', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const tx = makeTransaction('c'.repeat(64));
            const unreferenced = makeTransaction('d'.repeat(64));
            const envelope = encodeNotifications([traceNotification('assets', tx, 1)]).envelope;

            envelope.txs[unreferenced.id] = unreferenced;

            receiver.onData('assets', listener);

            await emit(JSON.stringify(envelope));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a legacy delta row with an empty data object', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();

            receiver.onData('assets', listener);

            await emit(JSON.stringify([{channel: 'assets', type: 'delta', data: {}}]));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a legacy trace row whose data.tx is null', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const notification = traceNotification('assets', makeTransaction('0'.repeat(64)), 1);

            (notification.data as any).tx = null;

            receiver.onData('assets', listener);

            await emit(JSON.stringify([notification]));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a legacy trace row with a null channel', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();
            const notification = traceNotification('assets', makeTransaction('ab'.repeat(32)), 1);

            (notification as any).channel = null;

            receiver.onData('assets', listener);

            await emit(JSON.stringify([notification]));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning and skips a legacy row with an unknown type', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();

            receiver.onData('assets', listener);

            await emit(JSON.stringify([{channel: 'assets', type: 'reorg', data: {block: makeBlock()}}]));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
        });

        it('logs a warning naming the unsupported version when an object message carries no v', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {receiver, emit} = createHarness();
            const listener = sinon.stub().resolves();

            receiver.onData('assets', listener);

            await emit(JSON.stringify({n: []}));

            expect(warnSpy.calledOnce).to.equal(true);
            expect(listener.called).to.equal(false);
            expect(warnSpy.firstCall.args[1].error).to.include('Unsupported notification format version');
        });
    });

    describe('round trips', () => {
        it('gives each notification its own transaction when two share an id', async () => {
            const {receiver, emit} = createHarness();
            const id = '3'.repeat(64);
            const received: NotificationData[] = [];

            receiver.onData('assets', async rows => {
                received.push(...rows);
            });

            await emit(compact([
                traceNotification('assets', makeTransaction(id, 100), 1),
                traceNotification('assets', makeTransaction(id, 200), 2)
            ]));

            expect(received).to.have.length(2);
            expect(received[0].data.tx).to.not.equal(received[1].data.tx);
            expect(received[0].data.tx.cpu_usage_us).to.equal(100);
            expect(received[1].data.tx.cpu_usage_us).to.equal(200);
        });

        it('round trips a delta entry as block and delta with no tx', async () => {
            const {receiver, emit} = createHarness();
            const notification = deltaNotification('assets');
            const received: NotificationData[] = [];

            receiver.onData('assets', async rows => {
                received.push(...rows);
            });

            await emit(compact([notification]));

            expect(received).to.have.length(1);
            expect(Object.keys(received[0].data)).to.deep.equal(['block', 'delta']);
            expect(received[0].data.tx).to.equal(undefined);
            expect(received[0]).to.deep.equal(notification);
        });
    });
});

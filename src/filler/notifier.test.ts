import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';
import {Counter, Histogram} from 'prom-client';

import ApiNotificationSender from './notifier';
import {decodeNotificationMessage, NotificationEnvelope} from './notification-format';
import {EosioActionTrace, EosioContractRow, EosioTransaction} from '../types/eosio';
import {ShipBlock} from '../types/ship';
import logger from '../utils/winston';
import {
    notificationBatchesSkipped,
    notificationBytesPublished,
    notificationPublishDuration,
    notificationPublishFailures,
    notificationsPublished,
    notificationsSkipped,
    notificationTransactionsPublished,
    resetFillerPublishMetrics
} from '../metrics/filler-publish';

const HEAD_DISTANCE = 24;

function makeBlock(blockNum = 1000): ShipBlock {
    return {
        block_id: blockNum.toString(16).padStart(64, '0'),
        block_num: blockNum,
        timestamp: '2026-01-01T00:00:00.000',
        producer: 'producer1'
    } as any;
}

function makeTransaction(id: string, cpuUsage = 100): EosioTransaction {
    return {id, cpu_usage_us: cpuUsage, net_usage_words: 10, traces: []};
}

function makeTrace(ordinal: number): EosioActionTrace {
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

function makeRow(primaryKey: string): EosioContractRow {
    return {
        code: 'atomicassets',
        scope: 'atomicassets',
        table: 'config',
        primary_key: primaryKey,
        payer: 'atomicassets',
        present: true,
        value: {collection_format: []}
    };
}

function createSender(headDistanceBlocks = HEAD_DISTANCE): {
    sender: ApiNotificationSender;
    publish: sinon.SinonStub;
} {
    const publish = sinon.stub().resolves();
    const connection = {chain: {name: 'test'}, redis: {ioRedis: {publish}}} as any;

    return {sender: new ApiNotificationSender(connection, 'test-reader', headDistanceBlocks), publish};
}

function publishedEnvelopes(publish: sinon.SinonStub): NotificationEnvelope[] {
    return publish.getCalls().map(call => JSON.parse(call.args[1]));
}

async function counterValue(counter: Counter<string>): Promise<number> {
    const metric = await counter.get();

    return metric.values.reduce((sum, entry) => sum + entry.value, 0);
}

async function histogramObservations(histogram: Histogram<string>): Promise<number> {
    const metric = await histogram.get();
    const entry = metric.values.find(value => value.metricName?.endsWith('_count'));

    return entry ? entry.value : 0;
}

describe('ApiNotificationSender', () => {
    beforeEach(() => {
        resetFillerPublishMetrics();
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('encoding', () => {
        it('publishes nothing and touches no counter for an empty queue', async () => {
            const {sender, publish} = createSender();

            await sender.publish();

            expect(publish.called).to.equal(false);
            expect(await counterValue(notificationsPublished)).to.equal(0);
            expect(await counterValue(notificationTransactionsPublished)).to.equal(0);
            expect(await counterValue(notificationBytesPublished)).to.equal(0);
            expect(await histogramObservations(notificationPublishDuration)).to.equal(0);
        });

        it('serializes fifty traces of one transaction as a single txs entry', async () => {
            const {sender, publish} = createSender();
            const tx = makeTransaction('a'.repeat(64));

            sender.setBlockDistance(0);

            for (let i = 0; i < 50; i++) {
                sender.sendActionTrace('assets', makeBlock(), tx, makeTrace(i));
            }

            await sender.publish();

            const envelopes = publishedEnvelopes(publish);

            expect(envelopes).to.have.length(1);
            expect(Object.keys(envelopes[0].txs)).to.deep.equal(['a'.repeat(64)]);
            expect(envelopes[0].n).to.have.length(50);
        });

        it('splits one hundred seventy five traces into four messages that each decode alone', async () => {
            const {sender, publish} = createSender();
            const tx = makeTransaction('b'.repeat(64));

            sender.setBlockDistance(0);

            for (let i = 0; i < 175; i++) {
                sender.sendActionTrace('assets', makeBlock(), tx, makeTrace(i));
            }

            await sender.publish();

            expect(publish.callCount).to.equal(4);

            const decoded = publish.getCalls().map(call => decodeNotificationMessage(call.args[1]));

            expect(decoded.map(rows => rows.length)).to.deep.equal([50, 50, 50, 25]);

            for (const rows of decoded) {
                for (const row of rows) {
                    expect(row.data.tx).to.not.equal(undefined);
                    expect(row.data.tx.id).to.equal('b'.repeat(64));
                }
            }
        });

        it('holds at most fifty notifications per chunk', async () => {
            const {sender, publish} = createSender();
            const tx = makeTransaction('c'.repeat(64));

            sender.setBlockDistance(0);

            for (let i = 0; i < 175; i++) {
                sender.sendActionTrace('assets', makeBlock(), tx, makeTrace(i));
            }

            await sender.publish();

            for (const envelope of publishedEnvelopes(publish)) {
                expect(envelope.n.length).to.be.at.most(50);
            }
        });

        it('carries two distinct transactions of one chunk in txs', async () => {
            const {sender, publish} = createSender();
            const first = makeTransaction('d'.repeat(64));
            const second = makeTransaction('e'.repeat(64));

            sender.setBlockDistance(0);
            sender.sendActionTrace('assets', makeBlock(), first, makeTrace(1));
            sender.sendActionTrace('assets', makeBlock(), second, makeTrace(2));

            await sender.publish();

            const envelope = publishedEnvelopes(publish)[0];

            expect(Object.keys(envelope.txs)).to.deep.equal(['d'.repeat(64), 'e'.repeat(64)]);
            expect(envelope.n.map(entry => entry.tx_id)).to.deep.equal(['d'.repeat(64), 'e'.repeat(64)]);
        });

        it('keeps two distinct transaction objects that share an id under separate references', async () => {
            const {sender, publish} = createSender();
            const id = 'f'.repeat(64);
            const first = makeTransaction(id, 100);
            const second = makeTransaction(id, 200);

            sender.setBlockDistance(0);
            sender.sendActionTrace('assets', makeBlock(), first, makeTrace(1));
            sender.sendActionTrace('assets', makeBlock(), second, makeTrace(2));

            await sender.publish();

            const envelope = publishedEnvelopes(publish)[0];

            expect(Object.keys(envelope.txs)).to.deep.equal([id, id + '#1']);
            expect(envelope.txs[id].cpu_usage_us).to.equal(100);
            expect(envelope.txs[id + '#1'].cpu_usage_us).to.equal(200);
            expect(envelope.n.map(entry => entry.tx_id)).to.deep.equal([id, id + '#1']);
        });

        it('publishes a fork entry with no tx_id and a null channel', async () => {
            const {sender, publish} = createSender();

            sender.sendFork(makeBlock(900));

            await sender.publish();

            const envelope = publishedEnvelopes(publish)[0];

            expect(envelope.n).to.have.length(1);
            expect(envelope.n[0].type).to.equal('fork');
            expect(envelope.n[0].channel).to.equal(null);
            expect(envelope.n[0].tx_id).to.equal(undefined);
            expect(Object.keys(envelope.txs)).to.deep.equal([]);
        });
    });

    describe('head distance gate', () => {
        it('publishes no trace or delta notification at the threshold and leaves the queue empty', async () => {
            const {sender, publish} = createSender();

            sender.setBlockDistance(HEAD_DISTANCE);
            sender.sendActionTrace('assets', makeBlock(), makeTransaction('1'.repeat(64)), makeTrace(1));
            sender.sendContractRow('assets', makeBlock(), makeRow('1'));

            await sender.publish();

            expect(publish.called).to.equal(false);
            expect(sender.notifications).to.have.length(0);
        });

        it('publishes below the threshold', async () => {
            const {sender, publish} = createSender();

            sender.setBlockDistance(HEAD_DISTANCE - 1);
            sender.sendActionTrace('assets', makeBlock(), makeTransaction('2'.repeat(64)), makeTrace(1));

            await sender.publish();

            expect(publish.callCount).to.equal(1);
        });

        it('skips exactly at the threshold and publishes one block below it', async () => {
            const atThreshold = createSender();
            atThreshold.sender.setBlockDistance(HEAD_DISTANCE);
            atThreshold.sender.sendActionTrace('assets', makeBlock(), makeTransaction('3'.repeat(64)), makeTrace(1));
            await atThreshold.sender.publish();

            const belowThreshold = createSender();
            belowThreshold.sender.setBlockDistance(HEAD_DISTANCE - 1);
            belowThreshold.sender.sendActionTrace('assets', makeBlock(), makeTransaction('3'.repeat(64)), makeTrace(1));
            await belowThreshold.sender.publish();

            expect(atThreshold.publish.called).to.equal(false);
            expect(belowThreshold.publish.callCount).to.equal(1);
        });

        it('publishes only the fork entries of a gated batch', async () => {
            const {sender, publish} = createSender();

            sender.setBlockDistance(HEAD_DISTANCE + 100);
            sender.sendActionTrace('assets', makeBlock(), makeTransaction('4'.repeat(64)), makeTrace(1));
            sender.sendContractRow('assets', makeBlock(), makeRow('1'));
            sender.sendFork(makeBlock(900));

            await sender.publish();

            const envelope = publishedEnvelopes(publish)[0];

            expect(publish.callCount).to.equal(1);
            expect(envelope.n).to.have.length(1);
            expect(envelope.n[0].type).to.equal('fork');
            expect(await counterValue(notificationBatchesSkipped)).to.equal(1);
            expect(await counterValue(notificationsSkipped)).to.equal(2);
        });

        it('publishes nothing for a gated batch that carries no fork', async () => {
            const {sender, publish} = createSender();

            sender.setBlockDistance(HEAD_DISTANCE + 100);
            sender.sendActionTrace('assets', makeBlock(), makeTransaction('5'.repeat(64)), makeTrace(1));

            await sender.publish();

            expect(publish.called).to.equal(false);
            expect(await counterValue(notificationBatchesSkipped)).to.equal(1);
            expect(await counterValue(notificationsSkipped)).to.equal(1);
        });

        it('takes the threshold from the constructor argument', async () => {
            const wide = createSender(1000);
            wide.sender.setBlockDistance(500);
            wide.sender.sendActionTrace('assets', makeBlock(), makeTransaction('6'.repeat(64)), makeTrace(1));
            await wide.sender.publish();

            const narrow = createSender(100);
            narrow.sender.setBlockDistance(500);
            narrow.sender.sendActionTrace('assets', makeBlock(), makeTransaction('6'.repeat(64)), makeTrace(1));
            await narrow.sender.publish();

            expect(wide.publish.callCount).to.equal(1);
            expect(narrow.publish.called).to.equal(false);
        });

        it('gates each block of a batch by the distance it was queued at, not by the last block in the batch', async () => {
            const {sender, publish} = createSender();

            // First block: gate closed. Its trace is discarded, its fork is not.
            sender.setBlockDistance(HEAD_DISTANCE);
            sender.sendActionTrace('assets', makeBlock(1), makeTransaction('a'.repeat(64)), makeTrace(1));
            sender.sendFork(makeBlock(1));

            // Second block, same batch: gate open. Its trace publishes.
            sender.setBlockDistance(HEAD_DISTANCE - 1);
            sender.sendActionTrace('assets', makeBlock(2), makeTransaction('b'.repeat(64)), makeTrace(2));

            await sender.publish();

            const envelope = publishedEnvelopes(publish)[0];

            expect(publish.callCount).to.equal(1);
            expect(envelope.n.map(entry => entry.type)).to.deep.equal(['fork', 'trace']);
            expect(Object.keys(envelope.txs)).to.deep.equal(['b'.repeat(64)]);
            expect(await counterValue(notificationBatchesSkipped)).to.equal(1);
            expect(await counterValue(notificationsSkipped)).to.equal(1);
        });
    });

    describe('metrics', () => {
        it('logs a warning, clears the queue and counts one failure when the publish rejects', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {sender, publish} = createSender();

            publish.rejects(new Error('NOPERM this user has no permissions'));

            sender.setBlockDistance(0);
            sender.sendActionTrace('assets', makeBlock(), makeTransaction('7'.repeat(64)), makeTrace(1));

            await sender.publish();

            expect(warnSpy.calledOnce).to.equal(true);
            expect(sender.notifications).to.have.length(0);
            expect(await counterValue(notificationPublishFailures)).to.equal(1);
        });

        it('stops at the first failing chunk, keeps the earlier chunks counted, and still clears the queue', async () => {
            const warnSpy = sinon.stub(logger, 'warn');
            const {sender, publish} = createSender();
            const tx = makeTransaction('e'.repeat(64));

            sender.setBlockDistance(0);

            for (let i = 0; i < 175; i++) {
                sender.sendActionTrace('assets', makeBlock(), tx, makeTrace(i));
            }

            // Four chunks of 50, 50, 50, 25. The third rejects; the fourth is
            // never attempted, and the first two stay published and counted.
            publish.onCall(2).rejects(new Error('NOPERM this user has no permissions'));

            await sender.publish();

            const expectedBytes = [0, 1].reduce(
                (sum, index) => sum + Buffer.byteLength(publish.getCall(index).args[1]), 0
            );

            expect(publish.callCount).to.equal(3);
            expect(warnSpy.calledOnce).to.equal(true);
            expect(sender.notifications).to.have.length(0);
            expect(await counterValue(notificationPublishFailures)).to.equal(1);
            expect(await counterValue(notificationsPublished)).to.equal(100);
            expect(await counterValue(notificationTransactionsPublished)).to.equal(2);
            expect(await counterValue(notificationBytesPublished)).to.equal(expectedBytes);
            expect(await histogramObservations(notificationPublishDuration)).to.equal(1);
        });

        it('counts notifications, transactions per message, bytes and one duration observation', async () => {
            const {sender, publish} = createSender();
            const tx = makeTransaction('8'.repeat(64));

            sender.setBlockDistance(0);

            for (let i = 0; i < 175; i++) {
                sender.sendActionTrace('assets', makeBlock(), tx, makeTrace(i));
            }

            await sender.publish();

            const expectedBytes = publish.getCalls()
                .reduce((sum, call) => sum + Buffer.byteLength(call.args[1]), 0);

            expect(await counterValue(notificationsPublished)).to.equal(175);
            // One transaction spanning four messages is serialized four times.
            expect(await counterValue(notificationTransactionsPublished)).to.equal(4);
            expect(await counterValue(notificationBytesPublished)).to.equal(expectedBytes);
            expect(await histogramObservations(notificationPublishDuration)).to.equal(1);
        });

        it('moves only the skip counters for a gated batch', async () => {
            const {sender} = createSender();

            sender.setBlockDistance(HEAD_DISTANCE);
            sender.sendActionTrace('assets', makeBlock(), makeTransaction('9'.repeat(64)), makeTrace(1));

            await sender.publish();

            expect(await counterValue(notificationsSkipped)).to.equal(1);
            expect(await counterValue(notificationBatchesSkipped)).to.equal(1);
            expect(await counterValue(notificationsPublished)).to.equal(0);
            expect(await counterValue(notificationTransactionsPublished)).to.equal(0);
            expect(await counterValue(notificationBytesPublished)).to.equal(0);
            expect(await histogramObservations(notificationPublishDuration)).to.equal(0);
        });
    });
});

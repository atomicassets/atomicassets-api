import { ShipBlock } from '../types/ship';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../types/eosio';
import ConnectionManager from '../connections/manager';
import logger from '../utils/winston';
import { arrayChunk } from '../utils';
import {
    encodeNotifications,
    NOTIFICATION_CHUNK_SIZE,
    NotificationData
} from './notification-format';
import {
    fillerPublishLabels,
    FillerPublishLabels,
    notificationBatchesSkipped,
    notificationBytesPublished,
    notificationPublishDuration,
    notificationPublishFailures,
    notificationsPublished,
    notificationsSkipped,
    notificationTransactionsPublished
} from '../metrics/filler-publish';

// Re-exported so the api side keeps importing the notification shape from here.
// The import has to stay type only on that side: this module pulls in the filler
// publish metrics, and a value import would register those series in the api
// process too.
export type { NotificationData };

function prepareNotificationBlock(block: ShipBlock): any {
    const result = {};
    const whitelist = ['block_id', 'block_num', 'timestamp', 'producer'];

    for (const key of whitelist) {
        // @ts-ignore
        result[key] = block[key];
    }

    return result;
}

export default class ApiNotificationSender {
    channelName: string;
    notifications: Array<NotificationData>;

    // Whether each entry of `notifications`, at the same index, is publishable.
    // Eligibility is decided at queue time from the block distance in effect
    // when the notification was sent, not at publish time from the batch's
    // final block: a grouped batch can queue notifications across a range of
    // distances, and stamping them individually is what keeps a batch that
    // closes the gate partway through from releasing the blocks queued while
    // it was still open. This flag never reaches the wire: it lives only in
    // this parallel array, never inside a NotificationData object.
    private publishableFlags: boolean[];

    // The distance, in blocks, the reader was measured at for the block
    // currently being processed. setBlockDistance() moves it before that
    // block's notifications are queued. It starts at positive infinity so a
    // notification queued before the first measurement is never publishable.
    private blockDistance: number = Number.POSITIVE_INFINITY;

    private readonly metricLabels: FillerPublishLabels;

    constructor(
        private readonly connection: ConnectionManager,
        private readonly readerName: string,
        private readonly headDistanceBlocks: number
    ) {
        this.channelName = ['eosio-contract-api', this.connection.chain.name, this.readerName, 'api'].join(':');
        this.notifications = [];
        this.publishableFlags = [];
        this.metricLabels = fillerPublishLabels(this.readerName);
    }

    /**
     * Record the head distance the reader was measured at for the block about
     * to be processed. Call this before queuing that block's notifications:
     * sendActionTrace() and sendContractRow() stamp each notification against
     * the value in effect at the time they are called.
     */
    setBlockDistance(blocksUntilHead: number): void {
        this.blockDistance = blocksUntilHead;
    }

    sendActionTrace(channel: string, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<any>): void {
        this.notifications.push({channel, type: 'trace', data: {block: prepareNotificationBlock(block), tx, trace}});
        this.publishableFlags.push(this.blockDistance < this.headDistanceBlocks);
    }

    sendContractRow(channel: string, block: ShipBlock, delta: EosioContractRow): void {
        this.notifications.push({channel, type: 'delta', data: {block: prepareNotificationBlock(block), delta}});
        this.publishableFlags.push(this.blockDistance < this.headDistanceBlocks);
    }

    sendFork(block: ShipBlock): void {
        this.notifications.push({channel: null, type: 'fork', data: {block: prepareNotificationBlock(block)}});
        // Forks are always publishable: a fork is the only rollback signal a
        // socket client gets, and it reaches back further than the gate.
        this.publishableFlags.push(true);
    }

    /**
     * Publish the collected batch. Eligibility was decided per notification at
     * queue time (see setBlockDistance()), so this only partitions the batch on
     * the flags already stamped, publishes the eligible entries in order, and
     * counts the rest in the skip counters.
     */
    async publish(): Promise<void> {
        if (this.notifications.length === 0) {
            return;
        }

        const batch = this.notifications;
        const flags = this.publishableFlags;

        this.notifications = [];
        this.publishableFlags = [];

        const publishable = batch.filter((_notification, index) => flags[index]);
        const discarded = batch.length - publishable.length;

        if (discarded > 0) {
            notificationBatchesSkipped.inc(this.metricLabels);
            notificationsSkipped.inc(this.metricLabels, discarded);
        }

        if (publishable.length === 0) {
            return;
        }

        const observeDuration = notificationPublishDuration.startTimer(this.metricLabels);

        try {
            // The first failing chunk aborts the batch. Chunks already published
            // stay published and counted; there is no retry, and block
            // processing carries on.
            for (const chunk of arrayChunk(publishable, NOTIFICATION_CHUNK_SIZE)) {
                const {envelope, transactions} = encodeNotifications(chunk);
                const payload = JSON.stringify(envelope);

                await this.connection.redis.ioRedis.publish(this.channelName, payload);

                notificationsPublished.inc(this.metricLabels, chunk.length);
                notificationTransactionsPublished.inc(this.metricLabels, transactions);
                notificationBytesPublished.inc(this.metricLabels, Buffer.byteLength(payload));
            }
        } catch (e) {
            logger.warn('Failed to send API notifications', e);

            notificationPublishFailures.inc(this.metricLabels);
        } finally {
            observeDuration();
        }
    }
}

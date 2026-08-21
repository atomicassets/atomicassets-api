import * as os from 'os';
import { Counter, Histogram, register } from 'prom-client';

// These series live on prom-client's default registry, not on the per scrape
// Registry the collector handler builds. The reader that publishes notifications
// runs in a forked worker while /metrics is served by the cluster primary, and
// the default registry is what AggregatorRegistry collects from a worker over
// the cluster IPC. A metric registered anywhere else never reaches a scrape.

const LABEL_NAMES = ['process', 'hostname', 'filler_name'];

const PROCESS_LABEL = 'filler';
const HOSTNAME_LABEL = os.hostname();

// Publishing is on the serial block path, so the interesting range is
// milliseconds; the tail buckets are what a stalled Valkey shows up in.
const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export type FillerPublishLabels = {process: string, hostname: string, filler_name: string};

export function fillerPublishLabels(fillerName: string): FillerPublishLabels {
    return {process: PROCESS_LABEL, hostname: HOSTNAME_LABEL, filler_name: fillerName};
}

export const notificationsPublished = new Counter({
    name: 'eos_contract_api_filler_notifications_published_total',
    help: 'Notifications the filler wrote to the api notification channel',
    labelNames: LABEL_NAMES,
    registers: [register]
});

export const notificationTransactionsPublished = new Counter({
    name: 'eos_contract_api_filler_notification_transactions_published_total',
    help: 'Transaction entries serialized into published messages, counted once per entry per message',
    labelNames: LABEL_NAMES,
    registers: [register]
});

export const notificationBytesPublished = new Counter({
    name: 'eos_contract_api_filler_notification_bytes_published_total',
    help: 'UTF-8 bytes of the messages the filler wrote to the api notification channel',
    labelNames: LABEL_NAMES,
    registers: [register]
});

export const notificationPublishDuration = new Histogram({
    name: 'eos_contract_api_filler_notification_publish_duration_seconds',
    help: 'Time one publish call holds the block path',
    labelNames: LABEL_NAMES,
    buckets: DURATION_BUCKETS,
    registers: [register]
});

export const notificationBatchesSkipped = new Counter({
    name: 'eos_contract_api_filler_notification_batches_skipped_total',
    help: 'Publish calls the head distance gate skipped',
    labelNames: LABEL_NAMES,
    registers: [register]
});

export const notificationsSkipped = new Counter({
    name: 'eos_contract_api_filler_notifications_skipped_total',
    help: 'Notifications the head distance gate discarded',
    labelNames: LABEL_NAMES,
    registers: [register]
});

export const notificationPublishFailures = new Counter({
    name: 'eos_contract_api_filler_notification_publish_failures_total',
    help: 'Publish calls that failed',
    labelNames: LABEL_NAMES,
    registers: [register]
});

// The series are module level singletons, so a test that asserts on a counter
// starts from a known state only when the previous test's values are cleared.
export function resetFillerPublishMetrics(): void {
    notificationsPublished.reset();
    notificationTransactionsPublished.reset();
    notificationBytesPublished.reset();
    notificationPublishDuration.reset();
    notificationBatchesSkipped.reset();
    notificationsSkipped.reset();
    notificationPublishFailures.reset();
}

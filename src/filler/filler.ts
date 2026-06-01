import ConnectionManager from '../connections/manager';
import StateReceiver from './receiver';
import logger from '../utils/winston';
import { IReaderConfig } from '../types/config';
import { formatSecondsLeft } from '../utils/time';
import { getHandlers } from './handlers';
import { ContractHandler } from './handlers/interfaces';
import { ModuleLoader } from './modules';
import { JobQueue } from './jobqueue';
import ListPoller from './list-poller';
import { positiveIntEnv } from '../utils/env';

// Watchdog stall timeouts (env-tunable; previously hardcoded 6h/10m/4m). The 6h
// initial was far too long: a reader wedged from startup (e.g. drain contention
// during post-restart catch-up) would not self-restart for hours. Cap it low so
// a wedge auto-recovers in minutes; the maintenance drain-gate below lets the
// restarted reader catch up unimpeded so it doesn't re-wedge. positiveIntEnv
// rejects non-positive overrides (a negative timeout would fire instantly).
const READER_STALL_TIMEOUT_MS = positiveIntEnv('READER_STALL_TIMEOUT_MS', 15 * 60 * 1000);
const READER_CATCHUP_STALL_TIMEOUT_MS = positiveIntEnv('READER_CATCHUP_STALL_TIMEOUT_MS', 10 * 60 * 1000);
const READER_CAUGHTUP_STALL_TIMEOUT_MS = positiveIntEnv('READER_CAUGHTUP_STALL_TIMEOUT_MS', 4 * 60 * 1000);

// Maintenance drain-gate hysteresis (blocks behind chain head). Aggregator drains
// defer while the reader is catching up so it keeps block-write priority during
// bursts and post-restart catch-up, then resume once nearly caught up. Safe to
// gate (no unbounded-queue doom-loop) since 1.6.4 dedup caps
// atomicmarket_sales_filters_updates at distinct changed keys.
const DRAIN_GATE_STOP_BLOCKS = positiveIntEnv('ATOMICMARKET_DRAIN_GATE_STOP_BLOCKS', 200);
const DRAIN_GATE_RESUME_RAW = positiveIntEnv('ATOMICMARKET_DRAIN_GATE_RESUME_BLOCKS', 60);
// Hysteresis requires resume < stop; a misconfigured resume >= stop would
// collapse the band (flap or never resume), so fall back to half the stop.
const DRAIN_GATE_RESUME_BLOCKS =
    DRAIN_GATE_RESUME_RAW < DRAIN_GATE_STOP_BLOCKS ? DRAIN_GATE_RESUME_RAW : Math.max(1, Math.floor(DRAIN_GATE_STOP_BLOCKS / 2));

function estimateSeconds(blocks: number, speed: number, depth: number = 0): number {
    if (blocks <= 2) {
        return 1;
    }

    if (speed < 2) {
        return -1;
    }

    if (depth > 20) {
        return 0;
    }

    const seconds = Math.floor(blocks / speed);

    return seconds + estimateSeconds(seconds * 2, speed, depth + 1);
}

export default class Filler {
    readonly reader: StateReceiver;
    readonly modules: ModuleLoader;

    public readonly jobs: JobQueue;
    private running: boolean = false;

    private readonly handlers: ContractHandler[];

    private readonly listPollers: ListPoller[] = [];

    private maintenanceDeferred = false;

    constructor(private readonly config: IReaderConfig, readonly connection: ConnectionManager) {
        this.handlers = getHandlers(config.contracts, this);
        this.modules = new ModuleLoader(config.modules || []);
        this.reader = new StateReceiver(config, connection, this.handlers, this.modules);

        for (const listPollConfig of (config.list_polls ?? [])) {
            const listPoller = new ListPoller(listPollConfig, connection.database);
            this.listPollers.push(listPoller);
            listPoller.start();
        }

        this.jobs = new JobQueue();

        logger.info(this.handlers.length + ' contract handlers registered');
        for (const handler of this.handlers) {
            logger.info('Contract handler ' + handler.getName() + ' registered', handler.args);
        }
    }

    /**
     * Returns true when the reader is further than `thresholdBlocks` behind
     * chain head. Scheduled aggregators (atomicassets/atomicmarket mints,
     * sales filters) gate themselves on this so they don't pile concurrent
     * UPDATEs on hot tables while the filler is already saturating its
     * DataSource queue catching up. 200 blocks ≈ 100 s of WAX time — past
     * normal reversible-window jitter (~50 blocks) but close enough to
     * resume aggregator runs as soon as the backlog clears.
     *
     * Added 2026-05-09 after the wax.atomichub.io/drops/92030 hype-drop
     * cliff: with pg_stat_statements newly available we measured
     * update_atomicmarket_sales_filters() at 19.5 s mean / 296 s max per
     * call, exactly the contention shape that compounds during a spike.
     */
    public isFallingBehind(thresholdBlocks: number = 200): boolean {
        return this.reader.blocksUntilHead > thresholdBlocks;
    }

    /**
     * Reader-priority gate with hysteresis for scheduled aggregator drains
     * (sales filters, mints). Returns true while the reader is catching up so
     * those jobs defer and the reader keeps DB/block-write priority during
     * bursts and post-restart catch-up. Gates ON above DRAIN_GATE_STOP_BLOCKS,
     * OFF below DRAIN_GATE_RESUME_BLOCKS — the hysteresis band avoids flapping
     * the drain on/off while the reader hovers near a single threshold.
     *
     * Re-introduces the pre-1.6.3 gate (removed in bdebfd2a). Safe again because
     * 1.6.4 made the queue dedup at the source (unique partial indexes), so the
     * backlog stays bounded at distinct changed keys while gated, instead of the
     * unbounded growth that previously turned the gate into a doom-loop.
     */
    public shouldDeferDrain(): boolean {
        const behind = this.reader.blocksUntilHead;

        if (this.maintenanceDeferred) {
            if (behind < DRAIN_GATE_RESUME_BLOCKS) {
                this.maintenanceDeferred = false;
            }
        } else if (behind > DRAIN_GATE_STOP_BLOCKS) {
            this.maintenanceDeferred = true;
        }

        return this.maintenanceDeferred === true;
    }

    async deleteDB(): Promise<void> {
        const transaction = await this.connection.database.begin();

        await transaction.query('DELETE FROM contract_readers WHERE name = $1', [this.config.name]);
        await transaction.query('DELETE FROM reversible_queries WHERE reader = $1', [this.config.name]);

        try {
            for (const handler of this.handlers) {
                await handler.deleteDB(transaction);
            }
        } catch (e) {
            logger.error(e);
            await transaction.query('ROLLBACK');

            return;
        }

        await transaction.query('COMMIT');
        transaction.release();
    }

    async startFiller(logInterval: number): Promise<void> {
        const initTransaction = await this.connection.database.begin();

        for (let i = 0; i < this.handlers.length; i++) {
            logger.info('Init handler ' + this.config.contracts[i].handler + ' for reader ' + this.config.name);

            await this.handlers[i].init(initTransaction);
        }

        await initTransaction.query('COMMIT');
        initTransaction.release();

        if (this.config.delete_data) {
            logger.info('Deleting data from handler of reader ' + this.config.name);

            await this.deleteDB();
        }

        const query = await this.connection.database.query('SELECT block_num FROM contract_readers WHERE name = $1', [this.config.name]);

        if (query.rowCount === 0) {
            logger.info('First run of reader. Initializing tables...');

            await this.connection.database.query(
                'INSERT INTO contract_readers(name, block_num, block_time, live, updated) VALUES ($1, $2, $3, $4, $5)',
                [this.config.name, 0, 0, false, 0]
            );
        }

        logger.info('Starting reader: ' + this.config.name);

        await this.reader.startProcessing();

        const lastBlockSpeeds: number[] = [];

        let blockRange = 0;
        let lastBlockTime = Date.now();

        let lastBlockNum = 0;
        let lastOperations = 0;

        let timeout = READER_STALL_TIMEOUT_MS;

        const interval = setInterval(async () => {
            if (!this.running) {
                clearInterval(interval);
            }

            // Fast self-heal: if the consumer queue died on a non-recoverable
            // error it will never process another block, so don't wait out the
            // multi-minute stall timer below — restart the pod immediately. Uses
            // the same failure channel as the stall path (process.send → master
            // → exit → K8s restart; CrashLoopBackOff throttles a persistent
            // failure). Cuts recovery from up to ~10 min to ~5s + restart.
            if (this.reader.queueStopped) {
                logger.error('Reader ' + this.config.name + ' - consumer queue is dead, exiting immediately for restart');

                process.send({msg: 'failure'});

                await new Promise(resolve => setTimeout(resolve, logInterval / 2 * 1000));

                process.exit(1);
            }

            if (lastBlockNum === 0) {
                if (this.reader.currentBlock) {
                    blockRange = this.reader.blocksUntilHead;
                    lastBlockNum = this.reader.currentBlock;
                } else {
                    logger.warn('Not receiving any blocks');
                }

                return;
            }

            const blockSpeed = (this.reader.currentBlock - lastBlockNum) / logInterval;
            const dbSpeed = (this.reader.database.stats.operations - lastOperations) / logInterval;
            lastBlockSpeeds.push(blockSpeed);

            if (lastBlockSpeeds.length > 60) {
                lastBlockSpeeds.shift();
            }

            const queueState = `[DS:${this.reader.dsQueue.size}|SH:${this.reader.ship.blocksQueue.size}|JQ:${this.jobs.active}]`;

            if (lastBlockNum === this.reader.currentBlock && lastBlockNum > 0) {
                const staleTime = Date.now() - lastBlockTime;

                if (staleTime > timeout) {
                    process.send({msg: 'failure'});

                    await new Promise(resolve => setTimeout(resolve, logInterval / 2 * 1000));

                    process.exit(1);
                }

                logger.warn(
                    'Reader ' + this.config.name + ' - No blocks processed ' + queueState + ' - ' +
                    'Stopping in ' + Math.round((timeout - staleTime) / 1000) + ' seconds'
                );
            } else if (this.reader.blocksUntilHead > 60) {
                lastBlockTime = Date.now();
                timeout = READER_CATCHUP_STALL_TIMEOUT_MS;

                if (blockRange === 0) {
                    blockRange = this.reader.blocksUntilHead;
                }

                const averageSpeed = lastBlockSpeeds.reduce((prev, curr) => prev + curr, 0) / lastBlockSpeeds.length;
                const currentBlock = Math.max(blockRange - this.reader.blocksUntilHead, 0);

                logger.info(
                    'Reader ' + this.config.name + ' - ' +
                    'Progress: ' + this.reader.currentBlock + ' / ' + (this.reader.currentBlock + this.reader.blocksUntilHead) + ' ' +
                    '(' + (100 * currentBlock / blockRange).toFixed(2) + '%) ' +
                    'Speed: ' + blockSpeed.toFixed(1) + ' B/s ' + dbSpeed.toFixed(0) + ' W/s ' +
                    queueState + ' ' +
                    '(Syncs ' + formatSecondsLeft(estimateSeconds(this.reader.blocksUntilHead, averageSpeed)) + ')'
                );
            } else {
                lastBlockTime = Date.now();
                blockRange = 0;
                timeout = READER_CAUGHTUP_STALL_TIMEOUT_MS;

                logger.info(
                    'Reader ' + this.config.name + ' - ' +
                    'Current Block: ' + this.reader.currentBlock + ' ' +
                    'Speed: ' + blockSpeed.toFixed(1) + ' B/s ' + dbSpeed.toFixed(0) + ' W/s ' +
                    queueState + ' '
                );
            }

            lastBlockNum = this.reader.currentBlock;
            lastOperations = this.reader.database.stats.operations;
        }, logInterval * 1000);

        this.jobs.on('error', (error: Error, job: any) => {
            logger.error(`Error running job ${job.name}`, error);
        });

        setTimeout(() => this.jobs.start(), 5000);

        this.running = true;
    }

    async stopFiller(): Promise<void> {
        this.running = false;

        this.jobs.stop();

        await this.reader.stopProcessing();
    }

}

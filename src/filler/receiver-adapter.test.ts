import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { ShipError } from '@atomichub/antelope-ship-utils';
import type { IBlockRequest, IShipConsumer } from '@atomichub/antelope-ship-utils';

import StateReceiver from './receiver';
import ConnectionManager from '../connections/manager';
import { IReaderConfig } from '../types/config';
import { ModuleLoader } from './modules';
import logger from '../utils/winston';

type ShipStub = EventEmitter & {
    startProcessing: sinon.SinonStub;
    stopProcessing: sinon.SinonStub;
    getQueueSize: sinon.SinonStub;
};

type Handover = {
    request?: IBlockRequest;
    deltas?: string[];
};

/**
 * Build a StateReceiver through its real constructor against a stubbed
 * ConnectionManager. The connection stub stands in for the package's
 * StateHistoryConnection: it is an EventEmitter, and its startProcessing()
 * pulls the request config and the required deltas off the consumer the way
 * the package does, so the handover is exercised rather than asserted on a
 * field.
 */
const sandbox = sinon.createSandbox();

function createReceiver(overrides: Partial<IReaderConfig> = {}): {
    receiver: StateReceiver;
    ship: ShipStub;
    createShipConnection: sinon.SinonStub;
    handover: Handover;
} {
    const ship = new EventEmitter() as ShipStub;
    const handover: Handover = {};

    ship.startProcessing = sandbox.stub().callsFake(async (consumer: IShipConsumer) => {
        handover.request = await consumer.getRequestBlockConfig();
        handover.deltas = consumer.getRequiredDeltas();
    });
    ship.stopProcessing = sandbox.stub();
    ship.getQueueSize = sandbox.stub().returns(0);

    const createShipConnection = sandbox.stub().returns(ship);

    const connection = {
        chain: { name: 'test-chain' },
        createShipConnection,
    } as unknown as ConnectionManager;

    const config = {
        name: 'test-reader',
        start_block: 0,
        stop_block: 0,
        irreversible_only: false,
        ship_prefetch_blocks: 50,
        ship_min_block_confirmation: 10,
        ship_ds_queue_size: 5,
        ds_ship_threads: 0,
        db_group_blocks: 12,
        delete_data: false,
        contracts: [],
        ...overrides,
    } as IReaderConfig;

    const receiver = new StateReceiver(config, connection, [], {} as ModuleLoader);

    return { receiver, ship, createShipConnection, handover };
}

function stubDatabase(receiver: StateReceiver, checkpoint: number, positions: any[]): void {
    (receiver as any).database = {
        getReaderPosition: sandbox.stub().resolves({ block_num: checkpoint, live: true, updated: 0 }),
        getLastReaderBlocks: sandbox.stub().resolves(positions),
        cleanupStaleReversibleData: sandbox.stub().resolves(),
    };
}

describe('StateReceiver as an IShipConsumer', () => {
    afterEach(() => {
        sandbox.restore();
    });

    describe('getRequestBlockConfig', () => {
        it('carries the checkpoint start block and the positions the database returns', async () => {
            const { receiver, handover } = createReceiver();
            const positions = [{ block_num: 5_999_995, block_id: 'a'.repeat(64) }];
            stubDatabase(receiver, 6_000_000, positions);

            await receiver.startProcessing();

            expect(handover.request.start_block_num).to.equal(6_000_001);
            expect(handover.request.have_positions).to.equal(positions);
            expect(handover.request.max_messages_in_flight).to.equal(50);
            expect(handover.request.end_block_num).to.equal(0xffffffff);
            expect(handover.request.irreversible_only).to.equal(false);
            expect(handover.request.fetch_block).to.equal(true);
            expect(handover.request.fetch_traces).to.equal(true);
            expect(handover.request.fetch_deltas).to.equal(true);
        });

        it('honours a configured stop block as the request end block', async () => {
            const { receiver, handover } = createReceiver({ stop_block: 7_000_000 });
            stubDatabase(receiver, 6_000_000, []);

            await receiver.startProcessing();

            expect(handover.request.end_block_num).to.equal(7_000_000);
        });
    });

    describe('prefetch and confirmation deadlock guard', () => {
        it('lowers min_block_confirmation before the connection is constructed', () => {
            const { createShipConnection } = createReceiver({
                ship_prefetch_blocks: 50,
                ship_min_block_confirmation: 75,
            });

            expect(createShipConnection.calledOnce).to.equal(true);
            // floor(50 / 2): SHIP would otherwise never receive a first ack,
            // because the client waits for 75 processed blocks while the node
            // stops sending after 50 unacked messages.
            expect(createShipConnection.firstCall.args[0].min_block_confirmation).to.equal(25);
        });

        it('passes the configured confirmation count through when the prefetch depth covers it', () => {
            const { createShipConnection } = createReceiver({
                ship_prefetch_blocks: 50,
                ship_min_block_confirmation: 10,
            });

            expect(createShipConnection.firstCall.args[0].min_block_confirmation).to.equal(10);
        });

        it('never lowers the confirmation count below one', () => {
            const { createShipConnection } = createReceiver({
                ship_prefetch_blocks: 1,
                ship_min_block_confirmation: 5,
            });

            expect(createShipConnection.firstCall.args[0].min_block_confirmation).to.equal(1);
        });

        it('refuses empty payloads and forwards the queue ceiling to the connection', () => {
            const { createShipConnection } = createReceiver({ ship_max_blocks_queue: 400 });
            const options = createShipConnection.firstCall.args[0];

            expect(options.allow_empty_blocks).to.equal(false);
            expect(options.allow_empty_traces).to.equal(false);
            expect(options.allow_empty_deltas).to.equal(false);
            expect(options.max_blocks_queue).to.equal(400);
        });
    });

    describe('connection events', () => {
        it('reaches winston at the mapped level', () => {
            // winston's leveled methods are overloaded, so the stubs are read
            // back through the plain SinonStub shape to assert on call args.
            const errorSpy = sandbox.stub(logger, 'error') as unknown as sinon.SinonStub;
            const warnSpy = sandbox.stub(logger, 'warn') as unknown as sinon.SinonStub;
            const infoSpy = sandbox.stub(logger, 'info') as unknown as sinon.SinonStub;
            const debugSpy = sandbox.stub(logger, 'debug') as unknown as sinon.SinonStub;

            const { ship } = createReceiver();
            const shipError = new ShipError('Ship Websocket disconnected', new Error('ECONNRESET'));

            ship.emit('error', shipError);
            ship.emit('warning', 'Block #5 does not contain delta data');
            ship.emit('info', 'Receiving ABI from ship...');
            ship.emit('debug', 'Block 5 processed');

            expect(errorSpy.calledWith('Ship connection error', shipError)).to.equal(true);
            expect(warnSpy.calledWith('Block #5 does not contain delta data')).to.equal(true);
            expect(infoSpy.calledWith('Receiving ABI from ship...')).to.equal(true);
            expect(debugSpy.calledWith('Block 5 processed')).to.equal(true);
        });

        it('carries the metadata a warning is emitted with', () => {
            const warnSpy = sandbox.stub(logger, 'warn') as unknown as sinon.SinonStub;
            const { ship } = createReceiver();
            const meta = { type: 'unknown_result_v9' };

            ship.emit('warning', 'Not supported message received', meta);

            expect(warnSpy.calledWith('Not supported message received', meta)).to.equal(true);
        });
    });

    describe('getRequiredDeltas', () => {
        it('asks for contract_row only', async () => {
            const { receiver, handover } = createReceiver();
            stubDatabase(receiver, 6_000_000, []);

            expect(receiver.getRequiredDeltas()).to.deep.equal(['contract_row']);

            await receiver.startProcessing();

            expect(handover.deltas).to.deep.equal(['contract_row']);
        });
    });

    describe('stopProcessing', () => {
        it('stops the connection', async () => {
            const { receiver, ship } = createReceiver();

            await receiver.stopProcessing();

            expect(ship.stopProcessing.calledOnce).to.equal(true);
        });
    });
});

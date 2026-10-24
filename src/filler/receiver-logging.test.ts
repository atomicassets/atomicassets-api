import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ABI } from '@wharfkit/antelope';
import StateReceiver from './receiver';
import DataProcessor, { ProcessingState } from './processor';
import { ModuleLoader } from './modules';
import logger from '../utils/logger';

describe('receiver logging', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    function setup() {
        const processor = new DataProcessor(ProcessingState.CATCHUP, new ModuleLoader([]));
        const receiver = Object.create(StateReceiver.prototype) as any;
        const query = sandbox.stub().resolves({ rows: [] });
        const abi = ABI.from({ version: 'eosio::abi/1.1' });
        Object.assign(receiver, {
            processor, abis: {},
            connection: { database: { query }, chain: { deserializeAbi: sandbox.stub().returns(abi) } }
        });
        return { receiver, processor, query, abi };
    }

    const block = { block_num: 123, timestamp: '2026-01-01T00:00:00.000' };
    const action = { data: { account: 'example', abi: '00' } };

    it('recognizes active trace/table, binary-only and wildcard listeners through state changes and removal', () => {
        const { processor } = setup();
        expect(processor.tracksContractAccount('example')).to.equal(false);
        const removeTrace = processor.onActionTrace('example', '*', async () => {}, 100, { headOnly: true });
        expect(processor.tracksContractAccount('example')).to.equal(false);
        processor.setState(ProcessingState.HEAD);
        expect(processor.tracksContractAccount('example')).to.equal(true);
        removeTrace();
        expect(processor.tracksContractAccount('example')).to.equal(false);
        processor.setState(ProcessingState.CATCHUP);
        const removeTable = processor.onContractRow('example', '*', async () => {}, 100, { deserialize: false });
        expect(processor.tracksContractAccount('example')).to.equal(true);
        expect(processor.tracksContractAccount('other')).to.equal(false);
        removeTable();
        const removeWildcard = processor.onActionTrace('*', 'transfer', async () => {});
        expect(processor.tracksContractAccount('other')).to.equal(true);
        removeWildcard();
        const removeHeadTable = processor.onContractRow('*', '*', async () => {}, 100, { headOnly: true });
        expect(processor.tracksContractAccount('other')).to.equal(false);
        processor.setState(ProcessingState.HEAD);
        expect(processor.tracksContractAccount('other')).to.equal(true);
        removeHeadTable();
        expect(processor.tracksContractAccount('other')).to.equal(false);
    });

    for (const kind of ['Abi', 'Code']) {
        it(`persists untracked ${kind} updates, logging only at debug, and keeps tracked updates at info`, async () => {
            const { receiver, processor, query, abi } = setup();
            const info = sandbox.stub(logger, 'info');
            const debug = sandbox.stub(logger, 'debug');
            sandbox.stub(logger, 'isLevelEnabled').returns(true);
            await receiver[`handle${kind}Update`](block, action);
            expect(query.calledOnce).to.equal(true);
            expect(info.called).to.equal(false);
            expect(debug.calledOnce).to.equal(true);
            if (kind === 'Abi') expect(receiver.abis.example.abi).to.equal(abi);
            processor.onContractRow('example', '*', async () => {});
            await receiver[`handle${kind}Update`](block, action);
            expect(info.calledOnce).to.equal(true);
        });

        it(`keeps duplicate ${kind} updates at debug and unexpected database errors at error`, async () => {
            const { receiver, query } = setup();
            const info = sandbox.stub(logger, 'info');
            const debug = sandbox.stub(logger, 'debug');
            const error = sandbox.stub(logger, 'error');
            const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
            query.rejects(duplicate);
            await receiver[`handle${kind}Update`](block, action);
            expect(info.called).to.equal(false);
            expect(debug.calledWith(sinon.match.string, duplicate)).to.equal(true);
            const failure = new Error('database unavailable');
            query.rejects(failure);
            await receiver[`handle${kind}Update`](block, action);
            expect(error.calledWith(sinon.match.string, failure)).to.equal(true);
        });

        it(`retains ${kind} deserialization error diagnostics for untracked contracts`, async () => {
            const { receiver, query } = setup();
            const error = sandbox.stub(logger, 'error');
            await receiver[`handle${kind}Update`](block, { data: 'unparsed' });
            expect(error.calledOnce).to.equal(true);
            expect(query.called).to.equal(false);
        });
    }

    it('logs an invalid untracked ABI with the Error and does not cache it', async () => {
        const { receiver, query } = setup();
        const failure = new Error('invalid ABI');
        receiver.connection.chain.deserializeAbi.throws(failure);
        const warn = sandbox.stub(logger, 'warn');
        await receiver.handleAbiUpdate(block, action);
        expect(warn.calledWith(sinon.match.string, failure)).to.equal(true);
        expect(query.called).to.equal(false);
        expect(receiver.abis.example).to.equal(undefined);
    });

    for (const deserialize of [true, false]) {
        it(`skips action/row debug payload construction when disabled (deserialize=${deserialize})`, async () => {
            const { receiver } = setup();
            const processActionTrace = sandbox.stub();
            const processContractRow = sandbox.stub();
            receiver.processor = {
                actionTraceNeeded: () => ({ process: true, deserialize }),
                contractRowNeeded: () => ({ process: true, deserialize }),
                processActionTrace, processContractRow
            };
            receiver.modules = { checkTrace: () => true, checkDelta: () => true };
            receiver.config = { get name() { throw new Error('debug message constructed'); } };
            receiver.fetchContractAbi = async () => ({ block_num: 123 });
            sandbox.stub(logger, 'isLevelEnabled').returns(false);
            const debug = sandbox.stub(logger, 'debug');
            await receiver.handleActionTrace(block, {
                act: { account: 'example', name: 'transfer', data: { json: { id: 1 }, block_num: 123, binary: '00' } }
            }, {});
            await receiver.handleContractRow(block, {
                code: 'example', table: 'assets', scope: 'example', value: { json: { id: 1 }, block_num: 123, binary: '00' }
            });
            expect(processActionTrace.calledOnce).to.equal(true);
            expect(processContractRow.calledOnce).to.equal(true);
            expect(debug.called).to.equal(false);
        });
    }
});

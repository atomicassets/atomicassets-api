import 'mocha';
import { expect } from 'chai';

import { assertReaderStopped, RECONCILE_STOPPED_READER_SAFETY_THRESHOLD_MS, ReconcileRpc, walkTable } from './reconcile';

describe('assertReaderStopped', () => {
    const NOW = 1_700_000_000_000;

    it('throws when no contract_readers row exists', () => {
        expect(() => assertReaderStopped(undefined, 'reader-1', NOW)).to.throw(/no contract_readers row/);
    });

    it('throws when the reader is still live', () => {
        const reader = { live: true, updated: NOW - RECONCILE_STOPPED_READER_SAFETY_THRESHOLD_MS - 1 };
        expect(() => assertReaderStopped(reader, 'reader-1', NOW)).to.throw(/still live/);
    });

    it('throws when the reader was updated too recently', () => {
        const reader = { live: false, updated: NOW - 1_000 };
        expect(() => assertReaderStopped(reader, 'reader-1', NOW)).to.throw(/updated too recently/);
    });

    it('passes when the reader is stopped and past the safety threshold', () => {
        const reader = { live: false, updated: NOW - RECONCILE_STOPPED_READER_SAFETY_THRESHOLD_MS - 1 };
        expect(() => assertReaderStopped(reader, 'reader-1', NOW)).to.not.throw();
    });

    it('passes at exactly the threshold boundary (>= threshold is old enough)', () => {
        const reader = { live: false, updated: NOW - RECONCILE_STOPPED_READER_SAFETY_THRESHOLD_MS };
        expect(() => assertReaderStopped(reader, 'reader-1', NOW)).to.not.throw();
    });
});

describe('walkTable', () => {
    it('throws when next_key does not advance from the previous lower_bound', async () => {
        const rpc: ReconcileRpc = {
            get_info: async () => ({ head_block_num: 1 }),
            get_table_by_scope: async () => ({ rows: [], more: false }),
            get_table_rows: async () => ({
                rows: [{ id: 1 }],
                more: true,
                next_key: 'stuck-key',
            }),
        };

        let error: Error | undefined;

        try {
            await walkTable(rpc, 'atomicassets', 'somescope', 'templates');
        } catch (err) {
            error = err as Error;
        }

        expect(error?.message).to.match(/next_key equal to the previous lower_bound/);
    });
});

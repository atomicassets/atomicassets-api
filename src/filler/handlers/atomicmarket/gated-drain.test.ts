import 'mocha';
import { expect } from 'chai';

import { runGatedDrain } from './index';

/**
 * runGatedDrain is the shared wiring for all four reader-priority maintenance
 * jobs (sales filters + the 3 mint backfills). It enforces the ordering the
 * 1.6.6 robustness fix depends on: defer-if-behind BEFORE the work probe, and
 * the probe BEFORE the (expensive) drain. These tests pin that contract so an
 * inverted gate or a dropped early-return can't pass silently - the inline
 * `if (shouldDeferDrain()) return;` guards it replaced had zero coverage.
 */
describe('runGatedDrain', () => {
    const fillerWith = (defer: boolean): { shouldDeferDrain(): boolean } => ({
        shouldDeferDrain: () => defer,
    });

    it('defers without probing or draining when the reader is catching up', async () => {
        let probed = false;
        let drained = false;
        const result = await runGatedDrain(
            fillerWith(true),
            async () => { probed = true; return true; },
            async () => { drained = true; return 99; },
        );

        expect(result).to.equal('deferred');
        expect(probed).to.equal(false); // gate short-circuits BEFORE the probe
        expect(drained).to.equal(false); // ...and before the drain
    });

    it('skips the drain when the queue is empty (probe returns false)', async () => {
        let drained = false;
        const result = await runGatedDrain(
            fillerWith(false),
            async () => false,
            async () => { drained = true; return 99; },
        );

        expect(result).to.equal('no-work');
        expect(drained).to.equal(false);
    });

    it('runs the drain and returns its total when not deferred and work exists', async () => {
        const result = await runGatedDrain(
            fillerWith(false),
            async () => true,
            async () => 1234,
        );

        expect(result).to.equal(1234);
    });

    it('evaluates gate → probe → drain strictly in that order', async () => {
        const calls: string[] = [];
        await runGatedDrain(
            { shouldDeferDrain: () => { calls.push('gate'); return false; } },
            async () => { calls.push('probe'); return true; },
            async () => { calls.push('drain'); return 1; },
        );

        expect(calls).to.deep.equal(['gate', 'probe', 'drain']);
    });

    it('propagates a probe error without draining', async () => {
        let drained = false;
        await expect(
            runGatedDrain(
                fillerWith(false),
                async () => { throw new Error('probe failed'); },
                async () => { drained = true; return 1; },
            ),
        ).to.be.rejectedWith(/probe failed/);
        expect(drained).to.equal(false);
    });
});

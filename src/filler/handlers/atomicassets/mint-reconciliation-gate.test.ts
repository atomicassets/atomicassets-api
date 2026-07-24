import 'mocha';
import { expect } from 'chai';

import { shouldSkipMintReconciliation } from './index';

/**
 * shouldSkipMintReconciliation is the decision behind init()'s catch-up gate on the eager
 * missing-mint reconciliation. These tests pin its contract: eager near head, skip beyond the
 * lag threshold, and fail closed (skip) whenever either position is unreadable - an inverted
 * comparison or a fall-open default would put a restart mid-backlog straight back into the
 * statement_timeout crash-loop the gate exists to prevent.
 */
describe('shouldSkipMintReconciliation', () => {
    const MAX_LAG = 10_000;

    it('runs eagerly when the reader is near head', () => {
        const decision = shouldSkipMintReconciliation(999_500, 1_000_000, MAX_LAG);

        expect(decision.skip).to.equal(false);
        expect(decision.blocksBehindHead).to.equal(500);
    });

    it('runs eagerly at exactly the lag threshold', () => {
        const decision = shouldSkipMintReconciliation(990_000, 1_000_000, MAX_LAG);

        expect(decision.skip).to.equal(false);
        expect(decision.blocksBehindHead).to.equal(MAX_LAG);
    });

    it('skips when the reader lags beyond the threshold', () => {
        const decision = shouldSkipMintReconciliation(500_000, 1_000_000, MAX_LAG);

        expect(decision.skip).to.equal(true);
        expect(decision.blocksBehindHead).to.equal(500_000);
    });

    it('clamps a reader at or past the probed head to zero lag', () => {
        const decision = shouldSkipMintReconciliation(1_000_010, 1_000_000, MAX_LAG);

        expect(decision.skip).to.equal(false);
        expect(decision.blocksBehindHead).to.equal(0);
    });

    it('fails closed when the reader position is unreadable', () => {
        // Number(undefined) from a missing contract_readers row
        const decision = shouldSkipMintReconciliation(NaN, 1_000_000, MAX_LAG);

        expect(decision.skip).to.equal(true);
        expect(decision.blocksBehindHead).to.equal(null);
    });

    it('fails closed when the head probe is unreadable', () => {
        const decision = shouldSkipMintReconciliation(1_000_000, NaN, MAX_LAG);

        expect(decision.skip).to.equal(true);
        expect(decision.blocksBehindHead).to.equal(null);
    });
});

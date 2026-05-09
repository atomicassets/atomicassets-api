import 'mocha';
import {expect} from 'chai';

import Filler from './filler';

describe('Filler', () => {
    describe('isFallingBehind', () => {
        const stub = (blocksUntilHead: number): Filler => {
            const filler = Object.create(Filler.prototype) as Filler;
            (filler as any).reader = {blocksUntilHead};
            return filler;
        };

        it('returns false when caught up', () => {
            expect(stub(0).isFallingBehind()).to.equal(false);
        });

        it('returns false when within normal reversible-window jitter', () => {
            // ~50 blocks behind is the typical WAX reversible window
            expect(stub(50).isFallingBehind()).to.equal(false);
        });

        it('returns false at the default threshold (200)', () => {
            // Strictly greater than: exactly 200 still allows aggregators to run
            expect(stub(200).isFallingBehind()).to.equal(false);
        });

        it('returns true past the default threshold', () => {
            expect(stub(201).isFallingBehind()).to.equal(true);
        });

        it('returns true under heavy load (the WAX hype-drop cliff state)', () => {
            // The 2026-05-09 incident saw 1100+ blocks of lag
            expect(stub(1100).isFallingBehind()).to.equal(true);
        });

        it('honours an explicit threshold override', () => {
            expect(stub(150).isFallingBehind(100)).to.equal(true);
            expect(stub(150).isFallingBehind(500)).to.equal(false);
        });
    });
});

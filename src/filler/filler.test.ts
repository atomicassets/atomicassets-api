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

    describe('shouldDeferDrain (hysteresis)', () => {
        const stub = (): { filler: Filler; setBehind: (n: number) => void } => {
            const filler = Object.create(Filler.prototype) as Filler;
            const reader = {blocksUntilHead: 0};
            (filler as any).reader = reader;
            return {filler, setBehind: (n: number): void => { reader.blocksUntilHead = n; }};
        };

        it('does not defer when caught up', () => {
            expect(stub().filler.shouldDeferDrain()).to.equal(false);
        });

        it('defers once the reader passes the stop threshold (>200)', () => {
            const {filler, setBehind} = stub();
            setBehind(201);
            expect(filler.shouldDeferDrain()).to.equal(true);
        });

        it('keeps deferring in the hysteresis band until below the resume threshold (<60)', () => {
            const {filler, setBehind} = stub();
            setBehind(250); expect(filler.shouldDeferDrain()).to.equal(true);  // gate on
            setBehind(100); expect(filler.shouldDeferDrain()).to.equal(true);  // still on (band: 60..200)
            setBehind(59);  expect(filler.shouldDeferDrain()).to.equal(false); // resume
        });

        it('stays off in the band after resuming until it exceeds the stop threshold again', () => {
            const {filler, setBehind} = stub();
            setBehind(250); filler.shouldDeferDrain(); // on
            setBehind(50);  filler.shouldDeferDrain(); // off
            setBehind(150); expect(filler.shouldDeferDrain()).to.equal(false); // band, stays off
            setBehind(201); expect(filler.shouldDeferDrain()).to.equal(true);  // exceeds stop, on again
        });
    });
});

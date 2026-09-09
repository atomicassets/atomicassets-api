import 'mocha';
import { expect } from 'chai';

import { marketDissolvesBundles, versionDissolvesBundles } from './legacy-bundles';

const FLIP_BLOCK = 1000;

describe('versionDissolvesBundles', () => {
    it('holds for the version that removed bundle listings', () => {
        expect(versionDissolvesBundles('2.0.0')).to.be.true;
    });

    it('holds for every later version', () => {
        expect(versionDissolvesBundles('2.1.4')).to.be.true;
        expect(versionDissolvesBundles('10.0.0')).to.be.true;
    });

    it('does not hold for a v1 contract, which still settles bundles', () => {
        expect(versionDissolvesBundles('1.2.2')).to.be.false;
    });

    it('reads a leading-zero major, which the 2.0.9 backfill predicate has to match', () => {
        expect(versionDissolvesBundles('02.0.0')).to.be.true;
        expect(versionDissolvesBundles('01.2.2')).to.be.false;
    });

    it('does not hold for a version it cannot read, so an unknown chain keeps the old recording', () => {
        expect(versionDissolvesBundles('two')).to.be.false;
        expect(versionDissolvesBundles('')).to.be.false;
        expect(versionDissolvesBundles(undefined)).to.be.false;
        expect(versionDissolvesBundles(null)).to.be.false;
    });
});

describe('marketDissolvesBundles', () => {
    // The boundary, block by block. setversion sits at some position inside the
    // flip block and the config delta is applied ahead of that block's action
    // jobs, so an action earlier in it settled for real under v1 code. Admitting
    // the flip block would record that as a cancel.
    it('does not hold at the block the flip was observed at', () => {
        expect(marketDissolvesBundles({
            version: '2.0.0', markerBlock: FLIP_BLOCK, blockNum: FLIP_BLOCK
        })).to.be.false;
    });

    it('does not hold for the block before the flip', () => {
        expect(marketDissolvesBundles({
            version: '2.0.0', markerBlock: FLIP_BLOCK, blockNum: FLIP_BLOCK - 1
        })).to.be.false;
    });

    it('holds for the block after the flip', () => {
        expect(marketDissolvesBundles({
            version: '2.0.0', markerBlock: FLIP_BLOCK, blockNum: FLIP_BLOCK + 1
        })).to.be.true;
    });

    it('holds for every later block', () => {
        expect(marketDissolvesBundles({
            version: '2.0.0', markerBlock: FLIP_BLOCK, blockNum: FLIP_BLOCK + 5000
        })).to.be.true;
    });

    it('does not hold deep in pre-flip history, which a replay reaches with the head version loaded', () => {
        expect(marketDissolvesBundles({
            version: '2.0.0', markerBlock: FLIP_BLOCK, blockNum: FLIP_BLOCK - 5000
        })).to.be.false;
    });

    it('does not hold while the marker is unproven, which is a resync of a chain already on v2', () => {
        // deleteDB clears atomicmarket_config and init() re-seeds the version from
        // a head read, so nothing there locates the flip. The marker stays null and
        // the whole replay keeps the v1 recording.
        expect(marketDissolvesBundles({
            version: '2.0.0', markerBlock: null, blockNum: FLIP_BLOCK + 5000
        })).to.be.false;
    });

    it('does not hold for a reader whose start block is after the flip and never sees the delta', () => {
        expect(marketDissolvesBundles({
            version: '2.0.0', markerBlock: undefined, blockNum: FLIP_BLOCK + 5000
        })).to.be.false;
    });

    it('does not hold on a v1 contract even with a marker set', () => {
        expect(marketDissolvesBundles({
            version: '1.2.2', markerBlock: FLIP_BLOCK, blockNum: FLIP_BLOCK + 5000
        })).to.be.false;
    });
});

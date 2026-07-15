import 'mocha';
import { expect } from 'chai';

import { evaluateV2Guard, parseContractMajorVersion } from './v2-guard';

describe('parseContractMajorVersion', () => {
    it('parses a standard semver version string', () => {
        expect(parseContractMajorVersion('2.0.0')).to.equal(2);
        expect(parseContractMajorVersion('1.3.25')).to.equal(1);
        expect(parseContractMajorVersion('10.2.4')).to.equal(10);
    });

    it('treats malformed or missing version strings as unknown', () => {
        expect(parseContractMajorVersion('not-a-version')).to.equal(null);
        expect(parseContractMajorVersion('2.0')).to.equal(null);
        expect(parseContractMajorVersion('')).to.equal(null);
        expect(parseContractMajorVersion(undefined)).to.equal(null);
        expect(parseContractMajorVersion(null)).to.equal(null);
    });
});

describe('evaluateV2Guard', () => {
    it('trips when the chain is v2, the reader has a position, and no marker is set', () => {
        const decision = evaluateV2Guard({
            majorVersion: 2,
            hasReaderPosition: true,
            markerAlreadySet: false,
            acceptGap: false,
        });

        expect(decision).to.equal('block');
    });

    it('proceeds on a fresh sync with no reader position', () => {
        const decision = evaluateV2Guard({
            majorVersion: 2,
            hasReaderPosition: false,
            markerAlreadySet: false,
            acceptGap: false,
        });

        expect(decision).to.equal('proceed');
    });

    it('proceeds when the marker is already set', () => {
        const decision = evaluateV2Guard({
            majorVersion: 2,
            hasReaderPosition: true,
            markerAlreadySet: true,
            acceptGap: false,
        });

        expect(decision).to.equal('proceed');
    });

    it('writes the marker when accept_v2_gap is set and the marker is missing', () => {
        const decision = evaluateV2Guard({
            majorVersion: 2,
            hasReaderPosition: true,
            markerAlreadySet: false,
            acceptGap: true,
        });

        expect(decision).to.equal('write-marker');
    });

    it('proceeds on a pre-v2 chain regardless of reader/marker state', () => {
        const decision = evaluateV2Guard({
            majorVersion: 1,
            hasReaderPosition: true,
            markerAlreadySet: false,
            acceptGap: false,
        });

        expect(decision).to.equal('proceed');
    });

    it('proceeds (guard skipped) when the version is unknown', () => {
        const decision = evaluateV2Guard({
            majorVersion: null,
            hasReaderPosition: true,
            markerAlreadySet: false,
            acceptGap: false,
        });

        expect(decision).to.equal('proceed');
    });
});

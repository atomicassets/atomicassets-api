import 'mocha';
import {expect} from 'chai';

import {isTransientNetworkError, retryTransient} from './retry';

// Build an error whose real socket code hides under `.cause`, mirroring how
// native fetch surfaces ECONNREFUSED ("TypeError: fetch failed" + cause).
function fetchFailed(code: string): Error {
    const cause: any = new Error(`connect ${code}`);
    cause.code = code;
    const err: any = new TypeError('fetch failed');
    err.cause = cause;
    return err;
}

const noSleep = async (): Promise<void> => undefined;

describe('isTransientNetworkError', () => {
    it('detects ECONNREFUSED nested under cause (native fetch shape)', () => {
        expect(isTransientNetworkError(fetchFailed('ECONNREFUSED'))).to.equal(true);
    });

    it('detects a top-level transient code', () => {
        const err: any = new Error('reset');
        err.code = 'ECONNRESET';
        expect(isTransientNetworkError(err)).to.equal(true);
    });

    it('treats a bare "fetch failed" as transient', () => {
        expect(isTransientNetworkError(new TypeError('fetch failed'))).to.equal(true);
    });

    it('does NOT retry application errors (4xx / chain-id mismatch)', () => {
        const err: any = new Error('Invalid request: unknown key');
        err.code = 'INVALID_INPUT';
        expect(isTransientNetworkError(err)).to.equal(false);
    });
});

describe('retryTransient', () => {
    it('retries a transient failure then succeeds', async () => {
        let calls = 0;
        const result = await retryTransient(
            async () => {
                calls++;
                if (calls < 3) {
                    throw fetchFailed('ECONNREFUSED');
                }
                return 'ok';
            },
            {sleep: noSleep, random: () => 0, baseDelayMs: 1}
        );

        expect(result).to.equal('ok');
        expect(calls).to.equal(3);
    });

    it('re-throws immediately for a non-transient error (no retry)', async () => {
        let calls = 0;
        let thrown: Error | null = null;

        try {
            await retryTransient(
                async () => {
                    calls++;
                    const err: any = new Error('bad query');
                    err.code = 'INVALID_INPUT';
                    throw err;
                },
                {sleep: noSleep, random: () => 0}
            );
        } catch (e) {
            thrown = e as Error;
        }

        expect(calls).to.equal(1);
        expect(thrown?.message).to.equal('bad query');
    });

    it('gives up after the retry budget and re-throws the last error', async () => {
        let calls = 0;
        let thrown: Error | null = null;

        try {
            await retryTransient(
                async () => {
                    calls++;
                    throw fetchFailed('ETIMEDOUT');
                },
                {retries: 2, sleep: noSleep, random: () => 0, baseDelayMs: 1}
            );
        } catch (e) {
            thrown = e as Error;
        }

        // initial try + 2 retries
        expect(calls).to.equal(3);
        expect(thrown?.message).to.equal('fetch failed');
    });
});

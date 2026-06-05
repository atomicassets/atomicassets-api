import logger from './winston';

// Connection-transient error codes worth retrying: the node/endpoint (or
// DB/redis) is momentarily unreachable — pod mid-restart, DNS not yet
// resolving, socket reset — rather than the request itself being malformed.
// A 4xx / chain-id mismatch / bad query is NOT in here and must surface.
const TRANSIENT_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    // undici (native fetch) internal connection failures
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
]);

// Native `fetch` rejects with a generic `TypeError: fetch failed` and stashes
// the real socket error under `.cause`. wharfkit may wrap that again. Walk the
// cause chain looking for a transient code or the "fetch failed" signature.
export function isTransientNetworkError(error: unknown): boolean {
    let err: any = error;

    for (let depth = 0; err && depth < 5; depth++) {
        const code = err.code ?? err.errno;

        if (typeof code === 'string' && TRANSIENT_CODES.has(code)) {
            return true;
        }

        if (typeof err.message === 'string' && err.message.includes('fetch failed')) {
            return true;
        }

        err = err.cause;
    }

    return false;
}

export interface RetryOptions {
    // Max attempts AFTER the initial try (so total tries = retries + 1).
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    // Label for log lines, e.g. the RPC method name.
    label?: string;
    // Predicate deciding whether a given error is retryable.
    shouldRetry?: (error: unknown) => boolean;
    // Injectable for deterministic tests.
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Retry an async operation on transient network failures with capped,
// equal-jitter exponential backoff (each delay is 50–100% of the capped
// exponential value, so it never collapses to ~0). Re-throws immediately for
// non-transient errors and once the retry budget is exhausted.
export async function retryTransient<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const {
        retries = 5,
        baseDelayMs = 250,
        maxDelayMs = 4000,
        label = 'chain request',
        shouldRetry = isTransientNetworkError,
        sleep = defaultSleep,
        random = Math.random,
    } = options;

    let attempt = 0;

    for (;;) {
        try {
            return await fn();
        } catch (error) {
            if (attempt >= retries || !shouldRetry(error)) {
                throw error;
            }

            attempt++;

            // Exponential backoff with equal jitter (50–100% of the capped
            // exponential delay) — keeps a sensible floor while spreading retries.
            const expDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            const delay = Math.floor(expDelay * (0.5 + random() * 0.5));

            logger.warn(
                `Transient error on ${label} (attempt ${attempt}/${retries}) — retrying in ${delay}ms: ` +
                    (error instanceof Error ? error.message : String(error))
            );

            await sleep(delay);
        }
    }
}

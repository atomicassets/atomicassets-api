import pino, { DestinationStream, Level, LevelWithSilent } from 'pino';
import pretty from 'pino-pretty';

type LogMethod = (message: unknown, ...metadata: unknown[]) => void;

export interface Logger {
    debug: LogMethod;
    info: LogMethod;
    warn: LogMethod;
    error: LogMethod;
    isLevelEnabled(level: Level): boolean;
}

function resolveLevel(raw: string): LevelWithSilent {
    const level = raw.toLowerCase();
    // Accept the former Winston names as well as Pino's native levels.
    if (level === 'silly') return 'trace';
    // Winston places these between info and debug. For our four methods they
    // enable info/warn/error, but must not accidentally enable debug.
    if (level === 'verbose' || level === 'http') return 'info';
    if (['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(level)) {
        return level as LevelWithSilent;
    }
    return 'info';
}

// SQL and event metadata can contain nested Errors. Preserve their otherwise
// non-enumerable message/stack, without mutating the caller's objects. Leave
// native values (Date, Buffer, etc.) to Pino's JSON serialization.
function serializeErrors(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (value instanceof Error) return pino.stdSerializers.err(value);
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value;
    if (seen.has(value)) return seen.get(value);
    const result = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    for (const [key, entry] of Object.entries(value)) {
        Object.defineProperty(result, key, {
            value: serializeErrors(entry, seen), enumerable: true, configurable: true, writable: true
        });
    }
    return result;
}

export function createLogger(options: {
    level?: string;
    production?: boolean;
    output?: DestinationStream;
    errorOutput?: DestinationStream;
} = {}): Logger {
    const production = options.production ?? process.env.NODE_ENV === 'production';
    const configuredLevel = resolveLevel(options.level ?? process.env.LOG_LEVEL ?? 'info');
    // Keep the production console's info floor, while respecting stricter
    // LOG_LEVEL values (warn/error/silent). No sink receives disabled debug.
    const level = production && pino.levels.values[configuredLevel] < pino.levels.values.info
        ? 'info' : configuredLevel;
    const output = options.output ?? (production ? process.stdout : pretty({
        sync: true,
        colorize: Boolean(process.stdout.isTTY),
        translateTime: 'SYS:standard'
    }));
    // Error writes are rare and synchronous so fatal CLI process.exit() paths
    // retain diagnostics. The file remains append-only and JSON in all modes.
    const errorOutput = options.errorOutput ?? pino.destination({
        dest: './logs/error.log', mkdir: true, sync: true
    });
    const base = pino({ level, serializers: { metadata: serializeErrors } }, pino.multistream([
        { level, stream: output },
        { level: 'error', stream: errorOutput }
    ]));

    const write = (level: Level, first: unknown, metadata: unknown[]): void => {
        if (!base.isLevelEnabled(level)) return;
        const message = typeof first === 'string' ? first : first instanceof Error ? first.message : 'Log event';
        const data = typeof first === 'string' || first instanceof Error ? metadata : [first, ...metadata];
        const error = first instanceof Error ? first : metadata.find(value => value instanceof Error);
        // Nest external metadata to prevent collisions with msg/level/time.
        base[level]({
            ...(error ? { err: error } : {}),
            ...(data.length ? { metadata: data.length === 1 ? data[0] : data } : {})
        }, message);
    };

    return {
        debug: (message, ...metadata) => write('debug', message, metadata),
        info: (message, ...metadata) => write('info', message, metadata),
        warn: (message, ...metadata) => write('warn', message, metadata),
        error: (message, ...metadata) => write('error', message, metadata),
        isLevelEnabled: level => base.isLevelEnabled(level)
    };
}

export default createLogger();

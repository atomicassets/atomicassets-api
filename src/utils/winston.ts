import { createLogger, format, transports } from 'winston';

const defaultLevel = process.env.LOG_LEVEL || 'info';

const options = {
    exitOnError: false,
    level: defaultLevel,
    format: format.combine(
        format.metadata(),
        format.colorize(),
        format.timestamp(),
        format.printf((info: any) => {
            let meta = '';
            if (Object.keys(info.metadata).length > 0) {
                const seen = new WeakSet();
                meta = JSON.stringify(info.metadata, (_key, value) => {
                    if (typeof value === 'object' && value !== null) {
                        if (seen.has(value)) return '[Circular]';
                        seen.add(value);
                    }
                    return value;
                });
            }
            return `${info.timestamp} [PID:${process.pid}] [${info.level}] : ${info.message} ${meta}`;
        })
    )
};

const logger = createLogger(options);

if (process.env.NODE_ENV === 'production') {
    logger.add(new transports.Console({
        level: 'info'
    }));
} else {
    logger.add(new transports.Console({
        level: defaultLevel
    }));
}

logger.add(new transports.File({ filename: './logs/error.log', level: 'error' }));

logger.debug('Logger initialized with level ' + defaultLevel);

export default logger;

import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLogger } from './logger';

function capture(level = 'debug', production = true) {
    const output: string[] = [];
    const errors: string[] = [];
    const logger = createLogger({
        level, production,
        output: { write: line => output.push(line) },
        errorOutput: { write: line => errors.push(line) }
    });
    return { logger, output, errors, records: () => output.map(line => JSON.parse(line)) };
}

describe('Pino logger', () => {
    it('preserves message-first Errors, Error-first calls, stack, cause and custom properties', () => {
        const { logger, records, errors } = capture();
        const error = Object.assign(new Error('query failed', { cause: new Error('connection lost') }), { code: 'XX000' });
        logger.error(error, { reader: 'test' }, 'extra context');
        logger.warn('retrying', error);
        const [first, second] = records();
        expect(first.msg).to.equal('query failed');
        expect(first.err.stack).to.contain('connection lost');
        expect(first.err.code).to.equal('XX000');
        expect(first.metadata).to.deep.equal([{ reader: 'test' }, 'extra context']);
        expect(second.msg).to.equal('retrying');
        expect(second.err.stack).to.contain('query failed');
        expect(errors).to.have.length(1);
    });

    it('keeps nested SQL errors, arrays, primitives and all extra arguments', () => {
        const { logger, records } = capture();
        logger.error('SQL failed', { queryText: 'select $1', values: [123], error: new Error('bad query') });
        logger.info('event', [1, 2], null, false, 0, 'tail');
        logger.info('values', [1, 2]);
        const [sql, event, values] = records();
        expect(sql.metadata.error.stack).to.contain('bad query');
        expect(sql.metadata.values).to.deep.equal([123]);
        expect(event.metadata).to.deep.equal([[1, 2], null, false, 0, 'tail']);
        expect(values.metadata).to.deep.equal([1, 2]);
    });

    it('keeps object-first diagnostics and protects reserved record fields', () => {
        const { logger, records } = capture();
        logger.error({ msg: 'external', level: 0, time: 0, error: new Error('failed') });
        const [record] = records();
        expect(record.msg).to.equal('Log event');
        expect(record.level).to.equal(50);
        expect(record.time).to.be.greaterThan(0);
        expect(record.metadata.msg).to.equal('external');
        expect(record.metadata.error.message).to.equal('failed');
    });

    it('serializes circular metadata and native values without mutating them', () => {
        const { logger, records } = capture();
        const metadata: any = { date: new Date('2026-01-01'), buffer: Buffer.from([1]), count: 2n };
        metadata.self = metadata;
        logger.info('metadata', metadata);
        const [record] = records();
        expect(record.metadata.self).to.equal('[Circular]');
        expect(record.metadata.date).to.equal('2026-01-01T00:00:00.000Z');
        expect(record.metadata.buffer.data).to.deep.equal([1]);
        expect(record.metadata.count).to.equal(2);
        expect(metadata.self).to.equal(metadata);
    });

    it('caps production output at info and writes only errors to the error sink', () => {
        const { logger, records, errors } = capture('debug');
        expect(logger.isLevelEnabled('debug')).to.equal(false);
        logger.debug('disabled');
        logger.info('info');
        logger.warn('warning');
        logger.error('error');
        expect(records().map(record => record.level)).to.deep.equal([30, 40, 50]);
        expect(errors.map(line => JSON.parse(line).msg)).to.deep.equal(['error']);
    });

    it('does no metadata traversal when debug is disabled', () => {
        const { logger, output } = capture('info');
        const metadata = { get expensive() { throw new Error('must not evaluate'); } };
        expect(() => logger.debug('disabled', metadata)).not.to.throw();
        expect(output).to.have.length(0);
    });

    it('respects stricter production levels and silent, including the error sink', () => {
        const warn = capture('warn');
        warn.logger.info('disabled');
        warn.logger.warn('enabled');
        expect(warn.records().map(record => record.msg)).to.deep.equal(['enabled']);
        const silent = capture('silent');
        silent.logger.error('disabled');
        expect(silent.output).to.have.length(0);
        expect(silent.errors).to.have.length(0);
    });

    for (const level of ['silly', 'DEBUG']) {
        it(`accepts the legacy level ${level} in development`, () => {
            const { logger, records } = capture(level, false);
            expect(logger.isLevelEnabled('debug')).to.equal(true);
            logger.debug('enabled');
            expect(records()[0].level).to.equal(20);
        });
    }

    for (const level of ['verbose', 'http']) {
        it(`preserves the legacy ${level} threshold between info and debug`, () => {
            const { logger, records } = capture(level, false);
            expect(logger.isLevelEnabled('debug')).to.equal(false);
            logger.debug('disabled');
            logger.info('enabled');
            expect(records().map(record => record.level)).to.deep.equal([30]);
        });
    }

    it('falls back to info for an invalid level', () => {
        const { logger } = capture('unknown', false);
        expect(logger.isLevelEnabled('info')).to.equal(true);
        expect(logger.isLevelEnabled('debug')).to.equal(false);
    });

    for (const production of [true, false]) {
        it(`uses ${production ? 'JSON' : 'pretty'} stdout and appends durable JSON errors before process.exit`, () => {
            const directory = mkdtempSync(join(tmpdir(), 'atomicassets-logger-'));
            try {
                const entry = resolve(__dirname, 'logger.ts');
                const register = require.resolve('@swc-node/register');
                const script = `const logger = require(${JSON.stringify(entry)}).default; logger.error(new Error('exit diagnostic')); process.exit(0);`;
                for (let i = 0; i < 2; i++) {
                    const child = spawnSync(process.execPath, ['--require', register, '-e', script], {
                        cwd: directory, encoding: 'utf8',
                        env: { ...process.env, NODE_ENV: production ? 'production' : 'development', LOG_LEVEL: 'info' }
                    });
                    expect(child.status, child.stderr).to.equal(0);
                    if (production) expect(JSON.parse(child.stdout).err.stack).to.contain('exit diagnostic');
                    else expect(child.stdout).to.contain('ERROR').and.contain('exit diagnostic');
                }
                const records = readFileSync(join(directory, 'logs/error.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                expect(records).to.have.length(2);
                expect(records[0].err.stack).to.contain('exit diagnostic');
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });
    }
});

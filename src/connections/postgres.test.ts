import 'mocha';
import { expect } from 'chai';

import PostgresConnection from './postgres';

/**
 * pg-pool emits 'error' on the pool when an idle client dies, for example when
 * the server restarts. An EventEmitter with no 'error' listener throws, and
 * Node raises that as an uncaught exception. A pool connects on first use, so
 * these tests need no database.
 */
describe('PostgresConnection.createPool', () => {
    const connection = new PostgresConnection('127.0.0.1', 5432, 'user', 'password', 'database');

    it('gives every pool it creates an error listener', async () => {
        const pool = connection.createPool({ max: 1 });

        try {
            expect(pool.listenerCount('error')).to.be.greaterThan(0);
        } finally {
            await pool.end();
        }
    });

    it('does not throw when an idle client of a created pool dies', async () => {
        const pool = connection.createPool({ max: 1 });

        try {
            expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).to.not.throw();
        } finally {
            await pool.end();
        }
    });
});

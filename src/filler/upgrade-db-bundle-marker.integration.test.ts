import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';
import { Client } from 'pg';

import { getTestPostgresConfig } from '../utils/test';

// Replays definitions/migrations/2.0.9/atomicmarket.sql against fixtures that
// stand for each deployment the marker has to serve. Every test runs inside one
// transaction that is rolled back, so the shared test database keeps its rows.
// The column itself is already present by the time these run, which is the
// state a replay meets, so each test drives the backfill on top of it.
describe('migration 2.0.9 legacy bundle marker backfill', () => {
    const MIGRATION = `${__dirname}/../../definitions/migrations/2.0.9/atomicmarket.sql`;
    const MARKET_CONTRACT = 'bundlemarker';
    const ASSETS_CONTRACT = 'atomicassets';

    let client: Client;
    let migration: string;

    before(async () => {
        client = new Client(getTestPostgresConfig());
        await client.connect();
        migration = fs.readFileSync(MIGRATION, { encoding: 'utf8' });
    });

    after(async () => {
        await client.end();
    });

    beforeEach(async () => {
        await client.query('BEGIN');
        // The fixtures below are the only reader positions and config rows the
        // backfill may see, so it cannot pick up a value from the real ones.
        await client.query('DELETE FROM contract_readers');
        await client.query('DELETE FROM atomicmarket_config');
    });

    afterEach(async () => {
        await client.query('ROLLBACK');
    });

    // live defaults to true because most cases below turn on a reader that has
    // proven the chain head. Pass false for a reader that is still catching up.
    async function seedReader(name: string, blockNum: number, live: boolean = true): Promise<void> {
        await client.query(
            'INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, $2, 0, $3, 0)',
            [name, blockNum, live]
        );
    }

    async function seedConfigRow(version: string, markerBlock: number | null = null): Promise<void> {
        await client.query(
            'INSERT INTO atomicmarket_config (' +
                'market_contract, assets_contract, delphi_contract, version, maker_market_fee, taker_market_fee, ' +
                'minimum_auction_duration, maximum_auction_duration, minimum_bid_increase, auction_reset_duration, v2_marker_block' +
            ') VALUES ($1, $2, $3, $4, 0.01, 0.01, 3600, 2592000, 0.1, 120, $5)',
            [MARKET_CONTRACT, ASSETS_CONTRACT, 'delphioracle', version, markerBlock]
        );
    }

    async function readMarker(): Promise<any> {
        const result = await client.query(
            'SELECT v2_marker_block FROM atomicmarket_config WHERE market_contract = $1',
            [MARKET_CONTRACT]
        );

        return result.rows[0].v2_marker_block;
    }

    it('gives a database already indexing a v2 chain the furthest reader position', async () => {
        // Case 3: the flip is in this deployment's past and no delta will ever
        // re-announce it, so the migration is the only thing that can turn the
        // rules on. MAX, so a reader still replaying history keeps the old
        // recording rather than rewriting a settled trade as a cancel.
        await seedReader('atomicmarket-head', 400000000, true);
        await seedReader('atomicmarket-backfill', 120000000, true);
        await seedConfigRow('2.0.0');

        await client.query(migration);

        expect(Number(await readMarker())).to.equal(400000000);
    });

    it('leaves a reader that has not reached the head unmarked', async () => {
        // src/filler/receiver.ts writes contract_readers.live at every
        // checkpoint as state === HEAD, and a fresh row starts false. A reader
        // still catching up sits below the flip, so a marker at its position
        // would rewrite the pre-flip history it has yet to replay.
        await seedReader('atomicmarket-backfill', 120000000, false);
        await seedConfigRow('2.0.0');

        await client.query(migration);

        expect(await readMarker()).to.be.null;
    });

    it('takes the live reader position over a further one that is not live', async () => {
        // The config row reads v2 from a head-time seed, so the version says
        // nothing about where either reader stands. The live flag does, and the
        // further reader is still replaying pre-flip history.
        await seedReader('atomicmarket-head', 200000000, true);
        await seedReader('atomicmarket-backfill', 400000000, false);
        await seedConfigRow('2.0.0');

        await client.query(migration);

        expect(Number(await readMarker())).to.equal(200000000);
    });

    it('leaves a chain still on v1 unmarked, because its reader observes the flip itself', async () => {
        // Case 1: marking here would apply the rules to the pre-flip blocks the
        // reader has yet to reach.
        await seedReader('atomicmarket-head', 400000000);
        await seedConfigRow('1.2.2');

        await client.query(migration);

        expect(await readMarker()).to.be.null;
    });

    it('leaves a fresh install unmarked, because no reader has a position yet', async () => {
        // Case 2: a resync of a chain already on v2 seeds version 2.x from a head
        // read. Nothing here may infer the flip block from that.
        await seedReader('atomicmarket-head', 0);
        await seedConfigRow('2.0.0');

        await client.query(migration);

        expect(await readMarker()).to.be.null;
    });

    it('leaves an established marker alone on a replay', async () => {
        await seedReader('atomicmarket-head', 400000000);
        await seedConfigRow('2.0.0', 123456);

        await client.query(migration);
        await client.query(migration);

        expect(Number(await readMarker())).to.equal(123456);
    });

    it('does not abort on a version string that carries no leading number', async () => {
        await seedReader('atomicmarket-head', 400000000);
        await seedConfigRow('unreleased');

        await client.query(migration);

        expect(await readMarker()).to.be.null;
    });

    for (const version of ['2.beta', '2.0', '2', '2.0.0.1', 'v2.0.0', '2.0.x']) {
        it(`leaves version "${version}" unmarked, because the runtime gate cannot parse it`, async () => {
            // parseContractMajorVersion takes a complete major.minor.patch and
            // nothing else. A marker the gate then refuses to honor would sit
            // there stale when a later delta corrects the version.
            await seedReader('atomicmarket-head', 400000000);
            await seedConfigRow(version);

            await client.query(migration);

            expect(await readMarker()).to.be.null;
        });
    }

    it('marks a leading-zero major, which the runtime gate reads as v2', async () => {
        // parseContractMajorVersion runs the captured major through Number(), so
        // "02.0.0" is a v2 contract to the gate. A predicate that skipped it
        // would leave the deployment unmarked with the rules never turning on.
        await seedReader('atomicmarket-head', 400000000);
        await seedConfigRow('02.0.0');

        await client.query(migration);

        expect(Number(await readMarker())).to.equal(400000000);
    });

    it('leaves a leading-zero major below 2 unmarked', async () => {
        await seedReader('atomicmarket-head', 400000000);
        await seedConfigRow('01.2.2');

        await client.query(migration);

        expect(await readMarker()).to.be.null;
    });

    it('marks a version the runtime gate parses, whitespace and all', async () => {
        await seedReader('atomicmarket-head', 400000000);
        await seedConfigRow(' 2.0.0\n');

        await client.query(migration);

        expect(Number(await readMarker())).to.equal(400000000);
    });

    it('marks a version well past the removal release', async () => {
        await seedReader('atomicmarket-head', 400000000);
        await seedConfigRow('10.4.2');

        await client.query(migration);

        expect(Number(await readMarker())).to.equal(400000000);
    });
});

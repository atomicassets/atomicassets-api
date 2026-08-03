import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';
import { Client, Pool } from 'pg';

import { initAtomicMarketTest } from '../../../api/namespaces/atomicmarket/test';
import { getTestPostgresConfig } from '../../../utils/test';
import { compareVersionString } from '../../../utils';
import { drainAtomicmarketTemplatePrices, TEMPLATE_PRICES_WORK_PROBE_SQL } from './index';

// Integration coverage for the 1.7.26 incremental, queue-driven
// update_atomicmarket_template_prices(): the two enqueue triggers, the batched
// claim/release protocol, the self-arming aging row, the authoritative
// per-template recompute, the cutover seed, and the TS batch loop that drives
// all of it. Runs against the test database, which replays every migration.
//
// The load-bearing proposition is PARITY: for a template with price inputs the
// queue-driven recompute must write exactly what the 1.3.14 full scan wrote for
// the same state. The reference is not transcribed here: it is read out of
// definitions/migrations/1.3.14/atomicmarket.sql at run time and created under a
// second name, so a drift in either implementation fails the comparison.

const MARKET = 'amtest';
const ASSETS = 'aatest';
const COLLECTION = 'tpcol';
const DAY_MS = 24 * 3600 * 1000;
const THREE_DAYS_MS = 3 * DAY_MS;
const MIGRATIONS_DIR = './definitions/migrations';
const FIRST_VERSION = '1.7.26';
const REFERENCE_FILE = './definitions/migrations/1.3.14/atomicmarket.sql';
const REFERENCE_FN = 'tp_reference_full_scan';

const { client, txit } = initAtomicMarketTest();

type QueueRow = { template_id: string, kind: number, prio: number, refresh_at: string, seq: string };
type PriceRow = Record<string, unknown>;

/**
 * The atomicmarket half of every migration from FIRST_VERSION onwards, in version
 * order, concatenated. The feature spans more than one version (the queue, triggers
 * and drain function in one, the cutover seed in the next, because the seed's full
 * scan of atomicmarket_stats_markets does not belong in the DDL transaction), and
 * which statement sits in which version is a migration-authoring decision that these
 * tests must not restate. Replaying the range is also what the test database itself
 * does, one version per transaction.
 */
function migrationSql(): string {
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter(version => compareVersionString(version, FIRST_VERSION) >= 0)
        .sort((a, b) => compareVersionString(a, b))
        .map(version => `${MIGRATIONS_DIR}/${version}/atomicmarket.sql`)
        .filter(file => fs.existsSync(file))
        .map(file => fs.readFileSync(file, { encoding: 'utf8' }))
        .join('\n');
}

/**
 * The 1.3.14 full-scan recompute, verbatim from its migration, under a second
 * name so it can be run side by side with the queue-driven one. Two edits, both
 * outside the value computation: the function name, and the probabilistic
 * `random() <= 0.05` orphan sweep pinned off. That sweep is precisely what the
 * authoritative per-template delete replaces, and leaving it live would make the
 * reference nondeterministic.
 */
function referenceFunctionSql(): string {
    const src = fs.readFileSync(REFERENCE_FILE, { encoding: 'utf8' });
    const start = src.indexOf('CREATE OR REPLACE FUNCTION update_atomicmarket_template_prices()');
    const end = src.indexOf('$$;', start);

    if (start < 0 || end < 0) {
        throw new Error(`Could not extract the 1.3.14 reference recompute from ${REFERENCE_FILE}`);
    }

    return src.slice(start, end + 3)
        .replace('update_atomicmarket_template_prices()', `${REFERENCE_FN}()`)
        .replace('random() <= 0.05', 'FALSE');
}

// The claim measures due-ness against MAX(block_time) over contract_readers, so
// every drain test pins that clock. Readers are cleared first: a stray reader
// with a later block_time would silently make future aging rows claimable.
async function setBlockTime(blockTime: number): Promise<void> {
    await client.query('DELETE FROM contract_readers');
    await client.query(
        'INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, 1, $2, FALSE, 1)',
        ['tp-test', blockTime],
    );
}

async function clearQueue(): Promise<void> {
    await client.query('DELETE FROM atomicmarket_template_prices_updates');
}

async function enqueueLive(templateId: number, prio = 0): Promise<void> {
    await client.query(
        `INSERT INTO atomicmarket_template_prices_updates (market_contract, assets_contract, template_id, kind, prio, refresh_at)
         VALUES ($1, $2, $3, 0, $4, 0)
         ON CONFLICT (market_contract, assets_contract, template_id, kind)
            DO UPDATE SET seq = nextval('atomicmarket_template_prices_updates_seq'), prio = EXCLUDED.prio`,
        [MARKET, ASSETS, templateId, prio],
    );
}

async function queueRows(templateId?: number): Promise<QueueRow[]> {
    const res = await client.query<QueueRow>(
        `SELECT template_id, kind, prio, refresh_at, seq
         FROM atomicmarket_template_prices_updates
         ${templateId === undefined ? '' : 'WHERE template_id = $1'}
         ORDER BY kind, template_id`,
        templateId === undefined ? [] : [templateId],
    );

    return res.rows;
}

async function priceRows(templateId: number): Promise<PriceRow[]> {
    const res = await client.query<PriceRow>(
        `SELECT market_contract, assets_contract, collection_name, template_id, symbol,
                median, average, suggested_median, suggested_average, "min", "max", sales
         FROM atomicmarket_template_prices
         WHERE template_id = $1
         ORDER BY market_contract, collection_name, symbol`,
        [templateId],
    );

    return res.rows;
}

async function drain(batchSize = 200): Promise<number> {
    const res = await client.query<{ released: number }>(
        'SELECT update_atomicmarket_template_prices($1) AS released',
        [batchSize],
    );

    return Number(res.rows[0].released);
}

async function insertStats(values: {
    template_id: number,
    price: number,
    time: number,
    symbol?: string,
    asset_id?: number | null,
    listing_type?: string,
    listing_id?: number,
}): Promise<{ listing_type: string, listing_id: number }> {
    const listingType = values.listing_type ?? 'sale';
    const listingId = values.listing_id ?? client.getId();

    await client.query(
        `INSERT INTO atomicmarket_stats_markets
            (market_contract, listing_type, listing_id, assets_contract, collection_name, schema_name,
             template_id, asset_id, symbol, price, "time", buyer, seller)
         VALUES ($1, $2, $3, $4, $5, 'tpschema', $6, $7, $8, $9, $10, 'buyer', 'seller')`,
        [
            MARKET, listingType, listingId, ASSETS, COLLECTION, values.template_id,
            values.asset_id === undefined ? client.getId() : values.asset_id,
            values.symbol ?? 'TEST', values.price, values.time,
        ],
    );

    return { listing_type: listingType, listing_id: listingId };
}

async function insertListing(values: {
    template_id: number,
    price: number,
    updated_at_time: number,
    sale_id?: number,
    asset_count?: number,
    seller_contract?: boolean | null,
}): Promise<number> {
    const saleId = values.sale_id ?? client.getId();

    await client.query(
        `INSERT INTO atomicmarket_sales_filters_listed
            (sale_id, created_at_block, offer_id, price, asset_count, updated_at_time, created_at_time,
             sale_state, filter, market_contract, assets_contract, maker_marketplace, seller_contract)
         VALUES ($1, 1, $1, $2, $3, $4, $4, 1,
                 create_atomicmarket_sales_filter(template_ids := ARRAY[$5::BIGINT]),
                 $6, $7, '', $8)`,
        [
            saleId, values.price, values.asset_count ?? 1, values.updated_at_time,
            values.template_id, MARKET, ASSETS, values.seller_contract ?? null,
        ],
    );

    return saleId;
}

describe('template-prices queue - enqueue triggers (1.7.26)', () => {
    txit('a resolved single-asset stats row enqueues one live row and no aging row', async () => {
        const template = client.getId();
        await clearQueue();

        await insertStats({ template_id: template, price: 100, time: Date.now() });

        const rows = await queueRows(template);
        expect(rows.length, 'exactly one queue row').to.equal(1);
        expect(rows[0].kind, 'live kind').to.equal(0);
        expect(rows[0].prio, 'real-time lane').to.equal(0);
        expect(Number(rows[0].refresh_at), 'live rows are always due').to.equal(0);
    });

    txit('a stats row without a resolved asset or template does not enqueue', async () => {
        await clearQueue();

        await insertStats({ template_id: client.getId(), price: 100, time: Date.now(), asset_id: null });

        expect((await queueRows()).length, 'multi-asset / unresolved rows are not price inputs').to.equal(0);
    });

    txit('a stats row deletion enqueues the live row from OLD', async () => {
        const template = client.getId();
        const { listing_type, listing_id } = await insertStats({ template_id: template, price: 100, time: Date.now() });
        await clearQueue();

        await client.query(
            'DELETE FROM atomicmarket_stats_markets WHERE market_contract = $1 AND listing_type = $2 AND listing_id = $3',
            [MARKET, listing_type, listing_id],
        );

        const rows = await queueRows(template);
        expect(rows.length, 'rollback / refund removals enqueue too').to.equal(1);
        expect(rows[0].kind).to.equal(0);
    });

    txit('a second final sale for the same template bumps seq and adds no row', async () => {
        const template = client.getId();
        await clearQueue();
        await insertStats({ template_id: template, price: 100, time: Date.now() });
        const first = await queueRows(template);

        await insertStats({ template_id: template, price: 200, time: Date.now() });

        const second = await queueRows(template);
        expect(second.length, 'dedup keeps depth at one row per key').to.equal(1);
        expect(Number(second[0].seq), 'version token bumped').to.be.greaterThan(Number(first[0].seq));
    });

    txit('a stats row moved to another template enqueues both the old and the new one', async () => {
        const from = client.getId();
        const to = client.getId();
        const { listing_type, listing_id } = await insertStats({ template_id: from, price: 100, time: Date.now() });
        await clearQueue();

        await client.query(
            'UPDATE atomicmarket_stats_markets SET template_id = $1 WHERE market_contract = $2 AND listing_type = $3 AND listing_id = $4',
            [to, MARKET, listing_type, listing_id],
        );

        // The old template just lost a sale; leaving it unqueued would keep its price
        // rows counting an input it no longer has.
        expect((await queueRows(from)).length, 'OLD side enqueued').to.equal(1);
        expect((await queueRows(to)).length, 'NEW side enqueued').to.equal(1);
    });

    txit('a listed single-asset sale insert enqueues one live row', async () => {
        const template = client.getId();
        await clearQueue();

        await insertListing({ template_id: template, price: 500, updated_at_time: Date.now() - DAY_MS });

        const rows = await queueRows(template);
        expect(rows.length).to.equal(1);
        expect(rows[0].kind).to.equal(0);
        expect(rows[0].prio).to.equal(0);
    });

    txit('a listed-sale price change enqueues', async () => {
        const template = client.getId();
        const saleId = await insertListing({ template_id: template, price: 500, updated_at_time: Date.now() - DAY_MS });
        await clearQueue();

        await client.query('UPDATE atomicmarket_sales_filters_listed SET price = 400 WHERE sale_id = $1', [saleId]);

        expect((await queueRows(template)).length, 'the cap input moved').to.equal(1);
    });

    txit('a listed-sale update that changes neither price nor seller_contract does not enqueue', async () => {
        const template = client.getId();
        const saleId = await insertListing({ template_id: template, price: 500, updated_at_time: Date.now() - DAY_MS });
        await clearQueue();

        await client.query('UPDATE atomicmarket_sales_filters_listed SET asset_names = \'renamed\' WHERE sale_id = $1', [saleId]);

        expect((await queueRows(template)).length, 'no price input moved, no recompute owed').to.equal(0);
    });

    txit('a seller_contract flip enqueues at an unchanged price, from the side that changed', async () => {
        const joining = client.getId();
        const leaving = client.getId();
        // seller_contract TRUE is outside the cap's input set; NULL/FALSE is inside.
        const joiningSale = await insertListing({
            template_id: joining, price: 500, updated_at_time: Date.now() - DAY_MS, seller_contract: true,
        });
        const leavingSale = await insertListing({
            template_id: leaving, price: 500, updated_at_time: Date.now() - DAY_MS, seller_contract: null,
        });
        await clearQueue();

        await client.query('UPDATE atomicmarket_sales_filters_listed SET seller_contract = NULL WHERE sale_id = $1', [joiningSale]);
        await client.query('UPDATE atomicmarket_sales_filters_listed SET seller_contract = TRUE WHERE sale_id = $1', [leavingSale]);

        expect((await queueRows(joining)).length, 'listing joined the cap input set').to.equal(1);
        expect((await queueRows(leaving)).length, 'listing left the cap input set').to.equal(1);
    });

    txit('a listed-sale delete (the sale leaving the listed partition) enqueues', async () => {
        const template = client.getId();
        const saleId = await insertListing({ template_id: template, price: 500, updated_at_time: Date.now() - DAY_MS });
        await clearQueue();

        await client.query('DELETE FROM atomicmarket_sales_filters_listed WHERE sale_id = $1', [saleId]);

        expect((await queueRows(template)).length).to.equal(1);
    });

    txit('seller-contract and multi-asset listings do not enqueue', async () => {
        const sellerContract = client.getId();
        const multiAsset = client.getId();
        await clearQueue();

        await insertListing({
            template_id: sellerContract, price: 500, updated_at_time: Date.now() - DAY_MS, seller_contract: true,
        });
        await insertListing({
            template_id: multiAsset, price: 500, updated_at_time: Date.now() - DAY_MS, asset_count: 2,
        });

        // Both are excluded from the min-price computation, so neither can move a cap.
        expect((await queueRows()).length).to.equal(0);
    });
});

describe('update_atomicmarket_template_prices - batched drain (1.7.26)', () => {
    txit('a queued template recomputes byte-identically to the 1.3.14 full scan (PARITY)', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const template = client.getId();
        const other = client.getId();

        // Sales across two symbols and both sides of the three-day recent-sale window.
        await insertStats({ template_id: template, price: 100, time: now - DAY_MS });
        await insertStats({ template_id: template, price: 300, time: now - 2 * DAY_MS });
        await insertStats({ template_id: template, price: 500, time: now - 10 * DAY_MS, listing_type: 'auction' });
        await insertStats({ template_id: template, price: 700, time: now - 3600 * 1000, symbol: 'WAXX' });
        // Cap inputs: only single-asset, non-seller-contract listings older than three days.
        await insertListing({ template_id: template, price: 250, updated_at_time: now - 5 * DAY_MS });
        await insertListing({ template_id: template, price: 900, updated_at_time: now - 4 * DAY_MS });
        await insertListing({ template_id: template, price: 10, updated_at_time: now - DAY_MS });
        await insertListing({ template_id: template, price: 5, updated_at_time: now - 5 * DAY_MS, seller_contract: true });
        await insertListing({ template_id: template, price: 7, updated_at_time: now - 5 * DAY_MS, asset_count: 2 });
        // A second template with its own inputs: the batch-scoped restriction of the
        // listings CTE must not let its listings reach the claimed template's cap.
        await insertStats({ template_id: other, price: 400, time: now - DAY_MS });
        await insertListing({ template_id: other, price: 50, updated_at_time: now - 5 * DAY_MS });

        await clearQueue();
        await enqueueLive(template);
        expect(await drain(), 'one queue row released').to.equal(1);

        const incremental = await priceRows(template);
        expect(incremental.length, 'one row per (collection, symbol)').to.equal(2);
        expect((await priceRows(other)).length, 'an unclaimed template is not recomputed').to.equal(0);

        // Pinned by hand so the comparison below cannot pass on two identically empty
        // results: 4 prices (100/300/500/700) across both symbols feed the suggested
        // values, PERCENTILE_DISC(0.5) picks 300 and AVG 400, and both are capped by the
        // 250 listing, while the 10 (too young), 5 (seller contract) and 7 (multi-asset)
        // listings are outside the cap's input set.
        expect(incremental.map(row => ({
            symbol: row.symbol,
            median: row.median,
            average: row.average,
            suggested_median: row.suggested_median,
            suggested_average: row.suggested_average,
            min: row.min,
            max: row.max,
            sales: row.sales,
        }))).to.deep.equal([
            { symbol: 'TEST', median: '300', average: '300', suggested_median: '250', suggested_average: '250', min: '100', max: '500', sales: '3' },
            { symbol: 'WAXX', median: '700', average: '700', suggested_median: '250', suggested_average: '250', min: '700', max: '700', sales: '1' },
        ]);

        // Same fixture state, full-scan driving set.
        await client.query(referenceFunctionSql());
        await client.query('DELETE FROM atomicmarket_template_prices');
        await client.query(`SELECT ${REFERENCE_FN}()`);
        const reference = await priceRows(template);

        expect(incremental).to.deep.equal(reference);
    });

    txit('a template whose recent-sale window has emptied matches the full scan for that state', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const template = client.getId();

        // Every sale older than three days: the recent-window arm of the union is empty
        // and only the last-five arm contributes, which is the state an aging row wakes.
        await insertStats({ template_id: template, price: 100, time: now - 10 * DAY_MS });
        await insertStats({ template_id: template, price: 300, time: now - 20 * DAY_MS });
        await insertListing({ template_id: template, price: 250, updated_at_time: now - 5 * DAY_MS });

        await clearQueue();
        await enqueueLive(template);
        await drain();
        const incremental = await priceRows(template);
        expect(incremental.length, 'the template still has price rows').to.equal(1);
        // Only the last-five arm of the union contributes: PERCENTILE_DISC(0.5) over
        // [100, 300] is 100 and AVG is 200, both under the 250 cap.
        expect(incremental[0].suggested_median).to.equal('100');
        expect(incremental[0].suggested_average).to.equal('200');
        expect(incremental[0].sales, 'the price rows themselves still count every sale').to.equal('2');

        await client.query(referenceFunctionSql());
        await client.query('DELETE FROM atomicmarket_template_prices');
        await client.query(`SELECT ${REFERENCE_FN}()`);

        expect(incremental).to.deep.equal(await priceRows(template));
    });

    txit('returns the number of queue rows released, including for already-current templates', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const template = client.getId();
        await insertStats({ template_id: template, price: 100, time: now - DAY_MS });

        await clearQueue();
        await enqueueLive(template);
        expect(await drain(), 'first drain writes the price rows').to.equal(1);

        // Nothing changed, so the recompute writes no price row at all. The return value
        // still has to count the released queue row or the burn-down loop stops after
        // one batch on a backlog of already-current templates.
        await enqueueLive(template);
        expect(await drain(), 'a no-op recompute still reports its released row').to.equal(1);
    });

    txit('a row re-enqueued mid-batch survives the guarded release and is claimed next drain', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const template = client.getId();
        await insertStats({ template_id: template, price: 100, time: now - DAY_MS });
        await clearQueue();
        await enqueueLive(template);
        const before = await queueRows(template);

        // Deterministic injection of the race: the drain writes atomicmarket_template_prices
        // inside its recompute loop, BEFORE the guarded release, so a trigger there lands a
        // re-enqueue at exactly the point a block-writer's would land mid-batch.
        await client.query(`
            CREATE OR REPLACE FUNCTION tp_test_reenqueue_mid_batch() RETURNS TRIGGER AS $tp$
            BEGIN
                INSERT INTO atomicmarket_template_prices_updates (market_contract, assets_contract, template_id, kind, prio, refresh_at)
                    VALUES (NEW.market_contract, NEW.assets_contract, NEW.template_id, 0, 0, 0)
                ON CONFLICT (market_contract, assets_contract, template_id, kind)
                    DO UPDATE SET seq = nextval('atomicmarket_template_prices_updates_seq'), prio = 0;
                RETURN NULL;
            END
            $tp$ LANGUAGE plpgsql`);
        await client.query(`
            CREATE TRIGGER tp_test_reenqueue_tr AFTER INSERT ON atomicmarket_template_prices
                FOR EACH ROW EXECUTE FUNCTION tp_test_reenqueue_mid_batch()`);

        expect(await drain(), 'the (key, seq) guard skips the re-enqueued row').to.equal(0);

        await client.query('DROP TRIGGER tp_test_reenqueue_tr ON atomicmarket_template_prices');

        const survivors = (await queueRows(template)).filter(row => row.kind === 0);
        expect(survivors.length, 'the racing change survives').to.equal(1);
        expect(Number(survivors[0].seq), 'at a bumped seq').to.be.greaterThan(Number(before[0].seq));
        expect(await drain(), 'and is claimed by the next drain').to.equal(1);
    });

    txit('the claim drains the real-time lane before the bulk lane', async () => {
        await setBlockTime(Date.now());
        await clearQueue();
        const bulk = [client.getId(), client.getId(), client.getId()];
        for (const template of bulk) {
            await enqueueLive(template, 1); // seed / aging lane, lower seq
        }
        const realtime = client.getId();
        await enqueueLive(realtime, 0); // highest seq, fast lane

        expect(await drain(1), 'one row claimed').to.equal(1);

        const left = await queueRows();
        expect(left.map(row => Number(row.template_id)).sort(), 'the real-time row drained first')
            .to.deep.equal([...bulk].sort());
        expect(left.every(row => row.prio === 1)).to.equal(true);
    });

    txit('the drain consumes at most batch_size rows per call', async () => {
        await setBlockTime(Date.now());
        await clearQueue();
        const templates = [client.getId(), client.getId(), client.getId(), client.getId(), client.getId()];
        for (const template of templates) {
            await enqueueLive(template);
        }

        expect(await drain(2), 'bounded by the batch size').to.equal(2);
        expect((await queueRows()).length, 'the rest of the backlog is untouched').to.equal(3);
    });

    txit('draining a seeded template arms its aging row at the earliest future boundary', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const template = client.getId();
        // Two classes of pending boundary: a sale leaving the recent window at +0.5d and
        // a listing entering the cap at +1d. The earliest wins.
        await insertStats({ template_id: template, price: 100, time: now - 2.5 * DAY_MS });
        await insertListing({ template_id: template, price: 250, updated_at_time: now - 2 * DAY_MS });

        await clearQueue();
        await enqueueLive(template, 1); // seeded row: live kind, bulk lane, no aging row
        expect(await drain()).to.equal(1);

        const rows = await queueRows(template);
        expect(rows.length, 'exactly one row left, the armed aging row').to.equal(1);
        expect(rows[0].kind, 'aging kind').to.equal(1);
        expect(rows[0].prio, 'aging rows ride the bulk lane').to.equal(1);
        expect(Number(rows[0].refresh_at), 'earliest future boundary across both input classes')
            .to.equal(now - 2.5 * DAY_MS + THREE_DAYS_MS);
    });

    txit('the self-arm restores the later boundary after the earlier one fires', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const template = client.getId();
        // Two listings crossing into the cap at T1 < T2. One aging row cannot carry both,
        // so the drain that handles T1 has to arm T2 or the later crossing is lost.
        const t1 = now - 2 * DAY_MS + THREE_DAYS_MS;
        const t2 = now - DAY_MS + THREE_DAYS_MS;
        await insertListing({ template_id: template, price: 250, updated_at_time: now - 2 * DAY_MS });
        await insertListing({ template_id: template, price: 900, updated_at_time: now - DAY_MS });

        await clearQueue();
        await enqueueLive(template);
        await drain();
        const armedFirst = await queueRows(template);
        expect(armedFirst.length).to.equal(1);
        expect(Number(armedFirst[0].refresh_at), 'armed at the earlier crossing').to.equal(t1);

        // Not claimable before its boundary passes.
        expect(await drain(), 'a future aging row is not claimable').to.equal(0);
        expect((await queueRows(template)).length).to.equal(1);

        await setBlockTime(t1);
        expect(await drain(), 'claimable once the reader block time reaches it').to.equal(1);

        const armedSecond = await queueRows(template);
        expect(armedSecond.length).to.equal(1);
        expect(armedSecond[0].kind).to.equal(1);
        expect(Number(armedSecond[0].refresh_at), 'the later crossing is restored, not lost').to.equal(t2);
    });

    txit('a drain rolled back mid-batch leaves every claimed row in place at its original seq', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const template = client.getId();
        await insertStats({ template_id: template, price: 100, time: now - DAY_MS });
        await clearQueue();
        await enqueueLive(template);
        const before = await queueRows(template);

        await client.query('SAVEPOINT tp_drain');
        await drain();
        await client.query('ROLLBACK TO SAVEPOINT tp_drain');

        expect(await queueRows(template), 'claim and release are transaction-scoped').to.deep.equal(before);
        expect((await priceRows(template)).length, 'and so is the recompute').to.equal(0);
    });

    // Needs two real connections: txit's single-transaction model cannot represent two
    // concurrent backends. A queued row with no backing inputs is still released
    // (returns 1) by an unobstructed drain, so "returns 0 AND the row survives"
    // isolates the lockout from the empty-queue 0.
    it('a second drain while a batch holds the advisory lock is a clean no-op', async () => {
        const cfg = getTestPostgresConfig();
        const holder = new Client(cfg);
        const drainer = new Client(cfg);
        const template = 987650001;
        const reader = 'tp-advisory-lock-test';
        try {
            await holder.connect();
            await drainer.connect();
            await drainer.query('DELETE FROM atomicmarket_template_prices_updates WHERE template_id = $1', [template]);
            await drainer.query(
                `INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, 1, $2, FALSE, 1)
                 ON CONFLICT (name) DO UPDATE SET block_time = EXCLUDED.block_time`,
                [reader, Date.now()],
            );
            await drainer.query(
                `INSERT INTO atomicmarket_template_prices_updates (market_contract, assets_contract, template_id, kind, prio, refresh_at)
                 VALUES ($1, $2, $3, 0, 0, 0)`,
                [MARKET, ASSETS, template],
            );

            await holder.query('BEGIN');
            await holder.query('SELECT pg_advisory_xact_lock(hashtext(\'update_atomicmarket_template_prices\'))');

            const res = await drainer.query<{ released: number }>(
                'SELECT update_atomicmarket_template_prices(200) AS released',
            );
            expect(Number(res.rows[0].released), 'locked-out drain returns 0').to.equal(0);

            const still = await drainer.query<{ c: number }>(
                'SELECT count(*)::int c FROM atomicmarket_template_prices_updates WHERE template_id = $1',
                [template],
            );
            expect(still.rows[0].c, 'queue row untouched by the no-op drain').to.equal(1);

            await holder.query('ROLLBACK'); // releases the transaction-scoped lock

            // With the lock free the same call consumes the row: the no-op above was the
            // lock, not an empty queue.
            const after = await drainer.query<{ released: number }>(
                'SELECT update_atomicmarket_template_prices(200) AS released',
            );
            expect(Number(after.rows[0].released), 'the lock releases between batches').to.equal(1);
        } finally {
            await drainer
                .query('DELETE FROM atomicmarket_template_prices_updates WHERE template_id = $1', [template])
                .catch(() => undefined);
            await drainer.query('DELETE FROM contract_readers WHERE name = $1', [reader]).catch(() => undefined);
            await holder.end().catch(() => undefined);
            await drainer.end().catch(() => undefined);
        }
    });
});

describe('update_atomicmarket_template_prices - authoritative per-template recompute (1.7.26)', () => {
    txit('a claimed template whose stats rows have all been removed loses its price rows', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const template = client.getId();
        const { listing_type, listing_id } = await insertStats({ template_id: template, price: 100, time: now - DAY_MS });
        await clearQueue();
        await enqueueLive(template);
        await drain();
        expect((await priceRows(template)).length, 'priced first').to.equal(1);

        // The delete enqueues from OLD, which is what makes the cleanup event-driven:
        // the removal itself schedules the recompute that deletes the price rows.
        await client.query(
            'DELETE FROM atomicmarket_stats_markets WHERE market_contract = $1 AND listing_type = $2 AND listing_id = $3',
            [MARKET, listing_type, listing_id],
        );
        expect((await queueRows(template)).filter(row => row.kind === 0).length, 'removal enqueued').to.equal(1);

        await drain();

        expect((await priceRows(template)).length, 'stale price rows deleted, not left behind').to.equal(0);
    });

    txit('a pre-existing orphaned price row is seeded and removed by the first drain that claims it', async () => {
        const now = Date.now();
        await setBlockTime(now);
        const orphan = client.getId();
        // A price row whose template has no rows in the stats view. The seed covers it,
        // and the authoritative recompute deletes it on the drain that claims it.
        await client.query(
            `INSERT INTO atomicmarket_template_prices
                (market_contract, assets_contract, collection_name, template_id, symbol, median, average,
                 suggested_median, suggested_average, "min", "max", sales)
             VALUES ($1, $2, $3, $4, 'TEST', 1, 1, 1, 1, 1, 1, 1)`,
            [MARKET, ASSETS, COLLECTION, orphan],
        );
        await clearQueue();

        await client.query(migrationSql()); // replays the cutover seed

        const seeded = await queueRows(orphan);
        expect(seeded.length, 'the seed covers every already-priced template').to.equal(1);
        expect(seeded[0].prio, 'at bulk priority').to.equal(1);

        await drain();

        expect((await priceRows(orphan)).length, 'recomputed to empty inputs and removed').to.equal(0);
    });
});

describe('template-prices migration - replay, seed and storage', () => {
    txit('replaying the migration leaves one trigger per table, one drain function and one dedup index', async () => {
        await client.query(migrationSql());
        await client.query(migrationSql()); // the init-test-db path replays unconditionally

        const triggers = await client.query<{ table_name: string, c: number }>(
            `SELECT tgrelid::regclass::text AS table_name, count(*)::int c
             FROM pg_trigger
             WHERE NOT tgisinternal
               AND tgname IN ('atomicmarket_stats_markets_update_template_prices_tr',
                              'atomicmarket_sales_filters_listed_update_template_prices_tr')
             GROUP BY 1 ORDER BY 1`,
        );
        expect(triggers.rows).to.deep.equal([
            { table_name: 'atomicmarket_sales_filters_listed', c: 1 },
            { table_name: 'atomicmarket_stats_markets', c: 1 },
        ]);

        const fns = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM pg_proc WHERE proname = $1',
            ['update_atomicmarket_template_prices'],
        );
        expect(fns.rows[0].c, 'one signature, not a zero-argument overload alongside it').to.equal(1);

        const indexes = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM pg_indexes WHERE indexname = $1',
            ['atomicmarket_template_prices_updates_key'],
        );
        expect(indexes.rows[0].c).to.equal(1);
    });

    txit('the seed enqueues every priced and priceable template at bulk priority, live kind only', async () => {
        const priced = client.getId();
        const priceable = client.getId();
        await client.query(
            `INSERT INTO atomicmarket_template_prices
                (market_contract, assets_contract, collection_name, template_id, symbol, median, average,
                 suggested_median, suggested_average, "min", "max", sales)
             VALUES ($1, $2, $3, $4, 'TEST', 1, 1, 1, 1, 1, 1, 1)`,
            [MARKET, ASSETS, COLLECTION, priced],
        );
        await insertStats({ template_id: priceable, price: 100, time: Date.now() });
        await clearQueue();

        await client.query(migrationSql());

        for (const [template, label] of [[priced, 'already priced'], [priceable, 'priceable from the stats view']] as const) {
            const rows = await queueRows(template as number);
            expect(rows.length, `${label} template seeded`).to.equal(1);
            expect(rows[0].kind, 'live kind: the drain arms the aging row itself').to.equal(0);
            expect(rows[0].prio, 'bulk lane, behind real-time enqueues').to.equal(1);
        }

        const aging = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM atomicmarket_template_prices_updates WHERE kind = 1',
        );
        expect(aging.rows[0].c, 'the seed writes no aging rows').to.equal(0);
    });

    txit('the queue table carries the fillfactor and autovacuum storage parameters', async () => {
        const res = await client.query<{ reloptions: string[] }>(
            'SELECT reloptions FROM pg_class WHERE relname = $1',
            ['atomicmarket_template_prices_updates'],
        );

        // Compared numerically: Postgres stores reloptions as the literal text it was
        // given, so a scale factor written 0.0 reads back 0.0 and one written 0 reads
        // back 0, the same setting either way, and not what this pins.
        const options = new Map(res.rows[0].reloptions.map(option => {
            const separator = option.indexOf('=');

            return [option.slice(0, separator), Number(option.slice(separator + 1))] as const;
        }));

        // Every re-enqueue of a queued key is a DO UPDATE on the block-write path, so the
        // dead tuples need absolute autovacuum thresholds and the in-page (HOT) room that
        // fillfactor leaves.
        expect(options.get('autovacuum_vacuum_scale_factor')).to.equal(0);
        expect(options.get('autovacuum_vacuum_threshold')).to.equal(1000);
        expect(options.get('autovacuum_vacuum_insert_scale_factor')).to.equal(0);
        expect(options.get('autovacuum_vacuum_insert_threshold')).to.equal(1000);
        expect(options.get('fillfactor')).to.equal(70);
    });

    txit('dbinfo reports at least the 1.7.26 schema version', async () => {
        const res = await client.query<{ value: string }>('SELECT "value" FROM dbinfo WHERE name = $1', ['version']);

        expect(compareVersionString(res.rows[0].value, '1.7.26')).to.be.at.least(0);
    });

    txit('the zero-argument call (the rolled-back-image path) drains one default batch', async () => {
        await setBlockTime(Date.now());
        await clearQueue();
        const base = 960000000;
        await client.query(
            `INSERT INTO atomicmarket_template_prices_updates (market_contract, assets_contract, template_id, kind, prio, refresh_at)
             SELECT $1, $2, g, 0, 0, 0 FROM generate_series($3::BIGINT, $3::BIGINT + 204) g`,
            [MARKET, ASSETS, base],
        );

        const res = await client.query<{ released: number }>(
            'SELECT update_atomicmarket_template_prices() AS released',
        );

        expect(Number(res.rows[0].released), 'the parameter default is 200').to.equal(200);
        expect((await queueRows()).length, 'the rest waits for the next call').to.equal(5);
    });
});

describe('drainAtomicmarketTemplatePrices - TS batch loop against the real drain (1.7.26)', () => {
    const READER = 'tp-loop-test';
    const BASE_TEMPLATE = 970000001;
    const BACKLOG = 3;
    let pool: Pool;

    before(async () => {
        // max:1 mirrors production's longRunningPool shape, which is what makes
        // "the client is released between batches" a real property here.
        pool = new Pool({ ...getTestPostgresConfig(), max: 1, statement_timeout: 300_000 });
    });

    beforeEach(async () => {
        // These rows are committed rather than held in a transaction (the loop opens its
        // own transaction per batch), so the queue is emptied first and cleaned up after:
        // the drain claims due rows globally, not per contract.
        await pool.query('DELETE FROM atomicmarket_template_prices_updates');
        await pool.query(
            `INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, 1, $2, FALSE, 1)
             ON CONFLICT (name) DO UPDATE SET block_time = EXCLUDED.block_time`,
            [READER, Date.now()],
        );
        await pool.query(
            `INSERT INTO atomicmarket_template_prices_updates (market_contract, assets_contract, template_id, kind, prio, refresh_at)
             SELECT $1, $2, g, 0, 0, 0 FROM generate_series($3::BIGINT, $3::BIGINT + $4::BIGINT - 1) g`,
            [MARKET, ASSETS, BASE_TEMPLATE, BACKLOG],
        );
    });

    after(async () => {
        await pool.query('DELETE FROM atomicmarket_template_prices_updates');
        await pool.query('DELETE FROM contract_readers WHERE name = $1', [READER]);
        await pool.end();
    });

    async function pending(): Promise<number> {
        const res = await pool.query<{ c: number }>(
            'SELECT count(*)::int c FROM atomicmarket_template_prices_updates',
        );

        return res.rows[0].c;
    }

    it('drains the whole backlog in bounded batches while the reader is live', async () => {
        const total = await drainAtomicmarketTemplatePrices(pool, 1, 60_000, 900, 64);

        expect(total, 'one row per batch until the queue is empty').to.equal(BACKLOG);
        expect(await pending()).to.equal(0);
    });

    it('stops between batches when the gate reports the reader behind, leaving the backlog intact', async () => {
        const total = await drainAtomicmarketTemplatePrices(pool, 1, 60_000, 900, 64, () => true);

        expect(total, 'exactly one batch before yielding').to.equal(1);
        expect(await pending(), 'the rest of the backlog waits for the reader').to.equal(BACKLOG - 1);
    });

    it('the work probe reports work exactly when the claim would take some', async () => {
        const probe = async (): Promise<boolean> => {
            const res = await pool.query<{ has_work: boolean }>(TEMPLATE_PRICES_WORK_PROBE_SQL);

            return res.rows[0].has_work;
        };

        expect(await probe(), 'live rows are always due').to.equal(true);

        // Push every row past the reader's block time: the claim would take nothing, so
        // the probe must not wake the drain either.
        await pool.query(
            'UPDATE atomicmarket_template_prices_updates SET kind = 1, refresh_at = $1',
            [Date.now() + 7 * DAY_MS],
        );
        expect(await probe(), 'a future aging row is not work yet').to.equal(false);
        expect(await drainAtomicmarketTemplatePrices(pool, 200, 60_000, 900, 64)).to.equal(0);
    });
});

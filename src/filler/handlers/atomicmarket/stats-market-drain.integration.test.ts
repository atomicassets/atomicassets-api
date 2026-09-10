import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';

import { initAtomicMarketTest } from '../../../api/namespaces/atomicmarket/test';
import { AuctionState, BuyofferState, SaleState, TemplateBuyofferState } from './index';

// Integration coverage for the 2.0.10 bounded, queue-driven
// update_atomicmarket_stats_market(): the four enqueue triggers and their dedup
// key, the batched claim/release protocol, the auction boundary row, and the
// rebuilt queue table. Runs against the test database, which replays every
// migration.
//
// The load-bearing proposition is PARITY: the batched recompute must write
// exactly what the 1.3.23 full recompute wrote for the same state. The reference
// is not transcribed here: it is read out of
// definitions/migrations/1.3.23/atomicmarket.sql at run time and created under a
// second name, so a drift in either implementation fails the comparison.

const MARKET = 'amtest';
const REFERENCE_FILE = './definitions/migrations/1.3.23/atomicmarket.sql';
const REFERENCE_FN = 'sm_reference_full';

const { client, txit } = initAtomicMarketTest();

type QueueRow = { market_contract: string, listing_type: string, listing_id: string, refresh_at: string, seq: string };
type StatsRow = Record<string, unknown>;

/**
 * The 1.3.23 full recompute, verbatim from its migration, under a second name so
 * it can be run side by side with the batched one. One edit, outside the value
 * computation: the function name. Its DELETE-claim needs no adjustment, because
 * it names none of the columns 2.0.10 adds.
 */
function referenceFunctionSql(): string {
    const src = fs.readFileSync(REFERENCE_FILE, { encoding: 'utf8' });
    const start = src.indexOf('CREATE OR REPLACE FUNCTION update_atomicmarket_stats_market()');
    const end = src.indexOf('$$;', start);

    if (start < 0 || end < 0) {
        throw new Error(`Could not extract the 1.3.23 reference recompute from ${REFERENCE_FILE}`);
    }

    return src.slice(start, end + 3)
        .replace('update_atomicmarket_stats_market()', `${REFERENCE_FN}()`);
}

// The claim measures due-ness against MAX(block_time) over contract_readers, so
// every drain test pins that clock. Readers are cleared first: a stray reader with
// a later block_time would silently make a future boundary row claimable.
async function setBlockTime(blockTime: number): Promise<void> {
    await client.query('DELETE FROM contract_readers');
    await client.query(
        'INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, 1, $2, FALSE, 1)',
        ['sm-test', blockTime],
    );
}

async function clearQueue(): Promise<void> {
    await client.query('DELETE FROM atomicmarket_stats_markets_updates');
}

async function enqueue(listingType: string, listingId: number | string, refreshAt = 0): Promise<void> {
    await client.query(
        `INSERT INTO atomicmarket_stats_markets_updates (market_contract, listing_type, listing_id, refresh_at)
             VALUES ($1, $2, $3, $4)
         ON CONFLICT (market_contract, listing_type, listing_id, refresh_at)
             DO UPDATE SET seq = nextval('atomicmarket_stats_markets_updates_seq')`,
        [MARKET, listingType, listingId, refreshAt],
    );
}

async function queueRows(listingType?: string): Promise<QueueRow[]> {
    const res = await client.query(
        `SELECT market_contract, listing_type, listing_id, refresh_at, seq
         FROM atomicmarket_stats_markets_updates
         WHERE ($1::text IS NULL OR listing_type = $1)
         ORDER BY listing_type, listing_id, refresh_at`,
        [listingType ?? null],
    );
    return res.rows;
}

async function drain(batchSize = 1000): Promise<number> {
    const res = await client.query('SELECT update_atomicmarket_stats_market($1) AS released', [batchSize]);
    return Number(res.rows[0].released);
}

async function statsRows(): Promise<StatsRow[]> {
    const res = await client.query(
        `SELECT market_contract, listing_type, listing_id, buyer, seller, maker_marketplace,
                taker_marketplace, assets_contract, collection_name, symbol, price, "time",
                schema_name, template_id, asset_id
         FROM atomicmarket_stats_markets
         ORDER BY listing_type, listing_id`,
    );
    return res.rows;
}

/**
 * One listing of every type the recompute resolves, each already in the final
 * state its arm filters on, plus a two-asset sale whose schema_name, template_id
 * and asset_id must come back NULL. Returns the keys to enqueue.
 */
async function createEveryListingType(): Promise<Array<[string, string]>> {
    const { collection_name } = await client.createCollection();

    const sale = await client.createFullSale(
        { collection_name, state: SaleState.SOLD, final_price: 100, settlement_symbol: 'TEST' },
    );

    const auction = await client.createAuction({
        collection_name,
        state: AuctionState.LISTED,
        buyer: 'buyer',
        price: 200,
        end_time: 1000,
    });
    await client.createAuctionAssets({ auction_id: auction.auction_id });

    const buyoffer = await client.createBuyOffer({ collection_name, state: BuyofferState.ACCEPTED, price: 300 });
    await client.createBuyOfferAssets({
        buyoffer_id: buyoffer.buyoffer_id,
        asset_id: (await client.createAsset({ collection_name })).asset_id,
    });

    const templateBuyoffer = await client.createTemplateBuyOffer({
        collection_name,
        state: TemplateBuyofferState.SOLD,
        price: 400,
    });
    await client.createTemplateBuyOfferAssets({
        buyoffer_id: templateBuyoffer.buyoffer_id,
        asset_id: (await client.createAsset({ collection_name })).asset_id,
    });

    // Two assets on one offer: COUNT(*) = 1 fails, so the three resolved columns
    // must be NULL rather than an arbitrary one of the two.
    const multi = await client.createFullSale(
        { collection_name, state: SaleState.SOLD, final_price: 500, settlement_symbol: 'TEST' },
    );
    await client.createOfferAsset({
        offer_id: multi.offer_id,
        asset_id: (await client.createAsset({ collection_name })).asset_id,
        index: 2,
    });

    return [
        ['sale', sale.sale_id],
        ['auction', auction.auction_id],
        ['buyoffer', buyoffer.buyoffer_id],
        ['template_buyoffer', templateBuyoffer.buyoffer_id],
        ['sale', multi.sale_id],
    ];
}

describe('stats-market queue - enqueue triggers (2.0.10)', () => {
    txit('all four enqueue functions are wired to their triggers', async () => {
        const res = await client.query(
            `SELECT p.proname, t.tgrelid::regclass::text AS table_name
             FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE p.proname LIKE 'update_atomicmarket_stats_markets_by_%'
             ORDER BY p.proname`,
        );

        expect(res.rows.map((row: any) => [row.proname, row.table_name])).to.deep.equal([
            ['update_atomicmarket_stats_markets_by_auction', 'atomicmarket_auctions'],
            ['update_atomicmarket_stats_markets_by_buyoffer', 'atomicmarket_buyoffers'],
            ['update_atomicmarket_stats_markets_by_sale', 'atomicmarket_sales'],
            ['update_atomicmarket_stats_markets_by_template_buyoffer', 'atomicmarket_template_buyoffers'],
        ]);
    });

    txit('a second write to the same sale bumps seq and adds no row', async () => {
        await clearQueue();
        const sale = await client.createFullSale({ state: SaleState.SOLD, final_price: 100 });

        const first = await queueRows('sale');
        expect(first.length, 'one row for the first qualifying write').to.equal(1);

        await client.query(
            'UPDATE atomicmarket_sales SET final_price = 200 WHERE market_contract = $1 AND sale_id = $2',
            [MARKET, sale.sale_id],
        );

        const second = await queueRows('sale');
        expect(second.length, 'still one row: the dedup key collapses the re-enqueue').to.equal(1);
        expect(Number(second[0].seq), 'at a bumped seq').to.be.greaterThan(Number(first[0].seq));
    });

    txit('an auction enqueues an immediate row and a boundary row at end_time', async () => {
        await clearQueue();
        const auction = await client.createAuction({
            state: AuctionState.LISTED,
            buyer: 'buyer',
            end_time: 5000,
        });

        const rows = await queueRows('auction');
        expect(rows.map(row => row.refresh_at), 'both rows, kept apart by refresh_at in the key')
            .to.deep.equal(['0', String(5000 * 1000)]);
        expect(rows.every(row => row.listing_id === String(auction.auction_id))).to.equal(true);
    });

    txit('a bid that extends end_time adds the new boundary instead of replacing the old one', async () => {
        await clearQueue();
        const auction = await client.createAuction({
            state: AuctionState.LISTED,
            buyer: 'buyer',
            end_time: 5000,
        });

        await client.query(
            'UPDATE atomicmarket_auctions SET end_time = $3 WHERE market_contract = $1 AND auction_id = $2',
            [MARKET, auction.auction_id, 9000],
        );

        expect((await queueRows('auction')).map(row => row.refresh_at), 'the earlier boundary is still visited')
            .to.deep.equal(['0', String(5000 * 1000), String(9000 * 1000)]);
    });

    txit('the queue rejects a row with no market_contract or listing_id', async () => {
        // 2.0.10 makes both columns NOT NULL. Under the guarded release such a row
        // would be claimed by every batch and released by none, because the release
        // compares the claimed columns for equality and NULL never equals NULL.
        await expect(client.query(
            'INSERT INTO atomicmarket_stats_markets_updates (market_contract, listing_type, listing_id) VALUES (NULL, $1, 1)',
            ['sale'],
        )).to.be.rejectedWith(/not-null constraint/);
    });
});

describe('update_atomicmarket_stats_market - batched drain (2.0.10)', () => {
    txit('a queued listing of every type resolves byte-identically to the 1.3.23 full recompute (PARITY)', async () => {
        await setBlockTime(Date.now());
        const keys = await createEveryListingType();

        await clearQueue();
        for (const [listingType, listingId] of keys) {
            await enqueue(listingType, listingId);
        }
        expect(await drain(), 'every queued row released').to.equal(keys.length);

        const incremental = await statsRows();
        expect(incremental.length, 'one stats row per listing').to.equal(keys.length);

        // Pinned by hand so the comparison below cannot pass on two identically empty
        // results. The single-asset sale resolves its schema, template and asset; the
        // two-asset sale resolves none of the three.
        const single = incremental.find(row => row.listing_type === 'sale' && row.price === '100');
        expect(single?.asset_id, 'the single-asset sale resolves its asset').to.not.equal(null);
        const multi = incremental.find(row => row.listing_type === 'sale' && row.price === '500');
        expect([multi?.schema_name, multi?.template_id, multi?.asset_id], 'the two-asset sale resolves none')
            .to.deep.equal([null, null, null]);
        expect(incremental.map(row => row.listing_type).sort(), 'all four arms of the union fired')
            .to.deep.equal(['auction', 'buyoffer', 'sale', 'sale', 'template_buyoffer']);

        // Same fixture state, full-recompute driving set.
        await client.query('DELETE FROM atomicmarket_stats_markets');
        for (const [listingType, listingId] of keys) {
            await enqueue(listingType, listingId);
        }
        await client.query(referenceFunctionSql());
        await client.query(`SELECT ${REFERENCE_FN}()`);

        expect(incremental).to.deep.equal(await statsRows());
    });

    txit('a listing that leaves its final state has its stats row deleted, as the full recompute does', async () => {
        await setBlockTime(Date.now());
        const sale = await client.createFullSale({ state: SaleState.SOLD, final_price: 100 });

        await clearQueue();
        await enqueue('sale', sale.sale_id);
        expect(await drain()).to.equal(1);
        expect((await statsRows()).length, 'the sold sale is a stats row').to.equal(1);

        await client.query(
            'UPDATE atomicmarket_sales SET state = $3 WHERE market_contract = $1 AND sale_id = $2',
            [MARKET, sale.sale_id, SaleState.CANCELED],
        );
        await clearQueue();
        await enqueue('sale', sale.sale_id);
        expect(await drain(), 'the row is still released').to.equal(1);
        expect(await statsRows(), 'and the stats row is gone').to.deep.equal([]);

        // The full recompute reaches the same empty state from the same inputs.
        await enqueue('sale', sale.sale_id);
        await client.query(referenceFunctionSql());
        await client.query(`SELECT ${REFERENCE_FN}()`);
        expect(await statsRows()).to.deep.equal([]);
    });

    txit('returns the number of queue rows released, not the stats rows written', async () => {
        await setBlockTime(Date.now());
        const sale = await client.createFullSale({ state: SaleState.SOLD, final_price: 100 });

        await clearQueue();
        await enqueue('sale', sale.sale_id);
        expect(await drain(), 'first pass writes the row').to.equal(1);

        // Nothing changed, so the upsert's IS DISTINCT FROM guard writes nothing and
        // the delete branch removes nothing. Had the function kept 1.3.15's write
        // count it would report 0 here and the filler's burn-down would cap at one
        // batch per tick.
        await enqueue('sale', sale.sale_id);
        expect(await drain(), 'an already-current listing still reports its released row').to.equal(1);
    });

    txit('claims at most batch_size rows per call', async () => {
        await setBlockTime(Date.now());
        await clearQueue();
        for (let i = 1; i <= 7; i += 1) {
            await enqueue('sale', i);
        }

        expect(await drain(3), 'bounded by the batch size').to.equal(3);
        expect(await drain(3)).to.equal(3);
        expect(await drain(3), 'the remainder').to.equal(1);
        expect(await drain(3), 'and then the queue is empty').to.equal(0);
        expect((await queueRows()).length).to.equal(0);
    });

    txit('leaves a boundary row alone until the reader block time reaches it', async () => {
        await setBlockTime(1_000_000);
        await clearQueue();
        await enqueue('auction', 1, 0);
        await enqueue('auction', 1, 2_000_000);

        expect(await drain(), 'only the immediate row is due').to.equal(1);
        expect((await queueRows()).map(row => row.refresh_at), 'the boundary row waits')
            .to.deep.equal(['2000000']);

        await setBlockTime(2_000_000);
        expect(await drain(), 'and is claimed once block time reaches it').to.equal(1);
        expect((await queueRows()).length).to.equal(0);
    });

    txit('a row re-enqueued mid-batch survives the guarded release and is claimed next drain', async () => {
        await setBlockTime(Date.now());
        const sale = await client.createFullSale({ state: SaleState.SOLD, final_price: 100 });
        await clearQueue();
        await enqueue('sale', sale.sale_id);
        const before = await queueRows('sale');

        // Deterministic injection of the race: the drain writes
        // atomicmarket_stats_markets inside its recompute, BEFORE the guarded release,
        // so a trigger there lands a re-enqueue at exactly the point a block writer's
        // would land mid-batch.
        await client.query(`
            CREATE OR REPLACE FUNCTION sm_test_reenqueue_mid_batch() RETURNS TRIGGER AS $sm$
            BEGIN
                INSERT INTO atomicmarket_stats_markets_updates (market_contract, listing_type, listing_id, refresh_at)
                    VALUES (NEW.market_contract, NEW.listing_type, NEW.listing_id, 0)
                ON CONFLICT (market_contract, listing_type, listing_id, refresh_at)
                    DO UPDATE SET seq = nextval('atomicmarket_stats_markets_updates_seq');
                RETURN NULL;
            END
            $sm$ LANGUAGE plpgsql`);
        await client.query(`
            CREATE TRIGGER sm_test_reenqueue_tr AFTER INSERT ON atomicmarket_stats_markets
                FOR EACH ROW EXECUTE FUNCTION sm_test_reenqueue_mid_batch()`);

        expect(await drain(), 'the (key, seq) guard skips the re-enqueued row').to.equal(0);

        await client.query('DROP TRIGGER sm_test_reenqueue_tr ON atomicmarket_stats_markets');

        const survivors = await queueRows('sale');
        expect(survivors.length, 'the racing change survives').to.equal(1);
        expect(Number(survivors[0].seq), 'at a bumped seq').to.be.greaterThan(Number(before[0].seq));
        expect(await drain(), 'and is claimed by the next drain').to.equal(1);
    });

    txit('is re-entrant within one transaction and callable with no argument', async () => {
        await setBlockTime(Date.now());
        await clearQueue();
        await enqueue('sale', 1);

        // The advisory lock is transaction-scoped, so a second call in the same
        // transaction must still drain rather than no-op. The zero-argument form is
        // what an image rolled back to an earlier tag calls.
        expect(await drain()).to.equal(1);
        const res = await client.query('SELECT update_atomicmarket_stats_market() AS released');
        expect(Number(res.rows[0].released)).to.equal(0);
    });
});

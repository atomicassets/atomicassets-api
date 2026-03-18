import 'mocha';
import {expect} from 'chai';

import Semaphore from './semaphore';

describe('Semaphore', () => {
    it('allows acquire up to max concurrency', async () => {
        const sem = new Semaphore(3);

        await sem.acquire();
        await sem.acquire();
        await sem.acquire();

        // All 3 permits consumed — fourth acquire should block
        let blocked = true;
        const p = sem.acquire().then(() => { blocked = false; });

        // Yield to microtask queue
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(blocked).to.equal(true);

        // Release one permit — the blocked acquire should resolve
        sem.release();
        await p;
        expect(blocked).to.equal(false);
    });

    it('release unblocks waiters in FIFO order', async () => {
        const sem = new Semaphore(1);
        await sem.acquire();

        const order: number[] = [];

        const p1 = sem.acquire().then(() => order.push(1));
        const p2 = sem.acquire().then(() => order.push(2));

        sem.release(); // unblocks p1
        await p1;

        sem.release(); // unblocks p2
        await p2;

        expect(order).to.deep.equal([1, 2]);
    });

    it('leaks permits when release is not called', async () => {
        const sem = new Semaphore(2);

        // Acquire both permits without releasing
        await sem.acquire();
        await sem.acquire();

        // Third acquire should block indefinitely (semaphore leaked)
        let resolved = false;
        const p = sem.acquire().then(() => { resolved = true; });
        // Attach catch so purge() cleanup doesn't cause unhandled rejection
        p.catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(resolved).to.equal(false);

        // Cleanup: purge to prevent hanging
        sem.purge();
    });

    it('purge rejects all waiting promises and resets counter', async () => {
        const sem = new Semaphore(1);
        await sem.acquire();

        let rejected = false;
        sem.acquire().catch(() => { rejected = true; });

        const purgedCount = sem.purge();
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(purgedCount).to.equal(1);
        expect(rejected).to.equal(true);

        // After purge, counter is reset — acquire should work again
        await sem.acquire();
    });
});
